## Why

todo 池条目描述 `for x in *.log; do wc -l "$x"; done` 形态应走静默路径，并同步修正 BASH_GUARDRAILS 文案。

调查发现实现里**已有** for-loop 迭代集 glob 豁免（`isForLoopIterationGlobExempt`，src/lib/bash-extract.ts:451，测试 BMG88-96 覆盖）。实测验证（`extractBashTargets` 真跑）：

| 命令 | 当前判定 | 说明 |
|---|---|---|
| `for x in ./*.log; do wc -l "$x"; done` | reliable | 非空 prefix，已走静默 |
| `for x in src/*.ts; do cat "$x"; done` | reliable | 非空 prefix，已走静默 |
| `for x in *.log; do wc -l "$x"; done` | **glob_expansion** | 空 prefix，唯一缺口 |
| `for f in /etc/*.conf; do cat "$f"; done` | glob_expansion | 绝对路径，正确拒绝 |
| `for x in *.log; do rm "$x"; done` | glob_expansion | 写 body，正确拒绝 |
| `find . -name "*.ts"` | reliable | 已走静默，todo 提及但无需改 |

**真实 scope 比 todo 描述窄**：唯一缺口是空 prefix（`*.log`）—— `isBoundedPrefix("")` 返回 false（src/lib/bash-extract.ts:295 显式拒绝空 prefix："Empty prefix means the glob is at token start (e.g. `*` alone). We conservatively reject"）。`find . -name '*.ts'` 已静默，无需改。

## What Changes

- `src/lib/bash-extract.ts`：在 `isForLoopIterationGlobExempt` 内，当 for-loop 迭代集 glob 的 prefix 为空且迭代词是相对路径（不以 `/`、`~` 或 Windows 盘符开头）时，放宽 `isBoundedPrefix` 拒绝——空 prefix 的相对 glob 在 cwd 展开，cwd == projectRoot 假设下 bounded 于 projectRoot。
- `extensions/index.ts`：BASH_GUARDRAILS Layer 2 新增 `for x in *.log; do wc -l "$x"; done` 为静默示例；Layer 3 移除 `for x in *.log` 示例（或限定为"写 body 或非相对 prefix 的 for-loop 仍弹窗"）。
- `test/bash-extract.test.ts`：新增 BT-S21..BT-S23 覆盖空 prefix 豁免的接受/拒绝边界。

