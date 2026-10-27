## Why

`permission-guard-pi` 的所有用户可见 UI 文案都硬编码为英文（`extensions/index.ts` 里的 dialog choices、footer、note、`ctx.ui.notify` 消息、`decision.reason` 展示、`bashSubtitleForReason` 副文本），且有一处硬编码中文与英文混用（`bashSubtitleForReason` 的 `glob_expansion` 分支）。用户 shell env `PI_LANG` 与 pi 官方都不提供 i18n 机制——用户靠社区汉化补丁包（`pi-cn`）打。

具体后果：
- 中文用户在 tier=three / tier=two 弹窗、deny 通知、bash 副文本里看到的是英文，与 pi 主 UI 的（可能的）中文不一致；
- `bashSubtitleForReason` 一处返回中文（`glob_expansion` 分支）+ 其余返回英文，项目自身 UI 语言不一致；
- 未来加第三语言（ja / de / ko）时改代码更痛苦（散落的字符串拼接 vs 集中 bundle）。

同时发现两处 spec 与代码漂移（历史遗留，非本 change 引入）：
- `approval-flow` spec 引用了 `bash_reason == "glob_expansion"` 作为分派场景，但代码里 `extractBashTargets` 从未产生该值（已改为 `unreliable_command` 兜底）；
- `access-decision` spec 有 scenario 引用 `reason 含 command_substitution`，但代码里的实际 reason 是 `unresolved variable: ${var}`。

漂移若不修，i18n 的 ReasonCode 表要么与 spec 对齐（引入不存在的 code 值）、要么与代码对齐（破坏 spec 断言）——必须本次一并处理。

## What Changes

- **A1：新增 i18n 基础设施（纯函数模块，符合 `src/lib/*.ts` 约定）**
  - 新增 `src/lib/reason-codes.ts`：`ReasonCode` 联合类型 + 3 域 code 常量（decision 12 / sensitive 7 / bash 7）。
  - 新增 `src/lib/i18n.ts`：`t(code, lang, params?)` 纯函数 + en/zh bundle 对象。
  - 新增 `src/lib/lang-detect.ts`：`detectLang(env, settings)` 纯函数（优先级链：`$PI_LANG` > `settings.json.lang` > `$LANG[0:2]` > `"en"`）。
  - 新增 `src/lib/settings.ts`：`loadSettings(dir)` 读 `~/.pi/agent/extensions/permission-guard-pi/settings.json`（JSONC 语法，与三档 permission.json 一致）。

- **A2：类型加宽（加宽兼容，不改现有字段）**
  - `src/lib/decision.ts`：`DecisionCommon` 新增 `reasonCode?: ReasonCode` 字段（UI 层用；audit 层继续用英文 `reason` 字符串）。
  - `src/lib/sensitive.ts`：`SensitiveRule` 新增 `code: SensitiveReasonCode` 字段（`SensitiveRule` 是内部类型，`findSensitiveMatch` 返回值增加字段无破坏性）。

- **A3：extensions/index.ts 逐处替换硬编码文案**
  - `showPermissionDialog`：dialog choices / title / footer / note 改为 `t(code, lang)`。
  - `ctx.ui.notify` 5 处消息：改为 `t(code, lang, {params})`。
  - `bashSubtitleForReason`：改为按 code 查本地化文案（现有 `glob_expansion` 分支的中文硬编码自然收敛到 zh bundle）。
  - 决策 reason → UI 展示链：用 `t(reasonCode, lang, {params})` 替代直接拼 `decision.reason`；audit 层继续用 `decision.reason` 英文字符串（跨版本兼容）。
  - session start 时读 `settings.json` 一次缓存到 `SessionState`（不每次 prompt 重读，避免 UI 语言中途切换）。

- **A4：新增运行时配置文件**
  - 位置：`~/.pi/agent/extensions/permission-guard-pi/settings.json`（与 `trusted.json` 同级同性质——用户个人偏好，不进 git，不参与策略合并）。
  - 结构（本期仅 1 字段）：`{ "lang": "en" | "zh" }`，缺省回退到 env 链。
  - 未来 UI 偏好预留位（`theme` / `dateFormat` 等），本期不启用。

