# Change: Bash grant keypoints (命令关键点授权)

## Metadata

- **Status**: proposal
- **Change Type**: behavior (boundary refinement)
- **Spec Driven**: yes
- **Source**: td-explore（2026-10-31），方向 A（token 级关键点）+ 窄边界 + 双轨不迁移 + 有限 flag 白名单，用户已拍板
- **Related Change**: `bash-grant-whitespace-normalize`（既有词法 whitespace 等价，本 change 在其上扩展）、`bash-symlink-grant-key-fix`

## Why

当前「允许本会话/总是允许」对 bash 命令都以**整条 `rawCommand` 的 sha256** 为 grant 键（`trust.ts` `bashKey`），任何字符变化都换 hash → 重新弹窗。以样本命令（cd 只读巡查链）为例：

```
cd /Users/eliot/my/permission-guard-pi && echo "===OPENSPEC===" && find openspec -type f | head -50 && ...
```

- `head -50` → `head -60`：换 hash，重弹（flag 值变了，但访问集不变）
- `-type f` → `-type d`：换 hash，重弹（纯读过滤，访问集不变）
- 增删 `2>/dev/null`：换 hash，重弹（fd 重定向，不改变安全性质）
- `find openspec` → `find src`：换 hash，重弹（**不同路径，本应重弹**——访问集变了）

「关键点」机制：grant 键从整条命令 hash 改为**命令关键点**（token 级派生）——只保留决定「访问哪个文件、什么动作」的 token，忽略安全无关 token。`head -50`↔`-60`、`-type f`↔`-type d`、增删 `2>/dev/null` 命中同一 grant（免弹）；`find src`↔`test`、`cd /a`↔`/b` 命中不同 grant（保守弹窗）。**免弹的是安全等价类，不误放行。**

## What (behavior change)

Bash grant 键派生从 `sha256(normalizeBashCommand(rawCommand))` 改为 `sha256(bashCommandKeypoints(rawCommand, projectRoot))`。关键点只忽略「确定不改变访问集与动作」的 token，保留所有「决定访问哪个文件、什么动作」的 token。

### 关键点规则（token 级，窄边界）

| token 类别 | 判据 | 处理 |
|---|---|---|
| `cd` 命令 | 片段首个是 `cd` | 记录 `cd:<绝对落点>`，更新追踪 cwd |
| 命令名 | 片段/管道 stage 首个非 flag token | 记录 `CMD:<basename>` |
| fd 重定向 | `2>&1` `N>&-` `2>/dev/null` `N>/dev` | **忽略**（不改变安全性质） |
| 写重定向 | `>` `>>` `2>>` `N>` | 记录 `WRITE:<绝对化目标>` |
| 纯读 flag | 有限白名单（find/head/tail/cat/wc/ls） | **名+值连跳**（访问集不变） |
| 写/不确定 flag | 不在白名单（`rm -rf`、`find -delete`、`sed -n`…） | 记录 `FLAG:<名>` + `FLAGVAL:<值>`（保守） |
| 文本参数 | 文本命令（echo/printf/true/false/pwd…） | **忽略** |
| shell glob 位置参数 | `cat src/*.ts`（非 find 匹配 flag） | 记录 `GLOB:<原始>`（决定访问集，保留） |
| 路径位置参数 | `looksLikePath` | 记录 `PATH:<绝对化>`（按追踪 cwd） |
| 其余裸词 | `openspec`（无扩展名目录） | 记录 `WORD:<原始>`（保守保留） |

**关键区分**：find 的匹配 flag 值（`-name '*.ts'`）是**内部匹配**（遍历根由路径参数决定）→ 连跳安全；`cat src/*.ts` 的 glob 是 **shell 展开**（决定访问集）→ 必须保留。

**cd 落点降级**：绝对路径 → 绝对化入键；仅 `$VAR`（未解析变量，无法静态确定值）→ 降级为 `cd-var:<原始>`，不更新追踪 cwd（保守，避免误放行）；`~`/相对路径由 `toAbsolutePath` 正常解析为 `cd:<绝对化>` 并更新追踪 cwd（均可静态解析，非降级）。

