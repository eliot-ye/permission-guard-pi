# Proposal: find-exec-readonly-payload

## Why

`find` 的 `-exec`/`-execdir` 后跟**只读载荷**（如 `find . -name '*.ts' -exec cat {} \;`）时，当前 `isFindReadOnly`（`src/lib/bash-extract/readonly.ts:46`）只按 flag 名判定——参数里出现 `-exec` 即判 `find_write_flag`，纯读命令被误判弹窗。

实测确认（2026-11-02）：本项目对 `find . -name '*.ts' -exec cat {} \;`、`-exec grep`、`-exec wc` 均判 `{ reliable: false, reason: "find_write_flag" }`（误报），仅 `find -exec rm` 判对。同类弹窗在宿主 bash 审批层也出现（用户运行 `find openspec -name '*.yaml' -path '*td-state*' -exec cat {} \;` 被 `find_write_flag` 弹窗）——本项目作为 bash 审批扩展，自身的静态提取层存在同一误报面。

## What Changes

- `isFindReadOnly` 改为**载荷感知（payload-aware）**：`-exec`/`-execdir` 后的载荷命令名（`;`/`+` 终止符之前的首个非 flag token）属于 `READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS` 时，该 flag 不再触发 `find_write_flag`；否则维持 flag。
- `-delete`/`-ok`/`-okdir` 判定**不变**（始终判写/交互，保守）。
- 载荷命令名不在上述集合、或无法确定载荷命令（`-exec` 后直接 `{}`、无 token）→ 维持 `find_write_flag`（fail-closed）。
- 同步更新 `openspec/specs/bash-target-extraction/spec.md`「find 的参数条件性只读判定」契约。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `bash-target-extraction`: 修改「有界 glob 免不可靠标记」requirement 内「find 的参数条件性只读判定」——`-exec`/`-execdir` 后跟已知只读载荷命令时不再判写。

## Impact

- `src/lib/bash-extract/readonly.ts` — `isFindReadOnly` 载荷感知判定
- `src/lib/bash-extract/control-flow.ts` — `scanFindWriteFlags` 经 `isFindReadOnly` 自动生效（无独立改动）
- `src/lib/bash-extract/extractors.ts` — `findExtract` 不变：`readExtract` 对载荷命令名（`cat`/`{}`/`;`）的 `looksLikePath` 均为 false，不会误提取为 target；载荷内真实路径（如 `/etc/shadow`）仍会被提取并经敏感/权限管线检查
- `src/lib/bash-extract/keypoints.ts` — 不变
- `test/bash-extract.test.ts` — 补载荷感知断言
- `openspec/specs/bash-target-extraction/spec.md` — 契约加宽

## 系统工程影响评估

- **影响哪些分系统**：仅 `bash-extract`（单分系统）。
- **整体性能预期变化**：无性能变化——纯分类判定调整，单次 O(n) token 扫描，无新增 IO。误报率：`find -exec <只读载荷>` 的误判从 100%（全部判 `find_write_flag`）降为 0%（判 reliable），其余 find 形态分类不变。
- **这是局部优化还是全局协调**：局部优化（缩小 `find_write_flag` 误报面），且**不弱化**对真实写载荷（`rm`/`sh`/`chmod`）与 `-delete`/`-ok`/`-okdir` 的保守判定——全局协调不失调。
- **如果是局部优化，对全局失调的风险**：低。放宽仅在「载荷命令名 ∈ 已知只读集合」这一窄条件下成立；写载荷、未知载荷、`{}` 直接执行、`+` 终止、交互式 `-ok` 均维持 flag。
- **预期行为模型**：用户运行 `find <args> -exec <readonly-cmd> {} \;`（readonly-cmd ∈ READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS）时 `extractBashTargets` 返回 `{ reliable: true }`，不再触发 `find_write_flag` 弹窗；对 `find -exec rm {} \;`、`find -exec sh -c ... \;`、`find . -delete`、`find . -exec {} \;` 仍返回 `{ reliable: false, reason: "find_write_flag" }`。验证：`test/bash-extract.test.ts` 新增断言 + 既有 find 断言保持绿色。
- **与既有架构/风格的遵循关系**：完全遵循——沿用现有 `isFindReadOnly` 单一事实源（所有调用方经同一函数受益），不改函数签名，不引入新模块/新架构；判定复用既有 `READ_ONLY_COMMANDS`/`HARMLESS_BUILTINS` 集合，不新建平行集合。

## caller impact 分析

