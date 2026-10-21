## Why

pi-coding-agent 目前的工具调用审批只覆盖"敏感读 + 项目外写"两条粗粒度路径，用户无法按项目自定义"哪些路径可读 / 可写 / 硬拒"，也无法让"我认这个项目的这个敏感文件"跨越会话重启。这个 change 建立一套分层的、可配置的路径权限系统，把"访问策略"从硬编码扩展为用户可读可编辑的 JSONC 声明。

## What Changes

- 新增 `src/lib/config.ts`：加载并合并三档 JSONC 配置（`~/.pi/agent/permission.json` → `<proj>/.pi/permission.json` → `<proj>/.pi/local/permission.json`），支持相对路径 glob（项目内 & 项目外）
- 新增 `src/lib/decision.ts`：纯函数决策引擎，返回 `auto_allow | deny_hard | prompt`，含跨源冲突检测
- 新增 `src/lib/trust.ts`：会话级 + 持久化的授权记忆存储，key = `projectHash | action | absPath`
- 新增 `src/lib/audit.ts`：JSONL 追加日志，串行写入防并发错行
- 新增 `src/lib/bash-extract.ts`：正则提取 bash 命令的文件目标路径；未识别的复杂语法走"未配置路径"兜底弹窗
- 新增 `src/lib/sensitive.ts`：默认敏感路径兜底表（SSH / key / env / credential store）
- 新增 `src/lib/path-utils.ts`：路径规范化、`~` 展开、Windows 大小写归一、glob 匹配、项目 hash
- 新增 `extensions/index.ts`：pi 集成层，`pi.on("tool_call", ...)` 拦截 read / write / edit / bash，通过 `ctx.ui.select` 呈现审批弹窗（三档 / 两档根据配置状态切换）
- 新增 `examples/`：全局 / 项目 / 项目本地三份示例 permission.json
- 新增 `test/*.test.ts`：TDD 覆盖全部行为契约（先写测试再写实现）
- 新增 `package.json`：npm 包 `@permission-system:pi-extension`，`pi-package` keyword，`peerDependencies: @earendil-works/pi-coding-agent@*`
- 新增 `README.md`：使用方式、配置语法、语义表格（不引用外部设计参考）

**明确不做**：不接 pi 的 `project_trust` 事件；不引入 tree-sitter；不提供 revoke 命令（用户手工编辑 trusted.json 撤销）。

## Capabilities

### New Capabilities

- `permission-config`: 三档配置文件的加载、合并与优先级（含 glob 匹配语义、JSONC 解析、优先级 local > project > global）
- `access-decision`: 决策引擎的行为契约——按（区域 × 权限 × 操作）返回 auto_allow / deny_hard / prompt，含跨源冲突处理与敏感路径兜底
- `grant-memory`: 授权记忆的存储、查询与项目隔离——会话级（进程内）与持久化（磁盘 trusted.json）双通道，key 复合结构
- `approval-flow`: 审批弹窗的呈现与交互——三档（配置声明路径）vs 两档（未配置路径）的语义、失败模式（无 UI → deny）
- `bash-target-extraction`: bash 命令的目标路径提取——支持哪些命令、如何处理无法解析的命令（兜底走"未配置路径"弹窗）
- `audit-log`: 审计日志的追加写入——事件分类、字段结构、串行化保证

### Modified Capabilities

无（本 change 是 greenfield，`openspec/specs/` 目前为空）。

## Impact

- **代码**：新增 `extensions/index.ts` + `src/lib/*.ts`（约 7 个模块）+ `test/*.test.ts`（8+ 个测试文件）+ `examples/**/permission.json`（3 份示例）
- **依赖**：仅 peerDependency `@earendil-works/pi-coding-agent@*`（由 pi 提供，不打包）；无运行时 npm 依赖，无 wasm/native
- **磁盘**：新增用户级运行时目录 `~/.pi/agent/extensions/@permission-system:pi-extension/`（trusted.json + logs/permission-review.jsonl）
- **配置**：新增用户可选配置文件三份（全局 / 项目 / 项目本地）；未创建时行为退化到"默认敏感兜底 + 项目外写弹审批"
- **与 pi 内置扩展的关系**：与 `permission-gate`、`protected-paths`、`project-trust` 等内置示例扩展共存；本扩展不监听 `project_trust`，也不修改 pi 内置审批流程。用户可同时启用；两个扩展的决策叠加（都是 block-then-allow 语义，最保守的胜出）
- **无 BREAKING**：greenfield change，无既有代码

