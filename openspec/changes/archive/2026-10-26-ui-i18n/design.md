# Design

## Overview

本 change 引入 UI 文本本地化（i18n）能力，覆盖 `en` / `zh` 两种语言，同时保持 audit 日志与 LLM prompt 的英文稳定性。核心策略是"最小侵入"：新增 4 个纯函数模块承载 i18n 逻辑，通过**类型加宽**（新增 `reasonCode` 字段）而非破坏性重构接入现有 `Decision` / `SensitiveRule` 类型，通过**独立 settings.json**（而非污染三档 `permission.json`）承载用户偏好。

## Goals / Non-goals

### Goals

1. 所有用户可见 UI 文案（dialog choices / footer / note / notify 消息 / reason 展示 / bash 副文本）可通过 `settings.json` 或 env 变量切换 `en` / `zh`。
2. audit 日志（`trusted.json` / `permission-review.jsonl`）的 reason / note 字段**保持英文稳定字符串**——跨版本日志查询不分裂。
3. LLM systemPrompt（`BASH_GUARDRAILS`）**保持英文**——LLM 提示的稳定英文是最佳实践。
4. 新模块遵循 `src/lib/*.ts` 无 UI/IO 依赖、纯函数约定。
5. 顺手修复 spec 与代码漂移（`glob_expansion` / `command_substitution`），避免 i18n 落地后被历史 spec 断言卡住。

### Non-goals

- 不引入完整的 i18n 框架（如 i18next / formatjs）——本 change 用 4 个纯函数模块足够，避免依赖膨胀。
- 不支持 3 种以上语言（本期 en + zh，ja / de / ko 走独立 change）。
- 不支持会话中途切换 lang（改 settings.json 后需重启 pi 会话）。
- 不本地化 audit / LLM prompt（有意边界，非遗漏）。
- 不改 `permission.json` schema（lang 不进 `RawConfig`，避免职责漂移）。
- 不修 `bash-extract.ts` 内部逻辑（reason 值列表保持不变，spec 对齐代码）。

## Decisions

### D1：4 个纯函数模块，而非 1 个大模块

- **决定**：`src/lib/reason-codes.ts`（类型 + 常量）/ `i18n.ts`（bundle + `t()`）/ `lang-detect.ts`（语言检测）/ `settings.ts`（settings.json 读取）分开。
- **理由**：
  - `src/lib/*.ts` 是纯函数约定，每个模块 1 个关注点便于测试与审查；
  - `reason-codes.ts` 是"契约层"（ReasonCode 类型定义），被 i18n / decision / sensitive 都依赖，独立成文件避免循环依赖；
  - 未来扩展（新语言 / 新 code 域）时改动局部化。
- **备选**：单文件 `i18n.ts` 承载所有——拒绝，因为 ReasonCode 类型是决策层的公共契约，塞进 i18n 文件会让"决策层依赖 i18n 模块"这个方向反转。

### D2：`ReasonCode` 命名规则——snake_case / 无域前缀 / past tense

- **决定**：所有 code 用 snake_case（与既有 `GrantSource` `config_declaration` / `allow_rule` 风格一致），不加 `decision_` / `sensitive_` / `bash_` 域前缀，用过去分词表达事件（`rule_denied` 而非 `rule_deny`）。
- **理由**：
  - snake_case 与既有类型风格一致，避免风格分裂；
  - 无域前缀：三域 code 列表长度可控（12 + 7 + 7 = 26 个），命名空间不冲突，前缀是冗余；
  - past tense：code 表达的是"发生了什么事件"（`rule_denied` = "规则拒绝了"），与 `decision.reason` 英文描述的一致表述。
- **备选**：kebab-case（`rule-denied`）——拒绝，与既有类型不一致；加域前缀——拒绝，冗余；present tense（`rule_deny`）——拒绝，语义上是"事件"而非"能力"。

### D3：`Decision.reason` 保持英文，新增 `reasonCode?` 字段

- **决定**：`Decision.reason` 字段**保持英文稳定字符串**（audit 层继续用），新增 `reasonCode?: ReasonCode` 供 UI 层查本地化文案。
- **理由**：
  - 向后兼容：既有 caller（audit / 日志 / 二次开发）消费 `reason` 字段行为不变；
  - 加宽兼容：新增可选字段，不破坏既有类型实例化；
  - 审计日志跨语言稳定：audit 层的 reason / note 是历史数据的语言，本地化会分裂查询工具。
- **备选**：把 `reason` 改成 `LocalizedReason` 对象 `{ code, params, lang }`——拒绝，破坏性重构；用 i18n 层翻译整个 `reason` 字符串——拒绝，audit 层不消费 i18n。

### D4：`SensitiveRule` 新增 `code` 字段（非可选）