- **变更点清单**：
  1. `isFindReadOnly`（`src/lib/bash-extract/readonly.ts:46`）返回值语义变更——`-exec`/`-execdir` + 只读载荷时 false→true。属 **④ 数据流/返回值语义变更**，非高危（①②③ 类无；函数签名不变，无公共契约/装配点变更）。
- **高危标记**：无高危变更点（①③ 类无；④ 类变更点无分系统外 caller——扩展公开 API 是 `src/lib/bash-extract/index.ts`（barrel），`src/lib` 内部导出仅供本扩展消费）。
- **已知 caller**：`scanFindWriteFlags`（`control-flow.ts:16`）、`isReadOnlyWithArgs`（`readonly.ts:66`）、`test/bash-extract.test.ts`（1303-1344）。预判结论：全部兼容（均受益于修复，无 break）；既有断言（1322 `-exec rm` 仍 false、1314 `-exec` 无载荷仍 false、1303-1309 filter-only 仍 true）保持绿色。

## Scenario→Test 覆盖账本

> 全部场景来自 delta spec `specs/bash-target-extraction/spec.md`（46 个）。新增场景用 🔴（待实现），既有场景映射到已存在的回归测试 🟢。测试文件均为 `test/bash-extract.test.ts`。

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 有界 glob 免不可靠标记 | 项目内 ls glob 自动放行 | `test/bash-extract.test.ts` | `BMG33: bounded_glob_ls_archive_auto_allow` | 🟢 |
| 同上 | 项目内 cat glob 自动放行 | `test/bash-extract.test.ts` | `BMG34: bounded_glob_cat_specs_auto_allow` | 🟢 |
| 同上 | `find . -name "*.ts"` 自动放行 | `test/bash-extract.test.ts` | `BT-S10: find . -name '*.ts' still reliable` | 🟢 |
| 同上 | `find /etc -type f` 自动放行 | `test/bash-extract.test.ts` | `BT-S11: find /etc -type f still reliable` | 🟢 |
| 同上 | `find -delete` 在 glob 上下文触发 glob_expansion | `test/bash-extract.test.ts` | `BT-S17: find with write flag in bounded glob context is find_write_flag` | 🟢 |
| 同上 | `find -exec` 在 glob 上下文触发 glob_expansion | `test/bash-extract.test.ts` | `helper: isFindReadOnly returns false for combined write flag`（-exec rm） | 🟢 |
| 同上 | `find -execdir` 在 glob 上下文触发 glob_expansion | `test/bash-extract.test.ts` | `find_execdir_readonly_payload_cat_reliable` | 🔴 |
| 同上 | `find -ok` 在 glob 上下文触发 glob_expansion | `test/bash-extract.test.ts` | `BT-S8: find -ok isolated is find_write_flag` | 🟢 |
| 同上 | `find -exec cat` 只读载荷自动放行 | `test/bash-extract.test.ts` | `find_exec_readonly_payload_cat_reliable` | 🔴 |
| 同上 | `find -exec wc` 只读载荷自动放行 | `test/bash-extract.test.ts` | `find_exec_readonly_payload_wc_reliable` | 🔴 |
| 同上 | `find -execdir cat` 只读载荷自动放行 | `test/bash-extract.test.ts` | `find_execdir_readonly_payload_cat_reliable` | 🔴 |
| 同上 | `find -exec cat {} +` 加号终止只读载荷自动放行 | `test/bash-extract.test.ts` | `find_exec_plus_terminator_readonly_reliable` | 🔴 |
| 同上 | `find -exec echo` HARMLESS 载荷自动放行 | `test/bash-extract.test.ts` | `find_exec_echo_harmless_payload_reliable` | 🔴 |
| 同上 | `find -exec sh -c` 载荷仍触发 glob_expansion | `test/bash-extract.test.ts` | `find_exec_sh_payload_unreliable` | 🔴 |
| 同上 | `find -exec {}` 无命令载荷仍触发 glob_expansion | `test/bash-extract.test.ts` | `find_exec_no_command_payload_unreliable` | 🔴 |
| 同上 | 写命令内的 glob 仍触发 glob_expansion | `test/bash-extract.test.ts` | `BMG35: bounded_glob_write_command_still_triggers_glob_expansion` | 🟢 |
| 同上 | 跨项目边界的 glob 仍触发 glob_expansion | `test/bash-extract.test.ts` | `BMG36: cross_boundary_glob_still_triggers_glob_expansion` | 🟢 |
| 同上 | git log 带路径 glob 自动放行 | `test/bash-extract.test.ts` | `BMG39: git_log_with_bounded_glob_auto_allow` | 🟢 |
| 同上 | `;` 分隔的多命令中每片段独立判定 | `test/bash-extract.test.ts` | `BMG60: semicolon_separated_echo_then_bounded_glob_is_safe` | 🟢 |
| 同上 | `&&` 分隔的多命令中每片段独立判定 | `test/bash-extract.test.ts` | `BMG63: logical_and_separated_echo_then_bounded_glob_is_safe` | 🟢 |
| 同上 | `||` 分隔的多命令中每片段独立判定 | `test/bash-extract.test.ts` | `BMG64: logical_or_separated_false_then_bounded_glob_is_safe` | 🟢 |
| 同上 | `&` 分隔的多命令中每片段独立判定 | `test/bash-extract.test.ts` | `BMG61: ampersand_separated_sleep_then_bounded_glob_is_safe` | 🟢 |
| 同上 | 换行分隔的多命令中每片段独立判定 | `test/bash-extract.test.ts` | `BMG62: newline_separated_echo_then_bounded_glob_is_safe` | 🟢 |
| 同上 | 写命令 glob 即使作为片段也不放行 | `test/bash-extract.test.ts` | `BMG65: semicolon_separated_write_glob_still_unreliable` | 🟢 |
| 同上 | 多片段混排且每片段均满足条件 | `test/bash-extract.test.ts` | `BMG60: semicolon_separated_echo_then_bounded_glob_is_safe`（分隔符族覆盖） | 🟢 |
| 同上 | for 循环迭代集 glob + read-only body 自动放行 | `test/bash-extract.test.ts` | `BMG88: for-loop iteration-set glob + read-only ls body is reliable` | 🟢 |
| 同上 | for 循环迭代集 glob 前缀出界仍触发 glob_expansion | `test/bash-extract.test.ts` | `BMG89: for-loop iteration-set glob prefix outside project is unreliable` | 🟢 |
| 同上 | for 循环迭代集 glob + write body 仍触发 glob_expansion | `test/bash-extract.test.ts` | `BMG90: for-loop iteration-set glob + write body is unreliable` | 🟢 |
| 同上 | for 循环迭代集 glob + cat body 自动放行 | `test/bash-extract.test.ts` | `BMG91: for-loop iteration-set glob + cat body is reliable` | 🟢 |
| 同上 | for 循环迭代集 glob + echo body 自动放行 | `test/bash-extract.test.ts` | `BMG92: for-loop iteration-set glob + echo body is reliable` | 🟢 |
| 同上 | for 循环迭代集 glob + 多命令只读 body 自动放行 | `test/bash-extract.test.ts` | `BMG93: for-loop iteration-set glob + multi-command read-only body is reliable` | 🟢 |
| 同上 | for 循环迭代集 glob + body 含 glob 仍触发 glob_expansion | `test/bash-extract.test.ts` | `BMG94: for-loop iteration-set glob + body glob is unreliable` | 🟢 |
| 同上 | for 循环结构不完整仍触发 glob_expansion | `test/bash-extract.test.ts` | `BMG95: for-loop incomplete structure is unreliable` | 🟢 |
| 同上 | for 循环迭代集全字面量走另一条路径 | `test/bash-extract.test.ts` | `BMG96: for-loop iteration-set with literal words still goes through literal path` | 🟢 |
| 同上 | for 循环迭代集空 prefix + read-only body 自动放行 | `test/bash-extract.test.ts` | `BT-S21: for-loop iteration-set glob empty prefix + read-only wc body is reliable` | 🟢 |
| 同上 | for 循环迭代集空 prefix + 非空 prefix 同命令形态自动放行 | `test/bash-extract.test.ts` | `BT-S24c: for-loop iteration-set glob non-empty prefix + relative word still reliable` | 🟢 |
| 同上 | for 循环迭代集空 prefix + 写 body 仍触发 glob_expansion | `test/bash-extract.test.ts` | `BT-S22: for-loop iteration-set glob empty prefix + write body is unreliable` | 🟢 |
| 同上 | for 循环迭代集绝对路径前缀仍触发 glob_expansion | `test/bash-extract.test.ts` | `BT-S23: for-loop iteration-set glob absolute prefix is unreliable` | 🟢 |
| 同上 | for 循环迭代集 ~ 前缀仍触发 glob_expansion | `test/bash-extract.test.ts` | `BT-S24: for-loop iteration-set glob home prefix is unreliable` | 🟢 |
| 同上 | 非 for-loop 路径的空 prefix glob 仍触发 glob_expansion | `test/bash-extract.test.ts` | `BMG38: rm_with_project_inner_glob_still_triggers` | 🟢 |
| 同上 | for 循环迭代集空 prefix + cat body 自动放行 | `test/bash-extract.test.ts` | `BT-S24b: for-loop iteration-set glob empty prefix + cat body is reliable` | 🟢 |
| 同上 | 只读命令 + 空 prefix glob 自动放行（情形 B 新增） | `test/bash-extract.test.ts` | `BMG-RO-empty-prefix-ls-glob-autoallow: ls_md_glob_autoallow` | 🟢 |
| 同上 | 只读命令 + 裸空 prefix glob 自动放行（情形 B 新增） | `test/bash-extract.test.ts` | `BMG-RO-bare-empty-prefix-ls-autoallow: ls_bare_glob_autoallow` | 🟢 |
| 同上 | 写命令 + 空 prefix glob 仍触发 glob_expansion（情形 B 反例新增） | `test/bash-extract.test.ts` | `BMG-RO-empty-prefix-tar-glob-reject: tar_glob_reject` | 🟢 |
| 同上 | 只读命令 + 绝对路径前缀 glob 仍触发 glob_expansion（情形 B 反例新增） | `test/bash-extract.test.ts` | `BMG-RO-abs-prefix-glob-reject: ls_abs_prefix_glob_reject` | 🟢 |
| 同上 | 只读命令 + ~ 前缀 glob 仍触发 glob_expansion（情形 B 反例新增） | `test/bash-extract.test.ts` | `BMG-RO-tilde-prefix-glob-reject: ls_tilde_prefix_glob_reject` | 🟢 |