## 系统工程影响评估

- **影响哪些分系统**：policy-core（config / decision / trust / path-utils，构成策略内核，跨模块依赖紧密）；side-effects（audit + bash-extract + sensitive，无相互依赖的纯工具模块，被 extension 与 policy-core 共同调用）；extension-orchestration（单一集成层，绑定 pi API + UI）
- **整体性能预期变化**：每个工具调用增加 1 次决策引擎调用（< 1 ms，纯内存查表 + 一次路径规范化）+ 至多 1 次 audit 追加写（< 5 ms，串行队列）；配置文件在 session_start 一次性加载，不每次 IO。整体决策开销对用户感知为 0（工具调用本身耗时通常 100ms+）
- **这是局部优化还是全局协调**：**全局协调**——三档配置优先级、双区域 × 三权限的矩阵、跨源冲突检测都是跨分系统的行为契约。局部看每个模块都很简单（config.ts 就是合并字典，decision.ts 就是 switch），但它们的组合才能产生用户可见的完整语义
- **如果是局部优化，对全局失调的风险**：N/A（本 change 是全局协调，不是局部优化）
- **预期行为模型**：
  - 输入：（区域 ∈ {项目内, 项目外}）× （权限 ∈ {read_write, read_only, unread, 未配置, 敏感兜底}）× （操作 ∈ {read, write, delete}）× （是否 bash 命令）
  - 期望输出：`auto_allow` | `deny_hard` | `prompt{tier: three|two}` 中的一种，且对同一（区域, 权限, 操作）组合，输出与既有会话授权记忆一致
  - 验证方式：6 个 capability 的 spec 每个至少含 3 个场景（scenario），全部转化为 `test/*.test.ts` 里的具名单元测试。关键场景包括：S1 项目内敏感配置声明后免弹、S2 项目外敏感文件首次访问弹三档、S3 项目隔离（A 项目的持久授权不影响 B 项目）、S4 硬拒绝路径任何授权都无法绕过、S5 跨源冲突（global=unread vs project=read_write）弹窗询问、S6 bash 命令无法解析时走"未配置路径"两档弹窗
  - **可验证性**：所有场景都可以用 `node --test` 直接跑（`decision.test.ts` 是纯函数，`config.test.ts` 写临时 JSONC 到 mkdtemp 目录，`bash-extract.test.ts` 是纯字符串输入输出）
- **与既有架构/风格的遵循关系**：greenfield change，无既有分系统可遵循。本 change 建立的分系统切分（policy-core / side-effects / extension-orchestration）成为后续所有 change 的架构基线，写入 `openspec/specs/` 各 capability 的"不变量"节


## scenario→test 覆盖账本

TDD 契约：每个 spec 场景对应一个具名单元测试。测试文件放在 `test/` 下，命名 `<capability>.test.ts`；测试框架 `node --experimental-strip-types --test test/`（Node 24 内置 test runner）。

### permission-config（→ `test/config.test.ts`）

| # | 场景 | 测试函数名 |
|---|---|---|
| PC1 | 三档配置全部存在时按优先级合并 | `merges_local_over_project_over_global` |
| PC2 | 缺失的项目本地配置不报错 | `missing_local_config_is_treated_as_empty` |
| PC3 | 格式错误的配置被降级为空并告警 | `malformed_jsonc_file_yields_empty_config_with_warning` |
| PC4 | 含注释和尾逗号的配置正常解析 | `jsonc_parser_strips_comments_and_trailing_commas` |
| PC5 | 非法权限值被忽略并告警 | `invalid_permission_value_is_skipped_with_warning` |
| PC6 | 绝对路径精确匹配 | `absolute_path_pattern_is_exact_match_not_prefix` |
| PC7 | `~` 展开匹配 | `tilde_expansion_matches_absolute_path` |
| PC8 | 项目内 glob 匹配 | `project_relative_glob_matches_inside_project_root` |
| PC9 | 项目内 glob 不跨越项目边界 | `project_relative_glob_does_not_match_outside_project_root` |
| PC10 | 项目外绝对路径 glob 支持 | `absolute_glob_matches_at_any_path_depth` |
| PC11 | 本地配置覆盖项目配置 | `local_source_overrides_project_source` |
| PC12 | 字面优先于 glob（同层） | `literal_pattern_beats_glob_in_same_source` |
| PC13 | global=unread 与 project=read_write 触发冲突标记 | `cross_source_unread_vs_read_write_flags_conflict` |
| PC14 | 同权限不触发冲突 | `same_permission_across_sources_not_flagged_as_conflict` |
| PC15 | 会话内删除某路径声明后回退 | `config_reload_after_removal_falls_back_to_default` |

