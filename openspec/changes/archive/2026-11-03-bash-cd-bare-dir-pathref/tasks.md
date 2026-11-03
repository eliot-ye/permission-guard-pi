## 1. 根因复现与基线（RED）

- [x] 1.1 新增 BT-CDBARE-1..4 正例测试（RED）：`cd /proj && find src -type f | head -50`、`cd /proj && grep -rn "p" dist/ | head`、`cd /tmp/x && find /tmp/x/src -type f -maxdepth 2`、`cd /proj && ls node_modules/@earendil-works 2>/dev/null`——全部断言当前 `reliable: false`（RED，本 change 前误报 cd_chdir），测试先于实现。
  - 验证：`node --test --test-name-pattern "BT-CDBARE" --experimental-strip-types test/bash-extract.test.ts` → BT-CDBARE-1..4 全 `✖`（`reliable: false, reason: "cd_chdir"`，RED 成立）。

- [x] 1.2 新增 BT-CDBARE-5..8 反例测试（RED，fail-closed 锁定）：`cd /tmp/x && rm -rf sub`、`cd /etc && find . -type f`、`cd /etc && sort sub`、`cd /tmp/x; ls src`——断言 `reliable: false, reason: "cd_chdir"`（本 change 后仍成立，锁定安全边界）。
  - 验证：同上 → BT-CDBARE-5..8 全 `✔`（基线锁定）。

**关键链**：1.1 → 2.1 → 2.2 → 3.1（TDD RED-GREEN-REFACTOR 主线）。**project buffer**：tier-medium 35%（表 1 critical-buffer），本组为 RED 基线，不占 buffer。

## 2. 根因修复（GREEN）

- [x] 2.1 修复根因 B：`collectStagePathRefs` 加 `find` flag 值跳过集合（`-type`/`-name`/`-maxdepth`/`-mindepth`/`-path`/`-size`/`-mtime`/`-newer`/`-newermt`/`-user`/`-group` 等），flag 值参数不收集为路径引用。
  - 实现：`extractors.ts` 定义 `FIND_NONPATH_FLAG_ARGS`（共享常量，单一事实源，提取侧同步）+ `shell-forwarder.ts` `collectStagePathRefs` find 分支复用跳过。
  - 验证：BT-CDBARE-3（`find /tmp/x/src -type f -maxdepth 2`）转绿（`reliable: true`，target 含 `/tmp/x/src`）。

- [x] 2.2 修复根因 A：D2a 条件 7/9 收窄裸词排除——read-only 文件参数命令（`find`/`grep`/`ls`/`cat` 等，`COMMAND_TABLE` 有 extractor）的裸词目录不再排除，改经 `resolveBase` 提取为 read target；write/delete 裸词仍排除。
  - 实现：`extractors.ts` 定义 `BARE_DIR_EXTRACTABLE` + `canExtractBareDir` 谓词（单一事实源）；`shell-forwarder.ts` 条件 9 收窄——read-only 可提取命令的裸词目录不排除（加 `containsRedirectOperator` 谓词排除重定向操作符形态，fail-closed）。
  - 验证：BT-CDBARE-1/2/4 转绿，BT-CDBARE-5/6 仍 cd_chdir；4 个 `redirect-token-*` 既有断言（含重定向操作符）保持 cd_chdir（非裸词目录，不豁免）。

- [x] 2.3 `readExtract` 加 `bareDirOk` 可选参数（默认 false，向后兼容）：D2a 豁免下 read-only 裸词目录经 `toAbsolutePath(expandHome(t), resolveBase)` push read target；entry.ts 在 D2a 豁免时传 `bareDirOk=true`。
  - 实现：`extractors.ts` `readExtractWithBareDir`（bareDirOk 扩展，同步跳过 grep pattern/find flag 值/重定向 token）+ `grepPatternSkipIdx` 移入 extractors.ts 共享；`entry.ts` 按 `extractor === readExtract` 身份分派传 `bareDirOk=true`。
  - 验证：`tsc --noEmit` 通过（exit=0）；BT-CDBARE-1/2/4 断言 target 含 `/cd目标/裸词目录`；无假目标污染（grep pattern/find flag 值/重定向 token 未被误 push，W2 收敛验证通过）。

