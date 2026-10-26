## 关键链与缓冲

- **关键链（critical chain）**：1.1（sensitive RED）→ 1.2（decide RED）→ 2.1（sensitive GREEN）→ 2.2（decide GREEN）→ 3.1（集成测试）→ 4.1（系统级验证）。串行依赖：TDD 测试先于实现、sensitive 规则先于 decide 分派、单元先于集成。
- **关键链估时**：1.1 ≈ 15min、1.2 ≈ 10min、2.1 ≈ 15min、2.2 ≈ 5min、3.1 ≈ 20min、4.1 ≈ 10min，合计 ≈ 75min。
- **project buffer**：75min × 35%（tier-medium，strength-matrix 表 1）≈ 26min，留在 3.1 集成测试（soft 持久化 + hard 不回归的跨场景）与 4.1 全套回归上。
- **任务主体约束**：每条 task 主体均为编程性动作（写测试 / 改代码 / 跑 CLI），非编程性动作降级为该 task 的验证字段。

## caller impact 实测记录（td-apply 步骤 4）

触发条件命中（②类内部实现前向兼容扩展 + ①类决策引擎核心行为变更 + ③类 spec 公共契约变更），实测结论：

- **`findSensitiveMatch`**（`find_references` 实测 62 匹配 / 13 文件，其中 openspec 文档自引用 7 文件；**代码 caller** 生产 1 处 + 测试 3 文件）：
  - `extensions/index.ts:755`（decideTarget，生产）— **兼容**，透传 `sensitive` 对象给 `decide()`（`extensions/index.ts:807-816`），`SensitiveRule` 加 `level` 字段后自动携带，调用点无需改动（实测确认）。
  - `test/sensitive.test.ts`（37 处）、`test/decision.test.ts:70`、`test/cross-system-boundary.mjs:90` — 测试侧，既有断言仅 `assert.ok(m)` / `m?.reason`，不断言字段集合完整性；加 `level` 字段与追加第 6 条规则均不触发回归（全量测试 609/609 绿实证）。
- **`decide()`**（caller 1 处）：`extensions/index.ts:807`（decideTarget 内 `return decide({...})`）— **兼容**，`Decision` 类型不变，tier 值由 `decide()` 内部按 `sensitive.level` 计算。
- **`SensitiveRule` 类型构造点**：全仓实测唯一构造点为 `DEFAULT_SENSITIVE_RULES`（`src/lib/sensitive.ts:14`）；类型引用 2 处（`src/lib/decision.ts:18,92`，`import type` + `decide` 入参）均自动适配。无遗漏构造点。

## 1. 单元测试（RED）

- [x] 1.1 在 `test/sensitive.test.ts` 追加 soft 规则匹配用例：`findSensitiveMatch("~/.config/gh/config.yml")` 命中 soft（`level: "soft"`，reason 标 soft）；`auth.json`/`settings.toml`/`models.json` 同理命中 soft。`config.ts`/`auth.py`/`config`（无扩展名）**不**命中 soft。`~/.ssh/id_rsa`/`~/.ssh/config` 仍命中 hard（`level: "hard"`）。`~/.aws/config.json` 仍命中 hard（排序边界：hard 凭证目录规则按 dirname `.aws` 命中，先于 soft 凭证配置文件规则——设计不变式见 design.md Decision 3）。
  - **验证**：追加 5 个用例（soft 命中 / 代码扩展名不命中 / 无扩展名不命中 / ssh id_rsa+config 仍 hard / hard 排序边界）。实现前 `--test-name-pattern="SENS-SOFT"` 失败（`m?.level` 为 `undefined`，exit=1），2.1 后 5/5 PASS。
  - **实际追加**：除任务列出的 `~/.aws/config.json` 外，补了第二个排序边界 `config.pem`（hard 私钥扩展名规则 vs soft basename `config`），覆盖 design.md Decision 3 提及的两个重叠形态。

