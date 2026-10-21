# grant-memory (delta)

## ADDED Requirements

### Requirement: bash-command grant 与 unread 的优先级

Bash 命令记忆（session 与 persistent 两个通道）MUST 保证：配置层显式声明为 `unread` 的路径，即使被 bash-command grant 覆盖，也 MUST 走 `deny_hard` 硬拒绝路径——不允许被 grant 覆盖。

**触发时机**：extension 层收到 bash 命令、`extractBashTargets` 返回 `reliable: false`（不可靠命令）、且 `state.trust.hasBashSessionGrant(projectHash, command)` 或 `state.trust.hasBashPersistentGrant(projectHash, command)` 命中时，MUST 先扫描命令字符串里可识别的裸路径 token 跑 `policy.resolve()` 检查，若任一 token 对应路径的 config 声明为 `unread`，则 MUST 走 `deny_hard` 硬拒绝路径，**不走** grant auto-allow。

**扫描规则**：
- 使用 `tokenize`（quote-aware）拆分命令字符串为 token 数组
- 对每个 token 调用 `looksLikePath` 判定是否像路径
- 命中则 `expandHome` + `toAbsolutePath` 规范化
- 调 `policy.resolve(absPath)` 检查 config 声明
- 任一 token 解析出的路径 config 声明为 `unread` → 走 `deny_hard`

**授权撤回语义**：本 requirement 明确 bash-command grant **不是** "覆盖所有配置"的强授权——`read_write` / `read_only` 声明的授权可被 grant 覆盖（沿用既有 `handlePromptDecision` 语义），但 `unread` 声明**永远优先于 grant**。这是"配置作为契约"的核心：unread 是配置层显式声明的硬拒绝，不能被"用户之前点过 Always allow"的授权覆盖。

**审计日志**：grant 被 unread 覆盖时 MUST 记录 `event: "hard_deny"`（沿用既有 audit log schema，不新增事件类型），`note` 字段 MUST 说明 "Bash command grant bypassed: unread hard-deny for <path>"，让审计消费者可以区分"用户拒绝"（`deny`）与"系统因 unread 硬拒绝"（`hard_deny`）。

**与既有"Bash 命令记忆渠道"requirement 的交互**：
- 既有 requirement 的"查询逻辑"（extension 层查询 path-level 授权和 Bash 命令授权）保持不变
- 本 requirement 补充的是"查询命中后仍要跑 unread 兜底检查"——这是对既有查询逻辑的**后置约束**，不是替代
- 既有 authorization type mapping（`reason` → permission）保持不变
- 既有 audit 日志字段（`grant_type: "bash"`、`commandHash`、`reason`）保持不变；本 requirement 只影响命中 unread 时的记录行为（多一条 `hard_deny` 而非 `auto_allow`）

**已知边界**（本 change 明确保留）：
- 只对"裸路径 token"生效——对 `bash -c "cat /etc/passwd"` 这类"路径嵌在字符串参数里"的形态**不生效**（tokenize 后 token 是 `cat /etc/passwd` 带空格，不是裸路径）
- 对 reliable 命令无影响——reliable 命令走既有 target 提取路径，本身会命中 unread 检查
- 对 tier=three 的 path-level prompt 无影响——用户选 "Allow for this session" 或 "Always allow" 后写入的 path-level grant 沿用既有 `decideTarget` 语义

**理由**：`access-decision` 分系统声明 unread 是"硬拒绝、不可覆盖"契约（见 `access-decision` spec.md 的 unread hard-deny requirement）。原实现在 `extensions/index.ts` L453-472 的 bash grant 命中分支直接 `return undefined`，跳过了所有 config 检查，导致 unread 被 bash-command grant 覆盖。这是"配置作为契约"原则的破坏——用户如果配了 unread，之后对该命令访问的路径添加 unread 声明，应该撤回该 bash 授权。

#### Scenario: bash persistent grant 命中 + 命令访问 unread 路径 → 硬拒绝

- **WHEN** 用户之前对 `bash -c "cat /etc/passwd"` 点过 "Always allow"（写入 persistent bash grant），之后配置 `{"/etc/passwd": "unread"}`，再次执行该命令
- **THEN**
  - 命令被 `deny_hard` 硬拒绝，命令不执行
  - persistent bash grant 存在但被 bypass，不生效
  - audit log 记录 `event: "hard_deny"`，`grant_type: "bash"`（若适用），`note: "Bash command grant bypassed: unread hard-deny for /etc/passwd"`

