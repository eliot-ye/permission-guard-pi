## Context

详见 proposal.md「Why」与「系统工程影响评估」。本节只记录实现约束。

`extractBashTargets`（`src/lib/bash-extract/entry.ts`）的守卫与提取顺序（entry.ts:76 起）：`scanFindWriteFlags` → `scanUnreliable` → `scanControlFlow` → `scanCdChdir` → `isShellForwarder`（含 `tryExtractLiteralShellC` 递归）→ `isAnyUnreliableCommand`（含 sed 豁免）→ 逐 stage（`splitPipelines`）提取。不可靠统一返回 `{ reliable: false, rawCommand, reason }`，决策层（`extensions/index.ts:700`）对不可靠走 tier=three 弹窗；对可靠逐 target 走 `decideTarget`，**任一 target 触发 prompt 即 `return handlePromptDecision(...)`（entry.ts:788）**。

四条绕过的精确根因（均已实测复现，见 proposal 表格）：

1. **管道 find**：`scanFindWriteFlags`（`control-flow.ts:9`）遍历 `splitCommands(cmd)`——按 `;`/`&&`/`||`/`&`/`\n` 拆分，**不含 `|`**。`echo hi | find /outside/victim -delete` 整条是一个 fragment，首 token 是 `echo` 而非 `find`，`isFindReadOnly` 守卫从未进入 → 落到逐 stage 提取时 `find` 被 `SUBSTITUTION_READONLY_CMDS` / 只读命令表当只读，返回 `read /outside/victim`。裸 `find /etc -name x -delete` 首个 fragment 首 token 是 `find`，正确命中 `find_write_flag`（对照组，已验证）。
2. **带引号重定向**：`extractRedirects`（`parse.ts:504`）路径读取循环 `while (!/[\s;|>&<]/.test(...))` **把引号字符纳入 path** → `path === '"/outside/output"'`；`looksLikePath`（`parse.ts:429`）`token.startsWith("/")` 对以 `"` 开头的 token 返回 false → `continue` 跳过，目标漏提。
3. **bash -c 外层重定向**：`isShellForwarder` 命中后 `tryExtractLiteralShellC`（**`entry.ts:34`**，非 `shell-forwarder.ts`）递归提取 `-c` 字符串**内部**目标并在 `entry.ts:55` 直接 `return`，**未合并外层重定向目标**（`> /outside/output`）。外层写目标丢失。
4. **for 赋值前缀**：控制流体只读判定 **`silent.ts:932`** `isForBodyReadOnly` 经 `isAssignmentPart`（**`silent.ts:975`**，`rhs` 不含特殊字符即 `silent.ts:982 return true` 整段豁免）把 `x=5 rm /outside/victim` 识别为变量赋值豁免形态，未继续对赋值前缀之后的 `rm` 执行写守卫 → 整体判只读、0 目标。`readonly.ts:445` 仅是调用点。

附加发现（多 target unread 绕过，非 extraction）：`extensions/index.ts:750` 逐 target 循环在首个 prompt target 处 `return handlePromptDecision(...)`（:788），早退跳过后续 target 的 `unread` 硬拒扫描。`access-decision` spec「unread 权限语义」requirement 已要求每个 target `deny_hard`——**实现违反既有契约**，非契约缺失。

## Goals / Non-Goals

**Goals:**

- 四条 extraction 绕过不再返回「`reliable:true` + read/空目标」的放行结果；改后各守卫正确降级 `reliable:false` 或提取到正确写/删除目标。
- 多 target bash 命令的 `unread` 硬拒在 prompt 短路前完成（符合既有 `unread` 契约）。
- 真正只读命令免弹行为不回归（验证式白名单保留低弹窗，见 proposal 权衡处置）。

**Non-Goals:**

- **不扩展 `ExtractResult` 类型形状**——不加 `confidence`/`partial` 字段（见 Decision D0）。
- 不重构 `bash-extract` 模块组织或 `entry.ts` 守卫编排结构。
- 不改动 `grant-memory`、unread 硬拒、tier 语义等既有决策机制（`access-decision` spec 无 delta）。
- 不穷举所有 shell 语法——只修复已复现的对抗形态 + 既有只读豁免的写 flag 校验收紧；未列形态由 fail-closed 兜底（守卫漏判 → 降级弹窗）。

## Decisions

### D0 — 不扩展 `ExtractResult` 类型，复用既有 `reliable:false` 分支，只收紧降级触发条件

proposal「What Changes」提到「`ExtractResult` 契约增加 fail-closed 降级语义」。实现层面**不新增类型字段**：现有 union 已含 `{ reliable: false, rawCommand, reason }` 分支，四条绕过的修复都是**让漏判的守卫正确返回该分支**，而非引入新的表达能力。