## 实际系统工程影响 vs 预期

> archive 复盘（td-archive 步骤 3，tier-medium 全 5 字段）。对照 proposal「系统工程影响评估」节（预期侧）与实施结果（实际侧）。对照源 2（`openspec/specs/bash-target-extraction/spec.md` baseline）：delta 仅改「find 参数条件性只读判定」的 `-exec`/`-execdir` 语义（无条件写 → 载荷感知），未触碰 bounded glob 条件 1-3、for 循环规则、反例结构等其余契约，baseline 不变量未被破坏。

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统：仅 `bash-extract` | 实际影响：仅 `bash-extract`（`readonly.ts` 逻辑 + `control-flow.ts`/`silent.ts`/`shell-forwarder.ts` 经 `isReadOnlyWithArgs` 间接受益 + `test/bash-extract.test.ts`）；未触碰 `decision`/`sensitive`/`trust`/`audit` 等其余分系统。✅ 一致 |
| 整体性能预期变化：无性能变化（单次 O(n) token 扫描）；`find -exec <只读载荷>` 误判从 100% 降为 0% | 实际：无性能变化（纯分类判定，无新增 IO）；误报面收敛——7 个新测试中 5 个只读载荷判 reliable，2 个写载荷保持 unreliable。✅ 一致 |
| 这是局部优化还是全局协调：局部优化（缩小误报面），不弱化保守判定 | 实际：局部优化——`find -exec cat/wc/echo` 判 reliable，`find -exec rm/sh/sort/chmod/mv`、`find -delete`、`find -ok`、`find -exec {}` 全部保持 `find_write_flag`（fail-closed 复验 12/12）。✅ 一致 |
| 如果是局部优化，对全局失调的风险：低（仅在窄条件放宽） | 实际：低——复验确认写载荷/未知载荷/`{}`/`+` 终止/畸形 flag/集合外命令全部判写；载荷外重定向 `> /etc/passwd` 仍提取 write target；载荷内敏感路径 `/etc/shadow` 仍提取 read target 走权限管线。无全局失调证据。✅ 一致 |
| 预期行为模型：只读载荷 → `reliable: true`；写载荷/`sh`/`delete`/`{}` → `reliable: false, reason: "find_write_flag"` | **模型验证：已验证**——`test/bash-extract.test.ts` 新增 7 测试（5 正例 + 2 反例）全部通过；既有 7 个 find helper 断言保持；typecheck 0 + 全量测试 908/908 全绿。预期行为模型与实际行为一致。 |

**预期之外的副作用**：无。架构 review 修正了 4 处 proposal/design 表述（design Non-Goal 失实、proposal 路径引用过时、D3 FIND_WRITE_FLAGS 语义注解、D4 措辞），均为文档事实性修正，非行为副作用。

**scenario→test 覆盖账本状态**：46 个场景全部映射；新增 7 个场景（只读载荷正例 + 写载荷/未知载荷反例）对应 🔴→实施后 🟢（新测试全部通过），其余 39 个映射到既有回归测试 🟢。无 `N/A` 条目。
