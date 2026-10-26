# grant-memory Specification

## Purpose
定义授权记忆的存储与查询契约——会话级（进程内、重启失效）与持久化（磁盘 trusted.json、跨会话生效）双通道，键含项目标识保证项目隔离。

## Requirements

### Requirement: 双通道记忆

系统 SHALL 维护两个独立的授权记忆通道：

- **会话级**：进程内存中的 Map，重启失效。任何弹窗的"会话内允许"选项写入此通道。
- **持久化**：磁盘 JSON 文件 `~/.pi/agent/extensions/permission-guard-pi/trusted.json`。任何弹窗的"总是允许"选项写入此通道。

授权记忆查询发生在 **extension 层**（在调用决策引擎之前）：extension 同时检查两个通道，任一击中即直接放行，不调用决策引擎。决策引擎收到的都是"未授权"请求。

#### Scenario: 会话内允许后同会话免弹

- **WHEN** 用户对项目外敏感文件选择"会话内允许"，同会话内再次访问同一文件
- **THEN** auto_allow（会话级记忆命中）

#### Scenario: 会话内允许后重启重新弹

- **WHEN** 上一场景后用户重启 pi 会话，再访问同一文件
- **THEN** 重新弹审批（会话级记忆清空）

#### Scenario: 总是允许后跨会话免弹

- **WHEN** 用户对配置声明的项目外路径选择"总是允许"，重启 pi 后再次访问
- **THEN** auto_allow（持久化记忆命中）

### Requirement: 记忆键结构

记忆键 MUST 为三元组，保证不同项目之间授权不互相影响：

```
<projectHash> | <action> | <absPath>
```

- **projectHash**：由 `<projectRoot>` 的稳定哈希派生。同一 `<projectRoot>` 内切换子目录 MUST 得到相同 projectHash；不同 worktree MUST 得到不同 projectHash；Windows 大小写差异 MUST 归一（hash 输入先小写化）
- **action**：`read` / `write` / `delete` 之一
- **absPath**：规范化后的绝对路径（先展开 `~`、resolve `..`、realpath 解符号链接、路径分隔符归一）

#### Scenario: 不同项目授权隔离

- **WHEN** 项目 A 对项目外文件 `F` 授予"总是允许"，项目 B（无 `F` 配置声明）访问 `F`
- **THEN** 项目 B 触发审批弹窗（`F` 对 B 是未配置路径，弹窗无"总是允许"按钮）

#### Scenario: 同项目切换子目录授权稳定

- **WHEN** 项目 A 用户授予 `F` "总是允许"，之后 `cd` 到项目 A 的某个子目录再访问 `F`
- **THEN** auto_allow（projectHash 稳定）

#### Scenario: 不同 worktree 授权隔离

- **WHEN** 项目 A 有两个 worktree `A-main` 和 `A-feature`，A-main 授予 `F` "总是允许"，A-feature 访问 `F`
- **THEN** A-feature 触发审批弹窗

### Requirement: 记忆写入的权限级别记录

持久化写入时 MUST 同时记录权限级别（`read_write` / `read_only`），以便后续审计与撤销。

#### Scenario: 写入时记录权限级别

- **WHEN** 用户对配置为 `read_write` 的项目外路径 `F` 选择"总是允许"
- **THEN** trusted.json 记录条目含 `{"permission": "read_write", "action": "read", ...}`

### Requirement: trusted.json 文件格式

持久化记忆文件 SHALL 使用 JSON 格式（非 JSONC），结构：

```json
{
  "grants": [
    {
      "projectHash": "...",
      "action": "read",
      "path": "/abs/path",
      "permission": "read_write",
      "createdAt": "<iso8601>"
    }
  ]
}
```

缺失文件 MUST 视为空 grants 数组。写入 MUST 使用原子操作（写临时文件 + rename），防止写入中途崩溃产生损坏文件。

#### Scenario: 缺失 trusted.json 视为空

