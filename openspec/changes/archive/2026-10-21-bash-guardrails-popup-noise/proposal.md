## Why

当前 `BASH_GUARDRAILS`（`extensions/index.ts:320-361`）是 9 条英文 bullet，措辞统一是"will prompt"、"will always prompt"、"trigger a prompt"——只说"这些命令会弹窗"，不说"弹窗是噪音"，也不显式告诉 LLM"决策引擎其实有一套硬规则会自动放行大多数静态命令"。结果是 LLM 只能被动地"避坑"（碰到陷阱才知道），而不是主动选择静默路径。

同时，正向引导（prefer read/grep/find）分散在 7 条陷阱 bullet 的尾缀里，位置靠后、结构不突出，LLM 读到第 8 条时才会看到"改用 grep/find"的建议，实际优先级被陷阱条款稀释。

**目标**：改提示词，让 LLM 明确理解"弹窗是噪音，要主动避开"，从"避免陷阱"升级为"主动选静默路径"。

**边界**：只改提示词（`BASH_GUARDRAILS` 数组 + README 同步）。不动硬规则（`src/lib/bash-extract.ts`）、不动弹窗结构（tier 两档/三档不变）、不动审批副文本（`bashSubtitleForReason` 与 spec `approval-flow` 分派 scenario 不动）、不动记忆渠道与授权语义。硬规则永远生效，提示词只影响 LLM 的主动选择倾向。

## What Changes

- **`BASH_GUARDRAILS` 数组重构为三层结构**（`extensions/index.ts:320-361`），从当前 9 条陷阱罗列（2729 字符 / 约 682–780 token）重构为：
  - **Layer 1（决策层）**：1 条元说明——"权限扩展有硬规则自动放行大多数静态命令，其余弹窗打断用户，请尽量 minimize prompts"。这是显式告诉 LLM"弹窗=噪音、静默=好"的动机说明，原稿没有。
  - **Layer 2（静默工具清单）**：约 8 条正向引导——`read`（含 offset/limit 用法）、`grep`（含"能匹配 markdown `- [ ]` 不需转义"的示例）、`find`，以及 git/test/dev-tool 的**只读形式**清单（`git status/diff/log/show`、`npm test/check`、`cargo check/test`、`tsc --noEmit`、`go vet/test`、`rg`/`jq`）、以及"项目内只读 glob 是 auto-allowed"的边界说明。
  - **Layer 3（弹窗陷阱清单）**：约 8 条陷阱，每条用 `→` 明确接一个替代方案——forwarder / substitution / control-flow / unquoted glob / shell forwarder / interpreter & remote / 非只读 dev-tool / **敏感系统路径**（`/etc`、`~/.ssh`、`~/.aws` 等）。
- **总长预算**：≤1K token。基线 9 条 2729 字符 ≈ 682–780 token；草稿 18 条 2397 字符 ≈ 599–685 token，低于基线（因 Layer 2 正向清单浓缩了原本散在陷阱条尾的"prefer grep/find"尾缀）。实际落盘字符数以最终文案为准。
- **`README.md` "Prompt guardrails" 小节同步**（`README.md:233-271`）：更新 bullet 引用为新的三层结构，并在"How it works"节里补充"Layer 1/2/3 的组织意图"说明。
- **保守列名**：Layer 2 只点名 `read`/`grep`/`find` 三个非-bash 工具，不点名 `edit_file`/`write_file`/`glob` 等（避免假设 pi 的具体工具名与实际不符，且节省 token）。

