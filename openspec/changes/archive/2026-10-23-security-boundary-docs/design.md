## Context

当前系统的安全边界语义分散在 6 份 spec 的散落脚注和实现代码中。`bash-target-extraction` spec 有"边界"提及但无统一 Non-Goals / Known Limitations / Explicit Boundary 声明。`BASH_GUARDRAILS` 是软 prompt guardrails（非硬约束），用户和 reviewer 无从区分"系统不会做什么"与"系统做不到什么"。

6 份 spec 的 Purpose 字段已明确各分系统的职责边界，但缺乏跨分系统的"元文档"层——即"系统作为一个整体，它的安全模型是什么、边界在哪里"。

参考：atomcode 的 `docs/security/permission-model.md`（384 行），三段式结构（Non-Goals / Known Limitations / Explicit Boundary），本系统的实现细节与 atomcode 不同但结构可复用。

## Goals / Non-Goals

**Goals:**
- 产出一篇独立安全文档 `docs/security/permission-model.md`，覆盖三段式结构
- 每条 Non-Goal / Known Limitation 可从源码或 spec 验证（不是主观声明）
- 文档术语与 spec 术语一致（如 `glob_expansion`、`reliable`、`read_only`、`prompt`）
- 为未来扩展（tool+pattern 规则、CredentialShell 层）提供"不改什么"的参照基线

**Non-Goals:**
- 不修改任何 spec 文件——本文档是 spec 的补充，不是替代
- 不修改任何代码
- 不引入新的安全机制或策略——仅文档化现有行为
- 不照搬 atomcode 文档内容——仅借鉴结构，内容为本系统实际行为

## Decisions

### D1: 文档放置位置 `docs/security/permission-model.md`

**理由**：与代码分层（`src/lib/` 纯函数、`extensions/` 集成层）正交——文档资产不参与运行时路径。`docs/` 目录当前不存在，本次创建。`security/` 子目录为未来可能的 `security/audit-guide.md` 等文档预留空间。

**替代方案**：放在 `openspec/` 下——但 `openspec/` 是契约层（spec + change），安全文档是面向用户/贡献者的参考层，不应混入契约层。

### D2: 三段式结构（Non-Goals / Known Limitations / Explicit Boundary）

**理由**：借鉴 atomcode `permission-model.md` 的结构——三段式清晰区分"系统不做什么"（Non-Goals）、"系统已知做不到什么"（Known Limitations）、"系统行为的边界在哪里"（Explicit Boundary）。这三段是安全模型的最小完备描述：缺 Non-Goals → 读者不知道系统的意图范围；缺 Known Limitations → 读者不知道系统的已知漏洞；缺 Explicit Boundary → 读者不知道系统行为的确定边界。

**替代方案**：平铺式（不分段）——但平铺式下"系统不做什么"和"系统做到什么"混在一起，读者需要自行区分，增加认知负担。

### D3: 内容来源从源码和 spec 提取，不主观编写

**理由**：安全文档的可信度依赖于"每条声明可验证"。每条 Non-Goal 通过 grep 源码确认无对应实现；每条 Known Limitation 通过反例命令确认实际行为；每条 Explicit Boundary 通过对照 spec 确认与契约一致。主观编写的文档容易与实现漂移。

**替代方案**：从实现者脑中"回忆"边界——容易遗漏已实现的行为或误记已变更的行为。

### D4: 显式标注"以源码为准"的降级策略

**理由**：文档一旦写就就可能与后续实现漂移。在文档开头显式声明"本文档以当前源码为准；若发现文档与实现不一致，以源码为准"——这是 brownfield 项目的必要降级策略，让文档成为"辅助理解"而非"权威来源"。

**替代方案**：声明文档为权威——但 brownfield 项目代码可能先改文档后改（或文档忘改），声明权威性反而增加风险。

## Risks / Trade-offs

- **文档与实现漂移** → 文档开头声明"以源码为准"的降级策略；文档中的每条声明标注来源（spec 引用或源码行号）以便后续验证。
- **过度文档化**（文档写了太多实现细节） → 文档聚焦"边界"而非"实现"——描述"什么受保护/什么不受保护"，不描述"如何保护/如何不保护"。实现细节属于 spec 和代码注释。
- **文档过长**（>350 行可能降低可读性） → 控制在 200-350 行；三段式结构天然控制篇幅——Non-Goals 通常 5-10 条，Known Limitations 通常 5-10 条，Explicit Boundary 按分系统分组。
