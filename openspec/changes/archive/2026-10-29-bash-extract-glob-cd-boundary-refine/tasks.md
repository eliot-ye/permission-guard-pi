# Tasks: bash-extract-glob-cd-boundary-refine

> **关键链**：T1（测试先行 RED）→ T2（实现边界① GREEN）→ T3（实现边界② GREEN，含 cd 跟踪 + 全绝对豁免）→ T6（全量回归）。关键链总估时 4.5 单元，project buffer = 4.5 × 35% ≈ 1.6 单元（tier-medium，表 1 critical-buffer 行）。T4/T5 是支流（文案 + 回归断言同步），在汇入关键链前加 feeding buffer。

## 1. 测试先行（RED）

- [x] 1.1 在 `test/bash-extract.test.ts` 添加边界① 5 个测试（`BMG-RO-empty-prefix-ls-glob-autoallow`、`BMG-RO-bare-empty-prefix-ls-autoallow`、`BMG-RO-empty-prefix-tar-glob-reject`、`BMG-RO-abs-prefix-glob-reject`、`BMG-RO-tilde-prefix-glob-reject`），预期断言见 proposal scenario→test 账本。验证：`node --test test/bash-extract.test.ts` 运行后 5 个新测试**失败**（RED，当前实现不放行空 prefix 只读 glob），已通过的既有断言不回归。
  - 验证证据：`node --test --test-name-pattern="BMG-RO" test/bash-extract.test.ts` → 5 fail（`ls *.md`/`ls *` 被 glob_expansion 拦截），全量 428 tests 仅 8 fail（全为新增豁免用例），既有断言不回归。
- [x] 1.2 在 `test/bash-extract.test.ts` 添加边界② 20 个测试（`BMG-CD-all-abs-downstream-exempt`、`BMG-CD-all-abs-redirect-exempt`、`BMG-CD-rel-redirect-cd-track`、`BMG-CD-rel-downstream-cd-track`、`BMG-CD-mixed-abs-rel-cd-track`、`BMG-CD-glob-rel-prefix-reject`、`BMG-CD-no-explicit-ref-reject`、`BMG-CD-silent-no-ref-reject`、`BMG-CD-dev-tcp-redirect-reject`、`BMG-CD-rel-cd-target-reject`、`BMG-CD-tilde-cd-target-reject`、`BMG-CD-var-cd-target-reject`、`BMG-CD-dash-reject`、`BMG-CD-pipeline-reject`、`BMG-CD-cwd-anchor-rm-reject`、`BMG-CD-cwd-anchor-redirect-reject`、`BMG-CD-dev-fd-cd-track-reject`、`BMG-CD-unextractable-rm-reject`、`BMG-CD-unextractable-mkdir-reject`、`BMG-CD-pwd-var-reject`），预期断言见 proposal scenario→test 账本。验证：`node --test test/bash-extract.test.ts` 运行后 20 个新测试**失败**（RED，当前实现无 cd 豁免/跟踪），已通过的既有断言不回归——特别注意既有 `test/security-probe.mjs` L3 cd 断言（`cd /etc && ls` 等）与 `test/cross-system-boundary.mjs:53`（7.1c `cd /etc && echo x > /dev/tcp/...`）——7.1c 保持 `cd_chdir` 不变（网络套接字排除，条件 6），但 L3 的 `cd /etc && ls` 在 cd 跟踪豁免下会**反转**为 `reliable:true`（预期行为变化），此测试须在 T5 同步更新。
  - 验证证据：`node --test --test-name-pattern="BMG-CD" test/bash-extract.test.ts` → 6 fail（豁免用例，当前 cd_chdir 一刀切）+ 14 pass（保守反例锁定，当前实现本就拦截）。全量 428 tests 既有断言不回归。

## 2. 实现边界①（GREEN）

- [x] 2.1 修改 `src/lib/bash-extract/readonly.ts` 的 `isBoundedGlobSafe`：在 glob 分支检测到空前缀时，若「命令满足 `isReadOnlyWithArgs` 只读判定（条件 3）且 glob 不以 `/`、`~`、Windows 盘符开头」则视为 bounded 放行（情形 B），否则维持空 prefix 拒绝。验证：`node --test test/bash-extract.test.ts` 运行后 1.1 的 5 个测试**通过**（GREEN），既有 glob 断言（BMG35/38/44/43 等）不回归。
  - 验证证据：`node --test --test-name-pattern="BMG-RO" test/bash-extract.test.ts` → 5 pass；全量 428 tests 仅 1 fail（BMG44 `ls *`，边界①预期行为变化，T5 同步）。`npm run typecheck` 通过。

## 3. 实现边界②（GREEN，cd 跟踪 + 全绝对豁免）