- [x] 1.2 在 `test/decision.test.ts` 追加 decide 分派用例：soft sensitive + 项目外读 → tier=three；soft sensitive + 项目外写 → tier=three（soft 放宽覆盖写，`decide()` step 2b 不分 action）；soft sensitive + 项目内读/写 → tier=three；hard sensitive + 项目外读 → tier=two（不变）；hard sensitive + 项目外写 → tier=two（不变）；hard sensitive + 项目内读/写 → tier=three（不变）。
  - **验证**：实现前 `--test-name-pattern="DEC-SOFT"` 5 用例中 fail=2（两个 soft 用例）、pass=3（三个 hard 用例，确认 hard 行为不变），exit=1；2.2 后 5/5 PASS。
  - **实际用例名**：`DEC-SOFT: soft outer read/write prompts tier three`、`soft inner read and write prompt tier three`、`hard outer read and write stay tier two`、`hard inner read and write stay tier three`。hard 内外读写与 inner config.json 共用「tier=three 不变」结论，未重复声明，故按读写维度各写一条用例覆盖两种分派。

## 2. 实现（GREEN）

- [x] 2.1 `src/lib/sensitive.ts`：`SensitiveRule` 接口加 `level: "hard" | "soft"` 字段；既有 5 条 `DEFAULT_SENSITIVE_RULES` 标 `level: "hard"`；新增第 6 条 soft 规则（test 匹配 `config`/`auth`/`settings`/`models` + `.json`/`.toml`/`.yml`/`.yaml` 的 basename，reason "Soft credential config file"，`level: "soft"`）。
  - **验证**：`node --experimental-strip-types --test test/sensitive.test.ts` 15/15 PASS（含 5 个 soft 用例 + 10 个既有 hard 用例不回归），exit=0。
  - **实际位置**：soft 规则追加在 `DEFAULT_SENSITIVE_RULES` 数组**末尾**（第 6 条），满足 design.md Decision 3 的 hard-before-soft 排序不变式；接口 `level` 字段带注释说明 hard/soft 语义差异与排序约束。

- [x] 2.2 `src/lib/decision.ts` `decide()` step 2b：`tier: isInside ? "three" : "two"` 改为 `tier: sensitive.level === "soft" ? "three" : isInside ? "three" : "two"`。
  - **验证**：`node --experimental-strip-types --test test/decision.test.ts` 48/48 PASS（含 5 个 DEC-SOFT + 43 个既有用例不回归），exit=0。
  - **实际写法**：`sensitive.level === "soft" ? "three" : isInside ? "three" : "two"`（`sensitive` 已在 `if (sensitive)` 块内，无需 `?.`）；step 2b 注释同步更新为 hard/soft 分级语义，并显式声明 action 不分派（外区写与读一并放宽）。

- [x] 2.3 `extensions/index.ts`：确认 `decideTarget`（L755 `findSensitiveMatch(absPath)`）已透传 `sensitive` 对象给 `decide()`（L807-816 `return decide({..., sensitive, ...})`）——`SensitiveRule` 加 `level` 字段后透传自动携带，无需改调用点。
  - **验证**：实测 `extensions/index.ts:807-816` 已透传，无代码改动；证据由 3.1 集成测试（真盘 + 真 trust store + 真 `registerPermissionGate` 管道）覆盖。

## 3. 集成测试