- **决定**：`SensitiveRule` 新增 `code: SensitiveReasonCode` 字段（必填，非可选），与 `reason` 字段并列。
- **理由**：
  - `SensitiveRule` 是 `src/lib/sensitive.ts` 内部类型（不对外导出），加字段是内部重构；
  - `findSensitiveMatch()` 的所有 caller 都是同一仓库内部，加字段不影响外部；
  - 必填 vs 可选：因为 `SensitiveRule` 的所有实例都在 `DEFAULT_SENSITIVE_RULES` 常量表里定义，全部实例都能显式声明 `code`——不必用可选。
- **备选**：从 `reason` 字符串反推 code——拒绝，脆弱（reason 文案改动会破坏映射）；`code` 作为可选——拒绝，无理由用可选。

### D5：`settings.json` 位置——`~/.pi/agent/extensions/permission-guard-pi/settings.json`

- **决定**：与 `trusted.json` 同级的独立文件，JSONC 语法，结构 `{ "lang": "en" | "zh" }`。
- **理由**：
  - 与 `trusted.json` 同级：用户偏好与授权记忆是同类"运行时"数据（不进 git、不跨项目共享）；
  - 独立文件而非加到 `permission.json`：lang 是"用户偏好"不是"策略"，职责分离；
  - 独立于三档配置：不改 schema，不影响 `permission-config` spec；
  - JSONC：与三档 `permission.json` 一致（可加注释），用户学习成本为零。
- **备选**：加到 `permission.json` 的 `RawConfig`——拒绝，职责漂移；用 pi 官方扩展 API 读用户偏好——拒绝，pi 官方无此 API。

### D6：语言来源链——`$PI_LANG` > `settings.json.lang` > `$LANG[0:2]` > `"en"`

- **决定**：4 级优先级，`settings.json` 优先于系统 `$LANG`（用户显式配置高于 OS 默认）。
- **理由**：
  - `$PI_LANG`：pi 官方未定义，本 change 主动扩展为最高优先级（无冲突）；
  - `settings.json.lang`：用户显式配置，优先于 OS 默认；
  - `$LANG`：POSIX 环境变量，回退到系统 locale（macOS 默认 `en_US.UTF-8` → `en`）；
  - `"en"`：最终 fallback，保证永不 fail。
- **备选**：`$LANG` 优先于 `settings.json`——拒绝，用户显式配置应覆盖 OS 默认；只支持 `$PI_LANG`——拒绝，用户不应被强制通过 env 配置。

### D7：`settings.json` 只在 session start 读一次

- **决定**：`registerPermissionGate` 初始化时读一次，缓存到 `SessionState.settings`，会话内不变。
- **理由**：
  - 避免 UI 语言中途切换（同一 session 里弹窗一会儿中文一会儿英文）；
  - 单次文件 IO 开销可忽略；
  - 与既有 `trusted.json` / 三档 `permission.json` 的 session-start 读取模式一致。
- **备选**：每次 `showPermissionDialog` 重读——拒绝，UI 语言会中途切换；watch settings.json——拒绝，过度设计。

### D8：未知 code / 未知 lang 都 fallback 到英文

- **决定**：`t(code, lang, params?)` 在 code 或 lang 未知时回退到英文 bundle；英文 bundle 也找不到时返回 code 本身（fail-safe）。
- **理由**：
  - 未知 lang 回退英文：保证不 crash；
  - 未知 code 回退英文：保证不 crash；
  - 双 fallback 都返回英文：中文用户看到英文不至于无法操作。
- **备选**：未知时抛错——拒绝，UI 层不能因文案问题 crash；返回 code 本身——仅作为双 fallback 的最终 fail-safe。

### D9：spec 与代码漂移——本次一并修

- **决定**：本 change 一并修复 `approval-flow` spec 的 `glob_expansion` scenario（删除）与 `access-decision` spec 的 `command_substitution` scenario（改为 `unresolved_variable`）。
- **理由**：
  - i18n 引入 ReasonCode 表后，spec 里的 `glob_expansion` code 会与实际 ReasonCode 表冲突——必须处理；
  - 顺手补 3 个新 bash 副文本 scenario（`find_write_flag` / `unreliable_command` / `unresolved_variable`），让 spec 与代码完全对齐；
  - scope 有限：只改 spec，不改 `bash-extract.ts` 逻辑（reason 值列表保持不变）。
- **备选**：本次不修漂移，i18n ReasonCode 表包含 7 个 code（含 2 个不产生的 `glob_expansion` / `command_substitution`）——拒绝，代码与 spec 不一致会让测试失败或行为异常；改 `bash-extract.ts` 让 `glob_expansion` 值产出——拒绝，代码改动风险大于 spec 修改。

## Trade-offs

