# Tasks: bash-sed-readonly-exempt

## 关键链与 buffer

- **关键链**：T1（RED——新增 sed 只读豁免测试断言，先跑失败暴露现状 bug）→ T2（实现 `isSedReadonlyForm` 守卫 + `sedExtract`，GREEN）→ T3（全量回归 + 既有断言核对）。T4（typecheck + design 文档一致性核对）依赖 T3，可并行。
- **Project buffer**：35%（tier-medium）。关键链估时 1.7h → project buffer ≈ 0.6h。
- Feeding buffer：无独立支流（T1 即关键链起点，无汇入支流）。

## Tasks

- [x] **T1**: RED——新增 sed 只读豁免测试断言（关键链，0.7h）
  - 文件：`test/bash-extract.test.ts`
  - 主体：在 `test/bash-extract.test.ts` 新增用例（先写测试、先跑失败），覆盖 spec 全部 scenario：
    1. `sed -n '335,345p' test/decision.test.ts` → `{reliable:true, targets:[read <projectRoot>/test/decision.test.ts]}`（只读 -n 形态放行）
    2. `sed '1,5p' file.txt` → `{reliable:true, targets:[read <projectRoot>/file.txt]}`（无 -n 标准输出读放行）
    3. `sed -e '1,5p' file.txt` → `{reliable:true, targets:[read <projectRoot>/file.txt]}`（-e 单脚本放行——`file.txt` 是文件参数非脚本，不误伤）
    4. `sed -i 's/a/b/' file.txt` → `{reliable:false, reason:"unreliable_command"}`（-i 写形态保留弹窗）
    5. `sed -i.bak 's/a/b/' file.txt` → `{reliable:false, reason:"unreliable_command"}`（-i 后缀原地改写保留弹窗）
    6. `sed '1,5w /etc/passwd' file.txt` → `{reliable:false, reason:"unreliable_command"}`（脚本含 w 写命令保留弹窗）
    7. `sed '1r /etc/shadow' file.txt` → `{reliable:false, reason:"unreliable_command"}`（脚本含 r 读文件命令保留弹窗）
    8. `sed 'e ls' file.txt` → `{reliable:false, reason:"unreliable_command"}`（脚本含 e 执行命令保留弹窗）
    9. `sed 's/foo/bar/e' file.txt` → `{reliable:false, reason:"unreliable_command"}`（替换式 flag e 执行保留弹窗）
    10. `sed 's/foo/bar/w /etc/passwd' file.txt` → `{reliable:false, reason:"unreliable_command"}`（替换式 flag w 写文件保留弹窗）
    11. `sed -e '1,5p' -e 'r /etc/shadow' file.txt` → `{reliable:false, reason:"unreliable_command"}`（多 -e 第二脚本 r 保留弹窗）
    12. `sed -f script.txt file.txt` → `{reliable:false, reason:"unreliable_command"}`（-f 脚本文件保留弹窗）
    13. `sed "s/$(date)/x/" file.txt` → `{reliable:false, reason:"command_substitution"}`（命令替换保留弹窗——scanUnreliable 先行拦截）
    14. `sed -n '1,5p' file.txt | grep x` → `{reliable:true, targets:[read <projectRoot>/file.txt]}`（只读管道链放行）
    15. `awk 'NR==1{print}' file.txt` → `{reliable:false, reason:"unreliable_command"}`（awk 只读非目标保留弹窗）
    16. `sed 'a.b' file.txt` → `{reliable:true, targets:[read <projectRoot>/file.txt]}`（脚本 `a.b` 被误判为路径的风险——`sedExtract` 必须跳过脚本参数，只收集 `file.txt`）
    17. `sed -n '/error/p' file.txt` → `{reliable:true, targets:[read <projectRoot>/file.txt]}`（正则地址只读，判据"判定不误伤"例证）
    18. `sed 'y/abc/rwx/' file.txt` → `{reliable:true, targets:[read <projectRoot>/file.txt]}`（transliteration 只读，判据"判定不误伤"例证）
  - 风险：medium（核心路径，但单分系统、无跨系统契约）
  - 验证：`node --experimental-strip-types --test test/bash-extract.test.ts`——T1 用例 RED（1/2/3/14/16/17/18 失败暴露现状 sed 弹窗 bug，4-13/15 基线确认现行为），既有用例不受影响。
  - 分系统影响：bash-extract
  - 依赖：无