- [x] 3.1 在 `test/sys-integration.test.ts` 追加 SYS 场景：(a) 项目外 soft 配置文件首次读 → tier=three prompt（"总是允许"选项出现）→ 跨会话第二次读 auto_allow；(b) 项目外 `~/.ssh/id_rsa` 读仍 tier=two 不可持久化（"总是允许"选项不出现）+ 新会话重新弹（证明未持久化）；(c) `~/.ssh/config` 仍 hard（外区 tier=two，"总是允许"不出现）；(d) 项目外 soft 配置文件写 → tier=three（可"总是允许"持久化）；(e) 项目外 `~/.ssh/id_rsa` 写仍 tier=two 不可持久化。
  - **验证**：`--test-name-pattern="SYS-SOFT"` 3/3 PASS，exit=0。
  - **实际组织**：拆为 3 个测试函数——`SYS-SOFT: soft outer config.yml read prompts tier three and persists`（a，双 session 验证跨会话 auto_allow，第二个 session 的 uiChoice 抛错以防误弹）、`SYS-SOFT: soft outer config.yml write also prompts tier three`（d）、`SYS-SOFT-HARD: hard outer id_rsa and ssh config stay tier two, no persist`（b+c+e，通过 uiChoice 捕获 choices 断言"总是允许"不出现 + promptCount 断言新会话重新弹）。
  - **soft 测试路径选择**：`join(projectRoot, "..", "config.yml")`（sandbox 内但 project 外的 `config.yml`，无 `.ssh`/`.aws` 重叠，soft 规则干净命中），非任务原文的 `~/.config/app/config.yml`——后者在 sandbox 外会碰到真实用户环境。

## 4. 系统级验证

- [x] 4.1 typecheck + 全套测试。
  - **验证**：`npm run typecheck` 0 error；`npm test` 609 tests / 609 pass / 0 fail（含 sensitive 15 / decision 48 / sys-integration / trust / grant-memory 跨分系统回归），exit=0。

- [x] 4.2 系统级验证（td-apply 步骤 6.2）：跨分系统边界 sensitive-path-classification × access-decision × grant-memory × audit-log。
  - **验证**：一次性边界脚本（`.openclaw/tmp/4.2-boundary-check.ts`，跑完删除）覆盖三条边界并全绿：
    - **边界 1+2（sensitive-path-classification × access-decision）**：soft 内外 × 读写 4 例均 tier=three + `declaration: "sensitive_default"`；hard 外区读写 tier=two、hard 内区读写 tier=three；排序边界 3 例（`~/.aws/config.json`、`config.pem`、`~/.ssh/config`）均 `level: "hard"`。
    - **边界 3（audit-log，proposal 列为间接影响）**：soft 外区 persist 路径的 audit 记录完整落盘（`event: "allow_persistent"`、`region: "project_outer"`、`declaration: "sensitive_default"`、`authorization: "by_person"`、`grant_source` 存在、`permission: "read_write"`）——本 change 未破坏 audit 契约。
  - **未扩 scope 说明**：`AuditRecord` 无 `tier`/`level` 字段，`declaration: "sensitive_default"` 为 hard/soft 共享声明。proposal 对 audit-log 的表述为间接影响（"soft 命中 audit 记录可标 level"），属可选标注而非硬要求，未纳入本 change。