### access-decision（→ `test/decision.test.ts`）

| # | 场景 | 测试函数名 |
|---|---|---|
| AD1 | 项目内路径判定 | `classifies_path_under_project_root_as_inner` |
| AD2 | `..` 逃逸规范化 | `dotdot_escape_resolves_to_project_outer` |
| AD3 | 符号链接逃逸规范化 | `symlink_escape_resolves_to_project_outer_via_realpath` |
| AD4 | 项目内敏感文件被配置覆盖 | `declared_config_overrides_default_sensitive_rule` |
| AD5 | 项目内敏感文件读取免弹 | `declared_read_write_auto_allows_read_inside_project` |
| AD6 | 项目内 read_write 读写免弹 | `declared_read_write_auto_allows_write_inside_project` |
| AD7 | 项目外 read_write 首次访问弹三档 | `declared_read_write_outside_project_prompts_three_tier` |
| AD8 | 项目外 read_write 已授权后免弹 | `persisted_grant_for_read_write_outside_project_skips_prompt` |
| AD9 | read_only 读免弹 | `declared_read_only_auto_allows_read` |
| AD10 | read_only 写弹三档 | `declared_read_only_write_prompts_three_tier` |
| AD11 | 硬拒绝项目内文件 | `declared_unread_hard_denies_inside_project` |
| AD12 | 硬拒绝项目外文件 | `declared_unread_hard_denies_outside_project` |
| AD13 | 已授权记忆不能绕过 unread | `persisted_grant_cannot_override_unread_declaration` |
| AD14 | 未配置项目内普通文件写自动放行 | `unconfigured_inner_plain_write_auto_allows` |
| AD15 | 未配置项目外敏感文件读弹两档 | `unconfigured_outer_sensitive_read_prompts_two_tier` |
| AD16 | 未配置项目外非敏感文件写弹两档 | `unconfigured_outer_plain_write_prompts_two_tier` |
| AD17 | 全局 unread 与项目 read_write 冲突 | `cross_source_unread_vs_read_write_prompts_with_conflict_flag` |
| AD18 | 敏感文件按文件记忆 | `sensitive_file_grant_is_keyed_by_full_path_not_directory` |
| AD19 | 无法解析的复杂 bash 命令 | `unreliable_bash_extraction_prompts_two_tier_with_raw_command` |

### grant-memory（→ `test/trust.test.ts`）

| # | 场景 | 测试函数名 |
|---|---|---|
| GM1 | 会话内允许后同会话免弹 | `session_grant_auto_allows_within_session` |
| GM2 | 会话内允许后重启重新弹 | `session_grant_cleared_on_new_session` |
| GM3 | 总是允许后跨会话免弹 | `persistent_grant_survives_session_restart` |
| GM4 | 不同项目授权隔离 | `grant_key_is_scoped_to_project_hash` |
| GM5 | 同项目切换子目录授权稳定 | `project_hash_stable_when_cd_into_subdirectory` |
| GM6 | 不同 worktree 授权隔离 | `distinct_worktrees_produce_distinct_project_hashes` |
| GM7 | 写入时记录权限级别 | `persistent_grant_persists_permission_level` |
| GM8 | 缺失 trusted.json 视为空 | `missing_trusted_json_is_treated_as_empty_grants` |
| GM9 | 原子写入保证 | `trust_store_atomic_write_survives_mid_write_crash` |
| GM10 | 敏感文件按文件独立记忆 | `sensitive_grants_are_per_file_not_per_directory` |
| GM11 | session_start 清空会话级记忆 | `session_start_clears_session_grants_and_loads_persistent` |
| GM12 | tier=two 弹窗不产生持久化写入 | `two_tier_grant_does_not_write_persistent_storage` |

