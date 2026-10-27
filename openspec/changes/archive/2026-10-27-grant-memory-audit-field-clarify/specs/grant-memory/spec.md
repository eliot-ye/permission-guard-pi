# Spec: Grant-memory audit field & allow-rule boundary clarification (D3)

## Capability: grant-memory (delta)

## MODIFIED Requirements

### Requirement: Bash 命令记忆渠道

**Level: should**

系统 SHALL 额外维护**Bash 命令记忆**存储空间，用于记录用户对不可靠 bash 命令的会话级授权，并允许 auto‑allow 下次相同的 rawCommand。

**键结构**：`<projectHash> | command_hash | session_tag>`

- `command_hash` 为 `rawCommand` 的 SHA-256（16 进制小写，无分隔符），以将长命令摘要化。**P1 等价语义（e2）**：哈希输入先做**词法 whitespace 规范化**（`replace(/\s+/g," ").trim()`），因此 `git  status`（双空格）与 `git status` 命中同一 grant；与 tool+pattern 规则匹配（config.ts normalizeWhitespace）对齐——同一系统、同一等价语义。
- `session_tag` 为与核心 grant 一样的 `sessionId`（或当前进程标识），以支持跨会话持久化
- `permission` 采用 `read_write` / `read_only`（不区分 `read`/`write`/`delete`，由 `extractBashTargets` 提供的 `ExtractResult.reason` 决定授权类型；具体规则见下文）
- `createdAt` 为 ISO-8601 时间戳

**记存逻辑**：

1. 当用户在 **tier=three** 的 bash 命令 prompt（unreliable bash）中选择**"允许一次"**或**"允许为本会话"**时，若其原始 `rawCommand` 对应一个不可靠检测（`extractBashTargets` 返回 `reliable: false, reason: X`），则写入该 Bash 命令记忆：
   - **"允许一次"** → 仅放行本次调用，不写入记忆
   - **"允许为本会话"** → 写入会话级 memory，并 auto-allow 下次**相同** `rawCommand`（在同一 sessionId 内），重启后清除
2. 当用户在 **tier=three** 的 bash 命令 prompt（unreliable bash）中选择**"总是允许本命令"**时，写入持久化 memory 中的 Bash 命令 memory，并 auto-allow 跨会话相同 `rawCommand`，弹窗 UI 须显示持久化文件路径（与 path-level 持久化统一）
3. **allow 规则命中的命令不写入记忆**：当 bash 命令被 allow 规则匹配并 auto-allow 时，不写入 Bash 命令记忆（无需记忆，规则已持久授权）
4. **deny 规则命中的命令不写入记忆**：当 bash 命令被 deny 规则匹配并 deny_hard 时，不写入 Bash 命令记忆（永远不可放行）

**P1 等价语义边界**（与 security-boundary-docs Non-Goal「不做完整 shell 解析」对齐）：

- 等价止步于**词法 whitespace 规范化**——`git  status` === `git status`；`  git status  ` === `git status`
- **不做语法级等价**：`bash -c "git status"` ≠ `git status`（shell-forwarder 语义漂移）；`cd /tmp && git status` ≠ `git status`（cwd 漂移）——这些语义漂移若被判等价会**误放行**，MUST NOT 采纳
- `git status` ≠ `git status --short`（参数不同 → 不同命令）

**查询逻辑**：

- 在 **extension 层**，当收到 bash 命令时，首先查询 **核心 path-level 授权**（`hasGrant(projectHash, action, absPath)`），再查询 **Bash 命令授权**（`hasBashSessionGrant(projectHash, commandHash, sessionTag)` 和 `hasBashPersistentGrant(projectHash, commandHash)`），最后查询 **tool+pattern 规则**（`resolveRule("bash", rawCommand)`）。任一击中即 auto-allow 并**跳过决策引擎**，如常规授权那样记录 audit 日志。
- **D3a 规则查询边界（不可靠 vs 可靠）**：
  - **可靠 bash 命令**（`extractBashTargets` 返回 `reliable: true`）→ 可静态解析 target，tool+pattern 规则 **allow 与 deny 均生效**（allow → auto_allow；deny → deny_hard），经 `decideTarget` 逐 target 判定。
  - **不可靠 bash 命令**（`reliable: false`）→ 无法静态解析 target，**只查询 deny 规则**（deny 优先，命中即 hard_deny）；**allow 规则对不可靠命令不生效**（若 allow 放行会绕过敏感检查——安全保守设计，MUST NOT 让不可靠命令经 allow 规则 auto-allow）。

**授权类型映射**：

- **基于命令不可靠类型的授权类型映射**（本 change 后统一用于 tier=three bash 命令）：
  - `reason: "glob_expansion"` 或 `reason: "unresolved variable: ..."` → 授权为 `read_only`
  - `reason: "control_flow"` 或 `reason: "shell_forwarder"` 或 `reason: "forwarding_command"` 或 `reason: "cd_chdir"` → 授权为 `read_write`（这类命令可能访问任意路径，属更高风险）
- **用户选择的权限**：如 tier=three prompt（配置声明路径或 unreliable bash）用户选择 `read_write` / `read_only` 时，Bash 命令授权使用该权限

**审计日志字段扩展**：

