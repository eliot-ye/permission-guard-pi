## Why

`cd <绝对路径> && …` 链下，用户**只读**的目录列举/搜索命令（如 `find src -type f | head`、`grep -rn "..." dist/`）被误判 `cd_chdir` 弹窗。系统提示词承诺「cd 目标绝对、下游无 `.`/`..`/glob 时自动放行」，但实际对**无扩展名裸词目录**与 **find 的 flag 值**有盲区，导致该承诺未兑现（实测 3 个真实弹窗，全部只读）。

根因两层叠加（均已实证，非推测）：

1. **裸词目录盲区（根因 A）**：`find src`/`grep ... dist/`/`ls src` 的参数 `src`/`dist/` 是无扩展名相对目录，`looksLikePath` 返回 `false`（只认 `.`/`..` 前缀、`/`、`~`、带扩展名词、Windows 盘符）。于是 D2a 条件 9「不可提取裸词排除」（`shell-forwarder.ts:898`）把这**真实目录引用**当「不可提取裸词」排除豁免 → 回退 `cd_chdir`。但条件 9 的排除是**有意防静默放行**（豁免会 0-target）——所以正确修复不是放宽条件 9，而是在 D2a 豁免下把裸词目录**解析为 target**（`resolveBase`），让决策层真正看到 `/cd_target/src` 这个读目标。
2. **find flag 值误收集（根因 B）**：`find /abs/src -type f`（绝对起点、无裸词）实测仍弹窗——`collectStagePathRefs` 把 `-type` 的**值** `f`、`-maxdepth` 的**值** `2` 当路径引用收集（`f`/`2` 不以 `-` 开头，`looksLikePath=false`）→ 条件 9 误判排除豁免。`find` 的 flag 值（`-type`/`-name`/`-maxdepth`/`-path`/`-mindepth`/`-size`/`-mtime` 等）**不是路径引用**，不该收集。

**设计内形态（不属本 change）**：cwd-anchor `.`（`find .`，条件 4 有意排除——`.` 锚定运行时 cwd，cd 后无法静态确定目标集）；`;` 链（非纯 `&&`，条件 1 有意排除——`;` 下 cd 失败时下游仍执行，cwd 不可静态确定）；glob（条件 5 有意排除）。这三个维持 `cd_chdir` 保守弹窗，是 fail-closed 安全边界，不是误报。

## What Changes

- **根因 A 修复**：D2a 豁免（cd 跟踪）下，read-only 文件参数命令（`find`/`grep`/`ls`/`cat` 等）的**裸词目录位置参数**经 `resolveBase` 解析为绝对 target（`/cd_target/src`），使决策层看到真实读目标而非 0-target 静默放行。条件 9 的裸词排除**收窄**为「extractor 无法提取为 target 的裸词」——write/delete 命令（`rm -rf sub`）的裸词仍排除（维持 `cd_chdir`，fail-closed，写裸词无法安全提取）。
- **根因 B 修复**：`collectStagePathRefs` 对 `find` 的 flag 值参数（`-type`/`-name`/`-maxdepth`/`-path`/`-mindepth`/`-size`/`-mtime`/`-newer` 等的值）**跳过收集**——它们不是路径引用，不该触发条件 9。
- **fail-closed 判据**：`cd /etc && find sub -type f`（外区读）→ 提取 `/etc/sub` 为 read target → 决策层按外区读弹窗；`cd /tmp && rm -rf sub`（写裸词）→ 维持 `cd_chdir`；`find .`（cwd-anchor）、`;` 链、glob → 维持 `cd_chdir`。全部保持保守。
- 涉及文件：`src/lib/bash-extract/shell-forwarder.ts`（collectStagePathRefs 的 find flag 值跳过 + 条件 9 裸词收窄）；`src/lib/bash-extract/extractors.ts`（readExtract 裸词目录提取 + 共享谓词/flag 值集合）；`src/lib/bash-extract/entry.ts`（D2a 豁免时传 bareDirOk）；`test/bash-extract.test.ts` 补正反例。

## Capabilities

### New Capabilities

无（本 change 修改既有能力，不引入新 capability 路径）。

### Modified Capabilities

- `bash-target-extraction`: 修改「cd cwd 变更判不可靠」requirement 的 cd 跟踪豁免边界——条件 9「不可提取裸词排除」收窄为仅排除 extractor 无法提取的裸词（read-only 裸词目录在 D2a 下解析为 target），并新增 find 的 flag 值不收集规则。

## Impact

- **代码**：`src/lib/bash-extract/shell-forwarder.ts`、`src/lib/bash-extract/extractors.ts`、`src/lib/bash-extract/entry.ts`；测试 `test/bash-extract.test.ts`。
- **公共契约**：无——`ExtractResult` 类型不变、授权决策入口不变、无 wire 结构变化。仅 cd 跟踪豁免的行为边界收窄（read-only 裸词目录从「0-target 静默放行」变为「真实 target 提取」，决策层仍按目标路径判定）。
- **依赖**：无新增依赖。
- **系统**：仅 `bash-extract` 子系统（tier-medium）内部；不触碰 policy-core、extension-orchestration、audit。