### 等价边界（实证验证）

- **免弹（安全等价，访问集+动作相同）**：`head -50`↔`-60`、`-type f`↔`-type d`、`-type f`↔`-name '*.ts'`、增删 `2>/dev/null`、`echo hello/world > 同文件`
- **保守弹窗（安全不等价）**：`find src`↔`test`、`cd /a`↔`/b`、`cat *.ts`↔`*.go`（shell glob）、写重定向有/无、`rm -rf`↔`rm -r`、`sed -n p`（不确定 flag）
- **语法级等价仍不做**：`bash -c "…"`、`cd && …` 语义漂移不判等价（与既有 Non-Goal 一致）

## What Changes

- `bash-extract/keypoints.ts` 新增 `bashCommandKeypoints(rawCommand, projectRoot)`（bash 命令分析子系统，复用 `splitCommands`/`splitPipelines`/`tokenize`/`looksLikePath`/`normalizeBashCommand`/`toAbsolutePath` 解析原语，不新增解析器）。
- `trust.ts` BashGrant 键派生换关键点：新增 `keypointsHash` 字段（双轨，旧 grant 不迁移）；`hasBashSessionGrant`/`hasBashPersistentGrant` 查询改「关键点命中 || 整条命中」。
- `extensions/index.ts` `handleBash` grant 查询端换新匹配。
- `grant-memory` spec 新增「Bash grant 关键点等价」requirement（放宽既有「词法 whitespace 等价」边界，**非覆盖**——关键点等价包含它）。

## Capabilities

### New Capabilities

无（不引入新能力路径，关键点是 grant-memory 既有能力的行为细化）。

### Modified Capabilities

- `grant-memory`: Bash grant 键从整条命令 hash 改为命令关键点（token 级），允许本会话/总是允许记录关键点而非整条命令；新增「Bash grant 关键点等价」requirement，覆盖既有「词法 whitespace 等价」边界并放宽到安全等价类。

## Impact

- **公共契约变更**：`trusted.json` 的 `bashGrants[].commandHash` 语义从「整条命令 hash」变为「关键点 hash」（新增 `keypointsHash` 字段双轨，旧 grant 保留 `commandHash` 精确匹配）。
- **分系统**：policy-core（`trust.ts` grant 键派生）+ bash-extract（`keypoints.ts` 新增派生函数，复用解析原语）+ side-effects（audit 一致性，`commandHash` 派生对齐）。
- **调用点**：`hasBashSessionGrant`/`hasBashPersistentGrant`/`addBashSessionGrant`/`addBashPersistentGrant`（`extensions/index.ts` `handleBash`）——API 形状不变，行为透明放宽到关键点等价类。
- **既有 trusted.json grant**：双轨不迁移——旧 grant 保持整条精确匹配（授权范围不自动扩大），用户需重授权才获得关键点免弹。**无数据破坏、无迁移。**

## Caller impact 分析

- **变更点清单**：
  1. `src/lib/bash-extract/keypoints.ts` 新增 `bashCommandKeypoints`（公共符号，新导出）——③ 类（装配点/新增公共 API），**低危**（纯新增，无既有 caller 破坏）。
  2. `src/lib/trust.ts` `createTrustStore` 签名变更（`trustedFilePath` → `(trustedFilePath, projectRoot)`）——③ 类（装配点，构造函数签名变更）——**非高危**（caller 极少：`extensions/index.ts:148` 传 `state.projectRoot`；测试 `withTmpStore`/`extensions/index.test.ts:1749` 传测试 projectRoot，均适配即可；`projectRoot` 仅用于关键点派生，不影响既有 path-grant 行为）。
  3. `src/lib/trust.ts` `bashKey`/`addBashSessionGrant`/`addBashPersistentGrant`/`hasBashSessionGrant`/`hasBashPersistentGrant`——② 类（内部行为变更，签名不变）——**非高危**（函数名/arity 不变，行为放宽是 intended）。
  4. `src/lib/trust.ts` `lookupBashGrantAuthor`——② 类（内部行为变更，签名不变）——**非高危**，但**保持整条 `commandHash` 匹配**（不随 keypoints 放宽；否则 `head -50` 的 grant 对 `head -60` 也会报 `by_person` author，公共行为未列明变宽）。
  5. `extensions/index.ts` `handleBash` grant 查询端——① 类（公共行为变更），**非高危**（查询放宽是 intended，`authorization` 派生语义不变）。