- **WHEN** 首次启动，trusted.json 不存在
- **THEN** 记忆查询返回空，任何授权请求都触发弹窗

#### Scenario: 原子写入保证

- **WHEN** 写入过程中进程崩溃
- **THEN** trusted.json 要么保持完整旧内容，要么完整新内容，不产生损坏文件

### Requirement: 敏感文件按文件记忆，非按目录

敏感文件的记忆键 MUST 包含完整路径，禁止以目录粒度记忆。

#### Scenario: 敏感文件按文件独立记忆

- **WHEN** 用户对 `~/.ssh/id_rsa` 授予"总是允许"
- **THEN** trusted.json 里存在 `path = "/Users/eliot/.ssh/id_rsa"` 的条目；`~/.ssh/known_hosts` 无对应条目

### Requirement: 会话级记忆在 session_start 清空

每次 `session_start` 事件时，会话级记忆 Map MUST 清空；持久化记忆 MUST 在此时（一次性）加载进内存以加速查询。

#### Scenario: session_start 清空会话级记忆

- **WHEN** 前一会话中用户做过多次"会话内允许"，新 session_start 触发
- **THEN** 会话级 Map 空，持久化 grants 从磁盘加载进内存

### Requirement: 未配置路径不写入持久化

若决策为 prompt 且 tier=two（未配置路径），"总是允许"选项 MUST 不出现在弹窗中；用户即使选择其他选项，也 MUST NOT 写入持久化通道。

#### Scenario: tier=two 弹窗不产生持久化写入

- **WHEN** 用户对未配置路径敏感文件选择"会话内允许"
- **THEN** 仅会话级记忆更新，trusted.json 无新条目

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

### Requirement: trusted.json 文件与目录权限

持久化记忆目录与 trusted.json 文件 MUST 以最小必要权限创建，防止同机其他用户 / 进程读取到用户对哪些路径做过持久化授权（该信息本身即敏感，暴露了用户的敏感文件清单与操作历史）。

具体约束：

- 首次创建 `~/.pi/agent/extensions/permission-guard-pi/` 父目录时，MUST 使用 `0o700` 权限（`fs.mkdir({ mode: 0o700, recursive: true })`）
- 每次 `atomicWrite` 落盘后，MUST 尝试将目标 `trusted.json` 文件权限收敛为 `0o600`——但仅当文件属主为当前进程用户时才执行 chmod；属主不匹配时 MUST 跳过 chmod 且不阻塞写入
- chmod 失败 MUST NOT 阻塞持久化授权写入；写入失败时的原有错误处理路径（session grant 降级）保持不变
- Windows 环境下 `fs.chmod` 是 no-op，本 requirement 在 Windows 上自动无操作

#### Scenario: 首次写入 trusted.json 时以 0o600 创建

- **WHEN** 用户对首次会话的持久化授权请求选择"总是允许"，trusted.json 不存在
- **THEN** trusted.json 被创建，`fs.stat(trustedJsonPath).mode & 0o777 === 0o600`

#### Scenario: 目录首次创建以 0o700

- **WHEN** 用户首次运行扩展，父目录 `~/.pi/agent/extensions/permission-guard-pi/` 不存在
- **THEN** 目录被递归创建，`fs.stat(parentDir).mode & 0o777 === 0o700`

#### Scenario: atomicWrite 后既有文件权限收敛到 0o600

- **WHEN** trusted.json 已存在且权限为 `0o644`，属主为当前用户，本次会话执行 `addPersistentGrant`
- **THEN** `fs.stat(trustedJsonPath).mode & 0o777 === 0o600`，文件内容完整更新为新 grants 数组

#### Scenario: 属主不匹配时跳过 chmod

- **WHEN** trusted.json 属主非当前用户（`stat.uid !== process.getuid()`）
- **THEN** 系统不执行 chmod，写入正常执行；不向用户报告错误

#### Scenario: chmod 失败不阻塞持久化写入

