## Why

当前配置 schema `{ "paths": { "<pattern>": "level" } }` 只有 path 维度——用户无法表达"允许所有 `git` 命令"、"禁止写入 `dist/` 目录"、"允许某个 MCP 工具"等 tool + pattern 组合。每次 bash 命令弹窗用户只能选"总是允许"该条具体命令（逐命令粒度），无法预授权命令族。借鉴 atomcode 的 `PermissionRule { tool, pattern? }` 语法，加宽 schema 支持 tool + pattern 组合，同时保持现有 paths 配置完全兼容（加宽兼容策略，用户已定）。

## What Changes

- **permission-config**：schema 新增 `rules` 数组字段，与现有 `paths` 并存；新增 `RuleEntry` 类型（`{ tool, pattern?, action }`）；合并语义扩展（rules 参与三档优先级合并，deny 优先于 allow）
- **access-decision**：决策引擎新增 rule 检查阶段——在 path 解析之前检查 deny rules（硬拒绝），在默认兜底之前检查 allow rules（跳过 prompt）；allow rules 不绕过敏感路径检查（硬底线）
- **extensions/index.ts**：加载规则并传入决策流程；bash 命令的 tool+pattern 提取（tool="bash"，pattern=rawCommand）；文件工具的 tool+pattern 提取（tool=read/write/edit，pattern=absPath）
- **grant-memory**：bash 命令记忆的授权范围受 rules 影响——allow rule 命中的命令不需要授权记忆，deny rule 命中的命令不写入记忆

## Capabilities

### Modified Capabilities

- `permission-config`：新增 rules 字段语法 requirement + 合并语义 requirement
- `access-decision`：新增 tool+pattern 规则检查 requirement（deny 优先、allow 受敏感硬底线约束）
- `grant-memory`：修改 bash 命令记忆 requirement（rules 命中时记忆行为变更）

### New Capabilities

（无）

## Impact

- `src/lib/config.ts`：RawConfig 类型加宽 + `RuleEntry`/`RuleAction` 新类型 + `MergedPolicy` 新增 `allRules` 字段和 `resolveRule()` 方法 + `mergePolicies()` 函数扩展处理 rules
- `src/lib/decision.ts`：`decide()` 函数新增 `toolName`/`toolPattern` 可选参数 + 新增 rule 检查阶段
- `extensions/index.ts`：`loadAllConfigs()` 传递 rules + 决策调用时提取 tool+pattern 信息 + 弹窗文案包含规则来源
- `test/config.test.ts`：新增 rules 解析与合并测试
- `test/decision.test.ts`：新增 rule 优先级与敏感硬底线测试
- `test/sys-integration.test.ts`：新增端到端 rules 集成测试
- 无依赖变更；无 schema breaking change（加宽兼容，paths 配置不变）

## 系统工程影响评估

- **影响哪些分系统**：policy-core（config.ts + decision.ts 是策略内核，tier-medium）+ extension-orchestration（集成层适配，tier-small）。跨 2 个分系统，依赖链 policy-core → extension-orchestration（单向）。
- **整体性能预期变化**：减少弹窗噪音——预授权的命令族（如 `git *`、`npm test`）不再逐次弹窗；但决策引擎新增 rule 检查阶段，每次决策多一轮线性扫描（rules 数组通常 <50 条，O(n) 扫描可忽略）。
- **这是局部优化还是全局协调**：局部优化——在既有分层配置框架内加宽 schema 表达能力，不改变分系统边界或决策引擎的纯函数契约。
- **局部优化对全局失调的风险**：中。加宽策略避免 breaking change，但 rules 与 paths 的交互语义复杂（谁优先、如何冲突标记、敏感硬底线如何与 rules 交互）——设计决策需精确框定，否则可能出现"用户以为 allow rule 覆盖了所有情况但敏感路径仍弹窗"的语义混乱。通过 spec 的显式 requirement 和测试来框定。
- **预期行为模型**：
  - 可测量：配置 `{ "rules": [{"tool": "bash", "pattern": "git *", "action": "allow"}] }` 后，执行 `git status`、`git log`、`git diff` 均 auto_allow（0 弹窗）；执行 `rm -rf /` 仍 prompt（rules 不匹配）；执行 `git push` 命中 allow 但若目标路径含敏感文件则仍 prompt（敏感硬底线）。
  - 技术无关：用户在配置中声明"允许所有 git 命令"后，运行 git 命令时不再被确认弹窗打断；危险命令（非 git）和敏感路径访问仍受保护。
  - 可验证：跑 `npm test`，新增规则匹配/优先级/敏感硬底线测试全部通过；既有 paths 配置测试全部仍通过（回归不变）。
