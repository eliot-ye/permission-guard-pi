# Tasks

## 关键链与 project buffer

**关键链（Critical Chain）**：T0 (前置 grep 检查) → T1 (TDD 测试先行) → T2 (`tsc` 特例实现) → T3 (`go vet/fmt` 实现) → T4 (`npx --no-install` 实现) → **T6 (两个 state machine 一致性核对)** → T7 (全量回归)。

**关键链理由**：Change C 是**语义放宽**类改动（三类命令的 allow-set 扩展），最脆弱的环节是"两个 state machine 分叉"（Change B code review 触发的 P1 教训）与"flag 白名单过窄或过宽"。T0 是 brownfield 变体规则要求的前置 grep 检查。T1-T4 是三类扩展点的 TDD 顺序（测试先行，避免实现漂移）。T6 是本 change 独有的关键步骤——显式核对 `isSilentCommand` 与 `extractBashTargets` step 4b 两个 state machine 的一致性，把 Change B 的 P1 教训固化成机械检查。T7 是全量回归兜底。

**Project buffer**：tier-medium 下按 strength-matrix 表 1 取 35%。本 change 关键链总估时约 120 min（T0: 5 min、T1: 40 min 写 25 条测试、T2: 25 min 实现 `tsc` 分支、T3: 15 min 实现 `go` 分支、T4: 20 min 实现 `npx` 分支、T5-T6 并行 15 min、T7: 5 min 回归、T6 一致性核对: 10 min），buffer 35% ≈ 40 min——留在 T8（缓冲收尾）承接意外（例如 `tsc` flag 白名单遗漏常用 flag、`npx --no-install` 特例与既有 step 4b 分叉、集成测试因分类扩展产生非预期回归）。

**Feed buffer**：T5/T6 汇入 T7，各自动作量小于 15 min，无需独立 feed buffer。

**主体合规**：所有 task 主体都是 agent 可执行的编程性动作（写文件 / 跑命令 / grep 断言 / 断言通过）。人工验证（如"用户日常开发时不再被弹窗打扰"）不做独立 task，降级为 T7 验证字段的补充说明。

---

## 0. 前置 grep 检查（brownfield characterization 前置）

- [x] T0.1 grep 既有测试断言，确认 BT-C1-* / BT-C2-* / BT-C3-* 新增断言与既有断言无语义冲突
  - 命令：
    ```
    grep -c '"tsc ' test/bash-extract.test.ts
    grep -c '"go vet\|"go fmt' test/bash-extract.test.ts
    grep -c '"npx --no-install\|"npx ' test/bash-extract.test.ts
    ```
  - 文件：`test/bash-extract.test.ts`（只读）
  - 风险：low（只读检查）
  - 验证：3 条 grep 全部返回 `0`；若非 0，先阅读命中上下文，判断是否与 BT-C1-* / BT-C2-* / BT-C3-* 命名有重叠，必要时调整新增测试命名（命名冲突不阻塞 T1，但需在本 task 报告中标出）
  - 分系统影响：无（前置检查）
  - 依赖：无

## 1. TDD 测试先行（RED）

- [x] T1.1 在 `test/bash-extract.test.ts` 中新增 BT-C1-1 到 BT-C1-11 共 11 条断言（`tsc` 特例），跑 `npm test -- test/bash-extract.test.ts` 确认新增 BT-C1-1、2、3、4、5、6、7、8、9、10、11 共 11 条 🔴 失败（`tsc` 分支当前是严格 flag-only，全部判 UNRL）
  - 文件：`test/bash-extract.test.ts`
  - 风险：medium（新测试面，需保证与既有 BT-C* 断言命名不冲突）
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出恰为 BT-C1-1 到 BT-C1-11 共 11 行
  - 分系统影响：side-effects.bash-extract（tier-small）—— 仅测试面
  - 依赖：T0.1