- **WHEN** `fs.chmod` 抛出异常
- **THEN** 写入正常完成；若写入本身成功则 grant 生效，若写入本身失败则按既有降级逻辑（session grant 替代）处理

### Requirement: Grant 记录 author 字段

持久化授权记录（`Grant` 与 `BashGrant`）MUST 支持可选字段 `author`，标识该条记录的授权来源：

- `"by_person"`：真人主动授权写入（当前唯一写入路径）
- `"presumed"`：系统/规则命中写入（当前无写入路径，类型能力保留）
- `"migration"`：迁移/导入路径写入（当前无写入路径，用于未来可信性存疑的批量迁移）

**语义约束**：
- `author` 字段是**写入时决定、读取时透传**的元数据——不改变 Grant 的键结构（`<projectHash> | <action> | <absPath>`）与匹配语义
- 决策引擎读取 Grant 时 MUST 使用 `author` 字段派生 `Decision.authorization`（见 access-decision spec 的"grant memory 命中带 by_person 授权" scenario）
- 撤销语义 MUST NOT 因 `author` 字段变化——`session_start` 清空、手动编辑 trusted.json 撤销的既有语义完全不变

#### Scenario: 真人弹窗选择"总是允许"时 Grant 记录 author

- **WHEN** 用户对某路径选"总是允许"，系统写入持久化 Grant
- **THEN** `trusted.json` 中新增的 Grant 条目包含 `author: "by_person"`

#### Scenario: 真人弹窗选择"总是允许"时 BashGrant 记录 author

- **WHEN** 用户对不可靠 bash 命令选"总是允许"，系统写入持久化 BashGrant
- **THEN** `trusted.json` 中新增的 bashGrants 条目包含 `author: "by_person"`

### Requirement: 存量 trusted.json 读取时迁移

系统 MUST 在加载既有 trusted.json（不含 `author` 字段的旧格式）时，把内存中每条 Grant / BashGrant 的 `author` 字段默认为 `"by_person"`——**不做磁盘写入**，只在内存视图上补齐。

**语义约束**：
- 迁移默认值 MUST 为 `"by_person"`，因为当前项目的持久化 grant **唯一写入路径是真人弹窗**（见 extension 层的 `handlePromptDecision` 中 `addPersistentGrant` 与 `addBashPersistentGrant` 调用点）
- 迁移 MUST 是**惰性**的：只在读取时补字段，不触发磁盘写入；下次持久化写入会自然带上新字段
- 若既有 Grant 已有 `author` 字段（新版本写入后再次读取），MUST 保留原值不覆盖

#### Scenario: 存量 trusted.json 无 author 字段加载

- **WHEN** 系统加载一份不含 `author` 字段的 trusted.json
- **THEN** 内存中每条 Grant / BashGrant 的 `author === "by_person"`；`hasSessionGrant` / `hasPersistentGrant` / `hasBashSessionGrant` / `hasBashPersistentGrant` 查询行为不变

#### Scenario: 新版本 trusted.json 有 author 字段保留原值

- **WHEN** 系统加载一份含 `author: "by_person"` 的 trusted.json
- **THEN** 内存中 Grant / BashGrant 的 `author` 保留 `"by_person"`，不覆盖

#### Scenario: 迁移不触发磁盘写入

- **WHEN** 系统首次启动加载旧 trusted.json，但会话中不产生任何持久化授权写入
- **THEN** trusted.json 磁盘文件保持不变（不添加 `author` 字段）

#### Scenario: 首次持久化写入带上新字段

- **WHEN** 加载旧 trusted.json 后，用户在会话中选择"总是允许"
- **THEN** trusted.json 磁盘文件更新，新条目包含 `author: "by_person"`；既有旧条目保持不变（磁盘上仍无 `author` 字段，直到下次重写整个文件时才会带上）

### Requirement: 可赦免敏感路径外区持久化授权

