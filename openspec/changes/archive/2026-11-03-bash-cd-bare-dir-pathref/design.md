## Context

`cd <绝对路径> && …` 链下，read-only 目录列举/搜索命令被误判 `cd_chdir` 弹窗。系统提示词承诺「cd 目标绝对、下游无 `.`/`..`/glob 时自动放行」，但 D2a 豁免的**条件 7/9「不可提取裸词排除」**把真实目录引用（`src`、`dist/`）当不可提取裸词排除，导致承诺未兑现。且 `find` 的 **flag 值**（`-type f` 的 `f`、`-maxdepth 2` 的 `2`）被 `collectStagePathRefs` 误收集，进一步排除豁免。

现状约束（`shell-forwarder.ts`）：
- D2a 条件 7（:910）：write/delete 命令的位置参数必须绝对或 `looksLikePath` 可提取。
- D2a 条件 9（:898）：非绝对 + 非网络/fd + `!looksLikePath` → 排除豁免。
- `collectStagePathRefs`（:616）：`find` 的 flag 值被当位置参数收集。
- `readExtract`（extractors.ts:47）：`looksLikePath(t)` 为 false 的裸词目录不 push target。

## Goals / Non-Goals

**Goals:**
- 修复 read-only 裸词目录（`find src`/`grep ... dist/`/`ls node_modules/@earendil-works`）在 cd 链下的 `cd_chdir` 误报——在 D2a 豁免下把它们解析为真实 read target。
- 修复 `find` flag 值（`-type f`/`-maxdepth 2` 等）被误收集导致的条件 9 误判。
- 保持 fail-closed：write/delete 裸词（`rm -rf sub`）、cwd-anchor（`find .`）、`;`/`||` 链、glob、无 extractor 裸词（`sort sub`）仍 `cd_chdir`。

**Non-Goals:**
- 不改变 `;`/`||`/`&`/换行链的保守排除（条件 1，设计内——`;` 下 cd 失败时下游仍执行）。
- 不改变 cwd-anchor `.` 的保守排除（条件 4，设计内——`.` 无法静态确定目标集）。
- 不改变 glob 的保守排除（条件 5，设计内）。
- 不改变 `$PWD`/`$OLDPWD` 的保守排除（条件 8）。
- 不修复无 extractor 命令裸词（`sort sub`，条件 10）——这些命令无法消费 `resolveBase`。

## Decisions

### D1. 修复方向：收窄条件 7/9，不放宽条件 4/5/8

条件 9 的裸词排除是**有意防静默放行**（豁免会 0-target）。正确修复不是删掉条件 9，而是**收窄**为「extractor 无法提取为 target 的裸词」：
- read-only 文件参数命令（`find`/`grep`/`ls`/`cat` 等，在 `COMMAND_TABLE` 有 extractor 且可消费 `resolveBase`）的裸词目录 → 不再排除，改经 `resolveBase` 提取为绝对 read target。
- write/delete 命令（`rm`/`mkdir`/`mv`/`cp`/`touch`/`chmod` 等）的裸词 → **仍排除**（写裸词无法安全提取，`cd /tmp/x && rm -rf sub` 真实删 `/tmp/x/sub`，若放行静默删）。

**理由**：read-only 裸词目录在 D2a 下 cwd 已模拟，落点可静态确定（`/cd目标/src`），且 extractor 能提取为 target——决策层仍按 `/cd目标/src` 判定读权限，不构成静默放行。write 裸词无法安全提取（extractor 对 write 命令的裸词位置参数不 push target，会 0-target 静默放行），必须保守排除。**备选（否决）**：a) 直接删条件 9 → write 裸词也放行，开静默放行洞；b) 全局放宽 `looksLikePath` 认裸词目录 → 会影响非 cd 场景（`cat sub` 在非 cd 下提取 0 target 变 `/proj/sub`，改变既有行为），风险面大。

### D2. find flag 值跳过：在 collectStagePathRefs 加 find 专用 flag 值集合

