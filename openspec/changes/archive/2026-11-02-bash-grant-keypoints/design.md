# Design: Bash grant keypoints (命令关键点授权)

## Context

见 `proposal.md` - Why。当前实现的 bash grant 键派生是**整条命令 hash**：

- `path-utils.ts` `bashCommandHash(rawCommand)` = `sha256(normalizeBashCommand(rawCommand))`——`normalizeBashCommand` 只做词法 whitespace 规范化（`replace(/\s+/g," ").trim()`）。
- `trust.ts` `bashKey(projectHash, rawCommand)` = `projectHash | hashCommand(rawCommand)`——整条命令精确匹配。

样本命令（cd 只读巡查链）触发 `cd_chdir`（`extractBashTargets` 返回 `reliable:false, reason:"cd_chdir"`），弹窗文案要求批准整条命令。用户选择「允许本会话/总是允许」后，grant 键 = 整条命令 hash——`head -50`→`-60`、`-type f`→`-type d`、增删 `2>/dev/null` 都换 hash 重新弹窗，虽然访问集与动作不变。

关键点机制把 grant 键从整条命令 hash 改为**命令关键点**（token 级派生），只保留决定「访问哪个文件、什么动作」的 token。

**关键解析原语（既有，复用不新增）**：
- `splitCommands`（`parse.ts:293`）：按 `&&`/`||`/`;`/换行拆片段，quote-aware。
- `splitPipelines`（`parse.ts:58`）：按 `|` 拆管道 stage（`||` 除外）。
- `tokenize`（`parse.ts:378`）：quote-aware 空白分词。
- `looksLikePath`（`parse.ts:429`）：路径 token 判定。
- `toAbsolutePath`（`path-utils.ts:35`）：相对路径绝对化（按 projectRoot 或追踪 cwd）。
- `normalizeBashCommand`（`path-utils.ts:227`）：词法 whitespace 规范化。

## Goals / Non-Goals

**Goals:**
- bash grant 键从整条命令 hash 改为命令关键点 hash，使「同一访问集 + 同一动作」的命令命中同一 grant（免弹）。
- 只忽略确定不改变安全性质的 token（纯读 flag、fd 重定向、文本参数），保留所有决定访问集与动作的 token。
- 旧整条 `commandHash` grant 双轨兼容（不迁移，授权范围不自动扩大）。
- 单一事实源：`bashCommandKeypoints` 在 `bash-extract/keypoints.ts`（bash 命令分析子系统），trust 消费它；audit 通道仍用 `bashCommandHash`（整条，不变），B5 契约不破坏（见 Decision 6）。

**Non-Goals:**
- 不做语法级语义漂移等价：`bash -c "git status"` ≢ `git status`、`cd /tmp && git status` ≢ `git status`（MUST NOT 判等价，与 Non-Goal「不做完整 shell 解析」对齐）。
- 不新增解析器（复用既有 `splitCommands`/`splitPipelines`/`tokenize`/`looksLikePath`/`toAbsolutePath`）。
- 不做穷尽 flag 清单（有限白名单，清单外保守保留）。
- 不迁移旧 grant（双轨不迁移，用户重授权才获得关键点免弹）。
- 不改变 `bashCommandHash` 的既有语义（保持整条 hash，作为双轨的旧轨与 audit 一致性锚点）。

## Decisions

### Decision 1：新增 `bashCommandKeypoints(rawCommand, projectRoot): string`，放 `bash-extract/keypoints.ts`

**选择**：新增导出函数 `bashCommandKeypoints`，返回关键点规范字符串（token 分类序列的规范化形式）。grant 键 = `sha256(bashCommandKeypoints(...))`。函数放在 `bash-extract/keypoints.ts`（bash 命令分析子系统），`trust.ts` 消费它。

**理由**：
- 关键点派生本质是 **bash 命令解析**（tokenize / 拆片段 / 路径判定 / cwd 追踪），归 bash-extract 子系统语义正确（`bash-extract-split` 归档确立「bash-extract 是 bash 命令解析子系统」）。
- `bash-extract` 已有全部解析原语（`splitCommands`/`splitPipelines`/`tokenize`/`looksLikePath`），放这里可直接复用，**不新增解析器**，与 Non-Goal「不做完整 shell 解析」对齐。
- 放置决策的循环依赖分析见 Decision 4（方案 C，采纳）。

