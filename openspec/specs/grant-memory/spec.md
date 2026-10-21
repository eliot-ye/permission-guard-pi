# grant-memory Specification

## Purpose
定义授权记忆的存储与查询契约——会话级（进程内、重启失效）与持久化（磁盘 trusted.json、跨会话生效）双通道，键含项目标识保证项目隔离。

## Requirements

### Requirement: 双通道记忆

系统 SHALL 维护两个独立的授权记忆通道：

- **会话级**：进程内存中的 Map，重启失效。任何弹窗的"会话内允许"选项写入此通道。
- **持久化**：磁盘 JSON 文件 `~/.pi/agent/extensions/@permission-guard/pi/trusted.json`。任何弹窗的"总是允许"选项写入此通道。

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

- `command_hash` 为 `rawCommand` 的 SHA‑256（16 进制小写，无分隔符），以将长命令摘要化
- `session_tag` 为与核心 grant 一样的 `sessionId`（或当前进程标识），以支持跨会话持久化
- `permission` 采用 `read_write` / `read_only`（不区分 `read`/`write`/`delete`，由 `extractBashTargets` 提供的 `ExtractResult.reason` 决定授权类型；具体规则见下文）
- `createdAt` 为 ISO‑8601 时间戳

**记存逻辑**：

1. 当用户在 tier=two 的 bash 命令 prompt 中选择**"允许一次"**或**"允许为本会话"**时，若其原始 `rawCommand` 对应一个不可靠检测（`extractBashTargets` 返回 `reliable: false, reason: X`），则写入该 Bash 命令记忆：
   - **"允许一次"** → 写入会话级 memory，仅放行本次调用
   - **"允许为本会话"** → 写入会话级 memory，并 auto‑allow 下次**相同** `rawCommand`（在同一 sessionId 内），重启后清除

2. 当用户在 tier=two 的 bash 命令 prompt 中选择**"总是允许"**时，写入持久化 memory 中的 Bash 命令 memory，并 auto‑allow 跨会话相同 `rawCommand`，弹窗 UI 须显示持久化文件路径（与 path‑level 持久化统一）

**查询逻辑**：

- 在 **extension 层**，当收到 bash 命令时，首先查询 **核心 path‑level 授权**（`hasGrant(projectHash, action, absPath)`），再查询 **Bash 命令授权**（`hasBashSessionGrant(projectHash, commandHash, sessionTag)` 和 `hasBashPersistentGrant(projectHash, commandHash)`）。任一授权命中即 auto‑allow 并**跳过决策引擎**，如常规授权那样记录 audit 日志。

**授权类型映射**：

- **基于命令不可靠类型的授权类型映射**
  - `reason: "glob_expansion"` 或 `reason: "unresolved variable: ..."` → 授权为 `read_only`
  - `reason: "control_flow"` 或 `reason: "shell_forwarder"` 或 `reason: "forwarding_command"` → 授权为 `read_write`（这类命令可能访问任意路径，属更高风险）
- **用户选择的权限**：如 tier=three prompt（权限声明路径）用户选择 `read_write` / `read_only` 时，Bash 命令授权使用该权限；如 tier=two prompt（无权限声明）则使用上文映射的授权类型

**审计日志字段扩展**：

- 新增 `grant_type` 字段，区分 `path` / `bash`
- Bash 类型日志中加入 `commandHash` 和 `reason`

#### Scenario: 会话内允许特定 bash 命令

- **WHEN** 用户看到 tier=two bash 命令 prompt（例如 `ls /tmp/*.log` 触发 glob_expansion），选择"允许为本会话"
- **THEN** 
  - 会话级 Bash 命令记忆中写入 `{projectHash, commandHash, sessionTag, permission: read_only, createdAt}`
  - 本次调用 auto‑allow，并记录 audit 日志 `event: "allow_session", grant_type: "bash"`
  - 下次相同 `rawCommand`（在同一 sessionId 内）直接 auto‑allow，不再走 tier=two prompt

#### Scenario: 总是允许 bash 命令

- **WHEN** 上场景中用户选择"总是允许"，同时 tier=two（无权限声明）则按上文 mapping 授权为 `read_only`
- **THEN**
  - 持久化 Bash 命令 memory 中写入 `{projectHash, commandHash, permission: read_only, createdAt}`
  - 会话级 memory 也写入（跨会话生效入口）
  - audit 日志含 `event: "allow_persistent", grant_type: "bash"` 和 `saved_to: <trusted.json 绝对路径>`
  - 下次任意 session 访问相同 `rawCommand` 均 auto‑allow

#### Scenario: 其他类型 bash 命令（控制流 + shell 转发器）授权为 read_write

- **WHEN** bash 命令为 `bash -c "rm -rf /etc/passwd"`，extractBashTargets 返回 `reason: "shell_forwarder"`
- **THEN** 用户选择"允许一次/会话/总是允许"时，Bash 命令授权的 permission 为 `read_write`（更严格），避免对这类高风险命令放行过多

#### Scenario: audit 日志区分 path vs bash 授权

- **WHEN** 用户授权一个路径 `/etc/passwd` 和一个 bash 命令 `cat /etc/passwd`，记录时日志中 `grant_type` 分别为 `path` / `bash`
- **THEN** 审计消费者可以区分用户对具体路径的授权与对具体命令的授权，便于安全分析

### Requirement: trusted.json 文件与目录权限

持久化记忆目录与 trusted.json 文件 MUST 以最小必要权限创建，防止同机其他用户 / 进程读取到用户对哪些路径做过持久化授权（该信息本身即敏感，暴露了用户的敏感文件清单与操作历史）。

具体约束：

- 首次创建 `~/.pi/agent/extensions/@permission-guard/pi/` 父目录时，MUST 使用 `0o700` 权限（`fs.mkdir({ mode: 0o700, recursive: true })`）
- 每次 `atomicWrite` 落盘后，MUST 尝试将目标 `trusted.json` 文件权限收敛为 `0o600`——但仅当文件属主为当前进程用户时才执行 chmod；属主不匹配时 MUST 跳过 chmod 且不阻塞写入
- chmod 失败 MUST NOT 阻塞持久化授权写入；写入失败时的原有错误处理路径（session grant 降级）保持不变
- Windows 环境下 `fs.chmod` 是 no-op，本 requirement 在 Windows 上自动无操作

#### Scenario: 首次写入 trusted.json 时以 0o600 创建

- **WHEN** 用户对首次会话的持久化授权请求选择"总是允许"，trusted.json 不存在
- **THEN** trusted.json 被创建，`fs.stat(trustedJsonPath).mode & 0o777 === 0o600`

#### Scenario: 目录首次创建以 0o700

- **WHEN** 用户首次运行扩展，父目录 `~/.pi/agent/extensions/@permission-guard/pi/` 不存在
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