无 BREAKING 变更。无 schema 变更。无公共 API 签名变更。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bash-target-extraction`：bounded-glob 安全封套对 for-loop 迭代集内空 prefix 相对 glob 放宽（cwd-relative，bounded 于 projectRoot）。

## Impact

- `src/lib/bash-extract.ts`：`isForLoopIterationGlobExempt`（私有函数，仅放宽空 prefix 判定）；不涉及 `isBoundedGlobSafe` 或非 for-loop 路径。
- `extensions/index.ts`：BASH_GUARDRAILS 文案常量（Layer 2 / Layer 3）。
- `test/bash-extract.test.ts`：新增 3 个测试。
- 无公共 API 变更；无 schema 变更；无依赖变更。

## 系统工程影响评估

- **影响哪些分系统**：side-effects（bash-extract 分类逻辑）+ extension-orchestration（guardrails 文案）。跨 2 个分系统。
- **整体性能预期变化**：减少弹窗噪音——仅针对 for-loop 迭代集内的**空 prefix** 相对 glob + 只读 body（如 `for x in *.log; do wc -l "$x"; done`），从 tier=two 弹窗降为静默路径。非空 prefix 的 for-loop glob（`./*.log`、`src/*.ts`）已走静默；写 body（`rm`）与绝对路径 prefix（`/etc/*.conf`）仍判 unreliable；其他 construct（管道转发器、命令替换、shell forwarder、控制流、cd_chdir）行为不变。
- **这是局部优化还是全局协调**：局部优化——bounded-glob 安全封套的细化，在既有豁免框架内放宽一个明确窄场景。
- **局部优化对全局失调的风险**：低。放宽范围被三重约束框定：(1) 仅 for-loop 迭代集内（非 for-loop 路径不变）；(2) 仅空 prefix（非空 prefix 已走静默，无变化）；(3) 仅相对路径迭代词（绝对路径仍拒绝）。写 body 仍由 `isForBodyReadOnly` 拒绝。项目外 prefix 仍由现有逻辑拒绝。风险被既有测试 BMG88-96 + 新增 BT-S21..23 完整框定。
- **预期行为模型**：
  - 可测量：输入 `for x in *.log; do wc -l "$x"; done`（cwd-relative 空 prefix + 只读 body）→ 输出 `reliable: true`（走静默路径，不触发 tier=two 提示）。
  - 技术无关：用户在项目根下运行带空 prefix glob 的只读 for 循环时，不再被确认弹窗打断。
  - 用户视角：用户运行 `for x in *.log; do wc -l "$x"; done` 看到命令静默执行，无弹窗。
  - 可验证：跑 `npm test`，新增 BT-S21..BT-S23 测试断言上述输入输出；既有 BMG88-96 测试仍通过（回归不变）。
- **与既有架构/风格的遵循关系**：
  - 遵循既有分层：`src/lib/bash-extract.ts` 纯函数（无 UI/IO），`extensions/index.ts` 集成层（guardrails 文案）—— 不变。
  - 遵循既有架构风格：在 `isForLoopIterationGlobExempt` 内放宽空 prefix 判定，不引入新模块/新函数/新导出。
  - 遵循既有代码约定：TDD（先写测试再改实现），测试命名沿用 BT-S 系列。
  - **无偏离**。

## caller impact 分析

- **变更点清单**：
  - ①`extractBashTargets` 返回语义（具体输入从 `reliable: false, reason: "glob_expansion"` 变 `reliable: true`）—— ④类（返回值语义变更）。注：shape 不变（同一 discriminated union），仅 specific inputs 的 discriminant 值变化。
- **高危标记**：无 ①③ 类变更点。④类不属高危范围。
- **已知 caller**：
  - `extensions/index.ts`（消费 `extractBashTargets` 结果，already handles both branches：reliable=true 走 decision 层，reliable=false 走 prompt 层）—— **兼容，无需适配**。
- 完整 caller 清单由 `td-apply` 步骤 4 实测产出。

## 实际系统工程影响 vs 预期

- **实际影响分系统**：side-effects（bash-extract 分类逻辑）+ extension-orchestration（guardrails 文案）——与预期一致，跨 2 个分系统。
- **实际整体性能变化**：减少弹窗噪音——`for x in *.log; do wc -l "$x"; done`（空 prefix + 只读 body）从 tier=two 弹窗降为静默路径，与预期一致。非空 prefix、写 body、绝对路径、home 路径、Windows 盘符仍判 unreliable。全量 558 测试通过，零回归。
- **实际是局部优化还是全局协调**：局部优化——与预期一致。在既有豁免框架内放宽一个明确窄场景（空 prefix for-loop glob），不涉及架构变更。
- **局部优化的实际全局影响**：低——与预期一致。三重约束（for-loop 内、空 prefix、相对路径）未被突破。实测确认：非 for-loop 路径（`rm *.log`）、写 body（`for x in *.log; do rm "$x"; done`）、绝对路径（`/etc/*.conf`）、home 路径（`~/*.conf`）、Windows 盘符（`C:/*.conf`）仍正确拒绝。Code review 发现的 2 个安全问题均为 pre-existing（非本 change 引入），安全态势未恶化。
- **模型验证**：预期行为模型已验证——`for x in *.log; do wc -l "$x"; done` → `reliable: true`，0 targets → auto_allow（静默路径）。跨分系统边界验证确认 extractBashTargets → decision 层流转正确。
- **预期之外的副作用**：
  - 实施中发现 for-loop glob 豁免有两条独立路径（`isForLoopIterationGlobExempt` 和 `isGlobForLoopExempt`），必须同步放宽——design.md D1 已回写补充。
  - 实施中发现空 prefix 分支的三重防御性检查（`/`/`~`/`C:`）是死代码——tokenStart === globPos 时 cmd[tokenStart] 必然是 glob 元字符，绝对路径走非空 prefix 分支由 isBoundedPrefix 拒绝。已删除死代码，design.md D1/D2 已更新。
  - Code review 发现 2 个 pre-existing 安全盲区（多迭代词绕过、redirect 绕过），本 change 未扩大但也不修复。建议作为独立 change 处理。