**备选 A**：放 `path-utils.ts`。问题：`path-utils` 需要 import `bash-extract/parse`（`splitCommands` 等），但 `parse.ts:4` 已 import `path-utils`（`expandHome`/`toAbsolutePath`/`isInside`）——形成**循环依赖**（path-utils ↔ parse），不可行。**否决**。

**备选 B**：在 `trust.ts` 内部实现。问题：破坏「单一事实源」——关键点派生若分散到 trust，audit 通道复用会漂移（B5 一致性）；且 trust 是 policy-core，内联 bash 解析逻辑职责偏散。**否决**。

### Decision 2：关键点 token 分类规则（窄边界）

**选择**：顺序扫描每个片段/管道 stage 的 token，按类别处理（见 proposal 的「关键点规则」表）。核心安全判据：**等价类 = 同一访问集 + 同一动作**，忽略的 token MUST NOT 改变访问集与动作。

**关键点输出格式**（规范字符串，`|` 连接）：
- `cd:<绝对化>`（绝对路径/`~`/相对路径，均可静态解析）或 `cd-var:<原始>`（仅 `$VAR` 不可静态解析）
- `CMD:<basename>`
- `PATH:<绝对化>`（`looksLikePath` 位置参数）
- `WRITE:<绝对化>`（写重定向目标）
- `FLAG:<名>` + `FLAGVAL:<值>`（写/不确定 flag）
- `GLOB:<原始>`（shell glob 位置参数，非 find 匹配 flag）
- `WORD:<原始>`（其余裸词，保守保留）

**忽略类别**：纯读 flag（名+值连跳）、fd 重定向、文本命令参数、纯文本 token。

**关键安全区分（find 内部匹配 vs shell glob）**：`find -name '*.ts'` 的 `*.ts` 是 find 内部匹配（遍历根由路径参数决定）→ 连跳安全；`cat src/*.ts` 的 `src/*.ts` 是 shell glob 展开（决定访问集）→ 必须保留。两处 `*.ts` 语义不同，不得混淆——否则 `cat *.ts`↔`cat *.go` 被误判等价会误放行。

**cd 落点追踪**：维护追踪 cwd，初始 = projectRoot；`cd <绝对路径>` 更新追踪 cwd 并记录 `cd:<绝对落点>`。**仅 `$VAR`（未解析变量，无法静态确定值）降级**为 `cd-var:<原始>` 且不更新追踪 cwd（下游 PATH 按当前追踪 cwd 保守解析，避免误放行）；`~`（展开家目录）与相对路径（按追踪 cwd 解析）**均能静态解析**，记录 `cd:<绝对化>` 并更新追踪 cwd——`toAbsolutePath` 对 `~`/相对路径已做解析（`path-utils.ts:35-57`），无需降级。

**理由**：窄边界下，忽略 token 不改变访问集与动作；保留 token 决定「访问哪个文件、什么动作」。等价类内安全性质相同（不误放行），关键点不同必有一个安全维度不同（保守弹窗）。反例实证全部通过（proposal「等价边界」节）。

### Decision 3：纯读 flag 有限白名单

**选择**：每命令一份有限白名单（find/head/tail/cat/wc/ls），白名单内 flag 名+值连跳；清单外 flag（`rm -rf`、`find -delete`、`sed -n` 等）保留为 `FLAG`+`FLAGVAL`。

**理由**：与方向 A 窄边界一致——清单外保留 = 保守多弹不误放行。穷尽清单一旦遗漏写 flag 会误放行（危险），否决穷尽方案。清单覆盖常见纯读命令的已知纯读 flag；清单外 flag 的「免弹不足」是安全方向正确的已知边界（多弹不误放行）。

