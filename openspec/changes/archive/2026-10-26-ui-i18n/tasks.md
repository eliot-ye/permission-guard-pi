# ui-i18n Tasks

**关键链**：T1 → T2 → T3 → T4 → T5 → T6 → T7

**Project buffer**：约 10%（tier-medium brownfield 比例，含 spec delta 修复的意外工作量）

**验证命令**：`node --experimental-strip-types --test test/` + `node --experimental-strip-types --test extensions/index.test.ts`

---

## T1. 新增 src/lib/reason-codes.ts（RED → GREEN）

**动作**：
- 创建 `src/lib/reason-codes.ts`，导出：
  - `DecisionReasonCode` 联合类型（13 code）
  - `SensitiveReasonCode` 联合类型（7 code）
  - `BashReasonCode` 联合类型（7 code）
  - `ReasonCode = DecisionReasonCode | SensitiveReasonCode | BashReasonCode` 联合类型
- 3 域 code 表（snake_case / 无域前缀 / past tense）：
  - decision：`rule_denied`, `cross_source_unread_conflict`, `path_unread_hard_deny`, `path_read_only_read_allowed`, `path_read_only_action_needs_approval`, `path_read_write_inner_allowed`, `path_read_write_outside`, `rule_allowed`, `network_exfil_dev_socket`, `tmp_default_allowed`, `in_project_default_allowed`, `outside_read_default_allowed`, `outside_write_needs_approval`
  - sensitive：`ssh_private_key`, `private_key_cert`, `env_credential_store`, `credential_config`, `system_credential_config`, `ssh_public_key`, `soft_credential_config`
  - bash：`control_flow`, `shell_forwarder`, `cd_chdir`, `forwarding_command`, `find_write_flag`, `unresolved_variable`, `unreliable_command`

**RED 测试**（`test/reason-codes.test.ts`）：
- 断言 3 域 code 表完整（无重复、无遗漏）
- 断言所有 code 符合 snake_case 正则（`^[a-z][a-z0-9_]*$`）
- 断言无跨域 code 名冲突

**验证**：`node --experimental-strip-types --test test/reason-codes.test.ts`

**依赖**：无

---

## T2. 新增 src/lib/i18n.ts（RED → GREEN）

**动作**：
- 创建 `src/lib/i18n.ts`，导出：
  - `Lang = "en" | "zh"` 类型
  - `enBundle: Record<ReasonCode, string>`（英文 bundle，26 条）
  - `zhBundle: Record<ReasonCode, string>`（中文 bundle，26 条，无 fallback）
  - `t(code: ReasonCode, lang: Lang, params?: Record<string, string>): string` 纯函数
- `t()` 语义：
  - 按 lang 查 bundle，替换 `{param}` 占位符
  - 未知 code / 未知 lang fallback 到英文
  - 英文也找不到时返回 code 本身（fail-safe）
- en bundle 使用现有英文文案（从 `decision.ts` / `sensitive.ts` / `bash-extract.ts` / `extensions/index.ts` 抽取）
- zh bundle 使用中文翻译（本 change 提供）

**RED 测试**（`test/i18n.test.ts`）：
- 断言 26 个 ReasonCode × 2 语言 = 52 条文案都存在
- 断言 zh bundle 无 fallback 到英文（无 code 缺失）
- 断言 params 替换正确（如 `{source}` / `{path}` / `{action}` / `{var_name}`）
- 断言未知 code fallback 到英文
- 断言未知 lang fallback 到英文
- 断言英文也找不到时返回 code 本身

**验证**：`node --experimental-strip-types --test test/i18n.test.ts`

**依赖**：T1

---

## T3. 新增 src/lib/lang-detect.ts + src/lib/settings.ts（RED → GREEN）

**动作**：
- 创建 `src/lib/settings.ts`，导出：
  - `Settings = { lang?: "en" | "zh" }` 类型
  - `loadSettings(agentExtDir: string): Promise<Settings>` 纯函数（读 `~/.pi/agent/extensions/permission-guard-pi/settings.json`，JSONC 语法，缺文件降级为 `{}`）