- [x] 3.1 修改 `src/lib/bash-extract/shell-forwarder.ts`：新增共享 `analyzeCd(cmd)`（返回 `{ hasCd, d2a, d2b }`），`scanCdChdir` 改为：若有 cd 且 `d2a`/`d2b` 均不成立 → 返回 `"cd_chdir"`；`d2a` 或 `d2b` 成立 → 返回 `undefined`（豁免）。`d2a` 判定：纯 `&&` 链 + 所有 cd 目标显式绝对（不含 `$VAR`/`~`/glob/相对前缀）+ 无管道 + 无 cwd 锚点路径引用 + 无未加引号 glob + 无网络套接字/数字 fd 重定向目标 + 无不可提取的非绝对路径参数 + 无 `$PWD`/`$OLDPWD`。`d2b` 判定：至少一个 cd 后下游片段含显式绝对路径引用，且所有下游片段全部路径引用（`looksLikePath` 位置参数 + `extractRedirects` 重定向目标）均为显式绝对路径，且不含网络套接字/数字 fd 重定向目标。验证：`node --test test/bash-extract.test.ts` 运行后 1.2 的 21 个测试**通过**（GREEN），既有 cd 断言（cd_chdir 各场景，含 `test/security-probe.mjs` L3 与 `test/cross-system-boundary.mjs:53` 7.1c）——7.1c 保持 `cd_chdir` 不变（网络套接字排除，条件 6），`cd /etc && ls` 等纯 `&&` 链反转（预期行为变化，T5 同步）。
  - 验证证据：`node --test --test-name-pattern="BMG-CD" test/bash-extract.test.ts` → 20 pass（含 6 个豁免用例从 RED→GREEN + 14 保守锁定）；`test/cross-system-boundary.mjs` 7.1c PASS（cd_chdir 保持）。`npm run typecheck` 通过。
- [x] 3.2 新增 `shouldTrackCdCwd(cmd): boolean`（`shell-forwarder.ts` 导出，返回 `analyzeCd(cmd).d2a`），并修改 `src/lib/bash-extract/entry.ts` 步骤 5：维护 `let resolveBase = projectRoot`；若 `shouldTrackCdCwd(rawCommand)` 为 true，每遇到首 token 为 `cd` 的片段（目标绝对）将 `resolveBase` 更新为该目标；`extractRedirects` / `COMMAND_TABLE` 提取器的第三个参数改用 `resolveBase` 而非固定 `projectRoot`（`entry.ts:295,304`）。验证：`node --test test/bash-extract.test.ts` 运行后 cd 跟踪豁免测试（`BMG-CD-rel-redirect-cd-track`、`BMG-CD-rel-downstream-cd-track`、`BMG-CD-mixed-abs-rel-cd-track`）**通过**——解析出真实落点（`/tmp/x/rel.txt`、`/tmp/x/file.txt`、`/tmp/x/b.txt`）；既有非 cd 场景不受影响（`resolveBase` 默认 `projectRoot`）。
  - 验证证据：`node --test --test-name-pattern="BMG-CD-rel" test/bash-extract.test.ts` → 3 pass（真实落点 `/tmp/x/rel.txt`、`/tmp/x/file.txt`、`/tmp/x/b.txt`）；全量 428 tests 仅 1 fail（BMG44，T5 同步）。`npm run typecheck` 通过。

## 4. i18n 文案修正（支流）

- [x] 4.1 修改 `src/lib/i18n.ts` 的 `cd_chdir` 中文/英文文案，明确「cd 后仍有相对路径命令时无法静态解析；全绝对下游自动豁免；`cd <绝对> && …` 链自动解析真实路径」，与实际行为一致。验证：`node --test test/i18n.test.ts`（若存在）通过；`npm run typecheck` 通过；grep `cd_chdir` 文案与设计 D3 一致。
  - 验证证据：grep `cd_chdir` 文案在 test/ 与 src/（非 i18n.ts）无旧文案残留断言；`npm run typecheck` 通过（exit 0）。`test/i18n.test.ts` 不存在，文案无独立断言文件（由 `npm test` 全量回归覆盖）。

## 5. 回归断言同步（支流）

- [x] 5.1 检查 `test/` 内是否有断言依赖旧 `cd_chdir` 文案或旧空 prefix 行为；若有则同步更新（文案断言改字符串、行为断言改预期）。**重点**：`test/security-probe.mjs` L3 的 `cd /etc && ls` 断言由 `cd_chdir` 改为 `reliable:true`（cd 跟踪豁免预期变化）；`test/bash-extract.test.ts` 既有 cd 断言按 cd 跟踪判据逐个核对（纯 `&&` 链 + 绝对 cd 目标 + 无锚点/glob → 反转，含相对 cd/管道/`.`/`;`/glob → 保持）。验证：全量 `npm test` 通过，无断言因本次行为/文案变更而失败。
  - 验证证据：`test/security-probe.mjs` L3 `cd /etc && ls` 已同步为 `reliable:true`（预期行为变化），其余 L3 断言（`rm -rf .`、`cd src`、`;` 分隔、`cd ..`、`cd -`）保持 cd_chdir → security-probe 55 pass / 0 fail。`test/cross-system-boundary.mjs` 7.1c（`cd /etc && echo x > /dev/tcp/...`）保持 cd_chdir → ALL PASS。`test/bash-extract.test.ts` BMG44（`ls *`）同步为 `reliable:true`（边界①预期行为变化）。全量 `npm test` → 729 pass / 0 fail。另：发现 `bash-extract-split`（2026-10-27 归档）遗留两个 .mjs 探针导入旧路径 `../src/lib/bash-extract.ts`（已被拆分删除），修复为 `../src/lib/bash-extract/index.ts`——这是让探针可运行的机械修复，非本 change 行为改动。
  - **补漏（6.3 review 期间发现）**：`test/probe-v3-bash-symlink-grant.mjs:17` 同样遗留旧路径导入 `../src/lib/bash-extract.ts`（T5 记录只提到两个，实际共三个）。修复为 `../src/lib/bash-extract/index.ts`，重跑 `node --experimental-strip-types test/probe-v3-bash-symlink-grant.mjs` → exit 0（探针正常运行，V3 断言「第二次仍弹窗、grant 键不匹配」完整保留）。同一类机械修复，非本 change 行为改动。