`collectStagePathRefs` 对 `find` 命令的 flag 值参数跳过收集。flag 值集合：`-type`/`-name`/`-maxdepth`/`-mindepth`/`-path`/`-size`/`-mtime`/`-newer`/`-newermt`/`-user`/`-group`/`-iname`/`-ipath`/`-regex`/`-iregex`/`-perm`/`-inum`/`-samefile`/`-links`/`-printf`/`-fprint`/`-fprintf`/`-fstype`/`-delete`（无值）。
**刻意排除（勿按上文文本实现）**：`-newer`/`-newerat`/`-newerct`/`-samefile`/`-fprint`/`-fprintf` 的**第一个值**是文件引用（真实落点依赖 cwd），必须保持收集供条件 9 排除（fail-closed）——若按上文文本跳过它们，决策侧 refs 空 → d2a 保持 true → 0 target 静默放行读外区。实现（`extractors.ts` `FIND_NONPATH_FLAG_ARGS`）刻意不含这六个 flag，与决策/提取两侧复用同步。回写注记原因：收尾 review nit 文档漂移，实现是更安全的偏差。

**理由**：这些 flag 值是查询条件（`f`/`2`/`*.ts`/`+0`），不是文件路径引用。收集它们（`looksLikePath("f")`=false）会误判条件 9。`find` 的**位置参数**（起点目录，如 `src`、`/tmp/x`）仍是路径引用，照常收集。**备选（否决）**：a) 全局跳过所有 flag 值 → 会误跳 `-name` 之后真实文件引用（无）；b) 不修 → `find /abs/src -type f` 仍误弹。

### D3. readExtract 裸词目录提取：加一个 `bareDirOk` 参数 + 共享谓词/flag 值集合

`readExtract` 当前只在 `looksLikePath(t)` 为 true 时 push target。D1 收窄后，D2a 下 read-only 裸词目录（`looksLikePath=false`）需要被提取为 target。给 `readExtract` 加一个可选 `bareDirOk` 标志（默认 false，向后兼容）——当 D2a 豁免适用且命令是 read-only 文件参数命令时，`bareDirOk=true`，裸词目录也经 `toAbsolutePath(expandHome(t), resolveBase)` push 为 read target。

**共享谓词单一事实源（W1 收敛）**：「哪些命令可消费裸词目录」的谓词（如 `canExtractBareDir(cmdBase, tokens)`）MUST 定义为**单一导出纯函数**，被 D1（shell-forwarder 条件 9 收窄）与 D3/D4（entry.ts 传 bareDirOk）共同引用——避免两处各自判断导致「决策侧判可提取放行、提取侧判不可提取没传 bareDirOk」的 0-target 静默放行洞。该谓词天然归属 `extractors.ts`（谁消费 `resolveBase` 提取裸词目录），shell-forwarder 侧复用（不复述知识）。谓词判据：命令在 `COMMAND_TABLE` 有 extractor **且** extractor 是可消费 `resolveBase` 的 read-only 命令（`find`/`grep`/`ls`/`cat`/`head`/`tail`/`wc`/`stat` 等，非 `WRITE_DELETE` 集合）。

**find flag 值提取侧同步（W2 收敛）**：`bareDirOk=true` 下 `readExtract` 的 push 分支 MUST 也跳过 find 的 flag 值（复用 D2 的 `FIND_FLAG_VALUE_ARGS` 集合）——否则 `find /abs/src -type f` 的 `f`/`-maxdepth 2` 的 `2` 会被 `readExtract` 当 read target push（`/abs/src/f`、`/abs/src/2`，目标集污染）。D2 的 flag 值集合是**共享常量**，决策侧（collectStagePathRefs）与提取侧（readExtract）复用同一集合，不各自定义。

**理由**：不加标志直接放宽 `readExtract` 会影响所有调用方（非 cd 场景 `cat sub` 会提取 `/proj/sub`）。加标志限定 D2a 场景，保持非 cd 行为不变。**备选（否决）**：a) 全局放宽 `readExtract` → 非 cd 场景 `cat sub` 行为变化；b) 在 entry.ts 提取后补 target → 重复提取逻辑。