- **高危标记**：无①③类「公共符号/装配点」的高危变更点——`bashCommandKeypoints` 是纯新增导出，不破坏既有 caller；`createTrustStore` 签名变更 caller 极少且 `projectRoot` 仅用于关键点派生（不影响既有 path-grant 行为）；查询放宽限定在**安全等价类**（实证反例通过，等价类=同一访问集+同一动作），虽设计内 intended，高危论证附注：等价类可靠性依赖实证反例（`find -type f` vs `-type d` 的读集=目录遍历，非文件内容读）。
- **已知 caller**：`trust.ts` 内部（`bashKey`、`addBashPersistentGrant`、`lookupBashGrantAuthor`）+ `extensions/index.ts` `handleBash` 的 grant 查询 + `createTrustStore` 的 caller（`extensions/index.ts:148`、`test/trust.test.ts:withTmpStore`、`extensions/index.test.ts:1749`）——预判结论：兼容（`createTrustStore` 加参 caller 适配；`hasBash*`/`addBash*`/`lookupBashGrantAuthor` 签名不变；`lookupBashGrantAuthor` 保持整条匹配）。

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"——专家判断 + 数据 + 模型反复迭代上升到定量认识）

- **影响哪些分系统**：policy-core（`trust.ts` grant 键派生）+ bash-extract（`keypoints.ts` 新增派生函数，复用解析原语）+ side-effects（audit 一致性，`commandHash` 派生对齐）。不引入新分系统切分。
- **整体性能预期变化**：每次 bash 命令多一次 O(token) 关键点派生（毫秒级以下，无感）；弹窗率显著下降——`head -N`↔`-M`、`-type`↔`-name`、增删 `2>/dev/null`、纯读 flag 值变化不再重弹。**预期可测量**：样本命令类「只读巡查链 + 纯读 flag/重定向变化」的重弹频率从「每字符变一次」降到「每访问集变一次」。
- **这是局部优化还是全局协调**：局部优化（grant 键等价语义放宽到安全等价类），但全局协调——消除「整条 hash 过严」与「规则通道 whitespace 等价」的既有不一致，且**不违背** Non-Goal「不做语义漂移等价」（`bash -c`/`cd` 漂移仍不判等价）。
- **如果是局部优化，对全局失调的风险**：低——放宽限定在**可证明安全等价**的 token 子集（等价类=同一访问集+同一动作）；关键点不同必有一个安全维度不同，保守弹窗。误放行面增量为零（实证反例全部通过）。
- **预期行为模型**（可验证契约）：
  1. **免弹（安全等价命中）**：`head -50`↔`-60`、`-type f`↔`-type d`、`-type f`↔`-name '*.ts'`、增删 `2>/dev/null`、`echo hello/world > 同文件`——命中同一关键点 grant，GM 新测试断言
  2. **保守弹窗（安全不等价）**：`find src`↔`test`、`cd /a`↔`/b`、`cat *.ts`↔`*.go`、写重定向有/无、`rm -rf`↔`rm -r`——命中不同关键点 grant，GM 新测试断言
  3. **语法级语义漂移不判等价**：`bash -c "git status"`、`cd /tmp && git status` 不命中（MUST NOT 判等价）——GM 新测试断言
  4. **双轨兼容**：旧整条 `commandHash` grant 保持精确匹配（授权范围不自动扩大），新 `keypointsHash` grant 用关键点匹配——GM 新测试断言
  5. **audit/grant 键派生一致**：audit 截断记录的 `commandHash` 与 grant 侧派生用同一 `bashCommandHash`（B5 契约不破坏）——AL 既有断言不回归