- 创建 `src/lib/lang-detect.ts`，导出：
  - `detectLang(env: Record<string, string | undefined>, settings: Settings): Lang` 纯函数
  - 优先级链：`env.PI_LANG` > `settings.lang` > `env.LANG?.slice(0,2)` > `"en"`
  - 无效值 fallback：非 `"en"` / `"zh"` 的字符串跳过，走下一级

**RED 测试**（`test/lang-detect.test.ts` + `test/settings.test.ts`）：
- lang-detect：覆盖 4 级优先级链（`$PI_LANG` 存在 / settings.lang 存在 / `$LANG` 存在 / 全空）
- lang-detect：无效值 fallback（`$PI_LANG=fr` 跳到下一级 / settings.lang = "fr" 跳过）
- lang-detect：`$LANG=zh_CN.UTF-8` → `zh` / `$LANG=en_US.UTF-8` → `en`
- settings：正常 JSONC 文件读取
- settings：JSONC 注释 + 尾逗号
- settings：文件不存在 → 降级为 `{}`（不报错）
- settings：JSONC 解析失败 → 降级为 `{}`（不报错）
- settings：非法 lang 值（如 `"fr"`）→ 保留原值，由 lang-detect 跳过

**验证**：`node --experimental-strip-types --test test/lang-detect.test.ts test/settings.test.ts`

**依赖**：T1, T2

---

## T4. 加宽 Decision 与 SensitiveRule 类型（GREEN，加宽兼容）

**动作**：
- `src/lib/decision.ts`：
  - `DecisionCommon` 加 `reasonCode?: DecisionReasonCode | SensitiveReasonCode` 字段（可选）
  - 每个 `decide()` 分支填对应 `reasonCode`（13 个 decision code + 敏感相关分支用 sensitive code）
- `src/lib/sensitive.ts`：
  - `SensitiveRule` 接口加 `code: SensitiveReasonCode` 字段（必填，非可选）
  - `DEFAULT_SENSITIVE_RULES` 7 条规则各填对应 code

**GREEN 测试**：
- 现有 `test/decision.test.ts` / `test/sensitive.test.ts` 全绿（加宽兼容，现有断言不动）
- 新增断言：
  - `test/decision.test.ts`：每个 decision 分支的 `reasonCode` 字段与预期 code 一致
  - `test/sensitive.test.ts`：`findSensitiveMatch` 返回的 rule 包含正确 `code` 字段

**验证**：`node --experimental-strip-types --test test/decision.test.ts test/sensitive.test.ts`

**依赖**：T1

---

## T5. extensions/index.ts 替换硬编码文案（RED → GREEN）

**动作**：
- session start 时读 `settings.json`：
  - `registerPermissionGate` 初始化时调 `loadSettings()` + `detectLang()`，缓存到 `SessionState`
  - 新增 `SessionState.lang: Lang` 字段
- `showPermissionDialog`：
  - dialog choices 改为 `t(code, lang)`（`allow_once` / `allow_session` / `allow_persistent` / `allow_persistent_bash` / `deny`）
  - title / footer / note 改为 `t(code, lang, {params})`
  - UserChoice 匹配逻辑用稳定 code（不依赖具体字符串）
- `ctx.ui.notify` 5 处：
  - `config_warning` 消息（2 处）：`t("config_warning", lang, {warnings})`
  - `deny_hard` 通知（1 处）：`t("deny_hard", lang, {reason, path})`
  - 其他 2 处类似
- `bashSubtitleForReason`：
  - 改为 `bashSubtitleForReason(code: BashReasonCode, lang: Lang)` 查 i18n bundle
  - 现有第 229 行硬编码中文（`glob_expansion` 分支）自然收敛到 zh bundle
  - 注意：spec 已删除 `glob_expansion`，代码里也不产生该值，直接映射到 `unreliable_command` 副文本
- 决策 reason → UI 展示链：
  - 弹窗 title/message 用 `t(reasonCode, lang, {params})` 替代直接拼 `decision.reason`
  - audit 层继续用 `decision.reason` 英文字符串（不改）

