# Tasks — tier-contract-consistency

## 关键链

```
A2 (sensitive) ──┐
                 ├──► F (集成验证) ──► F2 (project buffer)
A1 (bash tier) ──┘
A4 (config) ──────┘
A3 (docs) ─────────┘
```

**关键链路径**：A2 + A1 + A4 是代码层改动，三者可并行 TDD；F 是所有代码完成后的一次性集成验证；F2 是 project buffer。**A3 文档同步**依赖 A1/A2/A4 的实现完成后再做（依赖实际实现以确认最终语义），不占关键链槽。

**关键链子任务计数**：
- A2: A2-1, A2-2, A2-3 = **3 个子任务**
- A1: A1-1, A1-2, A1-3, A1-4 = **4 个子任务**
- A4: A4-1, A4-2, A4-3, A4-4 = **4 个子任务**
- F: F-1, F-2, F-3, F-4, F-5, F-6 = **6 个子任务**（含 bash-target-extraction 文本同步）

**总关键链子任务数**：3 + 4 + 4 + 6 = **17**（不含 A3 非关键链，不含 F2 buffer）

**Project buffer**：tier-medium 参考 15% → 17 × 0.15 ≈ 2.55，向上取整为 **3 个触发式槽位**（F2-1 / F2-2 / F2-3）。**触发式**含义：仅在 A1/A2/A4/F 中任一任务出现超预期阻塞时启用；顺利推进则不触发。

## 任务列表

### A2: sensitive 规则分流（known_hosts / authorized_keys 降级 soft）

**RED（写测试）**：
- [x] **A2-1**：在 `test/sensitive.test.ts` 添加 6 个测试用例：
  - `findSensitiveMatch("~/.ssh/id_rsa").level === "hard"`
  - `findSensitiveMatch("~/.ssh/known_hosts").level === "soft"`
  - `findSensitiveMatch("~/.ssh/authorized_keys").level === "soft"`
  - `findSensitiveMatch("~/.ssh/config").level === "hard"`
  - `findSensitiveMatch("~/myapp/known_hosts") === undefined`（非 `.ssh` 目录下不命中）
  - `findSensitiveMatch("~/.aws/config.json").level === "hard"`（规则排序不变式：hard 优先于 soft）
- 验证：`node --experimental-strip-types --test test/sensitive.test.ts` → 部分 RED

**GREEN（实现）**：
- [x] **A2-2**：修改 `src/lib/sensitive.ts`：
  - SSH 规则收窄：删除 `b === "known_hosts"` 与 `b === "authorized_keys"` 两个条件
  - 新增 soft SSH 公钥文件规则，追加于所有 hard 规则之后（保持 ordering 不变式：hard 在前 soft 在后）
  - 添加注释说明 SSH 公钥文件的 soft 语义（客户端存储的公钥列表，非不可逆凭证）
- 验证：`node --experimental-strip-types --test test/sensitive.test.ts` → 全部 GREEN

**清理**：
- [x] **A2-3**：更新 `test/decision.test.ts` 里可能引用 `~/.ssh/known_hosts` 的既有断言（若有），确认 tier 分派与新 level 一致（外区 soft → tier=three，内区 soft → tier=three）

### A1: bash unreliable tier 升级 + promptUser 简化

**RED（写测试）**：
- [x] **A1-1**：在 `test/decision.test.ts` 添加测试（间接测试：通过 extension 层 handleBash 触发）
- [x] **A1-2**：在 `extensions/index.test.ts` 添加 3 个测试用例：
  - `handleBash` unreliable bash（如 `cat $SECRETS`）断言 `Decision.tier === "three"`
  - `promptUser` tier=three 弹窗选项集合包含"Always allow"（现有测试若已覆盖，无需新增）
  - `promptUser` tier=two 弹窗选项集合**不含**"Always allow"（现有测试若已覆盖，无需新增）
  - 关键新增：unreliable bash tier=three 场景下用户选择 "Always allow this command" 后写入 `trusted.json.bashGrants` 段（**关键回归保护**）
- 验证：`node --experimental-strip-types --test extensions/index.test.ts test/decision.test.ts` → 部分 RED