### audit-log（→ `test/audit.test.ts`）

| # | 场景 | 测试函数名 |
|---|---|---|
| AL1 | 弹窗放行写入审计 | `prompt_persistent_decision_writes_allow_persistent_event` |
| AL2 | 硬拒绝写入审计 | `hard_deny_decision_writes_hard_deny_event` |
| AL3 | 常规 auto_allow 不写审计 | `routine_inner_plain_auto_allow_is_not_audited` |
| AL4 | 日志追加写入 | `audit_logger_appends_jsonl_line_per_record` |
| AL5 | 记录字段完整 | `audit_record_contains_all_required_fields` |
| AL6 | 磁盘满时不阻塞工具 | `audit_write_failure_does_not_throw` |
| AL7 | 并发工具调用不产生错行 | `concurrent_audits_are_serialized_no_line_interleaving` |
| AL8 | 首次写入自动创建目录 | `audit_logger_creates_log_directory_on_first_write` |

### bash-target-extraction（→ `test/bash-extract.test.ts`）

| # | 场景 | 测试函数名 |
|---|---|---|
| BT1 | `rm -rf` 提取路径 | `extracts_target_from_rm_rf` |
| BT2 | `mv` 提取目标路径 | `extracts_target_from_mv_destination` |
| BT3 | `cat` 提取路径 | `extracts_source_from_cat` |
| BT4 | 重定向提取 | `extracts_target_from_redirection_operator` |
| BT5 | `curl -o` 提取写目标 | `extracts_target_from_curl_output_flag` |
| BT6 | `$HOME` 展开 | `expands_HOME_variable` |
| BT7 | 用户变量导致不可靠 | `unknown_variable_marks_extraction_unreliable` |
| BT8 | 管道命令不可靠 | `pipeline_marks_extraction_unreliable` |
| BT9 | 命令替换不可靠 | `command_substitution_marks_extraction_unreliable` |
| BT10 | 相对路径解析 | `resolves_relative_path_against_project_root` |
| BT11 | 多目标命令 | `extracts_multiple_targets_from_chained_commands` |
| BT12 | 不可靠命令返回 raw | `unreliable_result_includes_raw_command` |

### approval-flow（→ `extensions/index.test.ts`，mock pi ExtensionAPI）

| # | 场景 | 测试函数名 |
|---|---|---|
| AF1 | 配置声明路径弹三档 | `three_tier_prompt_shows_four_options` |
| AF2 | 未配置路径弹两档 | `two_tier_prompt_shows_three_options` |
| AF3 | 三档弹窗显示保存位置 | `three_tier_prompt_mentions_trusted_json_path` |
| AF4 | 两档弹窗显示提示 | `two_tier_prompt_mentions_no_persistent_option` |
| AF5 | 硬拒绝只通知不弹审批 | `hard_deny_notifies_warning_without_prompt` |
| AF6 | RPC 模式下弹窗降级为拒绝 | `prompt_without_ui_blocks_and_audits_deny` |
| AF7 | 允许一次后再次访问重新弹 | `allow_once_does_not_persist_to_memory` |
| AF8 | 会话内允许在会话内免弹 | `allow_session_persists_within_session` |
| AF9 | 总是允许跨会话生效 | `allow_persistent_persists_across_sessions` |
| AF10 | 拒绝后审计记录 | `user_deny_writes_audit_record` |

**总计**：76 个场景 → 76 个具名测试（15 + 19 + 12 + 8 + 12 + 10 = 76）。每个测试都可用 `node --test` 直接跑，无 mock（除 extension 集成测试需要 mock pi ExtensionAPI）。

**测试文件分布**：
- `test/config.test.ts`：15 个
- `test/decision.test.ts`：19 个（含跨模块 bash 集成 1 个）
- `test/trust.test.ts`：12 个
- `test/audit.test.ts`：8 个
- `test/bash-extract.test.ts`：12 个
- `extensions/index.test.ts`：10 个（用 mock pi ExtensionAPI）