**RED 测试**：
- `extensions/index.test.ts` 既有 UI 字符串断言改为 lang-aware：
  - 同一测试用例按 `lang=zh` / `lang=en` 分别覆盖
  - 断言 dialog choices 集合正确（4 个 / 3 个 / 2 个）
  - 断言具体字符串匹配 lang 对应的 bundle
- 新增测试：
  - settings.json 读取后 lang 生效
  - `$PI_LANG` 环境变量覆盖 settings.json
  - 缺 settings.json 时回退到 `$LANG` 或 `"en"`

**验证**：`node --experimental-strip-types --test extensions/index.test.ts`

**依赖**：T2, T3, T4

---

## T6. Spec delta 应用（人工应用，非代码）

**动作**：
- 应用 `openspec/changes/ui-i18n/specs/approval-flow/spec.md` delta：
  - MODIFIED：弹窗选项与副文本的字符串断言改为 lang-aware
  - ADDED：3 个新 bash 副文本 scenario（`find_write_flag` / `unreliable_command` / `unresolved_variable`）
  - **保留（不删除）**：`bash 命令 glob 类 prompt 副文本` scenario——保留在 MODIFIED 块里以通过 archive 的"不能丢 scenario"校验；代码里从未产生 `glob_expansion` reason，本 change apply 后需单独提交 follow-up change 删除该 scenario（属于 spec 与代码漂移修复，非 i18n 主 scope）
- 应用 `openspec/changes/ui-i18n/specs/access-decision/spec.md` delta：
  - MODIFIED：`变量展开失败的 bash 命令弹三档` scenario 的 reason 断言从 `command_substitution` 改为 `unresolved_variable`
- 应用到 `openspec/specs/` 下对应 spec 文件

**验证**：`openspec validate ui-i18n --type change`

**依赖**：T1, T2, T3, T4, T5（代码完成后应用 delta，确保 spec 与实现一致）

---

## T7. README 更新（GREEN，文档）

**动作**：
- README 新增"多语言"节：
  - 说明 lang 来源链（`$PI_LANG` > `settings.json.lang` > `$LANG` > `"en"`）
  - settings.json 位置：`~/.pi/agent/extensions/permission-guard-pi/settings.json`
  - 如何切换（编辑 settings.json 或设置 `$PI_LANG`）
  - 生效时机（重启 pi 会话）
- README "How decisions work" 节：
  - 提及 ReasonCode 是稳定契约（不改名）
  - 提及 audit 日志的 reason 字段保持英文（跨版本兼容）
- CHANGELOG.md 新增条目：本 change 的用户可见变化

**验证**：人工读一遍（降级为 T7 的验证字段）

**依赖**：T5

---

## 关键链说明

T1 → T2 → T3 是 i18n 基础设施的 RED → GREEN 序列，可并行推进。
T4 是类型加宽，独立于 T2/T3，可与 T2/T3 并行。
T5 依赖 T2+T3+T4 全部完成（i18n 模块就绪 + 类型就绪 + extensions 改造）。
T6 依赖 T5（代码完成后应用 spec delta，避免 spec 与实现不一致）。
T7 依赖 T5（文档反映最终实现）。

**并行策略**：
- T1 → T2 → T3 串行（依赖链）
- T4 与 T1/T2/T3 并行
- T5 等 T2+T3+T4 完成
- T6/T7 等 T5 完成

**Project buffer**：约 10%——含 spec delta 应用的意外工作量（可能发现更多漂移）、i18n bundle 中文字符校对、extensions 改造的边界情况。

---

## 备注

- **不加域前缀**：ReasonCode 无 `decision_` / `sensitive_` / `bash_` 前缀（3 域命名空间不冲突，见 design.md D2）。
- **settings.json 不进 git**：用户本地个人偏好，与 `trusted.json` 同级同性质（不 commit）。
- **audit 日志保持英文**：`decision.reason` 字段英文稳定字符串，audit 层不消费 i18n（见 design.md D3）。
- **LLM prompt 保持英文**：`BASH_GUARDRAILS` 不本地化（见 design.md Non-goals）。
- **spec 漂移修复**：本 change 一并修 `glob_expansion` / `command_substitution` 漂移（见 design.md D9），不动 `bash-extract.ts`。