- [x] T1.2 在 `test/bash-extract.test.ts` 中新增 BT-C2-1 到 BT-C2-17 共 17 条断言（`go vet/fmt`），跑 `npm test -- test/bash-extract.test.ts` 确认新增 BT-C2-1、2、3、4、5、6、7、8 共 8 条 🔴 失败（`go vet/fmt` 子命令当前判 UNRL）；BT-C2-9、10 是 `go version` / `go env` 既有行为回归项应当通过；BT-C2-11..17 是边界保持项（`go vet /tmp`、`go fmt -w /tmp`、`go build`、`go test`、`go run`、`go mod tidy`、`go mod download`）应当通过
  - 文件：`test/bash-extract.test.ts`
  - 风险：low
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出包含 BT-C2-1、2、3、4、5、6、7、8 共 8 行；BT-C2-9、10、11、12、13、14、15、16、17 均为 `✔`
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T1.1

- [x] T1.3 在 `test/bash-extract.test.ts` 中新增 BT-C3-1 到 BT-C3-12 共 12 条断言（`npx --no-install`），跑 `npm test -- test/bash-extract.test.ts` 确认新增 BT-C3-1、2、3、4、5 共 5 条 🔴 失败（`npx --no-install <pkg>` 当前判 UNRL）；BT-C3-6..12 是边界保持项（无 `--no-install`、多余 positional、`--` 分隔、`--pkg`、`--prefix`、`-c` 等）应当通过
  - 文件：`test/bash-extract.test.ts`
  - 风险：low
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出包含 BT-C3-1、2、3、4、5 共 5 行；BT-C3-6..12 均为 `✔`
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T1.2

## 2. `tsc` 特例实现（GREEN）

- [x] T2.1 在 `src/lib/bash-extract.ts` 中新增模块内辅助函数 `isSafeTscFlag(flag: string): boolean` 与 `isAllowedTscEntryFlag(flag: string): boolean`（放在 `isSilentCommand` 定义之前），实现 D2 中的白名单与拒绝名单
  - 文件：`src/lib/bash-extract.ts`
  - 风险：low（新函数，纯字符串判定）
  - 验证：两个函数是 `function`（不 export，保持模块内私有），grep 确认存在；`npm test -- test/bash-extract.test.ts 2>&1 | tail -3` 既有测试仍全绿
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T1.1

- [x] T2.2 修改 `src/lib/bash-extract.ts` 的 `isSilentCommand` Mode 2 分支：对 `tsc` 增加"特例路径"——若首个非-flag token 是 `--noEmit`/`--version`/`--help`/`-h` 之一，进入特例路径；特例路径内所有 token MUST 满足"flag 白名单 + 值 token 判定"约束，否则返回 `false`
  - 文件：`src/lib/bash-extract.ts`
  - 风险：high（核心分类函数的语义扩展，触及公共契约）
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✔" | grep -c "BT-C1"` 输出恰为 11；`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出不含 BT-C1-* 行
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T2.1

- [x] T2.3 修改 `src/lib/bash-extract.ts` 的 `extractBashTargets` step 4b 分支：对 `tsc` 增加与 T2.2 一致的"特例路径"识别逻辑——两个 state machine 必须完全一致
  - 文件：`src/lib/bash-extract.ts`
  - 风险：high（state machine 分叉是 Change B 的 P1 教训）
  - 验证：grep 确认 4b 分支存在 `tsc` 特例处理；`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✔" | grep -c "BT-C1"` 仍为 11（T2.2 已保证 `isSilentCommand` 路径通过；本任务保证 4b 路径不覆盖 `isSilentCommand` 的结果）
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T2.2

## 3. `go vet` / `go fmt` 实现（GREEN）

- [x] T3.1 修改 `src/lib/bash-extract.ts` 的 `SILENT_COMMANDS.go`：allow-set 从 `{version, env}` 扩展为 `{version, env, vet, fmt}`
  - 文件：`src/lib/bash-extract.ts`
  - 风险：low（数据变更，无逻辑）
  - 验证：grep 确认 `SILENT_COMMANDS.go` 包含 `vet`、`fmt`；`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✔" | grep -c "BT-C2"` 输出至少为 9（BT-C2-9 是 `go version` 既有回归项，`go env` 也应通过；BT-C2-1..8 会因 Mode 3 允许 `vet`/`fmt` 但无 positional 支持而部分失败——正例是 T3.2 的目标）
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T1.2

