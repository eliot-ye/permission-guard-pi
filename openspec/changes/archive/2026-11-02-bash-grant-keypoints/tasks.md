# Tasks: Bash grant keypoints (命令关键点授权)

> **关键链**：T1（派生函数）→ T2（trust 双轨）→ T3（extension 查询端）→ T5（系统级验证）。
> **project buffer**：tier-medium 35%，落在 T5 系统级验证（关键链尾部）。T4 场景测试与 T5 系统验证之间无阻塞依赖（T4 可并行，不入关键链）。

## 1. 关键点派生函数（bash-extract/keypoints.ts）

- [x] 1.1 新建 `src/lib/bash-extract/keypoints.ts`，实现 `bashCommandKeypoints(rawCommand, projectRoot): string`——按 design.md Decision 2 的 token 分类规则输出规范字符串（`cd:`/`cd-var:`/`CMD:`/`PATH:`/`WRITE:`/`FLAG:`/`FLAGVAL:`/`GLOB:`/`WORD:`），复用 `splitCommands`/`splitPipelines`/`tokenize`/`looksLikePath`（`parse.ts`）+ `toAbsolutePath`/`normalizeBashCommand`（`path-utils.ts`）。验证：`node --experimental-strip-types --test test/` 中新增 `keypoints.test.ts` 全绿，且 `npm run typecheck` 无新错误。

- [x] 1.2 实现纯读 flag 有限白名单（find/head/tail/cat/wc/ls 各一份，design.md Decision 3）——白名单内 flag 名+值连跳，清单外保留 `FLAG:`+`FLAGVAL:`。验证：`keypoints.test.ts` 断言 `-type f`/`-type d`/`-name '*.ts'` 值连跳，`rm -rf`/`find -delete`/`sed -n` 保留。

- [x] 1.3 实现 find 匹配 flag 值 vs shell glob 的关键区分（design.md Decision 2）——`find -name '*.ts'` 的 `*.ts` 连跳（内部匹配），`cat src/*.ts` 的 `*.ts` 保留为 `GLOB:`（shell 展开）。验证：`keypoints.test.ts` 断言 `cat src/*.ts` vs `cat src/*.go` 关键点不同。

- [x] 1.4 实现 cd 落点追踪与降级——绝对路径记录 `cd:<绝对化>` 并更新追踪 cwd；仅 `$VAR`（未解析变量）降级 `cd-var:<原始>` 不更新追踪 cwd；`~`/相对路径按 `toAbsolutePath` 解析为 `cd:<绝对化>` 并更新追踪 cwd（非降级）。验证：`keypoints.test.ts` 断言 `cd /a` vs `cd /b` 关键点不同、`cd $HOME` 降级、`cd ~`/`cd src` 正常解析。

## 2. trust.ts 双轨（keypointsHash + commandHash）

- [x] 2.1 `BashGrant` 接口新增 `keypointsHash?: string`（可选，design.md Decision 5）。验证：`npm run typecheck` 无新错误，`test/trust.test.ts` 既有断言不回归。

- [x] 2.2 `addBashSessionGrant`/`addBashPersistentGrant` 写入逻辑改双轨——同时写 `commandHash`（整条，`bashCommandHash`）+ `keypointsHash`（关键点，`sha256(bashCommandKeypoints(...))`）。验证：`test/trust.test.ts` 新增 GM23 断言双字段写入。

- [x] 2.3 `hasBashSessionGrant`/`hasBashPersistentGrant` 查询逻辑改双轨——`keypointsHash` 命中（新 grant）|| `commandHash` 整条命中（旧 grant）。验证：`test/trust.test.ts` GM23 断言关键点命中 + GM24 断言旧整条命中。

## 3. extension 查询端（extensions/index.ts handleBash）

- [x] 3.1 `handleBash` grant 查询端换新匹配——`state.trust.hasBashSessionGrant(projectHash, command)` 与 `hasBashPersistentGrant` 改传关键点（内部已改，此步验证接口自洽）。验证：`extensions/index.test.ts` 既有 bash grant 断言不回归，`npm run typecheck` 无新错误。

## 4. scenario→test 覆盖账本（grant-memory spec 新增场景）

- [x] 4.1 编写覆盖账本：grant-memory spec 的 **13 个**新 Scenario 映射到 GM 测试（GM23-GM35），验证每个 scenario 至少一个断言。S9（词法 whitespace 等价保留）由既有 GM21/GM22 覆盖并入账本（既有 whitespace 断言已覆盖，不重复实现）；其余 12 个由 GM23-GM35 映射。验证：账本全映射、无 unmapped。

- [x] 4.2 实现对应 GM 测试：GM23 双轨写入+关键点命中、GM24 旧整条命中、GM25 纯读 flag 值变化免弹、GM26 fd 重定向增删免弹、GM27 不同路径不命中、GM28 cd 落点不同不命中、GM29 shell glob 保留、GM30 写重定向保留、GM31 语法级漂移不判等价、GM32 cd 变量降级、GM33 写 flag 变化不命中、GM34 find `-name` vs cat glob 不误放行、GM35 cd 家目录/相对落点正常解析。验证：`node --experimental-strip-types --test test/trust.test.ts` 全绿。

## 5. 系统级验证（project buffer）

- [x] 5.1 全量测试回归：`npm test`（`node --test "test/*.test.ts" "extensions/*.test.ts"`）全绿，确认既有 GM1-GM22 与 AL/BT 断言不回归。验证：退出码 0。

- [x] 5.2 `npm run typecheck`（`tsc --noEmit`）0 新错误。验证：退出码 0。

- [x] 5.3 `openspec validate bash-grant-keypoints --type change --json` 通过（artifact 集合无结构性问题）。验证：JSON 无本 change 校验错误。

- [x] 5.4 样本命令端到端实证：用 `bashCommandKeypoints` 对样本命令与变体（`head -50`↔`-60`、`-type f`↔`-type d`、`find src`↔`test`）输出关键点，确认「安全等价免弹 / 不等价弹窗」与 proposal「等价边界」节一致。验证：`node --experimental-strip-types` 探针输出与预期一致。