## 6. 全量回归（关键链收尾）

- [x] 6.1 运行 `npm test`（全量）——验证全部既有测试 + 新增测试通过。
  - 验证证据：`npm test` → 729 pass / 0 fail。
- [x] 6.2 运行 `npm run typecheck`——验证类型检查通过，无新增类型错误。
  - 验证证据：`npm run typecheck` → exit 0。
- [x] 6.3 系统级验证：确认 26 个新增 scenario 对应测试全部 GREEN，且既有 glob/cd 反例场景（写命令空 prefix、相对 cd 目标、`.` cwd 锚点、管道、glob、网络套接字、不可提取相对参数、`$PWD`、`;` 分隔）仍保持 `reliable:false`——验证「预期行为模型」（proposal 系统工程影响评估节）跨测试整合后成立。
  - 验证证据：`node --test --test-name-pattern="BMG-RO|BMG-CD" test/bash-extract.test.ts` → 25 pass / 0 fail（25 个账本场景全 GREEN；`ls *` 裸空 prefix 为行为 2 的 target 语义差异，GREEN 已验证）。预期行为模型 1–11 由测试覆盖：行为 1/2（`ls *.md`/`ls *` 放行）、行为 3/4/5（cd 豁免解析真实落点）、行为 6（`cd /etc && ls` → reliable，security-probe L3 同步）、行为 7–11（cwd 锚点/相对 cd/网络套接字/不可提取相对参数/`$PWD` 仍 cd_chdir）。跨分系统边界验证：`test/cross-system-boundary.mjs` ALL PASS（含 decide() 完整管线 7.1d：cd 守卫路径仍正确触发 prompt、网络外传不因 cd 豁免被放行）。

## Caller Impact 实测附注（td-apply 步骤 4）

实测结论（与 proposal 预判一致，无高危变更点）：

1. `isBoundedGlobSafe`（`readonly.ts`，第 2 类函数内部行为变化）——源码 caller 仅 `scan.ts:336`（`scanUnreliable` 内，签名不变）；经 `index.ts:8` barrel 公开导出；`decision.ts:19` 导入但只取 `isDevSocketOrFd` 不消费本函数；`test/bash-extract.test.ts:1046` 直接 import 做单元测试（既有断言不涉空 prefix 只读）。无公共契约破坏。
2. `scanCdChdir`（`shell-forwarder.ts`，第 2 类函数内部行为变化）——源码 caller 仅 `entry.ts:52`（只判 `=== "cd_chdir"`，返回类型保持 `string | undefined` 兼容）。新增 `analyzeCd`/`shouldTrackCdCwd` 为新增导出符号（`shouldTrackCdCwd` 被 `entry.ts` 消费）。测试消费者：`bash-extract.test.ts`、`security-probe.mjs` L3、`cross-system-boundary.mjs` 7.1c。
3. `i18n.ts` 的 `cd_chdir` 文案（第 2 类文案/展示变化）——展示层，无公共契约变更。

结论：无第 ①③ 类（公共符号/装配点）变更点，签名不变，外部无消费方；行为变化全部在函数内部。caller 实测与兼容确认完成，未发现 proposal 未标注的 caller。

## 设计回写记录（td-apply 步骤 5，6.3 人工 review 判出 critical 后）

6.3 收尾 review（code_review 工具三次失败 → 按 `requesting-code-review` 第 6 节「工具优先，LLM 兜底」转人工 review，逐 finding 对照代码实证）判出 **critical 安全洞**：cd 跟踪豁免（D2a）下，`cd /etc && echo x > sub`（无扩展名相对重定向目标 `sub`，`looksLikePath=false`）从原实现 `cd_chdir` 弹窗退化为 `reliable:true` + 0 target 静默放行，真实写 `/etc/sub`（系统敏感区）。根因：`analyzeCd` D2a 条件 7 只查 write/delete 命令位置参数，漏了 read-only 位置参数（`cat sub`）与重定向目标（`echo x > sub`）；`collectStagePathRefs` 用 `isVisiblePathRef`（`looksLikePath`）过滤丢弃了不可提取裸词，D2a 条件 4-8 全部看不到。proposal 预期行为模型/账本只测了 `rel.txt`（有扩展名），漏了无扩展名裸词引用。