### D4. 实现位置：shell-forwarder.ts（收集/条件）+ extractors.ts（提取 + 共享谓词/常量）+ entry.ts（传递）

- `collectStagePathRefs`（shell-forwarder.ts）：加 find flag 值跳过（D2，复用 `FIND_FLAG_VALUE_ARGS` 共享常量）。
- D2a 条件 9（shell-forwarder.ts）：收窄裸词排除——read-only 文件参数命令（`canExtractBareDir` 为 true）的裸词目录不再排除（D1，复用共享谓词）。
- `readExtract`（extractors.ts）：加 `bareDirOk` 参数（D3）+ find flag 值跳过（复用 `FIND_FLAG_VALUE_ARGS`）。
- entry.ts：D2a 豁免时传 `bareDirOk=true` 给 read-only 命令的 extractor（复用 `canExtractBareDir` 谓词）。

**bareDirOk 传递机制（W4 明确）**：`Extractor` 类型契约为 3 参 `(tokens, targets, projectRoot) => void`，`COMMAND_TABLE` 统一分派（entry.ts:334 `extractor(tokens, targets, resolveBase)`）。为不改 16 个 extractor 的公共契约（接口最小化），bareDirOk **不经 COMMAND_TABLE 分派**，由 entry.ts 在 D2a 豁免时**按谓词判定后**对 `readExtract` 直接调用额外参数（`bareDirOk` 是 `readExtract` 函数签名层面的可选参，非 `Extractor` 类型扩展）——`COMMAND_TABLE[cmd] === readExtract` 身份分派是刻意权衡（`readExtract` 是唯一需要 bareDirOk 的 extractor，身份分派仅限 entry.ts 内部，不改变 COMMAND_TABLE 注册签名）。**备选（否决）**：a) 加宽 `Extractor` 类型至 4 参 → 影响全部 16 个 extractor 与 COMMAND_TABLE 契约，违背接口最小化；b) entry.ts 无条件传 bareDirOk 给所有 extractor → 非 readExtract 的 extractor 忽略额外参（TS 报错）。

**依赖方向**：`shell-forwarder.ts` 与 `extractors.ts` 均被 `entry.ts` 消费，无新增环。`readExtract` 是 `COMMAND_TABLE` 内注册的 extractor，`Extractor` 类型契约 `(tokens, targets, projectRoot)` 不变（bareDirOk 是函数签名层面的可选参，非类型扩展，向后兼容）。`FIND_FLAG_VALUE_ARGS` 与 `canExtractBareDir` 从 `extractors.ts` 导出，被 `shell-forwarder.ts`/`entry.ts` 复用（shell-forwarder 已 import `COMMAND_TABLE`，无新增模块级依赖环）。

## Risks / Trade-offs

- **行为变化面**：read-only 裸词目录从「cd_chdir 弹窗」变为「提取 read target」——用户只读命令不再被弹窗打断（目标行为）。write 裸词、cwd-anchor、`;` 链、glob、无 extractor 裸词保持弹窗（fail-closed 安全边界）。
- **过度修复风险**：若 read-only 裸词目录提取逻辑误把 write 命令的裸词也提取，会静默放行写。D1 明确 write/delete 裸词仍排除，D3 的 `bareDirOk` 仅对 read-only 文件参数命令启用。
- **非 cd 场景行为不变**：`bareDirOk` 默认 false，非 D2a 场景 `readExtract` 行为与现状一致（裸词目录仍 0 target）。
- **既有测试影响**：主 spec 的 cd_chdir 反例（`cd /tmp/x && rm -rf sub/`、`cd /etc && cat sub`、`cd /etc && sort sub`）中 `rm`/`sort` 不属 read-only 裸词目录豁免范围，维持 `cd_chdir`；`cat sub`（read-only 裸词）行为变化（原 `cd_chdir` → 提取 `/cd目标/sub` read target），需在 apply 阶段同步更新既有断言——这是预期行为变化，非意外回归。
