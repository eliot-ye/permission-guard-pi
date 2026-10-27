# approval-flow delta — ui-i18n

本 change 把 approval-flow spec 里"弹窗包含具体英文字符串"的断言改为 lang-aware（`lang=zh` 时中文，`lang=en` 时英文），并补齐代码实际产生但 spec 未覆盖的 3 个 bash 副文本 requirement + scenario（`find_write_flag` / `unresolved_variable` / `unreliable_command`）。

**非行为变更**：tier 分派、选项集合、语义均不变；只改"具体字符"这一维度。bash-extract.ts 本身不改。

**注**：apply 阶段发现，`glob_expansion` 和 `command_substitution` 都是代码实际产生的 reason 值（`bash-extract.ts` 第 840/856/896 行等），既有 spec 里的 `bash 命令 glob 类 prompt 副文本` scenario **无需删除**——本次 delta 保留该 scenario 并在 MODIFIED 块中标注为 lang-aware，由新增的 `bash 命令 unreliable_command 兜底类 prompt 副文本` requirement 补齐原 spec 未覆盖的兜底 reason。

## MODIFIED Requirements

### Requirement: 两档 vs 三档弹窗

系统 SHALL 根据决策引擎返回的 `tier` 字段选择弹窗形态：

- **tier=three**：三档选项——"允许一次 / 允许为本会话 / 总是允许"（或 lang 对应的本地化文案），加"拒绝"（或本地化）。适用场景：
  - 配置声明路径（`read_write` 外区、`read_only` 写、跨源冲突含 unread）
  - 未配置项目内敏感路径（任何 level）
  - 未配置项目外 soft sensitive（任何 action）
  - 未配置项目外 non-sensitive 写
  - **bash 命令无法静态解析**（unreliable bash）——第 3 档将 rawCommand 写入 bash 命令持久化记忆（trusted.json 的 `bashGrants` 段）
- **tier=two**：两档选项——"允许一次 / 允许为本会话"（或本地化），加"拒绝"（或本地化）。**不出现"总是允许"**。适用场景：
  - 未配置项目外 hard sensitive（外区读 / 写 / delete）
  - 网络外带写入（`/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+`）

弹窗选项的**具体字符串**按当前 lang（由 i18n 模块解析）动态生成；选项**集合**（4 个 / 3 个 / 2 个）与 tier 语义契约不变。

**删除**：本 change 移除原 spec 中"tier=two bash 命令类（含 `bash_reason` 字段）"作为 tier=two 变体的定义。bash 命令类 prompt 现统一归 tier=three，与其他"可持久化"弹窗归为一类。副文本分派规则保留（见下条 requirement），仍按 `bash_reason` 精确分派，但触发前提从"tier=two + bash_reason"更新为"tier=three + bash_reason"。

#### Scenario: 配置声明路径弹三档

- **WHEN** 决策为 prompt tier=three（配置为 read_write 的项目外路径首次访问）
- **THEN** 弹窗显示 4 个选项（lang=zh 时中文"允许本次调用" / "允许本会话" / "总是允许" / "拒绝"；lang=en 时 `Allow this call only` / `Allow for this session` / `Always allow` / `Deny`）

#### Scenario: 未配置路径弹两档

- **WHEN** 决策为 prompt tier=two（未配置路径，例如项目外 hard sensitive，如 `~/.ssh/id_rsa`）
- **THEN** 弹窗显示 3 个选项（lang=zh 时中文"允许本次调用" / "允许本会话" / "拒绝"；lang=en 时 `Allow this call only` / `Allow for this session` / `Deny`）

#### Scenario: bash 命令类 prompt 弹三档

- **WHEN** 决策为 prompt tier=three 且包含 `bash_reason` 字段（例如 `cat $SECRETS` 触发 `unresolved_variable`）
- **THEN** 弹窗显示 4 个选项（lang=zh 时中文；lang=en 时英文，第 3 档为"总是允许本命令"）；第 3 档将 rawCommand 持久化到 trusted.json 的 `bashGrants` 段

#### Scenario: 未配置项目外 hard sensitive 弹两档

- **WHEN** 决策为 prompt tier=two（未配置项目外 hard sensitive，如 `~/.ssh/id_rsa`）
- **THEN** 弹窗显示 3 个选项（同"未配置路径弹两档"，lang-aware）

#### Scenario: 未配置项目外 soft sensitive 弹三档