**不改**：
- `BASH_GUARDRAILS` 的**注入机制**：仍走 `installPromptGuardrails(pi)` 在 `before_agent_start` 时通过 `systemPromptOptions.promptGuidelines` 修改，去重逻辑（exact-match dedupe）不变，try/catch fail-safe 不变
- `approval-flow` spec 与所有弹窗副文本（`bashSubtitleForReason` / tier 两档/三档选项结构 / deny_hard 红色通知）
- `src/lib/bash-extract.ts`（决策层）
- `src/lib/trust.ts` / `src/lib/audit.ts`（记忆与审计）
- `extensions/index.test.ts:779-784` 的 PF1 关键词断言（`/bash/` `/pipe/` `/glob/` `/grep|find/`）——新稿全部命中，无需修改测试断言

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。（`skip_specs: true`——见 `.openspec.yaml`；本次改动不触及任何 spec requirement，仅重构 `BASH_GUARDRAILS` 常量数组的字符串内容，属于提示词软引导层的措辞调整，不改变任何公共契约或硬规则行为。）

## Impact

- **代码文件**：
  - `extensions/index.ts`：`BASH_GUARDRAILS` 常量数组（原 9 条 → 新 18 条），字面量字符串替换，其他代码零改动
- **文档文件**：
  - `README.md:233-271`：Prompt guardrails 小节的 bullet 引用与"How it works"说明同步
- **测试文件**：
  - `extensions/index.test.ts`：`PF1: before_agent_start_appends_bash_guardrails_to_promptGuidelines` 断言（关键词覆盖 `/bash/` `/pipe/` `/glob/` `/grep|find/`、幂等、既有 guidelines 保留、malformed event fail-safe）应全部保持通过——新稿的 Layer 1 提到 `bash`，Layer 3 提到 `pipeline`/`xargs`（匹配 `pipe`），Layer 3 提到 `glob`，Layer 2 提到 `grep` 与 `find`，四条断言全覆盖
- **不影响**：
  - `src/lib/bash-extract.ts` 的所有硬规则、`SILENT_COMMANDS` / `UNRELIABLE_COMMANDS` / `COMMAND_TABLE`、`sensitive.ts`
  - `approval-flow` spec 与所有弹窗 UI / 副文本
  - `src/lib/trust.ts` / `src/lib/audit.ts` 与 grant memory 语义
  - `~/.pi/agent/extensions/@permission-system:pi-extension/` 的运行时数据
  - `systemPromptOptions.promptGuidelines` 的注入机制（in-place mutation、dedupe、try/catch 均不变）
  - 其他扩展注入的 `promptGuidelines` 条目（既有 dedupe 逻辑保留）
- **运行时行为变化**：无。LLM 提示词变化后 LLM 的命令选择倾向可能变化，但决策引擎、弹窗触发、记忆写入、审计日志的**代码路径完全不变**

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"）

- **影响哪些分系统**：
  - `extension-orchestration`（tier-small）：仅 `BASH_GUARDRAILS` 常量数组的字面量字符串内容变化，注入机制（`installPromptGuardrails` / `before_agent_start` handler / `systemPromptOptions.promptGuidelines` in-place mutation / dedupe / try-catch fail-safe）完全不变
  - 分系统边界**未变**，无新增模块、无新增公共符号、无跨分系统依赖新增
- **整体性能预期变化**：
  - **代码层面**：无。字符串替换不改变运行时代码路径，`installPromptGuardrails` 调用开销与去重逻辑 O(n) 遍历行为完全不变
  - **用户体验层面**：LLM 在提示词引导下更倾向选择静默工具路径（Layer 2），减少触发硬规则弹窗的概率。这是**软引导**，效果取决于模型遵循度，无法保证。可观测指标：单会话审计日志中 `event=prompt` 的计数从基线水平下降（具体下降幅度受 LLM 遵循度影响，无精确百分比预期）