soft sensitive 路径（见 `access-decision` spec 的"可赦免敏感路径分级与 tier 语义" requirement）的项目外持久化授权 SHALL 允许写入 `trusted.json`——override 本 spec "未配置路径不写入持久化" requirement 的 tier=two 限定。

**语义约束**：
- soft sensitive 项目外路径命中 tier=three（非 tier=two），用户选"总是允许"时 MUST 写入持久化 grant，键含完整路径（按文件粒度，与既有 sensitive 按文件记忆一致）；action 不限（读/写/delete 均可持久化，与既有 grant action-scoped 语义一致）。
- hard sensitive 项目外路径仍 tier=two（读与写均），"总是允许"选项不出现，不写入持久化（既有"未配置路径不写入持久化" requirement 不变）。
- 撤销语义不变：用户可编辑 `trusted.json` 删除 soft 持久化 grant，删除后该路径重新走 tier=three prompt。

**理由**：soft sensitive 含可撤销凭证（apikey/token），持久化赦免换首弹后免打扰；hard sensitive 含不可撤销私钥，仍不可持久化（既有硬底线不变）。

#### Scenario: soft sensitive 外区"总是允许"写入持久化

- **WHEN** 用户对项目外 `~/.config/gh/config.yml`（soft sensitive）选"总是允许"
- **THEN** `trusted.json` 写入 `{projectHash, action, path: resolvedPath, permission, author: "by_person", createdAt}`，后续同会话/跨会话同路径读 auto_allow

#### Scenario: soft sensitive 外区写持久化授权

- **WHEN** 用户对项目外 `~/.config/gh/config.yml`（soft sensitive）的写操作选"总是允许"
- **THEN** `trusted.json` 写入 `{projectHash, action: "write", path: resolvedPath, permission, author: "by_person", createdAt}`，后续同会话/跨会话同路径写 auto_allow（action-scoped，不影响读授权）

#### Scenario: soft sensitive 外区 delete 持久化授权

- **WHEN** 用户对项目外 `~/.config/gh/config.yml`（soft sensitive）的 delete 操作选"总是允许"
- **THEN** `trusted.json` 写入 `{projectHash, action: "delete", path: resolvedPath, permission, author: "by_person", createdAt}`，后续同会话/跨会话同路径 delete auto_allow（action-scoped，不影响读/写授权）
- **KNOWN BOUNDARY**：delete 持久化按**路径**粒度（`addPersistentGrant({action:"delete", path})`），一次批准后续同路径任意 `rm <该路径>` 形态全部静默；且 delete 与 read/write 不同——删除后的文件无法通过吊销 token 恢复。用户 2026-10-26 确认接受此边界，可编辑 `trusted.json` 撤销该 grant

#### Scenario: hard sensitive 外区仍不可持久化

- **WHEN** 用户对项目外 `~/.ssh/id_rsa`（hard sensitive）的 tier=two prompt 选"会话内允许"
- **THEN** 仅会话级记忆更新，`trusted.json` 无新条目（tier=two 不可持久化不变）

#### Scenario: hard sensitive 外区写仍不可持久化

- **WHEN** 用户对项目外 `~/.ssh/id_rsa`（hard sensitive）的写操作 tier=two prompt 选"会话内允许"
- **THEN** 仅会话级记忆更新，`trusted.json` 无新条目（hard 外区读写均不可持久化不变）

#### Scenario: soft 持久化 grant 撤销后重新弹窗

- **WHEN** 用户曾对 `~/.config/gh/config.yml` 选"总是允许"写入持久化，后编辑 `trusted.json` 删除该条目，再读该路径
- **THEN** 重新走 tier=three prompt（撤销语义与既有 grant 一致）

#### Scenario: soft sensitive 按文件记忆不抬开目录

- **WHEN** 用户对项目外 `~/.config/app/config.json` 选"总是允许"
- **THEN** 持久化 grant 仅对 `config.json` 生效，`~/.config/app/settings.json` 的读取仍需重新授权（按文件粒度，与既有 sensitive 按文件记忆一致）