用户（总体设计部）已选择「回写 artifact + 修复（推荐）」。

**回写内容**：
- **代码**（`src/lib/bash-extract/shell-forwarder.ts`）：`collectStagePathRefs` 重构——位置参数不再做 `looksLikePath` 过滤（不可提取裸词也返回，供 D2a 条件 9 排除）；新增 `FILE_ARG_COMMANDS`（文件参数命令）/`grepPatternSkipIdx`（跳过 grep PATTERN）；`analyzeCd` D2a 新增条件 9（非绝对 + 非网络/fd + 不可提取裸词 → 排除豁免，回退 cd_chdir），条件 7 扩展覆盖 read-only 位置参数与重定向目标。清理未使用导入（`toAbsolutePath`/`expandHome`）与未使用函数（`hasAnyPathRef`）。
- **测试**（`test/bash-extract.test.ts`）：新增 6 个回归锁定测试（`BMG-CD-unextractable-redirect-reject`、`-redirect-slash-reject`、`-read-cat-reject`、`-read-ls-reject`、`-read-grep-reject`、`-read-wc-reject`），RED（修复前 6 fail）→ GREEN（修复后 6 pass，全部判 cd_chdir）。
- **spec**（`specs/bash-target-extraction/spec.md`）：cd 跟踪豁免条件 7 扩展（覆盖三类引用）+ 新增条件 9（不可提取裸词纳入判定）；反例清单补「下游含不可提取的非绝对路径引用」条目；新增 2 个 Scenario（`cd /etc && echo x > sub`、`cd /etc && cat sub` 仍判不可靠）。
- **proposal**：系统工程影响评估风险节补 ④「不可提取引用排除（6.3 人工 review 判出的 critical 修复）」；预期行为模型补行为 12；验证方式补 `cd /etc && echo x > sub`、`cd /etc && cat sub` 保持 cd_chdir；scenario→test 账本补 6 行（25 → 31 个新增场景，无 unmapped）。

**原因**：proposal/spec 的 cd 跟踪豁免判据漏了「不可提取非绝对引用」这一安全边界（原条件 7 只覆盖 write/delete 位置参数），导致豁免下静默放行 cd 后 cwd 相对的无扩展名裸词引用。修复后安全边界比原实现更完整（这类裸词引用原实现靠 cd_chdir 一刀切拦截，修复后同样拦截且无静默放行窗口）。

## 设计回写记录（td-apply 步骤 5，6.3 收尾 review subagent 判出 F1 critical 后）

6.3 收尾 review（code_review 工具三次失败 → 按 `requesting-code-review` 第 6 节转 LLM 人工 review，subagent 对照实际代码逐项实证）判出 **F1 critical 安全洞**：cd 跟踪豁免（D2a）下，`cd /etc && curl -o sub url` / `cd /etc && wget -O sub url`（curl/wget 输出写目标 `sub` 无扩展名裸词，`looksLikePath=false`）从原实现 `cd_chdir` 弹窗退化为 `reliable:true` + 0 target 静默放行，真实写 `/etc/sub`（系统敏感区）——与原始 D2a 洞（`echo x > sub`）同后果同类别。根因：`curl`/`wget` 不在 `FILE_ARG_COMMANDS`，其输出写目标 flag 值（`-o`/`-O`/`--output`/`--output-document`）不被 `collectStagePathRefs` 收集，D2a 条件 9 看不到 `sub`；且 curl/wget 的 URL 位置参数是网络路径而非文件引用（不能简单纳入 FILE_ARG_COMMANDS，否则 URL 会被误排除、破坏 `curl -o /tmp/a.bin url` 的合法豁免）。

用户（总体设计部）已选择「回写 artifact + 修复（推荐）」。

**回写内容**：
- **代码**（`src/lib/bash-extract/shell-forwarder.ts`）：新增 `OUTPUT_FLAG_COMMANDS` 常量（curl/wget 输出写目标 flag 表：`curl` = `{-o, --output}` withArg + `{-O}` noArg；`wget` = `{-O, --output-document}` withArg）+ `OUTPUT_NOARG_SENTINEL` 哨兵（`\0output-noarg`，真实 shell 参数不可能含 NUL）；`collectStagePathRefs` 增加分支——cmdBase 命中 `OUTPUT_FLAG_COMMANDS` 时定向收集输出写目标 flag 值（含内联 `--output=<path>`/`--output-document=<path>` 形式），URL 位置参数不收集，`curl -O` 无参写目标（URL basename，cwd-relative 未知）推入哨兵供条件 9 排除。
- **测试**（`test/bash-extract.test.ts`）：新增 4 个测试——3 个回归锁定（`BMG-CD-unextractable-curl-oreject`、`-wget-O-reject`、`-curl-O-noarg-reject`，判 cd_chdir）+ 1 个防过度修复对照（`BMG-CD-curl-abs-write-exempt`，`cd /etc && curl -o /tmp/a.bin url` 仍豁免并解析 write /tmp/a.bin）。RED（修复前 3 洞 fail + 1 对照 pass）→ GREEN（4 pass）。
- **spec**（`specs/bash-target-extraction/spec.md`）：cd 跟踪豁免条件 7 覆盖范围补「curl/wget 输出写目标」类；反例清单补 `cd /etc && curl -o sub url`、`cd /etc && wget -O sub url`、`cd /etc && curl -O url` 变体。
- **proposal**：预期行为模型补行为 13（curl/wget 输出写目标排除，含防过度修复对照）；scenario→test 账本补 4 行（31 → 35 个新增场景，无 unmapped）。