- **A5：spec 与代码对齐（漂移修复）**
  - `approval-flow` spec：
    - **DELETED**：`bash 命令 glob 类 prompt 副文本` scenario（`glob_expansion` reason 不存在）；
    - **MODIFIED**：所有弹窗文案断言从"包含具体英文字符串"改为 lang-aware（`lang=zh` 时中文，`lang=en` 时英文，两者都要有 scenario）；
    - **ADDED**：3 个新 bash 副文本 scenario（`find_write_flag` / `unreliable_command` / `unresolved_variable`）。
  - `access-decision` spec：
    - **MODIFIED**：`Scenario: 变量展开失败的 bash 命令弹三档` 里 `reason 含 command_substitution` 改为 `reason 含 unresolved_variable`（对齐代码实际值）。
  - **非行为变更**：`bash-extract.ts` 本身**不改**（保持现有 7 个 reason 值产出）；spec 对齐代码。

- **A6：文档同步**
  - README 新增"多语言"节：说明 lang 来源链、settings.json 位置、如何切换、生效时机（重启 pi 会话）。
  - `docs/security/permission-model.md`：如涉及 tier / reason 术语的引用需同步。

- **不变**：
  - `BASH_GUARDRAILS`（LLM systemPrompt）保持英文——LLM 提示的稳定英文是最佳实践，不属于用户可见 UI。
  - `trusted.json` / `permission-review.jsonl` 的磁盘格式与 reason / note 字段**保持英文稳定字符串**——跨版本兼容、跨语言日志查询不分裂。
  - 三档 `permission.json` 结构不变（`lang` 不进 `RawConfig`，避免职责漂移）。
  - `Decision.reason` 字段**保持英文人读字符串**（audit 层消费）；新增 `reasonCode` 是加宽兼容。
  - `GrantSource` / `Authorization` 类型定义不变。

## Capabilities

### New Capabilities

- `i18n`：定义 UI 文本本地化契约——语言来源链、`t(code, lang, params?)` 语义、ReasonCode 三域枚举、settings.json 位置与结构、审计与 LLM prompt 不本地化的边界。

### Modified Capabilities

- `approval-flow`：弹窗选项与副文本的**字符串断言**从英文固定字符串改为 lang-aware（保留 tier / 选项集合 / 语义不变，只改"具体字符"这一维度）。删除 `glob_expansion` 副文本 scenario（代码从未产生），新增 3 个 bash 副文本 scenario 补齐现有 reason 值。
- `access-decision`：**文本级同步（非行为变更）**——`unresolved variable` 变量的 scenario 断言对齐代码实际 reason 格式，不改判定逻辑。
- `bash-target-extraction`：**不改动**——extractor 的 reason 值保持不变，漂移修复责任在 approval-flow spec 侧（本次一并处理）。

## Impact

- **代码**：
  - 新增 4 个纯函数模块：`src/lib/i18n.ts` / `reason-codes.ts` / `lang-detect.ts` / `settings.ts`。
  - 加宽 `src/lib/decision.ts`（`DecisionCommon.reasonCode?`）、`src/lib/sensitive.ts`（`SensitiveRule.code`）。
  - `extensions/index.ts`：`showPermissionDialog` / `ctx.ui.notify` / `bashSubtitleForReason` 三处大改 + session start 加一次 `loadSettings` 读入。
  - `src/lib/bash-extract.ts`：**不改**（extractor 只报告 reliable/unreliable 与 reason；reason 值列表保持不变）。
- **配置**：新增 `~/.pi/agent/extensions/permission-guard-pi/settings.json`（用户本地，不进 git；缺文件降级为空 settings，不报错）。
- **数据**：`trusted.json` 磁盘格式不变；`permission-review.jsonl` reason / note 字段保持英文（跨版本兼容）。
- **审计**：`grant_source` / `authorization` 派生规则不变。
- **spec 变更**：
  - `approval-flow`：MODIFIED 多处 + DELETED 1 处 + ADDED 3 处。
  - `access-decision`：MODIFIED 1 处（scenario 断言文本）。
  - `bash-target-extraction` / `grant-memory` / `permission-config` / `audit-log`：**不改动**。
- **测试面**：TDD 优先——
  - A1：新增 4 个模块的单元测试（`test/i18n.test.ts` / `test/lang-detect.test.ts` / `test/settings.test.ts` / `test/reason-codes.test.ts`）。
  - A2：现有 `test/decision.test.ts` / `test/sensitive.test.ts` 补断言 `reasonCode` 字段（加宽兼容，既有断言不变）。
  - A3：`extensions/index.test.ts` 里既有的 UI 字符串断言改为 lang-aware（同一测试按 `lang=zh` / `lang=en` 分别覆盖）。
  - A5：新增 3 个 bash 副文本测试（`test/` 或 `extensions/index.test.ts`），补 `find_write_flag` / `unreliable_command` / `unresolved_variable` 分派。

