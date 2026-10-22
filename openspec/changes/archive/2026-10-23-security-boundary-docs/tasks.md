## 1. 文档骨架与 Non-Goals 段

- [x] 1.1 创建 `docs/security/permission-model.md` 骨架：标题 + 开头声明（"以源码为准"降级策略）+ Overview 段（1-2 段概括系统安全模型）+ Design Goals 段（5-7 条设计目标，从 spec Purpose 提取）+ 三段式章节头（Non-Goals / Known Limitations / Explicit Boundary）
- [x] 1.2 撰写 Non-Goals 段：从 6 份 spec 和源码提取系统明确不做的事（5-8 条），每条标注来源（spec 引用或源码行号）
  - 验证：grep 源码确认无对应实现；对照 spec 确认无对应 requirement

## 2. Known Limitations 段

- [x] 2.1 撰写 Known Limitations 段：从源码和测试提取系统已知的安全盲区（5-10 条），每条含"是什么"（一句话）+ "为什么存在"（设计权衡）+ "如何验证"（反例命令或 grep 检查）
  - 验证：每条限制运行反例命令确认实际行为与文档描述一致

## 3. Explicit Boundary 段

- [x] 3.1 撰写 Explicit Boundary 段：按分系统分组描述边界契约，每个分系统含"受保护什么"（bullet list）+ "不受保护什么"（bullet list）+ "边界在何处"（一句话）
  - 分组：bash-target-extraction / sensitive-path-classification / access-decision / approval-flow / grant-memory / permission-config
  - 验证：每个分系统的"受保护"和"不受保护"对照对应 spec 的 requirement 确认一致

## 4. 用户视角与总结

- [x] 4.1 撰写 User Experience Model 段：从用户视角描述安全模型（5-8 条 bullet），不含技术细节
- [x] 4.2 撰写 Summary 段：1 段总结系统保护什么、不保护什么、为什么这样设计
- [x] 4.3 校验文档结构完整性：标题层级、术语一致性（与 spec 术语对齐）、行数控制（200-350 行）
  - 验证：`wc -l docs/security/permission-model.md` 在 200-350 范围内；grep 术语列表确认无同义词

## 关键链（Critical Chain）

T1.1（骨架）→ T1.2（Non-Goals）→ T2.1（Known Limitations）→ T3.1（Explicit Boundary）→ T4.3（校验）。

关键链总估时：T1.1 (~15min) + T1.2 (~20min) + T2.1 (~25min) + T3.1 (~25min) + T4.3 (~10min) = **~95min**。

T3.1 的验证子步和 T4.1/T4.2 为非关键链任务，可穿插执行。

## Project Buffer

按 tier-medium 比例（35%）计算：95min × 35% = **~33min**。Buffer 留在 T2.1 和 T3.1 上——Known Limitations 和 Explicit Boundary 需要从源码和 spec 提取事实，可能需要反复 grep 和运行反例验证，实际耗时可能超过预估。

## Task 主体约束（合规声明）

所有 7 个 task 的主体均为 agent 可编程性执行的动作（创建文件 / 撰写文档 / grep 验证 / wc 检查）。**无**非编程性动作作为独立 task。验证字段均为可执行的 CLI 命令或可观察的文件状态（行数、术语匹配），不依赖人工判断。

## 与 design.md 的一致性

- D1（文档位置 `docs/security/permission-model.md`）→ T1.1
- D2（三段式结构）→ T1.2 + T2.1 + T3.1
- D3（内容来源从源码和 spec 提取）→ T1.2 验证 + T2.1 验证 + T3.1 验证
- D4（显式标注"以源码为准"降级策略）→ T1.1 开头声明