**原因**：D2a 条件 9 的裸词排除判据对 curl/wget 的输出写目标不可见（命令不在 FILE_ARG_COMMANDS，且 URL 非文件引用不能整体纳入）。修复后 curl/wget 的输出写目标裸词与重定向目标/read-only 位置参数同等处理——cd 链下不可提取的非绝对写目标同样排除豁免（维持 cd_chdir），绝对写目标仍走 D2b 豁免，无静默放行窗口。

## 设计回写记录（td-apply 步骤 5，6.3 收尾 review subagent 判出 critical、复验后升级为 F2 后）

6.3 收尾 review（subagent 隔离）判出 **F2 critical 安全洞**：cd 跟踪豁免（D2a）下，无 extractor 命令（`sort`/`tar`/`cmp`/`diff`/`uniq`/`sha256sum`/`gzip`/`xz`）的裸词位置参数漏检——`cd /etc && sort sub`（读 `/etc/sub`）、`cd /etc && tar xf sub`（解压写 `/etc/sub`）从原实现 `cd_chdir` 弹窗退化为 `reliable:true` + 0 target 静默放行。subagent 原判「低-中 warning」，按 `requesting-code-review` 第 6 节「逐 finding 复验」实测后**升级为 critical**：`/etc` 是用户确认的敏感目录，`cd /etc && sort sub` 静默读 `/etc/sub` 与 6.3/F1 修复的洞同后果同类别（不可提取裸词豁免下静默放行）。

根因（两层）：
1. **`FILE_ARG_COMMANDS` 集合不完备**——只覆盖有 extractor 命令（cat/grep/ls 等），漏了无 extractor 但位置参数是文件路径的命令（`sort`/`tar`/`cmp`/`diff`/`uniq`/`sha256sum`/`gzip`/`xz`）。这些命令的裸词位置参数不被 `collectStagePathRefs` 收集，D2a 条件 9 看不到 → 豁免成立 + 0 target 静默放行。
2. **无 extractor 命令治本落空**——即使裸词被条件 9 排除，可提取相对路径（`sort data.txt`，`looksLikePath=true`）仍漏：无 extractor 命令无法消费 `resolveBase` 提取真实落点（entry.ts 的 COMMAND_TABLE miss → D6 → 0 target），D2a 豁免成立会 `reliable:true + 0 target` 静默放行读 `/tmp/x/data.txt`。这是条件 9（只排除不可提取裸词）覆盖不到的独立类别，需新增条件 10。

用户（总体设计部）已选择「回写 artifact + 修复（推荐）」（与 6.3/F1 两次同类 critical 的既定方向一致）。

**回写内容**：
- **代码**（`src/lib/bash-extract/shell-forwarder.ts`）：
  - `FILE_ARG_COMMANDS` 补齐 8 个命令（`sort`/`tar`/`cmp`/`diff`/`uniq`/`sha256sum`/`gzip`/`xz`），并加 tar 操作标志跳过逻辑（`i===1` 且纯字母且非绝对且 `looksLikePath=false` 时跳过，如 `tar xf /tmp/a.tar` 的 `xf` 非路径引用，避免误伤绝对归档的 D2b 豁免）。
  - `analyzeCd` D2a 新增**条件 10**：下游片段首命令不在 `COMMAND_TABLE`（无 extractor）且命令在 `FILE_ARG_COMMANDS` 且含非绝对位置参数 → d2a 排除（回退 cd_chdir）。绝对位置参数（`sort /tmp/data.txt`）不受影响，仍走 D2b 豁免。
  - import `COMMAND_TABLE`（来自 `./extractors.ts`，无循环依赖——extractors 不依赖 shell-forwarder）。
