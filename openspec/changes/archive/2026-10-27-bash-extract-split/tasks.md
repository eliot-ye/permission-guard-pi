# Tasks — bash-extract-split

## 关键链

```
D0 (前置事实) ──► D3 (td-reverse-spec) ──► D1 (代码拆分) ──► D4 (集成验证)
                                             └──► D2 (profile-tier.yaml) ──┘
```

**关键链路径**：D0 → D3 → D1 → D4。D2 与 D1 并行（D3 结果同时输入 D1 与 D2）。D4 在 D1 + D2 都完成后运行。

**关键链子任务计数**：
- D0: D0-1 = **1**
- D3: D3-1, D3-2, D3-3 = **3**
- D1: D1-1, D1-2, D1-3, D1-4, D1-5, D1-6 = **6**
- D2: D2-1 = **1**（与 D1 并行）
- D4: D4-1, D4-2, D4-3 = **3**

**总关键链子任务数**：1 + 3 + 6 + 1 + 3 = **14**（D2 与 D1 并行，都算关键链子任务）

**Project buffer**：tier-medium 参考 15% → 14 × 0.15 ≈ 2.1，向上取整为 **3 个触发式槽位**（F2-1 / F2-2 / F2-3）。触发式：仅在 D0/D3/D1/D2/D4 中任一任务出现超预期阻塞时启用；顺利推进则不触发。

## 任务列表

### D0: 拆分前置事实

**RED（写测试）**：不适用（D0 是分析前置，无测试）。

- [x] **D0-1**：确认拆分前置事实完整——`bash-extract.ts` 3421 行 / 29 requirement / 86 decl / 18 export；`extractBashTargets` 传递闭包 = 86 decl（强连通）；`decision.ts` + `extensions/index.ts` + `test/bash-extract.test.ts` 6 处 import 路径。记录到 design.md D0 节。
- 验证：`wc -l src/lib/bash-extract.ts`=3421 ✅；`grep -c "^export" src/lib/bash-extract.ts`=18 ✅；`grep -rn "from \".*bash-extract" src extensions test`=6 处 ✅。

### D3: `td-reverse-spec` 定向刷新

**位置**：apply 第一步（在拆代码前）。

- [x] **D3-1**：运行 `td-reverse-spec` 对 `bash-extract` 定向刷新，建立 29 requirement → 86 decl 的映射，识别内部层次（11 个语义层）。
- 验证：29 requirement → 8 文件映射已写入 design.md D1 最终文件列表表（无遗漏/无重复）✅；spec 与代码无漂移（`git diff openspec/specs/bash-target-extraction/spec.md` 空）✅。

- [x] **D3-2**：判定 `bash-extract` 独立子系统的 tier（预计 tier-medium）——写入 design.md D2 的 tier 判定。
- 验证：tier-medium 判定已写入 design.md D2（判据：29 req 对齐 policy-core + 3421 行 + 15+ archive change 独立演进 + 无 UI/IO + 未达 tier-large）✅。

- [x] **D3-3**：把拆分粒度最终判定写入 design.md D1 "最终文件列表"小节（可能维持 8 文件，也可能调整到 6–10 文件）。
- 验证：8 文件 + index.ts barrel 最终列表已写入 design.md D1（含 29 req → 8 文件映射表 + 依赖方向 DAG + 无循环验证）✅。

### D1: 代码拆分 + import 路径迁移

**RED（写测试）**：不适用（403 个既有测试作为回归网，拆分不改测试文本）。

- [x] **D1-1**：创建 `src/lib/bash-extract/` 目录。
- 验证：`mkdir -p src/lib/bash-extract` 成功，目录存在 ✅。

- [x] **D1-2**：按 D3 最终判定的文件列表，把 `bash-extract.ts` 内容拆分到子文件（默认 8 文件，按 D0 语义域划分）。
- 验证：90 decl 全分配（8 文件，无遗漏/无重复），`Total decls: 90 / 90` ✅。

- [x] **D1-3**：创建 `src/lib/bash-extract/index.ts` barrel——重导出 18 个对外符号（含 `SUBSTITUTION_READONLY_CMDS` 修正后）。
- 验证：index.ts 18 个 export 符号与拆分前 `bash-extract.ts` 完全一致（含 `SUBSTITUTION_READONLY_CMDS`）✅。