**关键链**：2.1 → 2.2 → 2.3（根因修复主线，GREEN）。**project buffer**：本组修复完成后消耗 1/3。

## 3. 回归与收尾（REFACTOR + 验证）

- [x] 3.1 更新既有受影响断言：主 spec 反例 `cd /etc && cat sub`（read-only 裸词）行为变化（原 cd_chdir → 提取 `/etc/sub` read target）——同步更新既有测试断言为预期行为变化，非意外回归。
  - 处置：用户（总体设计部）拍板「回写 spec」——更新 4 个 `BMG-CD-unextractable-read-*` + 1 个 `BMG-CD-redirect-token-rel-posarg-reject` 断言为预期行为变化（裸词目录解析为 read target）；delta + 主 spec 该场景同步改豁免（场景标题保原名匹配，语义写 WHEN/THEN）。
  - 验证：`node --test --test-name-pattern "BMG-CD-unextractable-read-cat-reject|...|BT-CDBARE" --experimental-strip-types test/bash-extract.test.ts` → 13/13 绿。

- [x] 3.2 全量回归：bash-extract 全量 + 项目全量测试跑通。
  - 验证：bash-extract 全量 586/586 绿；项目全量（排除已知既有 flaky AL4/AL7）929/929 绿；`tsc --noEmit` 通过（exit=0）。AL7/AL4 为既有 flaky（HEAD 基线全量跑 2 次：第 1 次 AL4+AL7 都失败 919/921、第 2 次 921/921 全绿——证明基线即偶发，audit.ts 未改动，与本 change 无关）。SYS-KP 载体失效（`find openspec` 裸词目录豁免后不再弹窗）→ 用户拍板更新载体为 `find . -type f | head -50`（仍判 cd_chdir），SYS-KP 复绿。

- [x] 3.3 系统级验证（跨分系统边界，proposal 标注仅 bash-extract 但需确认不触碰 policy-core/audit）：用真实用户命令（`cd /Users/eliot/my/permission-guard-pi && find src -type f | head`）跑 `extractBashTargets` 断言 `reliable: true`；用 `cd /etc && rm -rf sub` 断言 `reliable: false`（fail-closed 保守）。
  - 验证：实测脚本 `find src` → `reliable: true`（target 含 `.../src`）；`cd /etc && rm -rf sub` → `reliable: false`（reason `cd_chdir`）；SYS-KP 跨分系统（trust↔bash-extract↔audit）绿。

- [x] 3.4 `openspec validate <name> --type change` + `openspec validate --all --json` 全库校验通过。
  - 验证：`openspec validate --changes "bash-cd-bare-dir-pathref"` → 1 passed, 0 failed（场景标题改回原名后通过）。

**关键链**：3.1 → 3.2 → 3.3（收尾验证主线）。**project buffer**：3.4 完成后消耗 2/3，剩余 1/3 兜底。

## 4. 归档前 review（可选，若架构 review 有 warning）

- [x] 4.1 若步骤 7 架构 review 报 warning，按 review 意见修正 proposal/design 后复验（无 warning 则跳过本组，任务标记 N/A 并注明理由）。
  - 处置：**N/A**——步骤 7 架构 review 结论 `APPROVED_WITH_CHANGES`（无 critical，W1-W4 已在 propose 阶段收紧进 proposal/design，实施中无架构级 warning 残留）；收尾 review 判出的 1 critical + 1 warning + 1 nit 属代码级（非架构级），已修复 + 回写注记 + 复审 APPROVED。
  - 验证：收尾 review 复审 Verdict `APPROVED`（subagent 隔离），无架构级 critical/warning 残留。