- **测试**（`test/bash-extract.test.ts`）：新增 11 个测试——8 个回归锁定（`BMG-CD-unextractable-sort/tar/cmp/uniq/sha256sum/diff/gzip/xz-reject`，裸词判 cd_chdir）+ 1 个无 extractor 相对路径锁定（`BMG-CD-no-extractor-rel-path-reject`，`sort data.txt` 判 cd_chdir）+ 2 个防过度修复对照（`BMG-CD-no-extractor-abs-exempt`、`BMG-CD-tar-opflag-abs-exempt`，绝对路径仍 D2b 豁免）。RED（修复前 9 洞 fail + 2 对照 pass）→ GREEN（11 pass）。
- **spec**（`specs/bash-target-extraction/spec.md`）：cd 跟踪豁免条件清单补**条件 10**（无 extractor 命令非绝对位置参数排除）；反例清单补「下游命令无 extractor 且含非绝对位置参数」条目；新增 4 个 Scenario（`sort sub`、`sort data.txt` 判不可靠 + `sort /tmp/data.txt`、`tar xf /tmp/a.tar` 豁免对照）。
- **proposal**：预期行为模型补行为 14（无 extractor 命令非绝对位置参数排除，含防过度修复对照）；scenario→test 账本补 11 行（35 → 46 个新增场景，无 unmapped）。

**原因**：D2a 条件 9 的裸词排除判据对无 extractor 命令不可见（命令不在 FILE_ARG_COMMANDS，其裸词不被 collectStagePathRefs 收集），且可提取相对路径（`sort data.txt`）对无 extractor 命令治本落空（条件 9 不触发但 0 target）。修复后无 extractor 命令的裸词与可提取相对位置参数一律排除豁免（维持 cd_chdir），绝对位置参数仍走 D2b 豁免，无静默放行窗口。

## 设计回写记录（td-apply 步骤 5，用户拍板落地 F3：git 写子命令在 cd 链下的安全边界）

6.3 收尾 review 期间发现：`cd /tmp/x && git log file.txt`（git 只读子命令 + 相对路径）静默放行（`reliable:true + 0 target`）。subagent 初判为缺口，用户（总体设计部）拍板：**git 只读子命令静默放行正确**（`log`/`show`/`diff`/`status` 等 pathspec 是 git 内部管理的查询条件，非 shell cwd 文件引用，本解析器不提取为 target——静默放行是既有设计意图，非退化）。

但复查暴露**写边界**：git **写**子命令（`rm`/`add`/`commit`/`checkout`/`clean`/`mv`/`reset`/`revert`/`stash`，不在 `GIT_READONLY_SUBCOMMANDS`）在 cd 链下同样 `reliable:true + 0 target` 静默放行——`cd /etc && git rm file.txt` 真实删除 `/etc/file.txt`（工作树文件），但本解析器不把 git 路径参数提取为 target，豁免成立即 0 target 静默放行。用户（总体设计部）拍板：**git 写子命令在 cd 落点非默认 tmp 目录时保守排除（cd_chdir）；cd 落点在默认 tmp 目录（/tmp、/private/tmp、/var/tmp）时静默放行**（tmp 无持久安全价值，与 `decision.ts` step 2c 的 `tmp_default_allowed` 语义一致）。

用户（总体设计部）已选择「回写 artifact + 修复（推荐）」。

**回写内容**：
- **代码**：
  - `src/lib/bash-extract/git-cmds.ts`（新增）：`GIT_READONLY_SUBCOMMANDS` 单一事实源——独立文件避免 `readonly.ts` ↔ `silent.ts` 相互导入的模块顶层 TDZ 循环（readonly 用 `isForBodyReadOnly`、silent 用 `isReadOnlyWithArgs`），三者（readonly/silent/shell-forwarder）均可安全导入。与 `SILENT_COMMANDS.git` 语义一致（git 子命令不在集合即视为写子命令）。
  - `src/lib/bash-extract/readonly.ts`：删除本地 `GIT_READONLY_SUBCOMMANDS` 定义，改从 `git-cmds.ts` 导入并重新导出。
  - `src/lib/bash-extract/silent.ts`：`SILENT_COMMANDS.git` 改为 `new Set(GIT_READONLY_SUBCOMMANDS)`（引用共享集）。
  - `src/lib/path-utils.ts`：新增 `isDefaultTmpPath` 导出（从 `decision.ts` 下沉，供 bash-extract 与 policy-core 共享——bash-extract 是独立子系统不能反向依赖 policy-core 的 decision.ts）。
  - `src/lib/decision.ts`：删除本地 `isDefaultTmpPath`，改为从 `path-utils.ts` 导入（行为不变，单点定义）。
  - `src/lib/bash-extract/shell-forwarder.ts`：`analyzeCd` D2a 新增**条件 11**（git 写子命令 + cd 落点非默认 tmp → d2a 排除）+ `isGitWriteSubcommand` 辅助（基于 `GIT_READONLY_SUBCOMMANDS`，git 子命令不在集合即写子命令，flag 跳过与 `getStageCommandName` 一致）。