- [x] 4.3 change 级收尾 code review（td-apply 步骤 6.3）。
  - **验证**：`code_review` 工具（`deep` 深度，review 对象为本 change 全部代码改动）在后台启动后未返回结果，按 `requesting-code-review` 的降级路径走 LLM 自审，`reviewed-by: unisolated-self`。
  - **自审结论**：`APPROVED_WITH_CHANGES`——无 critical。已实证的 3 个关键点：
    - `hasPersistentGrant` 匹配键为 `grantKey(projectHash, action, path)`（`src/lib/trust.ts:218-221`），`permission` 字段不参与判定 → soft 外区 read 的持久化 grant 不会反向放行 write（action 在键内隔离）。
    - `sensitive` 在 `extensions/index.ts` 仅 2 处引用（`:755` 构造、`:813` 透传 `decide()`），无其他决策消费点 → design.md warning-1 声明的「tier 是"总是允许"唯一门控」不变式项目级成立。
    - `GrantAuthor = "by_person" | "presumed" | "migration"`（`src/lib/trust.ts:66`），grant-memory baseline spec L249/255/261 明确要求 `author: "by_person"` → 无枚举不一致。
  - **自审发现并已修的 1 处缺口**：`decide()` 的 `Action` 类型为 `"read" | "write" | "delete"`，而 DEC-SOFT 的 hard 循环只跑了 read/write——`delete` 未覆盖，grant-memory spec 却明确写了「action 不限（读/写/delete 均可持久化）」。已把两个 hard 循环扩为 `["read", "write", "delete"]`（DEC-SOFT 6/6 pass）。
  - **自审记 2 条 warning（不阻塞，可延后）**：
    - soft 规则在依赖树（node_modules）中的命中规模未跨项目验证。当前项目 node_modules 实测 0 命中 soft basename，风险当前不成立；但依赖树内容因项目而异，若某项目依赖树大量含 `config.json` 会产生较多首弹（首弹后可"总是允许"消除，且 hard 排序不变式仍保证 `.ssh`/`.aws` 目录走 hard）。
    - soft 外区 read 持久化时，`extensions/index.ts:968` 的 `permission` fallback（`declaration === "sensitive_default"` 非 read_write/read_only → 落 `read_write`）被更多触发。该 `permission` 字段当前不参与 grant 命中判定，故无实际影响；但属既有行为被本 change 扩大覆盖面，未来若加按 `permission` gate 的严格层需注意。

## change 级收尾 review 的 findings 处置

`code_review` 后台结果最终返回（`APPROVED_WITH_CHANGES`，无 critical，10 条 finding）。与 4.3 自审结论一致，但其中 2 条经核实为误判，逐条处置如下：

| # | finding | 核实结论 | 处置 |
|---|---|---|---|
| 1 | DEC-SOFT 缺排序边界的**决策级**断言 | 成立。SENS-SOFT 只在分类层断言 `level === "hard"`，`decide()` 层的 tier 产出未断言——分类对但决策错时测不到 | **已修**：新增 `DEC-SOFT: ordering boundary keeps hard tier two at decision level`，断言 `/Users/x/.aws/config.json` 外区读出 `tier: "two"`、`/proj/config.pem` 内区出 `tier: "three"` |
| 2 | grant-memory spec 新增 scenario 未映射账本 | **误判**。实测 `grep -c "^#### Scenario:"` 得 spec 6 个 ↔ 账本 `可赦免敏感路径外区持久化授权` 6 行，逐字一一对应 | 无需动作 |
| 3 | SENS-SOFT 缺 reason negative-control | 成立。positive 只断 `level`，`reason` 未断；若软规则被错配到别的规则名，`level` 仍可能为 soft | **已修**：soft positive 用例补 `assert.equal(m?.reason, "Soft credential config file")` |
| 4 | tier=two 时 sensitive_default 与 unconfigured 不可区分 | 部分成立但**非本 change 范围**。审计侧确实无 `tier` 字段；但 tier=two 的唯一来源本就是 sensitive（`decision.ts:253`），且本 change 不改 unconfigured 的 tier 语义。属 audit-log 既有设计边界 | 记录为已知边界，不扩 scope |
| 5 | 无 soft sensitive 走完整管道的集成路径 | **误判**。SYS-SOFT 三个用例就是完整管道（真实 config 文件 + 真 trust store + 真 audit log，仅 mock `ExtensionAPI`），与 SYS1/SYS2 同骨架 | 无需动作 |
| 6 | 排序边界缺 DEC 层覆盖 | 同 #1，**已修** | 同 #1 |
| 7 | DEC-SOFT 未覆盖 delete | 成立（4.3 自审已独立发现） | **已修**：两个 hard 循环扩为 `["read","write","delete"]`；第二轮 review 进一步指出 soft 侧同样不对称，已一并对齐（见 P3-5） |
| 8 | 账本测试文件列与路径订正说明不一致 | 成立（4.3 自审已记录） | **已修**：2 行账本列订正为 `test/sys-integration.test.ts`，并在账本下新增「路径订正」说明 |
| 9 | 排序不变式仅靠代码顺序维护，无机械防护 | 成立但**非本 change 范围**。已有 4.2 边界脚本 + DEC-SOFT 决策级断言双重守护；规则表结构上无法声明顺序约束 | 记录，未来若规则表扩为可配置项再考虑 |
| 10 | DEC-SOFT 用例改名后与账本测试名不一致 | 成立（补测试后遗留） | **已修**：账本 18 行测试名列与 `grep '^test("'` 实测输出逐字对齐 |