- **Rationale**：类型形状不变 → 无公共符号变更 → 消费方（`extensions/index.ts`、`access-decision`）零适配，规避跨子系统 breaking。比新增 `confidence` 字段更符合「局部动作从整体性能反推」——fail-closed 的本质是「判不可靠就弹窗」，现有机制已完备，缺的是判据精确度，不是表达能力。proposal 的「契约增加降级语义」在此明确为**语义收紧，非类型变更**（spec delta 写「降级为不可靠」指行为，不指类型）。
- **Alternatives**：
  - 新增 `confidence`/`partial` 字段（explore 阶段 a1 原始设想）→ 需改所有消费方判断逻辑，跨子系统 breaking，且四条已复现绕过用现有 `reliable:false` 即可覆盖，新字段无增量收益。**否决**。
  - 保持现状逐提取器打补丁 → 见 proposal「局部优化对全局失调的风险」，否决。

### D1 — `scanFindWriteFlags` 改用 `splitPipelines` 逐 stage 守卫

`control-flow.ts:9` 的 `scanFindWriteFlags` 将 `splitCommands(cmd)` 改为对每个 command fragment 再 `splitPipelines`，对**每个 stage 的首 token**独立判 `find` + `isFindReadOnly`。任一 stage 命中写 flag → 返回 `find_write_flag`。

- **Rationale**：直接命中根因 1——写 flag 守卫的判定单元应与提取单元（stage）对齐。`splitPipelines` 已是 quote-aware、`||`/`|&` 感知的成熟拆分器（`parse.ts:58`），复用无新依赖。
- **Alternatives**：
  - 在 `scanFindWriteFlags` 内自写管道拆分 → 重复造轮子，易与 `splitPipelines` 语义漂移。**否决**。
  - 把 `find` 加入 `UNRELIABLE_COMMANDS` 全量弹窗 → 过度收紧，`find /etc | sort` 等纯只读管道被误伤（违反「真正只读免弹」目标）。**否决**——`isFindReadOnly` 写 flag 校验已足够精确。

### D2 — `extractRedirects` 剥离重定向目标的引号后再判 `looksLikePath`

`parse.ts:504` 路径读取循环在读到首字符为 `"`/`'` 时进入引号感知子模式：读到匹配闭引号为止，剥引号后取内部路径；无闭引号（`> "/outside/output`）保守降级为不可靠。`looksLikePath` 收到剥引号后的纯路径。

- **Rationale**：命中根因 2——引号是 shell 语法不是路径的一部分。剥引号后 `looksLikePath` 既有判定（`startsWith("/")` 等）即正确工作。单引号内字符全字面、双引号内除 `$(` 外字面——重定向目标场景 `$(` 已由 `scanUnreliable` 上游处理，此处剥引号不引入新命令替换风险。
- **Alternatives**：
  - 在 `looksLikePath` 内剥引号 → `looksLikePath` 被多处调用（token 级），改动影响面大于重定向单点。**否决**——只在 `extractRedirects` 剥引号，影响面最小。
  - 带引号重定向一律降级不可靠 → `echo hi > "relative.log"` 等合法只读写被误弹，可用性损失。**否决**——剥引号后正常提取更精确。
- **多调用方契约对齐**（架构 review Issue 3）：`extractRedirects` 有**两个**调用方——`entry.ts:383`（主提取路径）与 `silent.ts:870`（`isSedReadonlyForm` 用它收集写重定向以判 sed 豁免）。D2 改变其返回契约（无闭引号 → 返回降级信号），两处 MUST 同步对齐：`silent.ts:870` 侧在无闭引号降级信号出现时 MUST 判 sed 只读豁免**不成立**（含未闭合引号写重定向的 sed 脚本保守弹窗），不可因剥引号逻辑误判为「无写重定向」。详见 tasks 3.3。

### D3 — `tryExtractLiteralShellC` 合并外层重定向目标

`entry.ts:34` 的 `tryExtractLiteralShellC` 递归提取 `-c` 字符串内部目标后，**在返回前对该命令的外层部分跑一次 `extractRedirects`**，把外层重定向目标并入结果 targets。外层重定向存在但无法解析时 → 整体降级不可靠（D0 fail-closed）。

> 文件归属（架构 review Issue 1 更正）：`tryExtractLiteralShellC` 定义于 **`entry.ts:34`**（在 `entry.ts:117` 被调用），**非** `shell-forwarder.ts`——`shell-forwarder.ts` 只提供 `isShellForwarder` / `extractShellCArg` / `isPureLiteralShellArg` 等判定原语。实施改 `entry.ts`。

- **Rationale**：命中根因 3——递归提取解决了「看不到转发体内部」，但外层 `> file` 在递归返回时被丢弃（`entry.ts:55` 直接 return 内层目标）。合并外层重定向补齐完整目标集，与「提取必须完整，否则 fail-closed」一致。
- **Alternatives**：
  - 外层带重定向的 `bash -c` 一律降级不可靠 → `bash -c "grep x f" > out.log` 等常见形态被误弹。**否决**——合并比降级更精确，且真正无法解析时仍可降级兜底。
  - 在 `isShellForwarder` 层提前拦截所有带重定向的转发命令 → 粒度过粗，丢失「转发体只读 + 外层只读」的合法免弹。**否决**。

### D4 — 控制流体只读判定对「变量赋值前缀命令」继续守卫后续命令