- **这是局部优化还是全局协调**：**局部优化**（1 个分系统内 1 个常量数组的字符串内容替换，不牵动决策引擎、弹窗结构、记忆语义、审计字段、配置契约）。不触发 td-propose 的公共契约变更审查路径
- **如果是局部优化，对全局失调的风险**：**低风险**。
  - **风险 1**：prompt 变长或变短后，LLM 对其他扩展注入的 `promptGuidelines` 条目的关注权重下降。缓解：既有 `dedupe` 保留其他扩展条目；不重复 dispatch；prompt 长度控制在 ≤1K token（草稿约 685 token，比基线还省）
  - **风险 2**：Layer 3 新增"敏感系统路径"条（`/etc`、`~/.ssh`、`~/.aws`）超出 `BASH_GUARDRAILS` 的"bash 命令"名义范围，可能与 `sensitive.ts` 的实际清单不完全对应。缓解：本条只是"提示 LLM 不要主动碰"，不改变 `sensitive.ts` 的实际判定；敏感路径的授权决策与副文本仍由 `decision.ts` / `sensitive.ts` 与 `approval-flow` spec 的 `sensitive_default` scenario 决定，本 change 不触碰
  - **风险 3**：Layer 2 提到 pi 的 `read`/`grep`/`find` 工具，若 pi 的 tool 名字实际不同（例如 `read_file`、`search`、`list_files`），提示词会与真实工具名不匹配。缓解：保守策略——只点 pi-coding-agent 文档明确使用的 `read`/`grep`/`find` 三个通用短名（与 README 里既有引用一致）；不点名 `edit_file`/`write_file`/`glob` 等（d1=B 决策）
- **预期行为模型**（四判据：可测量 / 技术无关 / 用户视角 / 可验证）：
  - **可测量**：
    - `BASH_GUARDRAILS.length` 从 9 变为 18
    - `BASH_GUARDRAILS.join("\n\n").length` ≤ 2500 字符（草稿 2397 字符）
    - token 估算 ≤ 1000（草稿 599–685，按 len/4 到 len/3.5）
    - 新增关键词覆盖：Layer 1 含 "Minimize prompts"；Layer 2 含 "Prefer dedicated tools" 与 "auto-allowed"；Layer 3 每条以 `→` 结尾并含替代方案指引；Layer 3 含 "Sensitive system paths"
  - **技术无关**：LLM 在提示词引导下，日常执行时更倾向选择 `read`/`grep`/`find` 与 git/test/dev-tool 的只读形式，而不是 shell forwarder / heredoc / control-flow / unquoted glob 等弹窗陷阱
  - **用户视角**：单个工作会话内，弹窗发生的次数比改动前减少（具体数字取决于 LLM 遵循度，无严格 SLA）；弹窗仍按硬规则正确触发（不因提示词变长而漏放或误放）
  - **可验证**：
    - PF1 测试（`extensions/index.test.ts:740-820`）全绿：新稿关键词覆盖 `/bash/` `/pipe/` `/glob/` `/grep|find/` 四条断言
    - 幂等性：`installPromptGuardrails` 二次 dispatch 时 `promptGuidelines.length` 不增长
    - 其他扩展条目保留：既有 `promptGuidelines` 中的字符串不被过滤
    - Fail-safe：malformed event（undefined/null/空对象/`systemPromptOptions: null`）不抛异常
    - Token 预算：`node -e '…'` 一次性量测新稿字符数与 token 估算，断言 ≤1K token
- **与既有架构/风格的遵循关系**：
  - **遵循**：`BASH_GUARDRAILS` 仍是模块顶部常量、类型 `string[]`；`installPromptGuardrails` 函数签名与实现不变；仍通过 `systemPromptOptions.promptGuidelines` in-place 修改注入；既有 dedupe 与 try/catch fail-safe 机制不变
  - **未偏离**：无新分系统、无新依赖、无新公共符号、无装配点变化；分层边界（`src/lib/*.ts` 纯函数 vs `extensions/index.ts` 集成层）不变

## 假设