- [x] **D1-4**：`git rm src/lib/bash-extract.ts`（删除原文件）。
- 验证：`ls src/lib/bash-extract.ts` 不存在（`wc -l` 失败 = 已删）✅。

- [x] **D1-5**：迁移 6 处 import 路径——`extensions/index.ts:43`、`src/lib/decision.ts:19`、`test/bash-extract.test.ts:29,36,1046,1847`（共 4 处 test + 2 处生产）。
- 验证：`grep -rn "bash-extract.ts" src extensions test` 无残留（0 命中）✅；`grep -rn "bash-extract/index" src extensions test` 6 处命中 ✅。

- [x] **D1-6**：运行 `npm run typecheck` 确认 0 error（含循环依赖检测）+ `node --experimental-strip-types --test test/bash-extract.test.ts` 全部 GREEN（403 用例）。
- 验证：typecheck 0 error（排除 2 个已知 i18n 错误：extensions/index.test.ts:40 + test/approval-flow.test.ts:21，均与拆分无关）✅；bash-extract 测试 403 pass / 0 fail ✅。

### D2: `profile-tier.yaml` 子系统归属更新（与 D1 并行）

- [x] **D2-1**：更新 `openspec/.td-state/profile-tier.yaml` subsystems 列表——新增 `bash-extract` 独立 subsystem（tier-medium），`side-effects` judge_reason 更新为只保留 `audit.ts`。
- 验证：`grep -A2 "bash-extract" openspec/.td-state/profile-tier.yaml` 独立条目（tier-medium）✅；`grep -A2 "side-effects" ...` 只列 audit.ts ✅。

### D4: 集成验证

**顺序约束**：D4 在 D1 + D2 完成后运行。

- [x] **D4-1**：运行 `npm run typecheck` → 0 error（含循环依赖检测）。
- 验证：typecheck 0 error（排除 2 个已知 i18n 错误）✅。

- [x] **D4-2**：运行 `npm test` → 全部 GREEN（689 测试，含 403 bash-extract 回归网）。
- 验证：`npm test` 688 pass / 1 fail（AL7 已知并发审计 flake，`ENOTEMPTY` rmdir 清理时机，非本 change 引入；单跑 audit.test.ts 9/9 GREEN）✅。

- [x] **D4-3**：验证 spec 零变更 + profile-tier.yaml 正确——`git diff openspec/specs/bash-target-extraction/spec.md` 空 diff；`grep -A2 "bash-extract" openspec/.td-state/profile-tier.yaml` 独立 subsystem 条目。
- 验证：spec diff 空 ✅ + profile-tier.yaml bash-extract 独立条目（tier-medium）+ side-effects 只列 audit.ts ✅。

### F2: Project buffer（3 个触发式槽位）

**触发条件**：仅在 D0/D3/D1/D2/D4 中任一任务出现超预期阻塞时启用（tier-medium 15% × 14 = 2.1，取整为 3）。

- [x] **F2-1**：缓冲任务槽位 1 —— 未触发（D3 内部层次判读一次通过，无阻塞）。
- [x] **F2-2**：缓冲任务槽位 2 —— 未触发（D1 拆分 + import 迁移一次通过，无循环依赖）。
- [x] **F2-3**：缓冲任务槽位 3 —— 未触发（D4 集成验证一次通过，仅 AL7 已知 flake 未计）。

## 任务主体约束验证

- 所有任务主体是**编程性动作**：运行 CLI（D0-1, D3-1/2/3, D1-6, D4-1/2/3）、执行文件操作（D1-1/2/3/4/5）、编辑元数据（D2-1）
- D0/D3 是**分析前置**，非代码修改——但执行 `td-reverse-spec` CLI 与 `grep`/`wc` 是编程性动作
- 无其他非编程性动作作为独立任务主体

## 总任务数与缓冲比例

- 关键链子任务：D0 (1) + D3 (3) + D1 (6) + D2 (1) + D4 (3) = **14**
- 非关键链子任务：无
- Project buffer 槽位：**3**（触发式）
- **总任务数**：14 + 3 = **17**
- **Buffer 比例**：3 / 14 ≈ **21.4%**（略高于 tier-medium 15% 参考值，取整向上）

## 已知问题（架构 review P1/P2 项处理记录）

（D3 完成后由 `td-reverse-spec` 输出补充。占位。）