`silent.ts:932` 的 `isForBodyReadOnly`（经 `isAssignmentPart`（`silent.ts:975`）识别 `VAR=value cmd args` 赋值前缀形态）**不得将 `cmd args` 一并豁免**——赋值前缀剥离后须对 `cmd` 继续执行写守卫与目标提取；无法确定时降级不可靠。

> 文件归属（架构 review Issue 1 更正）：只读判定的真正定义在 **`silent.ts:932`** `isForBodyReadOnly`，赋值豁免根因在 **`silent.ts:975`** `isAssignmentPart`——`x=5 rm /outside/victim` 的 rhs 不含特殊字符 → `silent.ts:982 return true` 整段豁免。`readonly.ts:445` 仅是调用点，**实施改 `silent.ts`，非 `readonly.ts`**。

- **Rationale**：命中根因 4——赋值前缀是 `x=5 rm ...` 的合法 shell 语法，`rm` 仍是待守卫命令。赋值豁免只应豁免「纯赋值」（`x=5` 无后续命令），不应连带豁免赋值后的真实命令。
- **Alternatives**：
  - 控制流体一律降级不可靠 → 回退 `bash-cd-readonly` 等豁免成果，纯只读循环（`for f in a; do cat $f; done`）被误弹，违反非目标。**否决**——只收紧赋值前缀带命令的形态。
  - 赋值前缀命令全量弹窗 → `x=5 cat $f` 被误弹。**否决**——继续守卫 `cat` 仍可判只读免弹。

### D5 — 多 target 循环：先完成全部 target 硬拒扫描，再进入 prompt

`extensions/index.ts:750` 逐 target 循环改为**两阶段**：第一阶段对全部 target 跑 `decideTarget`，任一 `deny_hard` → 立即 hard-deny 返回（保持现有 audit）；第一阶段无 hard-deny 后，第二阶段再按序处理 prompt/allow。

- **Rationale**：命中多 target unread 绕过——unread 硬拒 MUST NOT 被 prompt 早退跳过（既有契约）。两阶段把「硬拒优先」提升为循环级不变量，单个 target 的 prompt 不再屏蔽后续 target 的 unread 检查。
- **性能注记**（架构 review Issue 4，nit 级）：两阶段下 prompt target 会被 `decideTarget` 调用两次（阶段一扫描 + 阶段二 prompt）。`decideTarget` 是纯决策函数（audit 在循环分支内，重复调用多算不改语义），正确性无影响，仅约 2x 计算。实施时可在阶段一缓存每个 target 的 decision，阶段二复用——非阻塞优化，见 tasks 6.1。
- **Alternatives**：
  - 在单循环内 prompt 前预扫所有 target 的 unread → 逻辑上等价，但把 unread 检查散在 prompt 分支前，易随迭代漂移。两阶段更清晰表达「硬拒优先于 prompt」。**采用两阶段**。
  - 改 `decideTarget` 签名让 prompt 决策携带后续 target 信息 → 跨函数耦合，复杂度高。**否决**。

## Risks / Trade-offs

- **[弹窗量上升]** 收紧守卫后，部分此前静默放行的形态改为弹窗 → Mitigation：D1/D4 用 `isFindReadOnly`/继续守卫等**精确判据**而非全量弹窗，真正只读形态保持免弹；explore 阶段已量化「豁免数量基本保持，判据收紧」。改后跑全量测试对比弹窗用例增量，若超出预期回看判据是否过粗。
- **[D2 剥引号边界]** 无闭引号、引号内特殊字符等边界 → Mitigation：无闭引号保守降级不可靠（fail-closed）；单引号内 `$(` 不触发命令替换（shell 语义，`scanUnreliable` 上游已覆盖），双引号内 `$(` 沿用既有规则。新增边界用例覆盖。
- **[D3 外层重定向合并遗漏]** 外层重定向目标形态多样（`&>`、fd 复制、`>>`）→ Mitigation：复用 `extractRedirects` 既有 operator 处理，不新写解析；`/dev/*` fd 豁免沿用。
- **[既有测试把漏洞行为写成预期]** 部分 `test/bash-extract.test.ts` 断言可能固化了绕过行为 → Mitigation：TDD 先写对抗用例（RED）再修守卫（GREEN）；对固化漏洞的既有断言逐条更正并注明理由，不静默删测试。
- **[改老代码回归]** `bash-extract` 是 5608 行 / 32 requirements 的成熟子系统（brownfield）→ Mitigation：每条 Decision 独立小步提交，每步跑全量 `node --experimental-strip-types --test test/`；对照 7 条对照组命令（proposal 表）不回归。

## Migration Plan

单仓库内闭环，无外部迁移。实施顺序按依赖与风险递增：

1. TDD 写对抗用例（RED）→ 修 D1–D4 extraction 守卫（GREEN），每条独立提交；
2. 修 D5 orchestration 两阶段循环 + unread 硬拒回归用例；
3. 全量测试 + 既有只读豁免回归对照。

回滚：每条 Decision 独立提交，可逐条 revert；无数据/配置迁移，revert 即恢复。spec delta 在 archive 时合入 baseline。

## Open Questions

无——四条根因均已复现定位，设计决策不依赖未确定信息。弹窗增量的可接受阈值由「真正只读免弹不回归」约束，无需额外拍板。