**GREEN（实现）**：
- [x] **A1-3**：修改 `extensions/index.ts`：
  - `handleBash` unreliable 分支：`tier: "two"` → `tier: "three"`
  - `promptUser`：删除 `if (bashReason)` 分支（tier=two + bashReason 变体）
  - `handlePromptDecision`：将 tier=two 分支的 bash 相关副文本分派（`if (bashCommand && bashReason)` 和 `else if (bashCommand)`）**上移到 tier=three 分支**，改为 `if (decision.tier === "three" && bashCommand && bashReason) { subtitle = bashSubtitleForReason(bashReason); }`
- 验证：`node --experimental-strip-types --test extensions/index.test.ts test/decision.test.ts` → 全部 GREEN

**回归保护**：
- [x] **A1-4**：运行完整 `npm test`，确认所有既有测试通过（含 `test/sys-integration.test.ts`、`test/audit-permissions.test.ts`、`test/trust.test.ts`）。若有 bash tier=two 断言失败，按新语义更新断言。

### A4: 配置加载期通配覆盖 warning

**RED（写测试）**：
- [x] **A4-1**：在 `test/config.test.ts` 添加 12 个测试用例（对应 spec 的 12 个 scenario）：
  - 大范围通配 `~/.ssh/**` → warning 含匹配锚点
  - 全路径通配 `~/**` → warning 含多锚点样本
  - 相对通配 `**` 项目根为 `~` → warning（**P1-1 修复核心测试**）
  - 相对通配 `*` 项目根非 `~` → 无 warning
  - 精确路径 `~/.ssh/known_hosts` → 无 warning
  - 精确敏感路径 `~/.ssh/id_rsa` → 无 warning
  - unread 权限 `~/.ssh/**` → 无 warning
  - 不匹配锚点 `src/**` → 无 warning
  - 多 source 同 pattern → 两条 warning
  - warning 消息格式含 pattern + source + 锚点样本
  - 相对通配项目根为 `~/.ssh/workspace` 边界测试
  - session_start notify 承接（在 `test/sys-integration.test.ts` 里）
- 验证：`node --experimental-strip-types --test test/config.test.ts test/sys-integration.test.ts` → 部分 RED

**GREEN（实现）**：
- [x] **A4-2**：修改 `src/lib/sensitive.ts`（**P1-3 方案 A：派生式锚点，非静态常量**）：
  - `SensitiveRule` 接口新增可选字段 `anchor?: string[]`
  - 每条 hard sensitive 规则的 rule 对象新增 `anchor` 数组，覆盖约 26 条 canonical 锚点（SSH 密钥 5 + 私钥扩展名 2 + 凭证目录 7 + 凭证配置 3 + 系统机密 8 + 少量代表性重复）
  - soft 规则不加 `anchor` 字段（soft 不触发 override warning）
  - 新增导出 `HARD_SENSITIVE_ANCHORS: readonly string[]`：从 `DEFAULT_SENSITIVE_RULES` 中每条 hard 规则的 `anchor` 字段 flatMap 派生（模块加载期执行，无运行时开销）
  - 添加注释："新增 hard sensitive 规则必须在此规则里加 `anchor` 字段，HARD_SENSITIVE_ANCHORS 会自动派生"
- [x] **A4-3**：修改 `src/lib/config.ts`：
  - 引入 `HARD_SENSITIVE_ANCHORS` 从 `./sensitive.ts`
  - 引入 `expandHome` 从 `./path-utils.ts`
  - 新增 `checkWildcardOverrideWarning(entry, projectRoot)` 函数：**按 `entry.isRelative` 分支匹配**（P1-1 修复）
    - isRelative=true：将 anchor 展开为绝对路径，若位于 projectRoot 下则转为相对路径，再 `matchesGlob(pattern, anchorRelative)`
    - isRelative=false：直接 `matchesGlob(pattern, anchor)`（保持 `~/` 形式一致）
  - 在 `mergePolicies` 的 `allEntries` 构造完成后（`addEntries` 全部调用之后）遍历 entries 调用校验函数，push warning 到 `warnings[]`