## 系统工程影响评估

- **影响哪些分系统**：`bash-extract`（tier-medium 子系统）内部为主——`shell-forwarder.ts`（`collectStagePathRefs` + D2a 条件 9）+ `extractors.ts`（`readExtract`/`findExtract`）。**下游影响**（非代码触碰，行为级）：`trust`（keypoints/grant 持久化）——`find <裸词目录>` 从 `cd_chdir` 弹窗变为豁免后，作为「弹窗载体」的既有测试（SYS-KP）首次不再弹窗、grant 不再持久化，需更新 SYS-KP 载体为仍判 `cd_chdir` 的形态（用户拍板）。`audit` 未触碰（audit.ts/approval-flow.ts 无改动）。无公共契约变更、无 wire 结构变化。
- **整体性能预期变化**：零运行时性能影响（纯静态分析，只读命令的 target 提取路径不变，豁免面收窄不改变提取目标集的完整性）。用户可观察行为：原先因 `cd_chdir` 弹窗打断的只读目录列举/搜索命令（`cd /abs && find src`、`cd /abs && grep ... dist/`）现在自动放行；写命令（`rm -rf sub`）、cwd-anchor（`find .`）、`;` 链、glob 仍弹窗（行为不变）。
- **这是局部优化还是全局协调**：局部优化（减少只读命令的 cd_chdir 误报弹窗）。
- **如果是局部优化，对全局失调的风险**：放宽若写太宽会让条件 9 的安全边界失守——`cd /etc && find sub` 若只放行不提取 target，会 0-target 静默放行读外区。风险由 fail-closed 判据控制：read-only 裸词目录在 D2a 下**必须提取为真实 target**（决策层仍按 `/etc/sub` 判定）；write/delete 裸词（`rm -rf sub`）、cwd-anchor（`find .`）、`;` 链、glob **仍排除**。不全局放宽，属窄条件修复。
- **预期行为模型**：输入 `cd <projectRoot> && find src -type f | head -50`（cd 目标绝对、下游 read-only、裸词目录 `src`）→ 预期输出 `reliable: true`，且提取 target 含 `<projectRoot>/src`（read）。验证：新增正例测试断言 `extractBashTargets` 返回 `reliable: true` 且 target 含解析后的绝对目录；反例测试断言 `cd /etc && find sub`（外区）仍 `reliable: false`（提取 target 为 `/etc/sub`，决策层按外区读弹窗）、`cd /tmp && rm -rf sub`（写裸词）、`find .`（cwd-anchor）、`;` 链、glob 仍 `reliable: false`（reason 保持 `cd_chdir`）。既有 900+ 测试全绿。
- **与既有架构/风格的遵循关系**：遵循既有架构——纯函数模块（无 UI/IO）、fail-closed 保守判定、D2a 豁免的窄边界风格。不偏离既有架构或风格，无重构。

## caller impact 分析

- **变更点清单**：
  - `collectStagePathRefs`（`shell-forwarder.ts:616`）——模块级内部函数（**模块私有**，无 export，仅同文件三个调用点消费）。变更：find flag 值跳过收集。类别：**无四类变更点**（不改变公共 API 签名、不改变装配点、不改变错误契约、不改变数据契约；内部行为扩展，调用方同文件内）。
  - `readExtract`（`extractors.ts:47`）——模块级内部函数（COMMAND_TABLE 内注册的 extractor）。变更：裸词目录位置参数在 D2a 下解析为 target（加可选 `bareDirOk` 参数，默认 false）+ 提取侧复用 find flag 值跳过集合。类别：**无四类变更点**（`Extractor` 类型契约 `(tokens, targets, projectRoot)` 不变，`readExtract` 函数本身加可选参数向后兼容，`COMMAND_TABLE` 注册签名不变）。
  - `extractBashTargets`（`entry.ts:14`）——模块级入口（公共契约入口，但本 change 不改其签名）。变更：D2a 豁免时给 read-only 命令的 extractor 传 `bareDirOk=true`。类别：**无四类变更点**（`extractBashTargets` 签名不变，仅内部编排逻辑扩展）。
  - D2a 条件 9 裸词排除收窄（`shell-forwarder.ts:898`）——内部逻辑，无公共符号变更。类别：无四类变更点。
- **高危标记**：无——不涉及公共符号 / 装配点变更。全部为子系统内部行为扩展。
- **已知 caller**：
  - `collectStagePathRefs` 被 `hasCwdRelativePathRef`（:706）/`hasExplicitAbsPathRef`（:719）/D2a 条件 9（:892）消费——三个真实调用方，签名不变，行为扩展（find flag 值不再收集）同步生效，预判：兼容。
  - `readExtract` 经 `COMMAND_TABLE`（`extractors.ts:289/294`）被 `entry.ts:334` 消费——签名不变，行为扩展（裸词目录提取），预判：兼容。