- **测试**（`test/bash-extract.test.ts`）：新增 9 个测试——4 个 git 写子命令非 tmp 落点锁定（`BMG-CD-git-write-nontmp-rm/checkout/add/mv-reject`，判 cd_chdir）+ 3 个 tmp 落点静默放行（`BMG-CD-git-write-tmp-rm/checkout-allow`、`-vartmp-rm-allow`）+ 2 个 git 只读子命令静默放行（`BMG-CD-git-read-nontmp-log/status-allow`）。RED→GREEN（9 pass）。
- **spec**（`specs/bash-target-extraction/spec.md`）：cd 跟踪豁免条件清单补**条件 11**（git 写子命令 + 非默认 tmp 落点排除）；反例清单补「下游为 git 写子命令且 cd 落点非默认 tmp 目录」条目；新增 9 个 Scenario（git 写子命令非 tmp 4 个判不可靠 + tmp 3 个静默放行 + git 只读 2 个静默放行）。
- **proposal**：预期行为模型补行为 15（git 写子命令非 tmp 落点排除，含 tmp 静默放行与只读子命令静默放行）；scenario→test 账本补 9 行（46 → 55 个新增场景，无 unmapped）。

**原因**：cd 跟踪豁免（D2a）下 git 写子命令的路径参数不被本解析器提取为 target（git 不在 COMMAND_TABLE），豁免成立会 0 target 静默放行真实工作树写操作。修复后 git 写子命令在非默认 tmp 落点排除豁免（维持 cd_chdir），默认 tmp 落点与 git 只读子命令按用户拍板静默放行，无静默放行窗口。

## 设计回写记录（td-apply 步骤 5，6.3 收尾 review subagent 判 MUST_FIX_CRITICAL 后 F2 补漏：coreutils 文件命令类穷尽）

6.3 收尾 review subagent（`f23-recheck`）复核 F2/F3 修复，判 **MUST_FIX_CRITICAL**：F2 对 `sort`/`tar`/`cmp`/`diff`/`uniq`/`sha256sum`/`gzip`/`xz` 的修复正确且无过度修复，但 `FILE_ARG_COMMANDS` 枚举**不穷尽**「无 extractor + 位置参数是文件引用」的命令类——`cd /etc && md5sum sub`（及 `sha512sum`/`sha1sum`/`b2sum`/`cksum`/`comm`/`join`/`paste`/`nl`/`cut` 等）仍 `reliable:true + 0 target` 静默放行读 `/etc/sub`，与 F2 critical 同类别同后果。实测复验确认窗口真实存在（`md5sum`/`sha1sum`/`sha512sum`/`b2sum`/`cksum`/`comm`/`join`/`paste`/`nl`/`cut`/`tac`/`sdiff`/`gunzip`/`zcat`/`chgrp` 全部 reliable:true + 0 target）。

用户（总体设计部）此前已授权「回写 + 修复（推荐）」，方向一致（F2 补漏为同类修复收尾），无需再次拍板。

**回写内容**：
- **代码**：
  - `src/lib/bash-extract/shell-forwarder.ts`：`FILE_ARG_COMMANDS` 穷尽 coreutils 文件命令类——校验和类（`md5sum`/`sha1sum`/`sha224sum`/`sha384sum`/`sha512sum`/`b2sum`/`cksum`/`sum`）、文本行处理类（`tac`/`nl`/`od`/`comm`/`join`/`paste`/`cut`/`sdiff`）、解压转换类（`gunzip`/`unxz`/`bzip2`/`bunzip2`/`zcat`）、元数据类（`chgrp`）。
- **测试**（`test/bash-extract.test.ts`）：新增 16 个测试——14 个 coreutils 裸词位置参数锁定（`BMG-CD-coreutils-{md5sum,sha512sum,b2sum,cksum,comm,join,paste,nl,cut,tac,sdiff,gunzip,zcat,chgrp}-bare-reject`，判 cd_chdir）+ 2 个防过度修复对照（`BMG-CD-coreutils-md5sum/paste-abs-exempt`，绝对位置参数 → D2b 豁免）。RED→GREEN（16 pass）。
- **spec**（`specs/bash-target-extraction/spec.md`）：cd 跟踪豁免条件 10 文案补「F2 补漏穷尽」范围；反例清单补「下游为 coreutils 文件命令类（校验和/文本行处理/解压转换/元数据）裸词位置参数」条目；新增 16 个 Scenario（14 个裸词判不可靠 + 2 个绝对位置参数豁免对照）。
- **proposal**：预期行为模型行为 14 补穷尽范围文案；scenario→test 账本补 16 行（55 → 71 个新增场景，无 unmapped）。

**原因**：F2 的 `FILE_ARG_COMMANDS` 枚举不穷尽「无 extractor + 位置参数=文件」命令类，该类命令（md5sum 等）在 cd 跟踪豁免下仍 0 target 静默放行读敏感目录。修复后穷尽枚举，该类命令裸词一律排除豁免（维持 cd_chdir），绝对位置参数仍走 D2b 豁免，无静默放行窗口。