- **来源标注以 `grant_source` 为权威**（B2/B5 已实现）：`config_declaration` / `allow_rule` / `grant_memory` / `bash_grant_memory` / `default`——完整区分授权来源。`grant_type`（path/bash/rule）为**粗粒度冗余，不单列为必填字段**（`grant_source` 已提供更细区分）。
- Bash 类型日志中含 `commandHash`（B5：长命令 > 511 字符截断时额外写入原始命令的 SHA-256，匹配 `trusted.json` 的 `bashGrants[].commandHash`）；未截断不写（向后兼容）。
- `saved_to` / `reason` 作为 `note` 内容已覆盖（持久化路径 / 不可靠原因），不单列为必填字段。

#### Scenario: 不可靠 bash 只查 deny 规则（D3a 边界）

- **GIVEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`
- **WHEN** bash 命令为不可靠命令（如 `git status && rm -rf /tmp/x`，`reliable: false`）
- **THEN** allow 规则**不生效**（不 auto-allow），走 tier=three 弹窗（不可靠命令无法静态解析，allow 放行会绕过敏感检查）

#### Scenario: 不可靠 bash deny 规则命中即 hard_deny（D3a 边界）

- **GIVEN** 配置声明 `{ "tool": "bash", "pattern": "rm *", "action": "deny" }`
- **WHEN** bash 命令为不可靠命令（`rm -rf / && echo done`，`reliable: false`）
- **THEN** deny 规则命中 → `deny_hard`，不写入 Bash 命令记忆

#### Scenario: 可靠 bash allow 规则生效（D3a 边界）

- **GIVEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`
- **WHEN** bash 命令为可靠命令（`git status`，`reliable: true`）
- **THEN** allow 规则命中 → auto_allow，不写入 Bash 命令记忆

#### Scenario: 来源标注以 grant_source 为权威（D3b 边界）

- **WHEN** 审计记录需要区分授权来源
- **THEN** 以 `grant_source` 字段为权威（`config_declaration` / `allow_rule` / `grant_memory` / `bash_grant_memory` / `default`），不依赖粗粒度的 `grant_type`

#### Scenario: 会话内允许特定 bash 命令

- **WHEN** 用户看到 tier=three bash 命令 prompt（例如 `ls /tmp/*.log` 触发 glob_expansion），选择"允许为本会话"
- **THEN**
  - 会话级 Bash 命令记忆中写入 `{projectHash, commandHash, sessionTag, permission: read_only, createdAt}`
  - 本次调用 auto-allow，并记录 audit 日志 `event: "allow_session"`（来源标注 `grant_source: "bash_grant_memory"`）
  - 下次相同 `rawCommand`（在同一 sessionId 内）直接 auto-allow，不再走 tier=three prompt

#### Scenario: 总是允许 bash 命令

- **WHEN** 上场景中用户选择"总是允许本命令"，同时 tier=three（无权限声明）则按上文 mapping 授权为 `read_only`
- **THEN**
  - 持久化 Bash 命令 memory 中写入 `{projectHash, commandHash, permission: read_only, createdAt}`
  - 会话级 memory 也写入（跨会话生效入口）
  - audit 日志含 `event: "allow_persistent"`（来源标注 `grant_source: "bash_grant_memory"`）
  - 下次任意 session 访问相同 `rawCommand` 均 auto-allow

#### Scenario: 其他类型 bash 命令（控制流 + shell 转发器）授权为 read_write

- **WHEN** bash 命令为 `bash -c "rm -rf /etc/passwd"`（`reason: "shell_forwarder"`）、`find /etc | xargs rm`（`reason: "forwarding_command"`）、`while read x; do cat $x; done`（`reason: "control_flow"`）、或 `cd /etc && rm -rf .`（`reason: "cd_chdir"`）
- **THEN** 用户选择"允许一次/会话/总是允许"时，Bash 命令授权的 permission 为 `read_write`（更严格），避免对这类高风险命令放行过多

#### Scenario: allow 规则命中的命令不写入记忆

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，bash 命令为可靠命令 `git status`
- **THEN** 决策为 auto_allow，不写入 Bash 命令记忆，来源标注 `grant_source: "allow_rule"`

#### Scenario: deny 规则命中的命令不写入记忆

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "rm *", "action": "deny" }`，bash 命令为 `rm -rf /`
- **THEN** 决策为 deny_hard，不写入 Bash 命令记忆（来源标注 `grant_source` 省略，hard_deny 非授权事件）

#### Scenario: audit 日志区分 path vs bash 授权

- **WHEN** 用户授权一个路径 `/etc/passwd` 和一个 bash 命令 `cat /etc/passwd`，记录时日志中 `grant_source` 分别为 `grant_memory` / `bash_grant_memory`
- **THEN** 审计消费者可以区分用户对具体路径的授权与对具体命令的授权，便于安全分析

#### Scenario: cd cwd 变更命令授权为 read_write

- **WHEN** bash 命令为 `cd /etc && rm -rf .`，`extractBashTargets` 返回 `reason: "cd_chdir"`，用户选择"允许为本会话"
- **THEN**
  - 会话级 Bash 命令记忆中写入 `{projectHash, commandHash, sessionTag, permission: read_write, createdAt}`
  - audit 日志含 `event: "allow_session"`（来源标注 `grant_source: "bash_grant_memory"`）