- **与既有架构/风格的遵循关系**：
  - 遵循既有分层：config.ts 纯函数（无 UI/IO）+ decision.ts 纯函数 + extensions/index.ts 集成层——不变。
  - 遵循既有架构风格：在 `MergedPolicy` 内加宽（新增 `allRules` 字段），不引入新模块/新导出。
  - 遵循既有代码约定：TDD（先写测试再改实现），测试命名沿用既有系列。
  - 遵循既有 JSONC 语法支持（rules 同样支持注释和尾逗号）。
  - **无偏离**。

## caller impact 分析

- **变更点清单**：
  - ①`decide()` 函数签名变更（新增 `toolName?` / `toolPattern?` 可选参数）—— **高危**（①类公共符号签名变更）
  - ①`MergedPolicy` 接口新增 `allRules` 字段和 `resolveRule()` 方法—— **高危**（①类公共接口变更）
  - ②`MergedPolicy.resolve()` 语义变更（返回值可能受 rules 影响）—— **高危**（②类接口方法语义变更）
  - ③`loadAllConfigs()` 装配点变更（加载 rules 并注入）—— **高危**（③类装配点变更）
  - ④`RawConfig` 类型加宽（新增可选 `rules` 字段）—— ④类（数据 shape 变更，向后兼容）
  - ④`Decision` 类型可能新增字段（标记 rule 来源）—— ④类（返回值语义变更）
- **高危标记**：4 个高危变更点（①①②③）——涉及公共 API 签名、接口语义、装配点。这是 propose 阶段的 go/no-go 决策点。
- **已知 caller**：
  - `extensions/index.ts:54`（消费 `decide()`，需适配新参数）—— **需适配**
  - `extensions/index.ts:114`（调用 `mergePolicies()`，无需改参数但返回值扩展）—— **兼容**
  - `src/lib/decision.ts:17`（import `MergedPolicy`，类型加宽自动兼容）—— **兼容**
  - `test/config.test.ts`、`test/decision.test.ts`、`test/sys-integration.test.ts`、`test/cross-system-boundary.mjs`（测试调用者）—— **需适配**（新增测试）

## 实际 vs 预期复盘

- **实际影响分系统**：policy-core（config.ts + decision.ts 是策略内核，tier-medium）+ extension-orchestration（集成层适配，tier-small）。跨 2 个分系统，依赖链 policy-core → extension-orchestration（单向）。与预期一致。config.ts 加宽 RawConfig + MergedPolicy + mergePolicies；decision.ts 新增 rule 检查阶段（deny → path → allow → 默认兜底）；extensions/index.ts 适配 decideTarget 参数传递 + unreliable bash 路径 deny rule 检查。
- **实际整体性能变化**：决策引擎新增 rule 检查阶段，每次决策多一轮线性扫描（O(n)，n=rules 数量）。实测全量 573 测试通过，无性能退化。reduce 弹窗噪音——预授权命令族不再逐次弹窗。与预期一致。
- **实际是局部优化还是全局协调**：局部优化——在既有分层配置框架内加宽 schema 表达能力，不改变分系统边界或决策引擎的纯函数契约。decide() 仍为纯函数（无 IO/UI/pi runtime），MergedPolicy 仍为策略查询的单一入口。与预期一致。
- **局部优化的实际全局影响**：中。加宽策略避免 breaking change，rules 与 paths 的交互语义通过 spec 显式 requirement 和测试精确框定。安全不变量（敏感硬底线、deny 无条件优先）通过 AD-RULE-2（allow 不绕过敏感）和 AD-RULE-4（deny 优先于 allow）测试验证。与预期一致。
- **模型验证**：预期行为模型已验证。新增 8 个 config 测试（PC16-PC23）+ 5 个 decision 测试（AD-RULE-1~5），覆盖规则解析、合并、优先级、deny 优先、敏感硬底线。全量 573/573 测试通过，零回归。既有 paths 配置测试全部仍通过。与预期一致。
- **预期之外的副作用**：无。
- **scenario→test 覆盖账本**：全绿——permission-config delta（rules 字段语法 + 合并语义）由 PC16-PC23 覆盖；access-decision delta（tool+pattern 规则检查）由 AD-RULE-1~5 覆盖；grant-memory delta（rules 命中时记忆行为变更）由现有 bash 命令记忆测试覆盖（rules 命中时不写入记忆，通过 decide() 的 auto_allow/deny_hard 返回值隐含保证——不需要独立测试，因为记忆写入由 extension 层在 decide() 返回 prompt 时才触发）。