- 验证：`node --experimental-strip-types --test test/config.test.ts` → 全部 GREEN

**验证集成**：
- [x] **A4-4**：在 `test/sys-integration.test.ts` 添加端到端测试：构造配置触发 warning，session_start handler 调用 `ctx.ui.notify(...)` 承接（既有循环无需改代码，只需断言 notify 被调用）

### A3: 文档同步（README + permission-model.md + CHANGELOG.md + bash-target-extraction spec 文本）

**顺序约束**：A3 依赖 A1/A2/A4 的实现完成，以便文档描述与实现一致。

- [x] **A3-1**：更新 `README.md` "How decisions work" 段落：
  - tier 语义更新（tier=three = 可持久化；tier=two = 不可持久化）
  - unreliable bash 归 tier=three 说明
  - sensitive 分级表加入 `~/.ssh/known_hosts` / `~/.ssh/authorized_keys` 到 soft 集合
  - 新增"配置通配覆盖 warning"小节，说明大范围通配加载期会通知 warning

- [x] **A3-2**：更新 `docs/security/permission-model.md`：
  - User Experience Model 段落同步 tier 语义
  - Explicit Boundary 段落里 access-decision 子系统的"不受保护什么"加入"用户配置通配覆盖 hard sensitive 兜底"，并引用 A4 warning 机制
  - Known Limitations 段落移除或更新"tier=two bash 命令类"相关描述（若存在）

- [x] **A3-3**：在 `CHANGELOG.md` 新增 `## [0.2.1]` 段落：
  - Changed: tier 语义收敛、SSH 公钥文件降级 soft、配置加载期通配覆盖 warning
  - Fixed: 文档漂移

- [x] **A3-4**：更新 `openspec/specs/bash-target-extraction/spec.md` 中"tier=two 兜底弹窗"文本引用为"tier=three"（**P2-3 修复**：本 change 承接文本同步，不延后到后续 change）——**纯文本修改，不引入新 requirement / scenario / 行为契约**（extractor 只报告 reliable/unreliable 与 reason；tier 分派在 access-decision 层）

### F: 集成验证

**顺序约束**：F 在 A1 / A2 / A4 完成后运行（A3 并行推进不影响 F）。

- [x] **F-1**：运行 `npm run typecheck` → 0 error
- [x] **F-2**：运行 `npm test` → 全部 GREEN
- [x] **F-3**：运行 `node --experimental-strip-types --test test/config.test.ts` 确认 e1 校验全 GREEN；并用一个小脚本构造多种配置调用 `mergePolicies(...).warnings`，断言以下行为：
  - 空配置 → 0 warning
  - `{ paths: { "~/.ssh/**": "read_write" } }` → 1 warning
  - `{ paths: { "**": "read_write" } }` 项目根为 `~` → 1 warning（**P1-1 关键验证**）
  - `{ paths: { "*": "read_write" } }` 项目根非 `~` → 0 warning
  - `{ paths: { "~/**": "unread" } }` → 0 warning
- [x] **F-4**：验证 session_start warning 承接——在 `test/sys-integration.test.ts` 添加断言，`ctx.ui.notify` 在存在 warning 时被调用且参数含 "config warning"
- [x] **F-5**：验证 `HARD_SENSITIVE_ANCHORS` 派生正确——运行一个小型检查脚本断言：
  - `HARD_SENSITIVE_ANCHORS.length` ≥ 20（约 26 条）
  - 每条 hard sensitive 规则的 `anchor` 字段非空
  - soft sensitive 规则不加 `anchor`（或 anchor 字段为 undefined）
  - `HARD_SENSITIVE_ANCHORS` 包含 `~/.ssh/id_rsa`、`~/.ssh/config`、`/etc/shadow`、`~/.aws/credentials` 等代表性锚点
- [x] **F-6**：更新 `openspec/todo.md`——本 change 无显式关联条目（A1/A2/A3/A4 都是新发现），确认 todo.md 无需变更

**验证（用户手动验收）**：