#### Scenario: bash session grant 命中 + 命令访问 unread 路径 → 硬拒绝

- **WHEN** 用户在同 session 内对 `bash -c "cat /etc/passwd"` 点过 "Allow for this session"（写入 session bash grant），之后配置 `{"/etc/passwd": "unread"}`，再次执行
- **THEN**
  - 命令被 `deny_hard` 硬拒绝，session grant 不生效
  - audit log 记录 `event: "hard_deny"`，`note` 说明 grant 被 bypass

#### Scenario: bash grant 命中 + 命令无 unread 路径 → grant 生效

- **WHEN** 用户之前对 `bash -c "cat /tmp/x.txt"` 点过 "Always allow"，且 `/tmp/x.txt` 未配置为 unread
- **THEN**
  - 命令 auto-allow（grant 生效）
  - audit log 记录 `event: "auto_allow"`，`grant_type: "bash"`（沿用既有语义）

#### Scenario: bash grant 命中 + 命令多路径部分 unread → 硬拒绝

- **WHEN** 用户之前对 `bash -c "cat /etc/passwd && echo ok"` 点过 "Always allow"，之后配置 `{"/etc/passwd": "unread"}`，再次执行
- **THEN**
  - 命令被 `deny_hard` 硬拒绝——任一裸路径 token 命中 unread 即触发
  - audit log 记录 `event: "hard_deny"`，`note` 含命中的路径

#### Scenario: bash grant 命中 + 路径在字符串参数内 → 不触发 unread 检查（已知边界）

- **WHEN** 用户之前对 `bash -c "cat /etc/passwd"` 点过 "Always allow"，之后配置 `{"/etc/passwd": "unread"}`，再次执行
- **THEN**
  - 命令 auto-allow（grant 生效）——`cat /etc/passwd` 是 bash 字符串参数的一部分，tokenize 后 token 是 `cat /etc/passwd` 带空格，不是裸路径，不触发 unread 检查
  - **这是 C5 的已知边界**——用户如果需要严格的 unread 覆盖，应该用 tier=two prompt（不能 "Always allow"），或不使用 bash-command persistent grant

#### Scenario: bash grant 命中 + read_write 声明的路径 → grant 生效（既有语义保留）

- **WHEN** 用户之前对 `bash -c "cat /etc/hosts"` 点过 "Always allow"，之后配置 `{"/etc/hosts": "read_write"}`，再次执行
- **THEN**
  - 命令 auto-allow（grant 生效）
  - 本 requirement 只覆盖 unread，`read_write` / `read_only` 声明的授权沿用既有"grant 覆盖 config"语义

#### Scenario: bash grant 命中 + read_only 声明的路径（尝试写操作）→ 硬拒绝

- **WHEN** 用户之前对 `bash -c "echo x > /etc/hosts"` 点过 "Always allow"，之后配置 `{"/etc/hosts": "read_only"}`，再次执行
- **THEN**
  - **本 scenario 属于本 requirement 的已知边界**：本 requirement 只对 `unread` 生效，`read_only` 声明下 bash-command grant 仍能覆盖。用户如果希望 `read_only` 也强制生效，需要用 tier=three 的 path-level prompt 授权（会尊重 read_only 限制）。
  - 命令 auto-allow（grant 生效，`read_only` 声明被 grant 覆盖）

#### Scenario: audit 日志区分 grant auto-allow 与 unread 硬拒绝

- **WHEN** 同一 session 内两次执行同一 bash 命令（`bash -c "cat /etc/passwd"`），第一次执行时 `/etc/passwd` 未配置为 unread，第二次执行前用户添加 `{"/etc/passwd": "unread"}`
- **THEN**
  - 第一次 audit log 记录 `event: "auto_allow"`，`grant_type: "bash"`
  - 第二次 audit log 记录 `event: "hard_deny"`，`note` 说明 grant 被 unread 覆盖
  - 审计消费者可以基于 event 类型区分"用户显式授权通过"vs"系统硬拒绝"