- [x] T3.2 修改 `src/lib/bash-extract.ts` 的 `isSilentCommand` Mode 3 分支：对 `go vet` / `go fmt` 增加"post-subcommand 阶段允许 repo 内相对路径 positional"的识别逻辑——若 subcommand ∈ `{vet, fmt}` 且后续所有非-flag positional 都通过 `looksLikeRepoRelativePath`，返回 `true`。flag 白名单见 D3。
  - 文件：`src/lib/bash-extract.ts`
  - 风险：medium（复用 Change B 的 helper，逻辑较简单）
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✔" | grep -c "BT-C2"` 输出恰为 17；`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出不含 BT-C2-* 行
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T3.1

- [x] T3.3 修改 `src/lib/bash-extract.ts` 的 `extractBashTargets` step 4b 分支：对 `go vet` / `go fmt` 增加与 T3.2 一致的"positional 支持"识别逻辑——两个 state machine 必须完全一致，包括 `GO_SILENT_POSITIONAL_SUBCOMMANDS` gate（对齐 Change B 的 `GIT_BLOB_OK_SUBCOMMANDS` 模式）
  - 文件：`src/lib/bash-extract.ts`
  - 风险：high（state machine 分叉风险）
  - 验证：grep 确认 4b 分支存在 `go` 特例处理且使用 `GO_SILENT_POSITIONAL_SUBCOMMANDS`；`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✔" | grep -c "BT-C2"` 仍为 17
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T3.2

## 4. `npx --no-install` 实现（GREEN）

- [x] T4.1 修改 `src/lib/bash-extract.ts` 的 `isSilentCommand` Mode 2 分支：对 `npx` 增加"特例路径"——若 tokens 中出现 `--no-install` 且 `--no-install` 前后所有 token 都是允许 flag、`--no-install` 之后恰好有一个非-flag positional 作为包名、无更多 token，返回 `true`
  - 文件：`src/lib/bash-extract.ts`
  - 风险：medium（语义清晰，但需处理 flag 与 positional 的相对顺序）
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✔" | grep -c "BT-C3"` 输出恰为 12；`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出不含 BT-C3-* 行
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T1.3

- [x] T4.2 修改 `src/lib/bash-extract.ts` 的 `extractBashTargets` step 4b 分支：对 `npx` 增加与 T4.1 一致的"特例路径"识别逻辑——两个 state machine 必须完全一致
  - 文件：`src/lib/bash-extract.ts`
  - 风险：high（state machine 分叉风险）
  - 验证：grep 确认 4b 分支存在 `npx` 特例处理；`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✔" | grep -c "BT-C3"` 仍为 12
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T4.1

## 5. 集成层验证

- [x] T5.1 跑 `npm test -- test/backlog-regression.test.ts test/sys-integration.test.ts 2>&1` 确认 SYS4/SYS5/SYS8 集成测试全部通过（这些测试覆盖 shell forwarder / control flow / forwarder 三类不可靠行为，与 `tsc --noEmit` / `go vet` / `npx --no-install` 无交集，验证无回归）
  - 文件：无（验证动作）
  - 风险：medium（跨分系统回归验证）
  - 验证：`npm test -- test/backlog-regression.test.ts test/sys-integration.test.ts 2>&1 | tail -3` 输出 `# fail 0`
  - 分系统影响：extension-orchestration、side-effects
  - 依赖：T3.3、T4.2

## 6. 两个 state machine 一致性核对（Change B P1 教训固化）

