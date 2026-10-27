## Why

当前系统的安全边界语义分散在 6 份 spec 的散落脚注和实现代码中——`bash-target-extraction` spec 有"边界"提及但无统一 Non-Goals / Known Limitations / Explicit Boundary 声明；`BASH_GUARDRAILS` 是软 prompt guardrails（非硬约束），用户和 reviewer 无从区分"系统不会做什么"与"系统做不到什么"。缺乏一篇独立的安全文档导致：(1) 新贡献者无法快速理解系统的安全模型与已知盲区；(2) code review 时无法引用权威边界契约来裁决争议；(3) 未来的扩展（如 tool+pattern 规则升级、CredentialShell 层）缺乏"不改什么"的参照基线。

借鉴 atomcode 的 `docs/security/permission-model.md`（384 行）三段式结构（Non-Goals / Known Limitations / Explicit Boundary），为本系统写出边界契约。

## What Changes

- 新增 `docs/security/permission-model.md`——独立安全文档，三段式结构：
  - **Non-Goals**：系统明确不做的事（完整 shell 解析、解释器代码静态分析、运行时路径推断等）
  - **Known Limitations**：当前实现已知的安全盲区与 heuristics 边界（fail-open 未知命令、forwarder 非首阶段下游盲区、bash grant 扫裸路径 token 的局限性、软 prompt guardrails 非硬约束等）
  - **Explicit Boundary**：系统行为的显式边界契约（什么受保护、什么不受保护、边界在何处——含 bash target extraction 的解析边界、sensitive path 分类边界、approval tier 边界、grant memory 的会话/持久边界）
- 零代码改动，仅新增文档文件

## Capabilities

本 change 为纯文档变更，不触及 spec 层行为契约（已设 `skip_specs: true`）。

## Impact

- **新增文件**：`docs/security/permission-model.md`（预计 200-350 行）
- **代码改动**：无
- **spec 改动**：无
- **依赖改动**：无
- **测试改动**：无（文档文件不参与测试套件）

## 系统工程影响评估

- **影响哪些分系统**：无代码层影响——仅新增文档资产。文档内容覆盖全部分系统（access-decision / approval-flow / audit-log / bash-target-extraction / grant-memory / permission-config / extension-orchestration / side-effects），但属于跨分系统的"元文档"层面，不改变任何分系统的行为契约。
- **整体性能预期变化**：无行为变化，见 caller impact 分析节。
- **这是局部优化还是全局协调**：局部优化——在既有架构上新增一层文档资产，不改变分系统边界或行为契约。
- **局部优化对全局失调的风险**：低。纯新增文档，无删除/修改/重构。风险仅在于文档内容可能与实现漂移——通过从 6 份 spec 和源码提取事实来撰写，并在文档中显式标注"以源码为准"的降级策略来缓解。
- **预期行为模型**：
  - 可测量：新贡献者读完文档后能回答 3 个关键问题——"系统不做什么"（Non-Goals）、"系统已知做不到什么"（Known Limitations）、"系统行为的边界在哪里"（Explicit Boundary），且答案与实现一致。
  - 技术无关：用户视角——"我想理解这个权限扩展的安全模型，读完一篇文档就能知道什么受保护、什么不受保护、哪些情况会弹窗、哪些不会"。
  - 可验证：文档中每条 Non-Goal 和 Known Limitation 可通过以下方式验证——(1) grep 源码确认无对应实现；(2) 对照 spec 确认无对应 requirement；(3) 运行反例命令确认实际行为与文档描述一致。
  - 输入输出形态：输入=系统当前实现（6 份 spec + 源码），输出=一篇 200-350 行的安全文档，覆盖三段式结构。
- **与既有架构/风格的遵循关系**：
  - 遵循既有分层：文档放在 `docs/security/` 下，与 `src/lib/`（纯函数）和 `extensions/`（集成层）的代码分层正交——文档资产不参与运行时路径。
  - 遵循既有架构风格：文档结构借鉴 atomcode 的三段式（Non-Goals / Known Limitations / Explicit Boundary），与 atomcode 的 `permission-model.md` 对齐——但内容为本系统的实际行为，不照搬。
  - 遵循既有代码约定：文档中的术语与 spec 中的术语一致（如 `glob_expansion`、`reliable`、`read_only`、`prompt` 等），不另造同义词。
  - **无偏离**。

## caller impact 分析

- **变更点清单**：无四类变更点——本 change 不修改任何代码、不改变任何 API、不变更任何行为契约。新增的文档文件不参与运行时加载、不影响任何 caller。
- **高危标记**：无高危变更点。
- **已知 caller**：不适用——无代码变更，无 caller 受影响。

## 实际系统工程影响 vs 预期

- **实际影响分系统**：无代码层影响——仅新增文档资产 `docs/security/permission-model.md`（239 行）。文档内容覆盖全部分系统（bash-target-extraction / sensitive-path-classification / access-decision / approval-flow / grant-memory / permission-config），但属于跨分系统的"元文档"层面，不改变任何分系统的行为契约。与预期一致。
- **实际整体性能变化**：无行为变化。文档文件不参与运行时加载、不影响任何 caller。与预期一致。
- **实际是局部优化还是全局协调**：局部优化——在既有架构上新增一层文档资产，不改变分系统边界或行为契约。与预期一致。
- **局部优化的实际全局影响**：低。纯新增文档，无删除/修改/重构。文档内容从 6 份 spec 和源码提取事实，在文档开头显式标注"以源码为准"的降级策略，缓解文档与实现漂移风险。与预期一致。
- **模型验证**：预期行为模型已验证。文档三段式结构完整——Non-Goals（7 条，每条含验证命令）、Known Limitations（10 条，每条含反例命令或 grep 检查）、Explicit Boundary（6 个分系统，每个含"受保护/不受保护/边界在何处"）。术语与 spec 一致（`glob_expansion`、`reliable`、`read_only`、`prompt` 等），无同义词。行数 239 在 200-350 范围内。
- **预期之外的副作用**：无。
- **scenario→test 覆盖账本**：N/A——纯文档变更，不涉及 spec delta。