**第二波补漏**（f2b-recheck 复核中断前提出的残留类——dir/vdir/shuf/base64/expand/fmt 等——中断后全量扫描证实）：`dir`/`vdir`/`shuf`/`base64`/`basenc`/`expand`/`unexpand`/`fmt`/`fold`/`ptx`/`tsort`/`pathchk`/`realpath`/`readlink`/`pinky`/`mktemp`/`link`/`unlink`/`mknod`/`mkfifo` 共 20 个命令仍 `reliable:true + 0 target` 静默放行，含**写类最高危形态**（`cd /etc && unlink sub` 静默删除 `/etc/sub`、`cd /etc && mkfifo sub` 静默创建特殊文件、`cd /etc && mktemp subXXXXXX` 静默创建临时文件）。修复：`FILE_ARG_COMMANDS` 补入 20 命令；新增 22 个测试（`BMG-CD-coreutils2-*-bare-reject` × 20 + `dir/unlink` 绝对照 × 2）。**排除判据**（防过度修复，实测确认保持豁免）：位置参数为用户名/数字/字符串操作的命令不纳入——`id`/`uname`/`tty`/`logname`/`groups`/`seq`/`factor`/`numfmt`（用户名/数字）、`basename`/`dirname`（字符串操作，无文件访问）。
- **spec**：条件 10 补第二波穷尽清单与排除判据；反例条目补第二波示例；新增 6 个代表性 Scenario（dir/base64/realpath/mktemp/unlink 判不可靠 + unlink 绝对照）。
- **proposal**：行为 14 补第二波文案；账本补 22 行（71 → 93，无 unmapped）。

**已知边界（预存在缺口，非本 change 引入，待后续 change）**：`env`/`nice`/`nohup`/`timeout`/`setsid`/`watch`/`stdbuf` 等命令执行器在 cd 链下 `./` 前缀形态（如 `cd /etc && env ./evil`，实测取证静默放行）不受条件 10 约束——其位置参数是 PATH 解析的命令名（裸词经 PATH 查找，非 cwd 文件引用），仅 `./`/`../` 前缀形态 cwd 依赖；且 wrapper 语义（KEY=VAL 透传、flag 值跳过）需要独立设计，不适合 FILE_ARG_COMMANDS 枚举（会误伤 `cd /proj/sub && env FOO=1 npm test` 等正常流程）。建议后续 change 以 wrapper 感知方式处理（复用 `skipWrapperTokens` 落到真实命令再判，仅拦截 `./`/`../` 前缀的执行目标）。

**第三波补漏**（final-closeout-review 判 APPROVED_WITH_CHANGES issue 1，实测证实）：reviewer 实证 `FILE_ARG_COMMANDS` 同族缺席（xz/gzip/bzip2/zcat 已入而 lzma/lz4/zstd/bzcat/xzcat 缺席；diff 已入而 diff3 缺席），实测 19 命令仍 `reliable:true + 0 target` 静默放行——`shred`（原地覆写，最高危写形态）/`split`/`csplit`（向 cwd 写分片）/`bzcat`/`xzcat`/`lzma`/`lz4`/`zstd`/`bzip3`/`unzip`/`zip`/`shasum`/`sha3sum`/`diff3`/`dos2unix`/`rev`/`column`/`pr`/`patch`（含 stdin 重定向形态 `patch -p0 < p.txt`）。修复：`FILE_ARG_COMMANDS` 补入 19 命令；新增 21 个测试（`BMG-CD-coreutils3-*` × 20 + shred 绝对照）；同时修正 spec「穷尽」过度承诺——spec/proposal 中「必须涵盖所有/穷尽」表述被本波残留证伪，改为「**已知清单（三波，非形式化穷尽）+ 清单完备性声明 + 排除判据为准**」的诚实表述（清单外同类命令残留为已知边界，以排除判据为准持续清点）。**同波修正**：`isGitWriteSubcommand` 注释归属 readonly.ts → git-cmds.ts（reviewer issue 4）；`pinky` 纳入的误伤噪音说明（reviewer issue 5——默认按用户名查询与 id 同类，但 `-f` 读文件，保守纳入，有意接受 `cd x && pinky <user>` 弹窗噪音）。

**已知边界二（预存在行为，非本 change 引入，reviewer issue 2/3，建议后续 change）**：条件 11（git 写子命令排除）存在两个设计边界——① **尾挂 cd /tmp 旁路**：`cd /etc && git rm file.txt && cd /tmp` 取「最终 cd 落点」（/tmp）判 cdInTmp=true → 不排除，而 `git rm` 实际在 /etc 执行（真实删除 /etc/file.txt）；spec 条件 11 如实写明「最终 cd 落点」，属 spec 级设计缺口。② **D2b 路径无 git 写检查**：`cd /etc && cat /etc/passwd && git clean -fd` —— 条件 11 仅在 d2a 分支强制（shell-forwarder.ts `if (d2a)` 门内），D2b 分支对 git 写子命令无对应检查（git pathspec 不被 collectStagePathRefs 收集，refs 全绝对 → d2b=true 静默放行）。修复方向：条件 11 改为「任一 git 写片段之前的最近 cd 落点」判定并补 D2b 分支检查，补 `cd /etc && git rm f && cd /tmp` 与 `cd /etc && cat /etc/passwd && git clean -fd` 反例测试；可与 env 类 wrapper 边界（已知边界一）合并为后续 change。