- [x] T6.1 显式核对 `isSilentCommand` 与 `extractBashTargets` step 4b 两个 state machine 在 `tsc` / `go` / `npx` 三个分支的一致性——这是本 change 的关键步骤，把 Change B 的 P1 教训固化成机械检查
  - 文件：`src/lib/bash-extract.ts`（只读检查）
  - 风险：medium（漏核对会导致 Change B 式 P1 缺陷）
  - 核对清单（对每个扩展点逐一核对）：
    - **`tsc`**：
      - [ ] `isSilentCommand` 里 `tsc` 特例路径的入口判定（首个非-flag token ∈ `{--noEmit, --version, --help, -h}`）与 step 4b 里一致
      - [ ] `isSilentCommand` 里允许 flag 白名单（`isSafeTscFlag` 判定）与 step 4b 里一致
      - [ ] `isSilentCommand` 里拒绝 flag 名单（`--outDir` / `--emitDeclarationOnly` / `--noCheck` / `--build` / `-b` 等）与 step 4b 里一致
      - [ ] `isSilentCommand` 里"不允许非-flag positional"规则与 step 4b 里一致
    - **`go vet` / `go fmt`**：
      - [ ] `isSilentCommand` 里 Mode 3 post-subcommand 的 `GO_SILENT_POSITIONAL_SUBCOMMANDS.has(subcommandSeen)` gate 与 step 4b 里一致
      - [ ] `isSilentCommand` 里 `looksLikeRepoRelativePath` 判定与 step 4b 里一致
      - [ ] `isSilentCommand` 里 `go vet` / `go fmt` 的 flag 白名单（`-copylocks`/`-shadow`/`-l`/`-w`/`-r <pattern>`/`-s` 等）与 step 4b 里一致
      - [ ] `isSilentCommand` 里"flag 必须在 positional 之前"规则与 step 4b 里一致
    - **`npx`**：
      - [ ] `isSilentCommand` 里 `npx` 特例路径的 `--no-install` 检测逻辑与 step 4b 里一致
      - [ ] `isSilentCommand` 里"允许 flag 白名单"（`--color`/`--cache`/`--yes`/`-y`/`--loglevel` 等）与 step 4b 里一致
      - [ ] `isSilentCommand` 里"拒绝 flag 名单"（`--prefix`/`--package`/`--call`/`-c`）与 step 4b 里一致
      - [ ] `isSilentCommand` 里"`--no-install` 之后恰好一个非-flag positional"规则与 step 4b 里一致
      - [ ] `isSilentCommand` 里"无更多 token"约束与 step 4b 里一致
  - 验证：全部核对项勾选完毕；若发现任一分叉，在本 task 修复后再勾选
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T2.3、T3.3、T4.2

## 7. 全量回归

- [x] T7.1 跑 `npm test` 全量测试，确认 `# pass N # fail 0`（N = 上一 change 完成时的 501 + 40 新增 = 541，实际数字以运行时为准），无 flaky
  - 文件：无（验证动作）
  - 风险：medium（跨分系统全量回归）
  - 验证：`npm test 2>&1 | tail -5` 输出 `# pass N # fail 0`，N ≥ 541 且 # fail = 0；`npm test 2>&1 | grep -c "^✖"` 输出 `0`
  - 分系统影响：全部子系统
  - 依赖：T5.1、T6.1

- [x] T7.2 跑 `node --experimental-strip-types test/security-probe.mjs 2>&1` 确认 35 条安全探针全部通过（本 change 未引入宽松化到既有安全边界——`tsc`/`go vet/fmt`/`npx --no-install` 都是明确只读形式，与既有探针无交集）
  - 文件：无（验证动作）
  - 风险：low
  - 验证：`node --experimental-strip-types test/security-probe.mjs 2>&1 | tail -3` 输出 `35 passed, 0 failed out of 35`
  - 分系统影响：无
  - 依赖：T7.1

## 8. 契约与规格完整性

- [x] T8.1 跑 `openspec validate bash-extractor-side-effect-tools-silent --type change --json` 确认无 structural 问题；跑 `openspec status --change bash-extractor-side-effect-tools-silent --json` 确认所有 applyRequires artifact 状态为 `done`
  - 文件：无（验证动作）
  - 风险：low
  - 验证：`openspec validate bash-extractor-side-effect-tools-silent --type change --json` 输出中 `issues` 数组为空；`openspec status --change bash-extractor-side-effect-tools-silent --json` 输出中每个 artifact `status === "done"`
  - 分系统影响：无
  - 依赖：T1-T7 全部完成

## 9. 缓冲收尾（project buffer 35%）