### P2 级（3 条，来自第二轮 review，均 P2）

| # | finding | 核实结论 | 处置 |
|---|---|---|---|
| P2-1 | `test/sys-integration.test.ts:709-744` SYS-SOFT 外区 write 用例只断言 tier=three 提供了"总是允许"选项，未验证 grant 真落盘——extension 层若对 write 路径漏调 `addPersistentGrant` 会被静默放过 | 成立。read 侧姊妹用例（`:652`）有第二段会话，write 侧缺 | **已修**：用例改名 `SYS-SOFT: soft outer config.yml write also persists across sessions`，补 s2 会话断言 `prompted === false` |
| P2-2 | `test/sensitive.test.ts:159-170` 排序不变式只覆盖 rule 1（SSH）与 rule 3 的 `~/.aws/config.json`，未覆盖 rule 3 dirname 后缀 × soft basename 的另一典型重叠 `~/.docker/config.json`（Docker Hub / 私有 registry token） | 成立。若未来把 soft 上移到 rule 3 之前，`.docker` 会从不可持久化降级为可持久化，现有测试无感 | **已修**：排序边界用例补 `~/.docker/config.json` 断言；另新增结构性断言 `SENS-SOFT: soft is the LAST rule, so hard always wins on overlap`（`DEFAULT_SENSITIVE_RULES` 末条必为 soft，soft 之后不得有 hard） |
| P2-3 | `src/lib/decision.ts:253` 语义歧义：soft 分支 action-agnostic，`delete` 也被静默放宽到 tier=three 可持久化——超出"可撤销凭证"论证范围 | 成立。且 blast radius 经实测为**路径粒度**（`extensions/index.ts:966-975` 走 `addPersistentGrant({action, path})`，非命令 hash 粒度）：一次批准后续同路径任意 `rm <该路径>` 形态全部静默；而删除后的文件无法通过吊销 token 恢复 | **用户 2026-10-26 拍板：接受现状（delete 一并放宽）+ 文档化**，不改实现。已落 4 处：`decision.ts` step 2b 注释标注已知边界、proposal 新增「已知边界」节、`access-decision` spec requirement 新增「delete 边界」段、`grant-memory` spec 新增 `soft sensitive 外区 delete 持久化授权` scenario + `KNOWN BOUNDARY` 行 |

### P3 级（7 条，来自第二轮 review，不阻塞）

