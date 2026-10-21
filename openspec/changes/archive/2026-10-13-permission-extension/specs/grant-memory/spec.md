## Purpose

定义授权记忆的存储与查询契约——会话级（进程内、重启失效）与持久化（磁盘 trusted.json、跨会话生效）双通道，键含项目标识保证项目隔离。

## ADDED Requirements

### Requirement: 双通道记忆

系统 SHALL 维护两个独立的授权记忆通道：

- **会话级**：进程内存中的 Map，重启失效。任何弹窗的"会话内允许"选项写入此通道。
- **持久化**：磁盘 JSON 文件 `~/.pi/agent/extensions/@permission-system:pi-extension/trusted.json`。任何弹窗的"总是允许"选项写入此通道。

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