### T1：`reasonCode` 加宽 vs 直接改 `reason` 字段

| 方案 | 优点 | 缺点 |
|---|---|---|
| 加宽 `reasonCode`（本 change） | 向后兼容；audit 层不变；测试面小 | 两个字段并列，语义重复 |
| 改 `reason` 为 `LocalizedReason` | 语义清晰；一个字段搞定 | 破坏性重构；audit 层也要改；跨版本日志分裂 |

**选择**：加宽——本 change 目标是"引入 i18n 而不破坏既有契约"，加宽是唯一不破坏的方案。

### T2：ReasonCode 命名——有前缀 vs 无前缀

| 方案 | 优点 | 缺点 |
|---|---|---|
| 无前缀（本 change） | 简洁；命名空间不冲突 | 未来加新域时可能有歧义 |
| 加 `decision_` / `sensitive_` / `bash_` 前缀 | 域归属清晰 | 冗长；26 个 code 全部加前缀视觉噪音大 |

**选择**：无前缀——当前 3 域命名空间不冲突，未来加域走独立 change 时统一加前缀（若届时真的冲突）。

### T3：`settings.json` 独立 vs 合并到 `permission.json`

| 方案 | 优点 | 缺点 |
|---|---|---|
| 独立文件（本 change） | 职责分离；不改 schema | 多一个文件 |
| 合并到 `permission.json` | 单文件管理 | 职责漂移；污染策略契约；三档合并语义要额外处理 |

**选择**：独立文件——lang 是"用户偏好"，不属于"访问策略"。

## Risks / Trade-offs 补充

### R1：ReasonCode 是跨版本契约

- **风险**：一旦外部消费者依赖某 code，改名即破坏性。
- **缓解**：本 change 落定后**不再重命名** code；未来加新 code 走独立 change（只加不减）。
- **文档**：README 说明 ReasonCode 是"稳定契约"。

### R2：UI 语言中途切换不生效

- **风险**：用户改 settings.json 后不重启，看到的行为不一致。
- **缓解**：README 明确说明"改 settings.json 后需重启 pi 会话"。
- **备选方案**：watch settings.json 自动重载——本 change 不做，过度设计。

### R3：中文 bundle 覆盖不全

- **风险**：zh bundle 里某些 code 未翻译，fallback 到英文——UI 语言混杂。
- **缓解**：本 change 的 zh bundle 必须**覆盖全部 26 个 code**（无 fallback 到英文）；未来加 code 时同步补 zh。
- **测试**：`test/i18n.test.ts` 断言 zh bundle 覆盖全部 ReasonCode。

## Migration

### 用户视角的迁移

**无强制迁移**——settings.json 缺省回退到系统 `$LANG` 或 `"en"`，既有用户完全不感知本 change。

**切换中文的用户操作**：
1. 创建文件 `~/.pi/agent/extensions/permission-guard-pi/settings.json`：
   ```jsonc
   {
     "lang": "zh"
   }
   ```
2. 重启 pi 会话（`Ctrl+C` 退出，重新启动）。
3. 之后所有弹窗 / 通知 / 副文本以中文显示。

### 开发者视角的迁移

**加宽兼容**——现有测试与 caller 无需改动：
- `Decision.reason` 字段行为不变，既有测试断言继续通过；
- `SensitiveRule` 新增 `code` 字段，`findSensitiveMatch()` 的 caller 只读 `reason` / `level` 字段的继续通过；
- `extensions/index.ts` 内部函数签名不变（`showPermissionDialog` 返回值类型 `UserChoice` 不变）。

**必须补的测试**：
- `test/i18n.test.ts`：覆盖 26 个 ReasonCode × 2 语言 = 52 条文案；
- `test/lang-detect.test.ts`：覆盖 4 级优先级链 + fallback；
- `test/settings.test.ts`：覆盖 JSONC 解析 + 缺文件降级 + 非法 lang 值 fallback；
- `test/reason-codes.test.ts`：断言 3 域 code 表完整（无重复、无遗漏）；
- `extensions/index.test.ts`：既有 UI 字符串断言改为 lang-aware（同一测试按 `lang=zh` / `lang=en` 分别覆盖）。

## Complexity Tracking

- **新增文件数**：4 个纯函数模块（`i18n.ts` / `reason-codes.ts` / `lang-detect.ts` / `settings.ts`），每个 100-300 行。
- **新增 spec scenario 数**：approval-flow 新增 3 个 + 修改 8 个左右（弹窗文案 lang-aware）；access-decision 修改 1 个。
- **新增测试数**：约 60-80 个新测试用例（i18n bundle 覆盖 + lang-detect + settings + reason-codes + extensions 改造）。
- **不新增外部依赖**：纯 TypeScript，不引入 i18n 框架。
