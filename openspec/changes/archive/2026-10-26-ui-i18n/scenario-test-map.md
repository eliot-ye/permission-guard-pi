# ui-i18n scenario→test 覆盖账本

**格式**：每个 delta 里涉及的 spec scenario 映射到具名测试。unmapped scenario 标 `N/A` 并给机械校验项。

**tier 分层**：tier-medium brownfield → 强制产出账本（本 change 修改 `approval-flow` spec + 新增 `i18n` capability）。

**测试文件约定**：
- 单元测试：`test/<module>.test.ts`
- 集成测试：`extensions/index.test.ts`

---

## approval-flow delta — MODIFIED scenarios

| Spec scenario | 测试文件 | 测试用例名（RED 后 GREEN） | 状态 |
|---|---|---|---|
| 配置声明路径弹三档（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_zh_returns_localized_choices` | 新增 |
| 配置声明路径弹三档（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_en_returns_english_choices` | 修改（既有测试改 lang-aware） |
| 未配置路径弹两档（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_two_zh_returns_localized_choices` | 新增 |
| 未配置路径弹两档（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_two_en_returns_english_choices` | 修改 |
| bash 命令类 prompt 弹三档（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_zh_returns_localized_choices` | 新增 |
| bash 命令类 prompt 弹三档（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_en_returns_english_choices` | 修改 |
| 未配置项目外 hard sensitive 弹两档（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_two_hard_sensitive_zh_returns_localized_choices` | 新增 |
| 未配置项目外 hard sensitive 弹两档（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_two_hard_sensitive_en_returns_english_choices` | 修改 |
| 未配置项目外 soft sensitive 弹三档（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_soft_sensitive_zh_returns_localized_choices` | 新增 |
| 未配置项目外 soft sensitive 弹三档（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_soft_sensitive_en_returns_english_choices` | 修改 |
| bash 命令无法静态解析弹三档（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_unreliable_zh_returns_localized_choices` | 新增 |
| bash 命令无法静态解析弹三档（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_unreliable_en_returns_english_choices` | 修改 |
| 三档弹窗显示保存位置（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_zh_footer_contains_trusted_path` | 新增 |
| 三档弹窗显示保存位置（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_en_footer_contains_trusted_path` | 修改 |
| 两档弹窗显示提示 | `extensions/index.test.ts` | `showPermissionDialog_tier_two_no_always_allow_in_footer` | 修改 |
| 外层敏感路径弹窗副文本（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_two_hard_sensitive_zh_subtitle_localized` | 新增 |
| 外层敏感路径弹窗副文本（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_two_hard_sensitive_en_subtitle_localized` | 修改 |
| bash 命令无法静态解析弹窗副文本（缺 bash_reason 兜底） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_no_reason_fallback_to_unified_text` | 修改 |
| 外层 hard sensitive 路径弹窗副文本（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_two_hard_sensitive_zh_subtitle_says_not_persistable` | 新增 |
| 外层 hard sensitive 路径弹窗副文本（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_two_hard_sensitive_en_subtitle_says_not_persistable` | 修改 |
| bash 命令无法静态解析弹窗副文本（tier=three，lang-aware 分派） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_subtitle_dispatches_by_reason_and_lang` | 新增（覆盖表） |
| bash 命令控制流类 prompt 副文本（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_control_flow_zh_subtitle_localized` | 新增 |
| bash 命令控制流类 prompt 副文本（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_control_flow_en_subtitle_localized` | 修改 |
| bash 命令 shell 转发器类 prompt 副文本（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_shell_forwarder_zh_subtitle_localized` | 新增 |
| bash 命令 shell 转发器类 prompt 副文本（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_shell_forwarder_en_subtitle_localized` | 修改 |
| bash 命令转发器类 prompt 副文本（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_forwarding_zh_subtitle_localized` | 新增 |
| bash 命令转发器类 prompt 副文本（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_forwarding_en_subtitle_localized` | 修改 |
| bash 命令 cd cwd 变更类 prompt 副文本（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_cd_chdir_zh_subtitle_localized` | 新增 |
| bash 命令 cd cwd 变更类 prompt 副文本（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_cd_chdir_en_subtitle_localized` | 修改 |
| bash 命令不可靠旧统一副文本已废弃 | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_never_uses_unified_fallback_text` | 修改 |

**统计**：28 个 MODIFIED scenario，全部有具名测试用例（既有测试改 lang-aware + 新增 zh 分支）。

---

## approval-flow delta — DELETED scenarios

| Spec scenario | 处理 |
|---|---|
| bash 命令 glob 类 prompt 副文本（原 `bash_reason == "glob_expansion"`） | 删除——代码从未产生该值。原 spec scenario 对应的测试用例（若存在）一并删除或改为 `unreliable_command` 场景。 |

---

## approval-flow delta — ADDED scenarios

| Spec scenario | 测试文件 | 测试用例名 | 状态 |
|---|---|---|---|
| bash 命令 find_write_flag 类 prompt 副文本（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_find_write_flag_zh_subtitle_localized` | 新增 |
| bash 命令 find_write_flag 类 prompt 副文本（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_find_write_flag_en_subtitle_localized` | 新增 |
| bash 命令 unresolved_variable 类 prompt 副文本（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_unresolved_variable_zh_subtitle_localized_with_params` | 新增（含 params 注入测试：变量名 `{var_name}`） |
| bash 命令 unresolved_variable 类 prompt 副文本（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_unresolved_variable_en_subtitle_localized_with_params` | 新增 |
| bash 命令 unreliable_command 类 prompt 副文本（lang=zh） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_unreliable_command_zh_subtitle_localized` | 新增 |
| bash 命令 unreliable_command 类 prompt 副文本（lang=en） | `extensions/index.test.ts` | `showPermissionDialog_tier_three_bash_unreliable_command_en_subtitle_localized` | 新增 |

