# grant-memory delta — tier-contract-consistency

本 change 修改 grant-memory spec 里 bash 命令记忆的 tier 前提：bash unreliable 命令的弹窗档位从 tier=two 更新为 tier=three。原 spec 里"tier=two bash 命令类"作为 tier=two 的变体，本次收敛为 tier=three 通用分支——bash 命令类与 path-based 弹窗同 tier=three 都通过 tier=three 弹窗提供持久化选项。

**tier=two 契约不变**：本 change 后 tier=two 严格等于"hard sensitive 外区"或"dev-socket 写入"，均不可持久化——"未配置路径不写入持久化" requirement 语义更纯粹（tier=two 变体被清空），无需修改。

## MODIFIED Requirements

### Requirement: Bash 命令记忆渠道

系统 SHALL 额外维护**Bash 命令记忆**存储空间，用于记录用户对不可靠 bash 命令的会话级授权，并允许 auto‑allow 下次相同的 rawCommand。

**键结构**：`<projectHash> | command_hash | session_tag>`

- `command_hash` 为 `rawCommand` 的 SHA-256（16 进制小写，无分隔符），以将长命令摘要化
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

**查询逻辑**：

- 在 **extension 层**，当收到 bash 命令时，首先查询 **核心 path-level 授权**（`hasGrant(projectHash, action, absPath)`），再查询 **Bash 命令授权**（`hasBashSessionGrant(projectHash, commandHash, sessionTag)` 和 `hasBashPersistentGrant(projectHash, commandHash)`），最后查询 **tool+pattern 规则**（`resolveRule("bash", rawCommand)`）。任一击中即 auto-allow 并**跳过决策引擎**，如常规授权那样记录 audit 日志。

**授权类型映射**：

- **基于命令不可靠类型的授权类型映射**（本 change 后统一用于 tier=three bash 命令）：
  - `reason: "glob_expansion"` 或 `reason: "unresolved variable: ..."` → 授权为 `read_only`
  - `reason: "control_flow"` 或 `reason: "shell_forwarder"` 或 `reason: "forwarding_command"` 或 `reason: "cd_chdir"` → 授权为 `read_write`（这类命令可能访问任意路径，属更高风险）
- **用户选择的权限**：如 tier=three prompt（配置声明路径或 unreliable bash）用户选择 `read_write` / `read_only` 时，Bash 命令授权使用该权限

**审计日志字段扩展**：

- 新增 `grant_type` 字段，区分 `path` / `bash` / `rule`
- Bash 类型日志中加入 `commandHash` 和 `reason`
- Rule 类型日志中加入 `tool`、`pattern` 和 `action`

#### Scenario: 会话内允许特定 bash 命令

- **WHEN** 用户看到 tier=three bash 命令 prompt（例如 `ls /tmp/*.log` 触发 glob_expansion），选择"允许为本会话"
- **THEN**
  - 会话级 Bash 命令记忆中写入 `{projectHash, commandHash, sessionTag, permission: read_only, createdAt}`
  - 本次调用 auto-allow，并记录 audit 日志 `event: "allow_session", grant_type: "bash"`
  - 下次相同 `rawCommand`（在同一 sessionId 内）直接 auto-allow，不再走 tier=three prompt

#### Scenario: 总是允许 bash 命令

- **WHEN** 上场景中用户选择"总是允许本命令"，同时 tier=three（无权限声明）则按上文 mapping 授权为 `read_only`
- **THEN**
  - 持久化 Bash 命令 memory 中写入 `{projectHash, commandHash, permission: read_only, createdAt}`
  - 会话级 memory 也写入（跨会话生效入口）
  - audit 日志含 `event: "allow_persistent", grant_type: "bash"` 和 `saved_to: <trusted.json 绝对路径>`
  - 下次任意 session 访问相同 `rawCommand` 均 auto-allow

#### Scenario: 其他类型 bash 命令（控制流 + shell 转发器）授权为 read_write

- **WHEN** bash 命令为 `bash -c "rm -rf /etc/passwd"`（`reason: "shell_forwarder"`）、`find /etc | xargs rm`（`reason: "forwarding_command"`）、`while read x; do cat $x; done`（`reason: "control_flow"`）、或 `cd /etc && rm -rf .`（`reason: "cd_chdir"`）
- **THEN** 用户选择"允许一次/会话/总是允许"时，Bash 命令授权的 permission 为 `read_write`（更严格），避免对这类高风险命令放行过多

#### Scenario: allow 规则命中的命令不写入记忆

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，bash 命令为 `git status`
- **THEN** 决策为 auto_allow，不写入 Bash 命令记忆，audit 日志 `grant_type: "rule"`

#### Scenario: deny 规则命中的命令不写入记忆

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "rm *", "action": "deny" }`，bash 命令为 `rm -rf /`
- **THEN** 决策为 deny_hard，不写入 Bash 命令记忆，audit 日志 `grant_type: "rule"`

#### Scenario: audit 日志区分 path vs bash 授权

- **WHEN** 用户授权一个路径 `/etc/passwd` 和一个 bash 命令 `cat /etc/passwd`，记录时日志中 `grant_type` 分别为 `path` / `bash`
- **THEN** 审计消费者可以区分用户对具体路径的授权与对具体命令的授权，便于安全分析

#### Scenario: cd cwd 变更命令授权为 read_write

- **WHEN** bash 命令为 `cd /etc && rm -rf .`，`extractBashTargets` 返回 `reason: "cd_chdir"`，用户选择"允许为本会话"
- **THEN**
  - 会话级 Bash 命令记忆中写入 `{projectHash, commandHash, sessionTag, permission: read_write, createdAt}`
  - audit 日志含 `event: "allow_session", grant_type: "bash"`，`reason: "cd_chdir"`