- **WHEN** 决策为 prompt tier=three（未配置项目外 soft sensitive，如 `~/.ssh/known_hosts` 或 `~/.config/app/config.json`）
- **THEN** 弹窗显示 4 个选项（lang=zh 时中文"允许本次调用" / "允许本会话" / "总是允许" / "拒绝"；lang=en 时英文，第 3 档为"总是允许"）

#### Scenario: bash 命令无法静态解析弹三档

- **WHEN** 决策为 prompt tier=three 且包含 `bash_reason` 字段（例如 `cat $SECRETS` 触发 `unresolved_variable`、`bash -c "..."` 触发 `shell_forwarder`）
- **THEN** 弹窗显示 4 个选项（lang=zh 时中文；lang=en 时英文，第 3 档为"总是允许本命令"）

### Requirement: 弹窗内容包含关键信息

弹窗文案 MUST 至少包含：

- 目标路径（或 bash 命令原文）
- 操作类型（读 / 写 / delete）
- 权限级别（若已配置）或"未配置"标记
- 若 tier=three：说明"总是允许将保存到 <trusted.json 绝对路径>"（或本地化）
- 若 tier=three bash 命令类（含 `bash_reason` 字段）：说明"总是允许本命令将保存到 <trusted.json 绝对路径>"（或本地化）

tier=two 的副文本 MUST 按决策来源分派，MUST NOT 使用统一文案：

- 外层 hard sensitive 路径（decision.declaration == "sensitive_default" 且 decision.tier == "two"）：提示"敏感系统路径不能持久化，如需长期允许请编辑 permission.json"（或本地化）
- 网络外带写入（decision 触发条件含 dev-socket 路径）：提示"网络外带路径不能持久化，每次写入都需确认"（或本地化）

tier=three bash 命令类 prompt（含 `bash_reason` 字段）的副文本 MUST 按 `bash_reason` 值动态生成（见下方细分 scenario），统一遵循：指出**为何无法通过静态解析**、**用户可如何避免重复弹窗**（选择"会话内允许"或"总是允许本命令"选项，或编写 permission.json glob）——副文本按 lang 本地化。

**语言来源**：副文本与选项的具体字符串由 i18n 模块的 `t(code, lang, params?)` 生成；`lang` 按 `$PI_LANG` > `settings.json.lang` > `$LANG[0:2]` > `"en"` 优先级链解析（详见 `i18n` capability）。

两条副文本 MUST 与 tier=three 的持久化提示互斥——非 bash 类 tier=two 不出现"总是允许将保存到 <trusted.json>"字样；bash 类 tier=three 的"总是允许本命令"选项的持久化说明只涉及 rawCommand，不涉及路径 glob。

#### Scenario: 三档弹窗显示保存位置

- **WHEN** 用户看到 tier=three 弹窗（配置声明路径）
- **THEN** 弹窗文案包含 lang=zh 时中文"总是允许"字样 + `~/.pi/agent/extensions/permission-guard-pi/trusted.json`；lang=en 时英文 `Always allow` 字样 + 同上路径

#### Scenario: 两档弹窗显示提示

- **WHEN** 用户看到 tier=two 弹窗（非 bash 类）
- **THEN** 弹窗副文本 MUST 按决策来源分派——不包含统一"未配置"字样；具体副文本见下方两个分派 scenario（lang-aware）

#### Scenario: 外层敏感路径弹窗副文本

- **WHEN** 用户看到 tier=two 弹窗，决策来源为"项目外 hard sensitive 路径 + 未配置"
- **THEN** 弹窗文案 lang=zh 时包含"敏感系统路径不能持久化"字样；lang=en 时包含英文 `Sensitive system path cannot be persisted` 字样；**不包含**"未配置路径"字样；**不包含**"总是允许将保存到"字样

#### Scenario: bash 命令无法静态解析弹窗副文本

- **WHEN** 用户看到 tier=three 弹窗，决策来源为"bash 命令不可靠"但缺少 `bash_reason` 字段（回归保护，理论上不应发生）
- **THEN** 弹窗文案回退到旧统一副文本（lang=zh 时中文"命令无法静态解析"字样；lang=en 时英文 `Could not reliably parse command` 字样）；**不包含**"permission.json"字样；**不包含**"总是允许将保存到"字样（因为无 rawCommand 持久化通道）

#### Scenario: 外层 hard sensitive 路径弹窗副文本