**统计**：6 个 ADDED scenario（3 个新 reason code × 2 语言），全部新增具名测试。

---

## access-decision delta — MODIFIED scenarios

| Spec scenario | 测试文件 | 测试用例名 | 状态 |
|---|---|---|---|
| 变量展开失败的 bash 命令弹三档 | `test/decision.test.ts` + `test/bash-extract.test.ts` | `decide_unreliable_bash_with_unresolved_variable_returns_prompt_tier_three_and_reason_code_unresolved_variable` | 修改（既有测试改断言 code 值） |

**统计**：1 个 MODIFIED scenario，对应既有测试断言更新。

---

## i18n capability — 新增测试（非 spec delta，属于新模块的单元测试）

### test/i18n.test.ts

| 测试用例名 | 断言 |
|---|---|
| `t_returns_en_for_en_bundle` | 26 个 ReasonCode 在 en bundle 中都能返回非空字符串 |
| `t_returns_zh_for_zh_bundle` | 26 个 ReasonCode 在 zh bundle 中都能返回非空字符串 |
| `t_zh_bundle_has_no_english_fallback` | zh bundle 中无英文兜底（所有 26 条都是中文） |
| `t_replaces_params_in_template` | `t(code, lang, {source: "foo"})` 正确替换 `{source}` |
| `t_falls_back_to_en_for_unknown_lang` | `t(code, "fr", params)` 返回英文 |
| `t_falls_back_to_en_for_unknown_code` | `t("nonexistent", "zh")` 返回英文或 code 本身 |
| `t_returns_code_itself_as_final_fallback` | 英文也找不到时返回 code 本身 |

### test/lang-detect.test.ts

| 测试用例名 | 断言 |
|---|---|
| `detectLang_pi_lang_wins` | `$PI_LANG=zh` 覆盖 settings / `$LANG` |
| `detectLang_settings_wins_over_lang` | `$PI_LANG` 未设、settings.lang="zh"、`$LANG=en_US` → `zh` |
| `detectLang_falls_back_to_system_lang` | `$PI_LANG` 未设、settings 无 lang、`$LANG=zh_CN` → `zh` |
| `detectLang_falls_back_to_en` | 全部未设 → `en` |
| `detectLang_invalid_pi_lang_skips` | `$PI_LANG=fr` → 跳过，用 settings 或 `$LANG` |
| `detectLang_invalid_settings_lang_skips` | settings.lang="fr" → 跳过，用 `$LANG` |
| `detectLang_system_lang_prefix_two_chars` | `$LANG=zh_CN.UTF-8` → `zh` / `$LANG=en_US.UTF-8` → `en` |

### test/settings.test.ts

| 测试用例名 | 断言 |
|---|---|
| `loadSettings_reads_valid_json` | 正常 JSON 文件 → 返回 `{ lang: "zh" }` |
| `loadSettings_reads_jsonc_with_comments` | JSONC 注释 + 尾逗号 → 正确解析 |
| `loadSettings_missing_file_returns_empty` | 文件不存在 → 返回 `{}`（不报错） |
| `loadSettings_malformed_json_returns_empty` | JSONC 解析失败 → 返回 `{}`（不报错） |
| `loadSettings_preserves_invalid_lang_for_downstream_check` | `lang: "fr"` → 保留原值，由 lang-detect 跳过 |

### test/reason-codes.test.ts

| 测试用例名 | 断言 |
|---|---|
| `reason_codes_decision_domain_has_13_codes` | decision 域 13 个 code |
| `reason_codes_sensitive_domain_has_7_codes` | sensitive 域 7 个 code |
| `reason_codes_bash_domain_has_7_codes` | bash 域 7 个 code |
| `reason_codes_all_snake_case` | 所有 code 符合 snake_case 正则 `^[a-z][a-z0-9_]*$` |
| `reason_codes_no_cross_domain_collision` | 3 域 code 无重复 |

---

## T4 类型加宽测试（既有测试 + 新增断言）

### test/decision.test.ts（新增断言）

| 测试用例名 | 断言 |
|---|---|
| `decide_returns_reasonCode_with_each_branch` | 13 个 decision 分支各返回正确 `reasonCode` |
| `decide_sensitive_branch_uses_sensitive_reasonCode` | 敏感路径分支返回 sensitive code（非 decision code） |

### test/sensitive.test.ts（新增断言）

| 测试用例名 | 断言 |
|---|---|
| `findSensitiveMatch_returns_rule_with_correct_code` | 7 条规则各返回正确 `code` 字段 |

---

## 汇总统计

- **MODIFIED scenario**：29 个（approval-flow 28 + access-decision 1）→ 全部有具名测试
- **ADDED scenario**：6 个（approval-flow 新增 bash 副文本）→ 全部新增具名测试
- **DELETED scenario**：1 个（approval-flow glob_expansion）→ 删除对应测试
- **新增单元测试**：i18n（7）+ lang-detect（7）+ settings（5）+ reason-codes（5）= 24 个
- **新增类型加宽测试**：2 个（decision）+ 1 个（sensitive）= 3 个
- **总计新增/修改测试**：约 40-50 个具名测试用例

---

## Unmapped scenarios

**无**——所有 delta 里的 scenario 都映射到具名测试，无 N/A 项。

---

## 机械校验

- 每个 spec delta scenario 都有对应测试用例名（本文档已列全）
- 每个测试用例名遵循 `<module>_<scenario_short>_returns_<expected>` 命名规范
- 测试文件路径与模块对应（`test/<module>.test.ts` / `extensions/index.test.ts`）
- 加宽兼容的类型字段（`Decision.reasonCode` / `SensitiveRule.code`）新增断言，不破坏既有断言