| # | finding | 核实结论 | 处置 |
|---|---|---|---|
| P3-4 | `src/lib/sensitive.ts:159-164` soft 的 `names`/`exts` 数组在 `test` 闭包内每次调用重新分配（热路径，bash 提取的每个 target 都过一遍） | 成立 | **已修**：提到模块级 `SOFT_CONFIG_NAMES` / `SOFT_CONFIG_EXTS`，每次调用零分配 |
| P3-5 | `test/decision.test.ts` soft 侧 tier 测试只跑 read/write，而 hard 侧循环 `["read","write","delete"]`——覆盖率不对称，未来 step 2b 加 `action === "delete"` 分支时 soft 侧无兜底 | 成立 | **已修**：soft 侧改为 full-action 循环（`DEC-SOFT: soft outer write and delete prompt tier three`、`DEC-SOFT: soft inner read, write and delete prompt tier three`），与 hard 侧对称 |
| P3-6 | `src/lib/decision.ts:253` 嵌套三元 `soft ? A : isInside ? B : C` 违反本 batch 的 no-nested-ternary 风格规则，且形态误导（soft 恒 three，只有 hard 才看 isInside） | 成立 | **已修**：抽为具名 `const tier: PromptTier` + 说明性注释 |
| P3-7 | `test/sys-integration.test.ts:925` `configPaths.local` 用字符串拼接 `".pi/local/permission.json"` 而非逐段 `join`，与本文件其它 5+ 处风格不一致 | 成立 | **已修**：改 `join(projectRoot, ".pi", "local", "permission.json")` |
| P3-8 | `test/sys-integration.test.ts:747-845` SYS-SOFT-HARD 集成测试 hard 侧只跑 read/write，未跑 delete（DEC 层已覆盖，仅集成层缺口） | 成立 | **已修**：补 (f) hard outer delete 段（bash `rm -f /Users/x/.ssh/id_rsa` → 无"总是允许"），并补 (g) soft outer delete 段（bash `rm -f <soft>` → tier=three 且 grant 落盘）——同一 rm 形态、相反 tier，形成端到端对照 |
| P3-9 | `test/sensitive.test.ts:159-170` 排序不变式只以具体路径"举例"验证，没有对数组结构断言"最后一个规则必为 soft / 无 hard 排在 soft 之后" | 成立 | **已修**：新增结构性断言 `SENS-SOFT: soft is the LAST rule, so hard always wins on overlap`——`DEFAULT_SENSITIVE_RULES.at(-1).level === "soft"`，且 soft 之后不得有 hard。行为用例证明"某些路径"，结构断言证明"整张表" |
| P3-10 | `test/decision.test.ts:755-797` 与 P3-5 同一条（soft/hard action 覆盖率不对称），review 从 soft 用例与 hard 用例两个入口各报一次 | 同 P3-5 | **已修**：同 P3-5，账本记一次避免重复 |

## 实施记录

- **最终验证（收尾时点）**：`npm run typecheck` 0 error；`npm test` **615 tests / 615 pass / 0 fail**；4 个裸探针（`cross-system-boundary.mjs`、`probe-v1-symlink-sensitive.mjs`、`probe-v3-bash-symlink-grant.mjs`、`security-probe.mjs`）全 exit=0；`openspec validate` valid=true / issues=[]；账本 21 行 ↔ spec 21 scenario 严格一致、测试名 0 断链。各 task 验证字段中的计数（609/609、48/48、15/15 等）为该 task 完成时的快照，非最终态。
- TDD 循环全程 RED → GREEN：1.1/1.2 先写失败测试（exit=1 实测）→ 2.1/2.2 实现 → 3.1 集成 → 4.1/4.2 系统级。
- 未发现 proposal / design / spec 与代码现实冲突，无需设计回写（步骤 5 未触发）。
- 架构 review 复核（td-apply 步骤 4）：apply 前 proposal / design / spec 在 propose 阶段 review 之后有改动（补强不变式 + 外区写 scope 澄清），已重跑复核，Verdict `APPROVED`（无新增 issue），reviewed-by: subagent。

## 6.4 current-change audit

「实际系统工程影响 vs 预期」复盘节已落在 `proposal.md` 的「实际系统工程影响 vs 预期（archive 复盘）」节（td-archive 步骤 3 硬门禁，复盘单一落点）。本节仅保留实施记录性质的 findings 处置与收尾补记，不承载复盘内容。

**收尾 review 两轮补记（6.3 之后）**：第一轮 review 10 条 finding（3 条误判：#2 grant-memory 未映射、#5 无 soft 集成路径；其余 5 条已修 + 2 条记录为已知边界）；第二轮 review 3 条 P2（全修 + P2-3 走产品决策）+ 7 条 P3（全修）。逐条核实结论与处置见上方「change 级收尾 review 的 findings 处置」两表。