- **与既有架构/风格的遵循关系**：全部遵循既有约定——`bash-extract/keypoints.ts` 归 bash 命令分析子系统（`bash-extract-split` 归档确立的分层），复用既有解析原语（`splitCommands`/`splitPipelines`/`tokenize`/`looksLikePath`/`toAbsolutePath`/`normalizeBashCommand`）**不新增解析器**，与 Non-Goal「不做完整 shell 解析」对齐；`trust.ts` 消费关键点（跨子系统边同方向已存在，`decision.ts` import `isDevSocketOrFd` 从 bash-extract）；audit 通道仍用 `bashCommandHash`（整条，不变），B5 契约不破坏（audit 的 `commandHash` 与 grant 侧 `commandHash` 一致）。**无偏离点**。

## 实际系统工程影响 vs 预期（archive 复盘）

（对照上节「系统工程影响评估」逐字段复盘，主基调第 3 条综合集成循环的闭合动作）

- **实际影响的分系统**：policy-core（`trust.ts` grant 键派生，含 `createTrustStore` 签名变更）+ bash-extract（`keypoints.ts` 新增派生函数）+ side-effects（audit 一致性，`commandHash` 派生对齐）。与预期一致，未引入新分系统切分。
- **实际整体性能变化**：每次 bash 命令多一次 O(token) 关键点派生（实测毫秒级以下，无感）；弹窗率显著下降——`head -N`↔`-M`、`-type`↔`-name`、增删 `2>/dev/null`、纯读 flag 值变化不再重弹（SYS-KP 端到端实测关键点变体 auto-allow）。与预期一致。
- **实际是局部优化还是全局协调**：局部优化（grant 键等价语义放宽到安全等价类），全局协调——消除「整条 hash 过严」与「规则通道 whitespace 等价」的既有不一致，不违背 Non-Goal「不做语义漂移等价」（`bash -c`/`cd` 漂移仍不判等价，K3/GM31 断言）。与预期一致。
- **局部优化的实际全局影响**：放宽限定在可证明安全等价 token 子集（等价类=同一访问集+同一动作）。6.3 收尾 review 实测发现 1 处误放行（相对 `cd` 落点按 `projectRoot` 而非追踪 cwd 解析，违反 design.md Decision 2 文字）——**已修复**（`keypoints.ts` 改 `toAbsolutePath(target, cwd)`）+ 补 K8 边界测试 + subagent 复验 APPROVED。修复后误放行面增量为零（全部实证反例通过）。
- **模型验证**：预期行为模型 5 条契约**全部验证通过**——
  1. 免弹（安全等价命中）：GM25/25b/K1-K1e 断言
  2. 保守弹窗（安全不等价）：GM27-30/33/34/K2-K2e 断言
  3. 语法级语义漂移不判等价：GM31/K3/K3b 断言
  4. 双轨兼容：GM23/24/24b 断言（旧整条精确匹配，授权范围不自动扩大）
  5. audit/grant 键派生一致：AL 既有断言不回归 + SYS-KP 持久化双轨字段断言
  **预期行为模型已验证**（无模型偏差需修正）。
- **预期之外的副作用**：1 项——实施中发现 design.md Decision 5 未写清查询端 projectRoot 来源（关键点派生需 projectRoot，但 `hasBash*` 签名不含）；用户拍板方案 A（`createTrustStore` 加 `projectRoot` 参数）后回写 design.md/proposal.md。非行为副作用，属设计文档补全。
- **scenario→test 覆盖账本状态**：全绿——13 个 Scenario 全映射（S9 由既有 GM21/22 覆盖，其余 12 由 GM23-GM35），无 `N/A` 条目。
- **baseline 对齐检查**：`openspec show --diff` 确认 delta 为新增 1 个 Requirement + 13 个 Scenario（grant-memory），全部新增、不触碰既有 grant-memory baseline 的契约/不变量行——无 drift。