- [x] **T2**: 实现——`isSedReadonlyForm` 守卫 + `sedExtract`（关键链，1.0h）
  - 文件：`src/lib/bash-extract/entry.ts`、`src/lib/bash-extract/extractors.ts`、`src/lib/bash-extract/index.ts`（如导出新符号）
  - 主体：按 design.md D1-D4：
    1. 在 `src/lib/bash-extract/extractors.ts` 新增 `sedExtract`——跳过全部脚本来源（所有 `-e`/`--expression` 值、`-f`/`--file` 值、首个非 flag 位置参数）与 `-n` flag，剩余非 flag 位置参数若 `looksLikePath` 则收集为 read target（D2：不复用 readExtract，避免脚本 `a.b` 误收集；`-e` 存在时非 flag 是文件非脚本，不误伤）。
    2. 在 `entry.ts` 的 `isAnyUnreliableCommand`（4a）之前加 `isSedReadonlyForm(rawCommand)` 守卫——命中 sed 且满足只读判据（无 `-i` 前缀/含 `i` cluster/`--in-place`、无 `-f` 前缀/含 `f` cluster/`--file`、所有脚本移除分隔符定界形式后无 `r`/`R`/`w`/`W`/`e`/`E` 命令字符、无写重定向、命令替换由 scanUnreliable 天然先行拦截）时不返回 `unreliable_command`，落到正常提取流程（D1：不改 `isAnyUnreliableCommand` 集合判定）。
    3. `COMMAND_TABLE` 加入 `sed: sedExtract`（仅当豁免成立时到达——写形态仍被 4a 拦截，不会进 extractor）。
    4. 不新增 public API 契约破坏；如 `isSedReadonlyForm` 需要测试导出，经 index.ts barrel 导出。
  - 风险：medium（判据不完备会误放行写/读任意文件/执行形态，测试 T1-4/5/6/7/8/9/10/11/12 覆盖反例）
  - 验证：`node --experimental-strip-types --test test/bash-extract.test.ts`——T1 全部用例转 GREEN；`node --experimental-strip-types -e '...isSedReadonlyForm...'` 确认 `sed -i`/`sed -i.bak`/`sed '1,5w f'`/`sed '1r /etc/shadow'`/`sed 'e cmd'`/`sed 's/foo/bar/e'`/`sed -e '1,5p' -e 'r /etc/shadow'`/`sed -f script.txt` 返回 false（写/读任意文件/执行形态守卫拒绝）。
  - 分系统影响：bash-extract
  - 依赖：T1

- [x] **T3**: 全量回归 + 既有断言核对（关键链，0.3h）
  - 文件：全量测试 + `test/security-probe.mjs`、`test/cross-system-boundary.mjs`、`test/probe-v3-bash-symlink-grant.mjs`
  - 主体：跑全量测试与安全探针；逐一核对 reason 变化的既有断言（预期：仅 sed 命令从 `unreliable_command` 变 `reliable`（只读形态）——真实写形态仍弹）。按预期行为变化更新非测试断言文件（security-probe/cross-system-boundary 等，若有命中 sed）。
  - 风险：medium
  - 验证：`node --experimental-strip-types --test test/` 全量绿 + `node test/security-probe.mjs`、`node test/cross-system-boundary.mjs` 通过（或断言按预期行为变化更新后通过）。
  - 分系统影响：bash-extract
  - 依赖：T2

- [x] **T4**: typecheck + design 文档一致性核对（汇入点，0.2h）
  - 文件：`openspec/changes/bash-sed-readonly-exempt/design.md`、`openspec/changes/bash-sed-readonly-exempt/specs/bash-target-extraction/spec.md`
  - 主体：跑 `npm run typecheck` 确认 0 error；核对 design.md D1-D4 与实际实现一致（`isSedReadonlyForm` 位置、`sedExtract` 跳过脚本、命令替换由 scanUnreliable 先行拦截）。
  - 风险：low
  - 验证：`npm run typecheck` 0 error + grep 断言 design 决策与实现一致。
  - 分系统影响：bash-extract
  - 依赖：T3

关键链 T1→T2→T3 = 2.0h，project buffer 35% ≈ 0.7h；T4 0.2h（汇入点）。

## 已知问题

- **K1（非阻塞，记录级）**：`isSedReadonlyForm` 用 `skipWrapperTokens` 展开 env/command/sudo 定位 sed（silent.ts:833-839），但 entry.ts 逐 stage 提取以 `tokens[0]` 查 `COMMAND_TABLE`（entry.ts:330-334），不展开 wrapper——`env FOO=1 sed -n '1,5p' file.txt` 豁免成立但 `file.txt` 不被 `sedExtract` 收集为 read target。与既有 `env cat`/`env ls` 行为一致（extract 侧不展开 wrapper），read 默认 auto-allow，无安全影响，属审计记录缺口。后续可考虑统一 extract 侧 wrapper 展开（独立 change，不并入本 change）。