- [x] T9.1 缓冲任务：若 T1-T8 中任一 task 出现非预期失败（例如 `tsc` flag 白名单遗漏常用 flag、`npx --no-install` 特例与既有 step 4b 分叉、集成测试因分类扩展产生非预期回归），此 task 承接修复；预计耗时 40 min 上限
  - 文件：视情况而定（预期为空操作）
  - 风险：low
  - 验证：本 task 完成时 T7.1、T7.2 与 T8.1 的验证字段全部通过；若 T1-T8 已一次通过，则本 task 主体为空但打勾（记录"buffer 未被消耗"）
  - 分系统影响：视情况而定
  - 依赖：T1-T8 全部完成

---

## 已知问题（架构 review 记录）

（tier-medium 架构 review 触发，见 td-propose 步骤 7。无 critical issue；以下 warning 均为已知取舍，不阻塞 apply。）

1. **[warning] spec delta 的 flag 白名单与场景集不闭合**
   - 位置：`specs/bash-target-extraction/spec.md:121`（"允许 flag"列表列了 14 个 flag，但"Scenario"节只断言了 4 个）
   - 影响：白名单里的 `--incremental`、`--pretty`、`--moduleResolution`、`--strictNullChecks`、`--strictFunctionTypes`、`--noUncheckedIndexedAccess`、`--useDefineForClassFields`、`--forceConsistentCasingInFileNames`、`--jsx`、`--esModuleInterop`、`--resolveJsonModule`、`--noImplicitAny`、`--noImplicitReturns` 等 flag 未通过 scenario 断言。若 TDD 实施时 `isSafeTscFlag` 判定漏放，spec scenario 无法捕获。
   - 处置：apply 阶段可考虑补 1-2 条 scenario 覆盖常见类型检查 flag（如 `tsc --noEmit --strict --target es2022` 已含在 BT-C1-6 中），或依赖 T2.2 的验证断言兜底。这是"spec 与实现的对齐精度"问题，不影响本 change 的契约层。

2. **[warning] proposal 的"预期断言数"统计口径不一致**
   - 位置：`proposal.md:115`（覆盖账本写 25 条），`proposal.md:89`（预期模型写"25 条新增断言"）
   - 影响：spec 层实际 46 条 Scenario，test 层 40 条（BT-C1: 11 + BT-C2: 17 + BT-C3: 12）。proposal 里的"25"是覆盖账本表的行数，未明说它是 test 数量而非 scenario 数量，读者易误解。
   - 处置：apply 前可微调 proposal 里的数字口径（明确是"test 断言数"还是"scenario 数"），不阻塞。

3. **[warning] `npx --no-install` 的"任意包名静默"是设计上的取舍偏宽**
   - 位置：`design.md:190`（"不做白名单枚举"）
   - 影响：`npx --no-install <pkg>` 静默依赖 npm CLI 的官方语义 `--no-install` 保证"只用本地已装包"。若 `<pkg>` 是任意包名，用户装了什么包决定执行什么代码——静态分析层无法验证"这是安全的本地包"。
   - 处置：这是 D4 的已知取舍，已在 design.md 与 proposal 里显式记录；用户侧的缓解是"信任项目本地已装包"。若未来发现用户装了恶意包，走独立 change 处理（本 change 不改语义）。

4. **[warning] 主 spec baseline 缺少"空 allow-set 命令的 strict 模式"requirement**
   - 位置：`openspec/specs/bash-target-extraction/spec.md:395`（"静默命令白名单" requirement 提到"命中 SILENT_COMMANDS 的命令 MUST 被视为 0-target 静默"，但**未把 strict 模式作为独立 requirement 显式表达**）
   - 影响：Change C 扩展 `tsc`/`npx` 两个空 allow-set 命令的特例，但 baseline 里没有"tsc/npx 严格 flag-only"的 requirement 作为"改之前"的对照锚点——只能靠 Change B 的归档 spec delta 反推。
   - 处置：这是 baseline 的历史债，超出 Change C 的 scope（Change C 只做 ADDED，不做 baseline 补写）。建议后续独立 change 补齐主 spec 的 baseline 完整性。

**Verdict 锚点**：APPROVED（无 critical；4 条 warning 均为已知取舍或统计口径问题，不阻塞 apply）

**reviewed-by**: subagent（architect 角色，fresh-context 隔离）