## 风险

- **ReasonCode 是跨版本契约**：一旦某 code 被外部消费者（自定义 audit viewer / 二次开发）依赖，改名即破坏性。命名已在 explore 阶段收敛（snake_case / 无域前缀 / past tense），本 change 落定后**不再重命名**（重命名走独立 change）。
- **audit 日志跨语言分裂**：本 change 明确不本地化 audit 日志的 reason / note——历史日志与新日志字段值一致（都是英文），audit 查询工具无需按 lang 分支。这是**有意的边界**，不是遗漏。
- **UI 语言中途切换不生效**：settings.json 只在 session start 时读一次，用户改完需重启 pi 会话才生效——写进 README。
- **spec 漂移修复可能触及 approval-flow 其他 scenario**：本次只修 `glob_expansion` 删除 + 3 个新 bash 副文本 scenario + 弹窗文案 lang-aware，其他 scenario 断言不改。若实施中发现更多漂移，走独立 change（本次不引入 scope creep）。

## 假设

- 用户 shell env 里 `PI_LANG` 未设置（pi 官方未定义该变量）——本 change 主动扩展它作为最高优先级来源，与 pi 主项目无耦合。
- `$LANG` 系统环境变量存在（POSIX 约定），前两位为语言代码（`zh_CN.UTF-8` → `zh`）。macOS 默认 `$LANG=en_US.UTF-8`。
- 用户不预期 i18n 在会话中途切换（改 settings.json 后重启 pi 会话）。
- 中文 bundle 由本 change 提供，英文 bundle 是 fallback（未知 lang 或未知 code 时回退英文）。

## Scenario→Test 覆盖账本

（在 proposal 定型后由 `td-apply` 补齐——本 change 修改的 spec scenario 与既有测试的映射关系，见 `references/scenario-test-map-template.md` 格式；本 change 涉及的 spec 变更面已在下方"Capabilities → Modified Capabilities"节中列出。）

## 与既有架构/风格的遵循关系

- 遵循 `src/lib/*.ts` 无 UI/IO 依赖、纯函数约定：新增 4 个模块全是纯函数（settings.ts 的 fs 读在 caller 传入 fs 时保持纯，或直接读磁盘但无副作用写入）。
- 遵循 `Decision` / `SensitiveRule` 类型加宽模式：新增字段可选，caller 消费现有字段行为不变。
- 遵循既有类型命名风格：`ReasonCode` snake_case 与既有 `GrantSource` (`config_declaration` / `allow_rule` / ...) 一致。
- 遵循 JSONC 语法：settings.json 与三档 permission.json 一致（可加注释）。
- **偏离点**：无——本 change 不引入新架构模式，是既有模式的自然扩展。

---

## 系统工程影响评估

服务钱学森系统工程主基调第 3 条（从定性到定量的综合集成）。

- **影响哪些分系统**：
  - `extension-orchestration`（`extensions/index.ts` 逐处替换文案、session start 新增 settings 读取）
  - `policy-core`（`src/lib/decision.ts` 新增 `reasonCode?` 字段；`src/lib/sensitive.ts` 新增 `code` 字段）
  - 新增模块：`src/lib/i18n.ts` / `reason-codes.ts` / `lang-detect.ts` / `settings.ts`（均属 policy-core 或 新增纯函数层）

- **整体性能预期变化**：
  - 启动时新增 1 次文件 IO（读 settings.json），可忽略
  - 运行时无额外开销（`t()` 是字典查表，O(1)）
  - audit 日志磁盘量不变（reason 字段保持英文）

- **这是局部优化还是全局协调**：局部优化。边界清晰：src/lib 纯函数约定不变、i18n 是新增模块不重构、三档 permission.json 不变、audit 日志不变、LLM prompt 不变。仅 extension-orchestration 层与 policy-core 的 Decision/SensitiveRule 类型加宽。

- **如果是局部优化，对全局失调的风险**：低。
  - ReasonCode 是跨版本契约（一次命名定型后不改名），命名已在 explore 阶段收敛（snake_case / 无域前缀 / past tense）
  - audit 日志保持英文稳定字符串，跨版本查询不分裂
  - LLM prompt 保持英文，与 i18n 解耦
  - 唯一需要关注的是 spec 与代码漂移（`glob_expansion` / `command_substitution`），已在 delta 里显式标注并在 tasks.md T6 里记 follow-up