**清单来源**：`readonly.ts` 的 `READ_ONLY_COMMANDS`（命令是否纯读判据）+ `FIND_WRITE_FLAGS`（find 写 flag 判据）可作命令级判据；纯读 **flag 名**清单需新写（find/head/tail/cat/wc/ls 各一份）。`find -maxdepth` 等若漏名单会多弹（保守，安全方向正确）。

### Decision 4：循环依赖处理（放置 `bash-extract/keypoints.ts`）

**选择**：`bashCommandKeypoints` 放在 `bash-extract/keypoints.ts`，`trust.ts` 从 bash-extract import（方案 C，采纳）。`path-utils.ts` 不依赖 bash-extract。

**方案 A（备选）**：把关键点派生函数放到 `path-utils.ts`，但 `path-utils` 需要 import `bash-extract/parse`，而 `parse.ts:4` 已 import `path-utils`——形成**循环依赖**（path-utils ↔ parse），不可行。**否决**。

**方案 B（备选）**：把 `bashCommandKeypoints` 放 `path-utils.ts`，但**不 import** bash-extract parse——在 `path-utils` 内实现一个**最小 tokenize/拆片段**（仅够关键点派生用，不需要完整 bash 解析）。问题：复制解析逻辑，破坏「复用既有解析原语」的 Non-Goal。**否决**。

**方案 C（采纳）**：把 `bashCommandKeypoints` 放 `bash-extract/keypoints.ts`，`trust.ts` 从 bash-extract import；`path-utils` 不依赖 bash-extract。关键点派生本质是 bash 命令解析（tokenize/拆片段/路径判定），归 bash-extract 子系统语义正确；`trust.ts` 已是 bash grant 消费方（import `bashCommandHash` 从 path-utils，keypoints 从 bash-extract import）。检查依赖图：`bash-extract/parse.ts` import `path-utils`（单向，无循环）；`bash-extract/keypoints.ts` import `path-utils`（`toAbsolutePath`/`normalizeBashCommand`）+ `parse`（tokenize/splitCommands/splitPipelines/looksLikePath）——单向，无循环；`trust.ts` import `path-utils`（`bashCommandHash`）+ `bash-extract/keypoints`——单向，无循环。**无循环依赖**。跨子系统边（trust → bash-extract）同方向已存在（`decision.ts` import `isDevSocketOrFd` from bash-extract），未引入新架构方向。

**结论**：采纳方案 C——`bashCommandKeypoints` 放 `bash-extract/keypoints.ts`（新文件），导出供 `trust.ts` 消费。这与「bash-extract 是 bash 命令解析子系统」的既有分层一致（`bash-extract-split` 归档时确立）。

### Decision 5：双轨不迁移（核心安全决策，用户已拍板）

**选择**：新 grant 用 `keypointsHash`（关键点）；旧 grant 保留 `commandHash`（整条 hash）精确匹配。查询时 `关键点命中 || 整条命中`。

**字段设计**（`BashGrant` 扩展）：
- 新增 `keypointsHash?: string`（可选，新 grant 写入；旧 grant 缺省）。
- `commandHash` 保留（整条命令 hash，既有字段；旧 grant 用它精确匹配，新 grant 也写入它作为 audit 一致性锚点——`bashCommandHash` 语义不变）。

**projectRoot 来源（方案 A，用户拍板）**：`createTrustStore(trustedFilePath, projectRoot)`——trust 层内部持有 `projectRoot`，写入端与查询端都用它调用 `bashCommandKeypoints(rawCommand, projectRoot)` 派生关键点。关键点派生需要 projectRoot（相对路径绝对化），而 `hasBashSessionGrant`/`hasBashPersistentGrant` 签名不含 projectRoot——由 `createTrustStore` 持有并注入，单一事实源。既有 caller 适配：`extensions/index.ts:148` 传 `state.projectRoot`（`initSession` 已有 `projectRoot`）；测试 `withTmpStore`/`extensions/index.test.ts:1749` 传测试 projectRoot。

**写入逻辑**（`addBashSessionGrant`/`addBashPersistentGrant`）：同时写 `commandHash`（整条）+ `keypointsHash`（关键点，`sha256(bashCommandKeypoints(rawCommand, projectRoot))`）。