**判断依据**：本 change 所有变更都是既有函数内部的行为扩展（find flag 值跳过 + 裸词目录 target 提取），不改变任何**公共契约**签名（`ExtractResult`、授权决策入口、barrel 接口均不变）、不改变装配点、不改变错误/数据契约。故无四类变更点。

## 实际系统工程影响 vs 预期

- **实际影响的分系统**：与预期一致——`bash-extract`（tier-medium 子系统）内部为主（`shell-forwarder.ts` / `extractors.ts` / `entry.ts`）。预期标注的 `trust`（keypoints/grant 持久化）**下游影响**已实证确认：SYS-KP 既有测试的弹窗载体 `find openspec`（裸词目录）本 change 后豁免不再弹窗 → 首次不弹窗 → grant 不持久化 → 断言失败。处理：用户拍板「更新 SYS-KP 载体」为 `find . -type f | head -50`（仍判 `cd_chdir`），复绿。`audit` 未触碰（audit.ts/approval-flow.ts 无改动，AL4/AL7 为既有 flaky 非本 change 引入）。无公共契约变更、无 wire 结构变化。
- **实际整体性能变化**：与预期一致——零运行时性能影响（纯静态分析，target 提取路径不变，豁免面收窄不改变提取目标集完整性）。用户可观察行为：只读裸词目录命令（`cd /abs && find src`、`cd /abs && grep ... dist/`）自动放行（实测 `reliable:true` + 提取 target）；写命令（`rm -rf sub`）、cwd-anchor（`find .`）、`;` 链、glob 仍弹窗（行为不变，实测 `reliable:false` reason `cd_chdir`）。
- **实际是局部优化还是全局协调**：与预期一致——局部优化（减少只读命令的 cd_chdir 误报弹窗）。未演变为全局协调需求。
- **局部优化的实际全局影响（主基调第 1 条事后回检）**：预期「fail-closed 判据控制全局失调风险」**成立**——read-only 裸词目录在 D2a 下经 `resolveBase` 提取为真实 target（决策层仍按 `/etc/sub` 判定，非 0-target 静默放行）；write/delete 裸词（`rm -rf sub`）、cwd-anchor（`find .`）、`;` 链、glob 仍排除（BT-CDBARE-5/6/7/8 反例锁定）。**但发现一处预期未覆盖的全局失调风险（收尾 review critical）**：`FIND_NONPATH_FLAG_ARGS` 跳过使 no-path `find -type f`（默认起点 `.`，cwd 锚点）refs 空 → 条件 9 无 ref 可查 → d2a 保持 true → `reliable:true + 0 target` 静默放行读外区。已修复：`collectStagePathRefs` find 无路径操作数 push `"."` 哨兵视同 cwd 锚点（与 `find .` 同判 `cd_chdir`）+ 固化 BT-CDBARE-9/10。同批修复 warning：`grep -e pattern sub` 的 `-e` 消费后 `!sawNonOpt` 误跳真实文件 → 0 target 静默放行（BT-CDBARE-11 固化）。
- **模型验证**：预期行为模型**已验证**——`cd <projectRoot> && find src -type f | head -50` → `reliable:true` + target `.../src`（read，BT-CDBARE-1）；`cd /etc && find sub -type f`（外区）→ 提取 `/etc/sub` 为 read target，决策层按外区读弹窗（fail-closed 保守）；`cd /tmp && rm -rf sub`（写裸词）→ `reliable:false` cd_chdir（BT-CDBARE-5）；`find .`（cwd-anchor）→ cd_chdir（BT-CDBARE-6）；`;` 链（BT-CDBARE-8）、无 extractor 裸词 `sort sub`（BT-CDBARE-7）→ cd_chdir。既有 900+ 测试全绿（实测 bash-extract 589/589、项目全量 932/932，排除已知既有 flaky AL4/AL7）。
- **预期之外的副作用**：①SYS-KP 弹窗载体失效（trust 下游影响，已处理，见上）；②spec delta 自相矛盾——「cd 后相对路径引用伴重定向 token 仍判不可靠」既有场景（`ls sub 2>/dev/null` → cd_chdir）与本 change 新增 BT-CDBARE-4 场景（`ls node_modules/... 2>/dev/null` → reliable）对同一形态相反，前提假设已被本 change 更新——用户拍板「回写 spec」改为豁免（场景标题保原名匹配，语义写 WHEN/THEN）；③收尾 review 判出 1 critical + 1 warning + 1 nit（见上），已修复 + 回写注记（`-newer`/`-samefile`/`-fprint`/`-fprintf` 实现刻意排除，design.md:37 + spec.md:50 回写注记）。
- **scenario→test 覆盖账本状态**：本 change `applyRequires: ['tasks']`（不含 `specs`），scenario→test 账本非强制。delta 7 个新增场景（含 4 个 read-only 裸词目录/find flag 值 + 3 个重定向 token）均有对应测试覆盖（BT-CDBARE-1..11），无 unmapped scenario 未标 N/A。