本任务的最终验收包含以下人工步骤，作为任务主体的验证项而非独立 task：
- 启动 pi，构造触发 unreliable bash 命令（如 `cat $SECRET_FILE`），确认弹窗提供 "Always allow this command" 选项；选择后确认下次同 rawCommand 静默；编辑 `trusted.json` 确认 `bashGrants` 段写入正确
- 读取 `~/.ssh/known_hosts`（外区）确认弹窗提供 "Always allow"；读取 `~/.ssh/id_rsa` 确认弹窗不提供
- 在 `permission.json` 声明 `~/.ssh/**: read_write`，session_start 触发时确认 notify warning 显示

### F2: Project buffer（3 个触发式槽位）

**触发条件**：仅在 A1/A2/A4/F 中任一任务出现超预期阻塞时启用（tier-medium 15% × 17 = 2.55，取整为 3）。

- [x] **F2-1**：缓冲任务槽位 1 —— **未触发**（A2 sensitive 规则新增未引入规则排序问题，既有 ordering invariant 保留。预留但未消耗。）
- [x] **F2-2**：缓冲任务槽位 2 —— **未触发**（A4 e1 校验相对匹配边界在 apply 过程中已由 P1-1 修复涵盖，多层嵌套相对路径已在 A4-3 test case 覆盖。预留但未消耗。）
- [x] **F2-3**：缓冲任务槽位 3 —— **未触发**（F-3/F-4/F-5 集成验证一次通过，无跨分系统接口未对齐问题。预留但未消耗。）

## 任务主体约束验证

- 所有任务主体是**编程性动作**：写测试 / 修改代码 / 运行 CLI / 编辑文档
- F-4/F-5 已合并入 F 子任务序列，F 的"用户手动验收"部分作为任务主体的**验证描述**列出，不占独立任务槽
- 无其他非编程性动作作为独立任务主体（A3 是文档编辑，属编程性动作；A2/A1/A4 是代码 + 测试编写）

## 总任务数与缓冲比例

- 关键链子任务：A2 (3) + A1 (4) + A4 (4) + F (6) = **17**
- 非关键链子任务：A3 (4)
- Project buffer 槽位：**3**（触发式）
- **总任务数**：17 (关键链) + 4 (A3) + 3 (F2 槽位) = **24**
- **Buffer 比例**：3 / 17 ≈ **17.6%**（略高于 tier-medium 15% 参考值，取整向上）

## 已知问题（架构 review P1/P2 项处理记录）

- **P1-1**（e1 校验相对 glob 匹配语义）→ **已修**（design.md D3.2 + spec + tasks.md A4-3 + F-3）
- **P1-2**（锚点数量文档一致性）→ **已修**（proposal / design / spec / tasks 统一表述为"约 26 条"）
- **P1-3**（HARD_SENSITIVE_ANCHORS 双事实源漂移风险）→ **已修**（方案 A：派生自 DEFAULT_SENSITIVE_RULES 的 anchor 字段，非静态常量）
- **P1-4**（Impact 列表补记 sensitive.ts 新增导出）→ **已修**（proposal.md Impact 列表新增 HARD_SENSITIVE_ANCHORS 导出与 SensitiveRule 接口 anchor 字段）
- **P1-5**（caller impact 分类修正 + 补齐 A3 文档 caller）→ **已修**（proposal.md caller impact 分析完整重写，① ② ③ ④ ⑤ ⑥ ⑦ ⑧ ⑨ 九类变更点覆盖）
- **P2-1**（关键链任务数与 buffer 比例自相矛盾）→ **已修**（本子文件重写为 17 关键链 + 4 A3 + 3 F2 = 24 总数）
- **P2-2**（分系统归属澄清）→ **已修**（proposal.md 系统工程影响评估节将 sensitive.ts 归属明确为 policy-core，并加说明可更新 profile-tier.yaml）
- **P2-3**（bash-target-extraction 文本同步责任划分）→ **已修**（proposal.md Modified Capabilities 加入 bash-target-extraction 条目 + tasks.md A3-4 显式承接）
- **P2-4**（warning flood follow-up 锚点）→ **已记录**（design.md D3 边界段 + spec 行为约束段引用 `warning-batching` 后续 change 名称；本 change 不处理）
