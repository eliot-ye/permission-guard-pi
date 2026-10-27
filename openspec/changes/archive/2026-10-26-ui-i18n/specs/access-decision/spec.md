# access-decision delta — ui-i18n

本 change 修复 `access-decision` spec 里一处**文本级漂移**（非行为变更）：既有 scenario 引用 `reason 含 command_substitution` 和 `reason 含 unresolved variable`，但代码里 `extractBashTargets` 实际产生的 reason 值分别是 `command_substitution`（无变化）和 `unresolved variable: ${var_name}`（含变量名参数）。本 delta 把 spec 的 reason 值表述从人类可读的松散字符串改为 **ReasonCode code + params 分离** 的精确契约表述。

**非行为变更**：`decide()` 函数的判定逻辑、tier 分派、return 结构、`bash_reason` 的实际字符串均不变；只修 spec 的 scenario 断言文本以对齐代码实际输出，并让 spec 与 ReasonCode 契约（`src/lib/reason-codes.ts`）对齐。

## MODIFIED Requirements

### Requirement: 未配置路径的行为

系统 MUST 对目标路径未在任何配置中声明的情况按以下规则决策：

- **项目内敏感路径**（命中默认敏感规则）：读与写都 prompt，tier=three（可持久授权；用户显式声明覆盖）
- **项目内非敏感路径**：读与写都 auto_allow（保持 pi 现状行为）
- **项目外敏感路径**：读与写都 prompt，按 hard/soft sensitive 分级决定 tier——**hard sensitive**（不可逆凭证：SSH 私钥、私钥扩展名、凭证目录、凭证配置文件、系统机密）tier=two 不可持久化；**soft sensitive**（可撤销凭证 + 客户端公钥文件：见"可赦免敏感路径分级与 tier 语义" requirement）tier=three 可持久化
- **项目外非敏感路径读**：auto_allow
- **项目外非敏感路径写 / delete**：prompt，tier=three（可持久授权；hard sensitive 已在上一条锁定 tier=two）

#### Scenario: 未配置项目内普通文件写自动放行

- **WHEN** 无任何配置，工具写 `<proj>/src/main.ts`
- **THEN** auto_allow（保持 pi 现状）

#### Scenario: 未配置项目内敏感文件读弹三档

- **WHEN** 无配置，工具读 `<proj>/.ssh/id_rsa`（命中默认 hard sensitive）
- **THEN** prompt，tier=three（提供"总是允许"选项，用户显式声明可覆盖）

#### Scenario: 未配置项目外敏感文件读弹两档

- **WHEN** 无配置，工具读 `~/.ssh/id_rsa`（命中 hard sensitive SSH 密钥规则）
- **THEN** prompt，tier=two（不提供"总是允许"）

#### Scenario: 未配置项目外 non-sensitive 文件写弹三档

- **WHEN** 无配置，工具写 `/tmp/somefile.txt`
- **THEN** prompt，tier=three（提供"总是允许"选项，持久化到 trusted.json）

#### Scenario: 未配置项目外非敏感文件写弹三档

- **WHEN** 无配置，工具写 `/opt/shared/data.txt`（non-sensitive，未声明）
- **THEN** prompt，tier=three（提供"总是允许"选项，持久化到 trusted.json）

### Requirement: 未识别 bash 命令的目标路径

对 bash 工具调用，若 bash-target-extraction capability 无法可靠提取目标路径（复杂命令、变量、管道等），系统 SHALL 将其视为"未配置路径"，决策为 **prompt，tier=three**，弹窗显示完整命令原文。用户可三档选择："允许一次 / 允许为本会话 / 总是允许本命令"——第 3 档将 rawCommand 写入 bash 命令持久化记忆（trusted.json 的 `bashGrants` 段）。

