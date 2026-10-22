## 1. RED — 新增测试

- [x] 1.1 在 test/config.test.ts 新增 rules 配置解析与合并测试：
  - 含 rules 的配置正常解析（一条 allow 规则）
  - 无 pattern 的规则匹配所有调用
  - 缺失 rules 字段不报错
  - 非法 action 值被忽略并告警
  - 本地规则覆盖项目规则
  - 跨源 deny 优先于 allow
  - 无匹配规则返回 undefined
  - pattern 匹配语义（git * 匹配 git status、不匹配 rm -rf、空格规范化、文件工具路径匹配）
  - 验证：`npx vitest run test/config.test.ts -t "rules"` 显示新测试全部失败（RED 阶段预期）

- [x] 1.2 在 test/decision.test.ts 新增 rules 决策测试：
  - allow 规则跳过非敏感路径弹窗
  - allow 规则不绕过敏感路径（敏感硬底线）
  - deny 规则无条件拒绝
  - deny 优先于 allow（同 tool+pattern）
  - path 声明优先于 allow 规则
  - 验证：`npx vitest run test/decision.test.ts -t "rule"` 显示新测试全部失败（RED 阶段预期）

- [x] 1.3 跑既有测试确认当前全部通过（建立回归基线）：
  - `npx vitest run test/config.test.ts test/decision.test.ts test/sys-integration.test.ts`
  - 记录通过数

## 2. GREEN — 实现 rules 支持

- [x] 2.1 在 src/lib/config.ts 新增 RuleEntry 类型和 resolveRule 方法：
  - 新增 `RuleAction = "allow" | "deny"` 类型
  - 新增 `RuleEntry` 接口（tool, pattern?, action, source, raw, isGlob）
  - 新增 `RuleMatch` 接口（tool, pattern, action, source）
  - 加宽 `RawConfig` 类型（新增可选 `rules` 字段）
  - 加宽 `MergedPolicy` 接口（新增 `allRules` 字段和 `resolveRule()` 方法）
  - 扩展 `mergePolicies()` 函数处理 rules（加载、分类、排序、resolve）
  - 实现 pattern 匹配逻辑（`*` 匹配任意字符，空格规范化）
  - 实现 deny 优先于 allow 的合并逻辑
  - 验证：`npx vitest run test/config.test.ts -t "rules"` 全部通过

- [x] 2.2 在 src/lib/decision.ts 新增 rule 检查阶段：
  - `decide()` 函数签名新增可选参数 `toolName?: string` / `toolPattern?: string`
  - 在 path 解析之前检查 deny rules（返回 deny_hard）
  - 在 path 解析之后、默认兜底之前检查 allow rules
  - allow 规则命中时检查敏感路径硬底线（命中敏感仍弹 prompt）
  - 验证：`npx vitest run test/decision.test.ts -t "rule"` 全部通过

- [x] 2.3 在 extensions/index.ts 适配 rules：
  - `before_tool_call` 事件中提取 toolName 和 toolPattern 传入 `decide()`
  - bash 工具：toolName="bash"，toolPattern=rawCommand（空格规范化）
  - 文件工具：toolName=read/write/edit，toolPattern=absPath
  - 弹窗文案包含规则来源（当 rule 命中时标注"规则匹配"）
  - 验证：`npx vitest run test/sys-integration.test.ts` 全部通过

## 3. REFACTOR — 清理与回归

- [x] 3.1 跑全量测试套件确认无回归：
  - `npx vitest run`
  - 验证：退出码 0，全部测试通过（包括新增 rules 测试 + 既有所有测试）

- [x] 3.2 校验 openspec 变更集结构完整：
  - `npx openspec validate permission-config-rules-upgrade --strict`
  - 验证：退出码 0，输出无 ERROR

- [x] 3.3 更新 openspec/todo.md 的 b2 条目：
  - 在 b2 条目下追加 change 子项引用本 change 名 `permission-config-rules-upgrade`
  - 备注迁移策略（加宽兼容：paths + rules 并存）
  - 不勾选主条目（勾选是 td-archive 的职责）
  - 验证：`grep -n "permission-config-rules-upgrade" openspec/todo.md` 返回 1 行；`grep -n "\[x\].*升级 permission-config" openspec/todo.md` 返回 0 行

## 关键链（Critical Chain）

T1.1（RED config）→ T2.1（GREEN config）→ T2.2（GREEN decision）→ T2.3（GREEN extensions）→ T3.1（全量回归）。

关键链总估时：T1.1 (~20min) + T2.1 (~40min) + T2.2 (~30min) + T2.3 (~25min) + T3.1 (~10min) = **~125min**。

T1.2（RED decision）、T1.3（回归基线）、T3.2（validate）、T3.3（todo 回写）为非关键链任务，可并行或穿插执行。

## Project Buffer

按 tier-medium 比例（35%）计算：125min × 35% = **~44min**。Buffer 留在 T2.1 和 T2.2 上——rules 合并语义复杂（deny 优先、跨源优先级、pattern 匹配），决策引擎的 rule 检查阶段与敏感硬底线的交互需要精确框定，实际耗时可能超过预估。

## Task 主体约束（合规声明）

所有 8 个 task 的主体均为 agent 可编程性执行的动作（写代码 / 改配置 / 跑测试 / 跑 CLI / 改 todo.md）。**无**非编程性动作作为独立 task。验证字段均为可执行的 CLI 命令或可观察的文件状态（退出码、grep 命中），不依赖人工判断。

## 与 design.md 的一致性

- D1（rules 作为独立顶层字段）→ T2.1（config.ts 加宽 RawConfig）
- D2（resolveRule 在 MergedPolicy 内）→ T2.1（config.ts 新增 resolveRule）
- D3（decide 新增可选参数，rule 检查顺序）→ T2.2（decision.ts 新增 rule 检查阶段）
- D4（allow 不绕过敏感）→ T2.2（敏感硬底线检查）
- D5（bash pattern 匹配 rawCommand）→ T2.3（extensions 提取 toolPattern）