- **WHEN** 用户看到 tier=two 弹窗，decision.declaration == "sensitive_default" 且 decision.tier == "two"
- **THEN** 弹窗文案 lang=zh 时包含"敏感系统路径不能持久化"字样；lang=en 时包含英文 `Sensitive system path cannot be persisted` 字样

#### Scenario: bash 命令无法静态解析弹窗副文本（tier=three）

- **WHEN** 用户看到 tier=three 弹窗，bash 命令包含 bash_reason
- **THEN** 副文本按 bash_reason 值与当前 lang 分派（见下方细分 scenario），不再使用统一副文本

#### Scenario: bash 命令控制流类 prompt 副文本

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "control_flow"`（例如 `while read x; do cat $x; done`）
- **THEN** 弹窗副文本 lang=zh 时包含中文"该命令包含控制流关键字"字样 + "建议使用 grep/find 等工具替代 shell 循环" + "选择「允许本会话」可避免重复弹窗"；lang=en 时包含英文 `Control flow keywords (while/for/if)` 字样

#### Scenario: bash 命令 shell 转发器类 prompt 副文本

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "shell_forwarder"`（例如 `bash -c "rm -rf /"`）
- **THEN** 弹窗副文本 lang=zh 时包含中文"该命令通过 shell 转发器执行"字样 + "字符串内的文件系统访问不可见于静态分析"；lang=en 时包含英文 `Shell forwarder; nested command filesystem access is invisible` 字样

#### Scenario: bash 命令转发器类 prompt 副文本

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "forwarding_command"`（例如 `find /etc | xargs rm`）
- **THEN** 弹窗副文本 lang=zh 时包含中文"该命令使用转发器"字样 + "下游参数来自上游 stdout"；lang=en 时包含英文 `Forwarding command; downstream args come from upstream stdout` 字样

#### Scenario: bash 命令不可靠旧统一副文本已废弃

- **WHEN** 用户看到 tier=three 弹窗，决策来源为"bash 命令不可靠"（包含 `bash_reason` 字段）
- **THEN** **不再**使用统一副文本；改用上述细分副文本（lang-aware）

#### Scenario: bash 命令 glob 类 prompt 副文本

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "glob_expansion"`（例如 `ls /tmp/*.log`），当前 lang=zh
- **THEN** 弹窗副文本包含中文"未加引号的 glob 通配符"字样；**包含**"无法静态枚举目标文件"字样；**包含**"选择「允许本会话」"字样