**查询逻辑**（`hasBashSessionGrant`/`hasBashPersistentGrant`）：先查 `keypointsHash` 命中（新 grant，用 `bashCommandKeypoints(rawCommand, projectRoot)` 派生传入命令关键点），再查 `commandHash` 整条命中（旧 grant）；任一命中 → true。

**理由**：用户对 `head -50` 的授权**不自动扩大**覆盖 `-60`——这是用户没授权过的命令，自动变宽是公共契约变更的安全核心，用户已拍板「双轨不迁移（保守）」。零迁移、零数据破坏；回滚 = 还原查询逻辑一行。

**备选（迁移）**：加载时从 `rawCommand` 重算 `keypointsHash`，旧 grant 立即用关键点匹配——授权范围自动扩大，用户当初只授权了 `head -50` 却覆盖 `-60`。用户拍板**否决**（安全方向保守）。

**备选 B（调用方预计算）**：`hasBashSessionGrant`/`hasBashPersistentGrant` 签名加可选 `keypointsHash` 参数，由 `handleBash`（有 `state.projectRoot`）预计算传入。问题：把计算责任推给调用方，职责偏散；且签名加参数虽向后兼容但破坏「签名不变」的 caller impact 预判。用户拍板**否决**（选 A）。

### Decision 6：audit 键派生一致性（B5）

**选择**：audit 截断记录的 `commandHash` 仍用 `bashCommandHash`（整条，不变）——B5 契约「audit 与 grant 键派生一致」指 audit 的 `commandHash` 与 `trusted.json` 的 `bashGrants[].commandHash` 一致。由于 `commandHash` 语义不变（整条），B5 契约**不破坏**；`keypointsHash` 是新增并行字段，audit 不额外记录（B5 只要求 commandHash 一致性，keypoints 是 grant 内部匹配用）。

**理由**：最小改动——不动 audit 通道，B5 既有断言不回归。audit 需要匹配 grant 时用 `commandHash`（整条）仍精确（旧轨）；若 audit 需要关键点匹配，将来单独评估（本 change 不引入）。

## Risks / Trade-offs

- **[纯读 flag 清单有限 → 清单外 flag 多弹] → 安全方向正确**：清单外 flag（如 `find -maxdepth` 若未列入）保留为 `FLAG`+`FLAGVAL`，保守多弹不误放行。免弹不足是可接受的已知边界（设计级 Non-Goal）。
- **[find 匹配 flag 值 vs shell glob 值混淆 → 误放行] → 显式区分**：`find -name '*.ts'`（内部匹配，连跳）vs `cat src/*.ts`（shell glob，保留）。两处 `*.ts` 语义不同，派生函数按「flag 值 vs 位置参数」区分，实证反例（`cat *.ts`↔`*.go`）不误判等价。
- **[cd 变量落点不可静态解析 → 误放行风险] → 降级保守**：仅 `cd $HOME`（`$VAR`）降级为 `cd-var:<原始>`，不更新追踪 cwd；`~`/相对路径按 `toAbsolutePath` 正常解析为 `cd:<绝对化>` 并更新追踪 cwd（均可静态解析）。`cd /a`↔`/b` 正确区分（实证）。
- **[双轨查询性能] → 无感**：`hasBashSessionGrant` 加一次 `Set.has`，`hasBashPersistentGrant` 加一次 `Array.some`——O(1)/O(n)，persistent grants 典型 < 100，无感。
- **[关键点派生对超长命令性能] → 无感**：O(token) 扫描，毫秒级以下；bash 命令典型 < 100 token。

## Migration Plan

**无迁移**。双轨不迁移——旧 `commandHash` grant 保持整条精确匹配，授权范围不自动扩大；新 `keypointsHash` grant 用关键点匹配。既有 `trusted.json` 的 bashGrants 无需重写（`keypointsHash` 可选，旧 grant 缺省，查询走整条旧轨）。

**回滚**：还原 `trust.ts` 查询逻辑（去掉关键点命中分支）一行 + 还原 `addBash*Grant` 写入（不再写 `keypointsHash`）——无副作用，旧 grant 立即恢复整条精确匹配语义。