**理由**：unreliable bash 命令的 rawCommand 作为**唯一身份**（同 rawCommand 即同语义），用户批准一次意味着"这条命令我认为安全"。持久化 rawCommand 提供"raw-command 通道"独立于 path 通道，与 sensitive-default tier=two 的"不持久化"契约无关——本 change 让 `tier` label 从"敏感语义标签"收敛为"可持久化 vs 不可持久化"标签，bash 命令类统一归 tier=three 与 tier 语义收敛一致。

**位置**：本规则在 access-decision 层实现，位于 bash-target-extraction 之后——extractor 只报告 reliable/unreliable 与 reason，不决定 tier。tier 分派发生在 `handleBash` unreliable 分支构造 `Decision` 时（tier="three"）。

**持久化边界**：rawCommand 持久化**不做规范化**——用户第一次批准 `ls -la /tmp`，之后 LLM 写 `ls  -la  /tmp`（多空格）视为不同 rawCommand，会重新弹窗。这是**保守但摩擦**的已知边界，见 grant-memory spec 的"Bash 命令记忆" requirement。

**`bash_reason` 字段契约**（本 change 新增）：`bash_reason` 值是 `extractBashTargets` 返回的 `reason` 字符串。UI 层通过 i18n 模块的 `bashReasonCodeAndParams(reason)` 辅助函数把它拆分为 `ReasonCode` code + `params`：
- 大多数 reason 值本身就是 snake_case code（如 `command_substitution`、`shell_forwarder`、`control_flow`、`cd_chdir`、`forwarding_command`、`find_write_flag`、`backtick_substitution`、`process_substitution_input`、`process_substitution_output`、`heredoc`、`subshell`、`glob_expansion`、`arithmetic`、`unreliable_command`）；
- `unresolved variable: ${var_name}` 是**唯一的参数化 reason**：code 为 `unresolved_variable`，变量名走 `params.var_name`；
- code 类型属于 `BashReasonCode` 联合（见 `src/lib/reason-codes.ts`），共 15 个 code。

#### Scenario: 无法解析的复杂 bash 命令

- **WHEN** bash 命令为 `$(cat $HOME/.ssh/id_rsa | base64) > /tmp/out.txt`
- **THEN** 若 bash-target-extraction 判定为不可靠（reliable=false，`bash_reason == "command_substitution"`），决策为 prompt，tier=three，弹窗展示完整命令文本与"总是允许本命令"选项

#### Scenario: 变量展开失败的 bash 命令弹三档

- **WHEN** bash 命令为 `cat $MYSECRETS`，`$MYSECRETS` 未在 shell 环境展开
- **THEN** 决策为 prompt，tier=three，`bash_reason == "unresolved variable: $MYSECRETS"`（code 为 `unresolved_variable`，变量名 `$MYSECRETS` 走 `params.var_name`，符合 snake_case ReasonCode 命名规范），弹窗提供"总是允许本命令"选项

**注**：原 spec 表述为"reason 含 `unresolved variable`"（人类可读的松散字符串），本 delta 同步 spec 与代码：明确 reason 的实际字符串形式为 `"unresolved variable: ${var_name}"`，并标注其对应的 `ReasonCode` code 为 `unresolved_variable`（不加冒号、不带变量名，snake_case 格式）——只改 `THEN` 里的 reason 字段值表述，判定逻辑、tier 分派、行为契约均不变。

#### Scenario: 用户"总是允许本命令"后同 rawCommand 跨会话免弹

- **WHEN** 用户对上一条 `cat $MYSECRETS` 选择"总是允许本命令"，重启 pi 后再次执行完全相同的 `cat $MYSECRETS`
- **THEN** auto_allow（bash grant memory 命中，`authorization === "by_person"`，`grant_source === "bash_grant_memory"`），audit 记录 `event: "allow_once"` 之外的 `grant_memory` 命中（无新 audit 事件，仅 grant_source 派生）

#### Scenario: rawCommand 规范化不生效

- **WHEN** 用户批准 `ls -la /tmp`，之后 LLM 执行 `ls  -la  /tmp`（额外空格）
- **THEN** 视为不同 rawCommand，重新弹窗（sha256(rawCommand) 哈希不同，grant memory 未命中）