#### Scenario: bash 命令 glob 类 prompt 副文本（lang=en）

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "glob_expansion"`，当前 lang=en
- **THEN** 弹窗副文本包含英文 `unquoted glob metachars (*, ?, [)` 字样

**注**：`glob_expansion` 是代码实际产生的 reason（`bash-extract.ts` 第 896 行，对应未加引号的 `*`/`?`/`[` 元字符）——本 scenario **保留**并转为 lang-aware，不是删除项。

### Requirement: cd cwd 变更命令弹窗副文本

当 bash 命令被判定为不可靠（`extractBashTargets` 返回 `reliable: false`）且 `bash_reason == "cd_chdir"` 时，弹窗副文本 MUST 按 lang 分派，说明"命令包含 `cd` 会改变后续命令的工作目录基准，相对路径无法静态确定"。

**理由**：`cd` 改变 cwd 基准，后续命令中所有相对路径（如 `.`、`a.txt`）的实际落点由运行时 cwd 决定，静态分析无法预测。用户看到此类弹窗时，副文本必须明确指出"这是 cd 引起的、建议用绝对路径或选择会话内允许"。

**位置**：本 requirement 与既有"bash 命令无法静态解析弹窗副文本"系列的 `control_flow` / `shell_forwarder` / `forwarding_command` 副文本 scenario 并列，不改变既有副文本。

**tier 前提更新**：bash 命令无法静态解析的弹窗档位从 tier=two 更新为 tier=three（本 change 全局修改），副文本分派规则本身不变。

#### Scenario: bash 命令 cd cwd 变更类 prompt 副文本

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "cd_chdir"`（例如 `cd /etc && rm -rf .`）
- **THEN** 弹窗副文本 lang=zh 时包含中文"该命令包含 cd 命令"字样 + "改变后续命令的工作目录基准" + "建议使用绝对路径或选择「允许本会话」避免重复弹窗"；lang=en 时包含英文 `Command contains cd; changes cwd baseline for subsequent commands` 字样

#### Scenario: cd cwd 变更类 prompt 与其他 bash 副文本互斥

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason` 为 `cd_chdir` / `control_flow` / `shell_forwarder` / `forwarding_command` / `find_write_flag` / `unresolved_variable` / `unreliable_command` 之一
- **THEN** 弹窗副文本按 `bash_reason` 精确分派，不使用统一文案，不与既有其他副文本重叠

## ADDED Requirements

### Requirement: bash 命令 find_write_flag 类 prompt 副文本

当 bash 命令被判定为不可靠（`extractBashTargets` 返回 `reliable: false`）且 `bash_reason == "find_write_flag"` 时，弹窗副文本 MUST 按 lang 分派，说明"命令含 find 的写入 flag（如 -delete / -exec），无法静态枚举目标文件"。

**位置**：本 requirement 与既有 `control_flow` / `shell_forwarder` / `forwarding_command` / `cd_chdir` 副文本 requirement 并列，属于 tier=three bash 命令类 prompt 的副文本分派规则。

#### Scenario: bash 命令 find_write_flag 类 prompt 副文本（lang=zh）

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "find_write_flag"`（例如 `find . -name '*.log' -delete`），当前 lang=zh
- **THEN** 弹窗副文本包含中文"find 命令含写入 flag"字样；**包含**"无法静态枚举目标文件"字样；**包含**"选择「允许本会话」可避免重复弹窗"字样

#### Scenario: bash 命令 find_write_flag 类 prompt 副文本（lang=en）

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "find_write_flag"`，当前 lang=en
- **THEN** 弹窗副文本包含英文 `find with write flag (-delete/-exec); cannot statically enumerate targets` 字样

### Requirement: bash 命令 unresolved_variable 类 prompt 副文本

当 bash 命令被判定为不可靠（`extractBashTargets` 返回 `reliable: false`）且 `bash_reason == "unresolved_variable"` 时，弹窗副文本 MUST 按 lang 分派，说明"命令含未解析的 shell 变量，无法静态确定实际访问的路径"。

**reason 字段格式**：代码里实际的 reason 字符串是 `unresolved variable: ${var_name}`（含变量名参数）；`ReasonCode` 层的 code 是 `unresolved_variable`（变量名走 `params`）。

#### Scenario: bash 命令 unresolved_variable 类 prompt 副文本（lang=zh）

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "unresolved_variable"`（例如 `cat $SECRETS`），当前 lang=zh
- **THEN** 弹窗副文本包含中文"命令含未解析的 shell 变量"字样；**包含**"变量 `SECRETS`"字样（变量名走 params 注入）；**包含**"选择「允许本会话」可避免重复弹窗"字样

#### Scenario: bash 命令 unresolved_variable 类 prompt 副文本（lang=en）

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "unresolved_variable"`（例如 `cat $SECRETS`），当前 lang=en
- **THEN** 弹窗副文本包含英文 `Unresolved shell variable: $SECRETS` 字样

### Requirement: bash 命令 unreliable_command 兜底类 prompt 副文本

当 bash 命令被判定为不可靠（`extractBashTargets` 返回 `reliable: false`）且 `bash_reason == "unreliable_command"` 时，弹窗副文本 MUST 按 lang 分派，说明"命令形态无法通过静态分析可靠提取访问目标，请审阅整条命令"。

**边界**：`unreliable_command` 是 extractor 的**兜底 reason**——当命令形态落入已知不可靠类别（不在既有 5 个 reason 精确分派里）时使用。UI 层不细分。

#### Scenario: bash 命令 unreliable_command 类 prompt 副文本（lang=zh）

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "unreliable_command"`（例如未分类的复杂命令），当前 lang=zh
- **THEN** 弹窗副文本包含中文"命令形态无法通过静态分析可靠提取访问目标"字样；**包含**"请审阅整条命令"字样

#### Scenario: bash 命令 unreliable_command 类 prompt 副文本（lang=en）

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "unreliable_command"`，当前 lang=en
- **THEN** 弹窗副文本包含英文 `Command form cannot be reliably extracted for static analysis; review the full command` 字样

## REMOVED Requirements

（无）——本 change 所有 scenario 都通过 MODIFIED（文本改为 lang-aware）或 ADDED（新增 find_write_flag / unresolved_variable / unreliable_command requirement）覆盖，无场景删除。原 spec 中的 `bash 命令 glob 类 prompt 副文本` scenario **保留**并在 MODIFIED 块中转为 lang-aware。