- `pi-coding-agent` 的 `systemPromptOptions.promptGuidelines` 数组是稳定接口，其他扩展（如有）注入的条目会通过本扩展的 dedupe 逻辑保留（现有实现已保证）
- 提示词是软引导，LLM 是否遵循取决于模型上下文与训练——本 change 只优化"引导质量"，不承诺"LLM 一定不弹窗"
- pi 的 `read`/`grep`/`find` 三个工具名在当前 pi-coding-agent 版本中可用且命名稳定（README 与既有 guardrails 引用一致）
- `BASH_GUARDRAILS` 的现有 9 条 bullet 中提到的所有陷阱类别（forwarder / substitution / glob / control-flow / shell forwarder / interpreter / dev-tool 非只读）在新稿 Layer 3 中都得到覆盖——本 change 不减少任何陷阱类别，只重组结构与措辞
- 敏感系统路径条目（Layer 3 最后一条）是新增的**提醒性**内容，不改变 `sensitive.ts` 的实际路径清单或授权判定；`approval-flow` spec 的 `sensitive_default` 副文本 scenario 保持不变

## 实际系统工程影响 vs 预期（archive 复盘，2026-10-21）

对照源 1（proposal「系统工程影响评估」节）逐项复盘；对照源 2（主 spec baseline）跳过——本 change `skip_specs: true`，无 spec delta，不存在"delta 是否破坏 baseline 契约"的对照面。

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统 | 仅 `extension-orchestration`（tier-small）：`BASH_GUARDRAILS` 常量数组字面量内容。实际改动面 = `extensions/index.ts` 常量 + `extensions/index.test.ts` 追加 3 条断言 + `README.md` 文档同步；分系统边界未变，注入机制、`src/lib/*`、公共符号零改动，与预期一致 |
| 整体性能预期变化 | 代码层：无变化（运行时代码路径零改动，与预期一致）。用户体验层（软引导减少弹窗）：预期"无精确百分比"，实际同样未量化——效果归入用户日常使用观察，不作为本 change 验收面（与预期一致） |
| 这是局部优化还是全局协调 | 预期"局部优化"，实际亦为局部优化：1 个分系统内 1 个常量数组的字符串替换 + 测试断言追加 + 文档同步，不牵动决策引擎、弹窗结构、记忆语义、审计字段、配置契约，未触发公共契约变更审查路径 |
| 如果是局部优化，对全局失调的风险 | 预期"低风险"（3 项风险 + 缓解），实际全部未兑现为问题：**风险 1**（对其他扩展 `promptGuidelines` 的注意权重）——既有 dedupe 保留其他条目，全量回归 520/520 无相关失败；**风险 2**（Layer 3 敏感路径与 `sensitive.ts` 清单不完全对应）——该条仅提醒性，`sensitive.ts` 实际判定与 `approval-flow` 的 `sensitive_default` scenario 未触碰；**风险 3**（pi 工具名不匹配）——保守策略落地（只点名 `read`/`grep`/`find`），无命名漂移。实际全局影响：无 |
| 预期行为模型 | **模型已验证**：12 项可测量字段全部 PASS——`length === 18`（actual 18）、`chars <= 2500`（actual 2409）、token 估算 602–688 ≤ 1000、L1 "Minimize prompts" / L2 "Prefer dedicated tools" + "auto-allowed" / L3 "Sensitive system paths" + `→` 五条关键词覆盖、PF1 四条正则（`/bash/` `/pipe/` `/glob/` `/grep|find/`）全部命中。唯一落盘偏差：字符数 2409（草稿预估 2397，+12 字符），仍在 2500 预算内，不构成模型偏差 |

**补充字段**：

- **预期之外的副作用**：AF7 测试（`allow_once_does_not_persist_to_memory`）在一次 `npm test` 运行中因临时目录清理报 `ENOTEMPTY: rmdir …/pi-ext-*/logs`——环境性 flake（临时目录竞态），重跑 520/520 全绿，与本 change 的字符串替换改动无关。作为 system-audit 的输入记录：测试 fixture 的临时目录清理存在竞态窗口，值得后续单独观察。
- **scenario→test 覆盖账本状态**：本 change 无 spec delta（`skip_specs: true`），未产出覆盖账本——无 `N/A` 条目问题。