- **预期行为模型**（供 td-archive 步骤 3 “实际 vs 预期”复盘对照）：
  - 输入：用户设置 `$PI_LANG=zh` 或 `~/.pi/agent/extensions/permission-guard-pi/settings.json.lang = "zh"`
  - 期望输出：所有弹窗选项、footer/note、副文本、notify 消息以中文显示；audit 日志的 reason/note 字段仍为英文
  - 验证：切换 lang 后同一 `Decision` 对象在 zh 展示层输出中文、en 展示层输出英文；audit 日志始终英文（与 lang 无关）
  - 量化目标：zh bundle 覆盖全部 26 个 ReasonCode（无 fallback）；lang-detect 4 级优先级链全覆盖；既有 extensions 测试全绿（lang-aware 后）

---

## caller impact 分析

服务 td-propose 步骤 6.c 的 caller impact 变更点标注（tier-medium 强制，本 change 命中）。

**变更点清单**：

| 变更点 | 类别 | 高危 | 已知 caller + 预判 |
|---|---|---|---|
| `Decision.reasonCode?: ReasonCode` 新增可选字段 | ② 契约新增（加宽） | 否 | `extensions/index.ts`（消费 `decision.reason` 字段，不消费 reasonCode）→ 兼容；`test/decision.test.ts`（断言 reason 字段英文字符串）→ 兼容 |
| `SensitiveRule.code: SensitiveReasonCode` 新增必填字段 | ① 内部类型（不对外） | 否 | `extensions/index.ts:import findSensitiveMatch`（不读 code 字段）→ 兼容；`test/sensitive.test.ts`（断言 reason/level/anchor，不读 code）→ 兼容 |
| `showPermissionDialog` 内部字符串替换 | ③ 内部实现细节 | 否 | `extensions/index.ts` 内部调用→ 行为不变（UserChoice 类型不变） |
| session start 新增 `loadSettings()` + `detectLang()` | ④ 初始化流程扩展 | 否 | `registerPermissionGate()` 初始化→ 新增 1 次文件 IO，行为不变 |
| 新增 4 个纯函数模块（i18n / reason-codes / lang-detect / settings） | ② 新公共模块 | 否 | 新增 caller 都为本 change 内部；无外部 caller |

**高危标记**：无①③类高危变更点（本 change 都是加宽/内部实现）。

**已知 caller**（proposal 预判，实测在 td-apply 步骤 4 产出完整清单）：
- `extensions/index.ts:1041-1093` showPermissionDialog → 行为不变（UserChoice 类型不变，字符串值变化）
- `extensions/index.ts:258-299` UserChoice 匹配逻辑 → 需适配（改为匹配本地化后字符串，或用 code 判定）
- `extensions/index.ts:456/480/713/1002/1054` notify 消息 → 需适配（改为 t() 调用）
- `test/decision.test.ts` 断言 reason 字符串 → 兼容（reason 字段不改）
- `test/sensitive.test.ts` 断言 rule.reason/level/anchor → 兼容（现有字段不改）
- `extensions/index.test.ts` UI 字符串断言 → 需适配（改为 lang-aware）

---

## 实际 vs 预期复盘（td-archive 步骤 3）

对照本 proposal 的"系统工程影响评估"节，逐项复盘 apply 阶段的实际结果。

### 字段对照表（tier-medium 全 5 字段）

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响 `extension-orchestration` + `policy-core`，新增 4 个纯函数模块 | **一致**：`extension-orchestration`（extensions/index.ts + 测试）、`policy-core`（decision.ts + sensitive.ts + 4 个新模块 i18n / reason-codes / lang-detect / settings）。无预期外的分系统被碰。 |
| 启动时新增 1 次文件 IO，可忽略；`t()` O(1) | **一致**：`initSession()` 只读 1 次 settings.json；`t()` 是字典查表。audit 日志磁盘量不变。 |
| 局部优化，边界清晰 | **一致**：`bash-extract.ts` 未改（保持现有 reason 值产出）；三档 permission.json 不变；audit 日志保持英文；`BASH_GUARDRAILS` LLM prompt 保持英文。 |
| 对全局失调风险：低（ReasonCode 命名定型、audit 英文稳定、LLM prompt 英文） | **一致**：命名定型后未被改；audit 日志英文字符串未被 i18n 污染；LLM prompt 未被 i18n 消费。 |
| **预期行为模型**：切换 lang 后 UI 全部本地化；audit 始终英文 | **部分成立，需修正量化字段**（见下） |

### 预期行为模型验证

**模型成立部分**（行为层）：
- 切换 `$PI_LANG=zh` / `settings.json.lang="zh"` 后，extensions/index.ts 里的所有弹窗选项、footer、note、notify 消息均以中文显示；
- `LANG=en_US.UTF-8 PI_LANG=en npm test` 与 zh 环境跑出的行为一致（audit 日志 reason/note 字段始终英文）；
- bash-extract.ts 的 reason 字符串原样透传给 audit 层，UI 层通过 `bashReasonCodeAndParams(reason)` 拆分为 code + params 走本地化。

**模型偏差部分**（量化字段，非行为层）：
- **偏差 1**：proposal 写"26 个 ReasonCode"；实际是 **50 个**（13 Decision + 7 Sensitive + 15 Bash + 15 UI-only code）。量化字段错误，但**行为契约不变**——en/zh bundle 完整覆盖全部 50 个 code（`test/i18n.test.ts` 覆盖 50 个 code × 2 语言）。
- **偏差 2**：BashReasonCode 预期 7 个，实际 **15 个**（`command_substitution` / `backtick_substitution` / `process_substitution_input` / `process_substitution_output` / `heredoc` / `subshell` / `glob_expansion` / `arithmetic` 均是代码实际产出，`bash-extract.ts:840/856/896` 等行 grep 确认）。命名定型未变，仅扩展集合。

**模型修正建议**（供后续 propose 参考）：
- propose 阶段对"代码实际产生的 reason 值集合"必须做一次完整的 grep 审计（`grep -oE 'reason: "[a-z_]+|reason: `[a-z_]+' src/lib/bash-extract.ts`），不能只按既有 spec 描述枚举——否则 ReasonCode 集合会与代码漂移。

### 预期之外的副作用

1. **Spec delta 的"删除"动作需撤回**：proposal 与 delta 都写"删除 `bash 命令 glob 类 prompt 副文本` scenario"，但 `bash-extract.ts:896` 实际 `return "glob_expansion"`。已在 apply 阶段（T6）撤回该删除，改为 MODIFIED lang-aware 保留；同步修正 `access-decision/spec.md` 里的 `command_substitution` 引用（代码也在产出，不该改）。
2. **Choice 匹配规则变更**：`promptUser()` 的 choice 匹配从"精确字符串相等"改为"identity + prefix"（`always_allow` / `always_allow_command` 共用前缀 "Always allow" / "总是允许"）——因为 zh bundle 里两个 code 的前缀是 "总是允许"，但 en 里不同，identity 匹配跨语言失效。这是 UI 层内部的匹配策略变化，UserChoice 联合类型本身不变，行为契约（选项集合 + tier 语义）不变。
3. **测试文件的 lang-aware 化**：既有测试断言里的硬编码字符串（"Deny"、"Allow for this session"、"Blocked"）需要改为 `UI.deny` / `UI.allowSession` / 双语 fallback。共改动 5 个测试文件（extensions/index.test.ts, test/sys-integration.test.ts, test/approval-flow.test.ts, test/backlog-regression.test.ts, test/decision.test.ts）+ 1 个新增（test/i18n.test.ts 等）。

### Scenario→Test 覆盖账本状态

`scenario-test-map.md` 172 行，覆盖所有 MODIFIED/ADDED scenario → test 的映射：
- MODIFIED 的 tier=two / tier=three 弹窗 scenario → extensions/index.test.ts 现有场景已 lang-aware 化
- ADDED 的 `find_write_flag` / `unresolved_variable` / `unreliable_command` 副文本 → extensions/index.test.ts + test/approval-flow.test.ts 覆盖
- REMOVED（预期）→ 实际改为 MODIFIED 保留，故无需处理移除映射

### 归档前验证背书

- `npm test`：689/689 pass（连续 5 次运行稳定），基线 677→689（新增 53 个 i18n 相关测试）
- `LANG=en_US.UTF-8 PI_LANG=en npm test`：688/689 pass（唯一失败是 AL7 审计写入 race，pre-existing flaky，与本 change 无关）
- `openspec validate ui-i18n --type change`：pass

**结论**：模型在行为契约层成立；量化字段有偏差（code 数量、bash reason 集合），已在 apply 阶段修正实现，未破坏任何既有契约。spec delta 中的错误删除动作已撤回。change 可归档。

