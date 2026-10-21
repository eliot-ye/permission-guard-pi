# Tasks

## 关键链与 project buffer

**关键链（Critical Chain）**：T1（替换 BASH_GUARDRAILS 数组）→ T2（同步 README Prompt guardrails 小节）→ T3（跑全量 `npm test` 回归）。

**次关键链**：T4（新增 Layer 1/2/3 关键词覆盖断言）与 T1 汇合到 T3。

**关键链理由**：T1 是本 change 唯一的代码层动作（字面量字符串替换），T2 是文档同步（不改运行时代码，但影响用户认知），T3 是全量回归。本 change 不涉及 `src/lib/*.ts` 与 spec delta，关键链极简。

**Project buffer**：tier-medium 下按 strength-matrix 表 1 取 35%。关键链总估时约 30 min（T1: 15 min、T2: 10 min、T3: 5 min），buffer 35% ≈ 10 min——留作 T5（缓冲收尾）承接意外（例如 README 引用格式漂移、关键词断言需要微调）。

**Feed buffer**：T4 汇入 T3，无独立 feed buffer（单条支流动作量小于 30 min）。

**主体合规**：所有 task 主体都是 agent 可执行的编程性动作（写文件 / 跑命令 / grep 断言 / 断言通过）。人工验证（如"用户手动观察 LLM 是否遵循"）本 change 不做——提示词是软引导，效果由用户在日常使用中观察，不纳入本 change 的验证清单。

---

## 1. 替换 BASH_GUARDRAILS 数组为三层结构（RED → GREEN 一体，因是纯字面量替换）

- [x] T1.1 用三层结构草稿替换 `extensions/index.ts:320-361` 的 `BASH_GUARDRAILS` 常量数组
  - 文件：`extensions/index.ts`
  - 风险：low（字面量字符串替换，不改变任何运行时代码路径；`installPromptGuardrails` 函数签名与实现保持不变）
  - 验证：
    1. `node -e "…"` 量测 `BASH_GUARDRAILS.length === 18`
    2. `BASH_GUARDRAILS.join('\n\n').length <= 2500`（草稿 2397 字符）
    3. token 估算 `Math.round(text.length / 4) <= 1000` 与 `Math.round(text.length / 3.5) <= 1000`
    4. 关键词覆盖：Layer 1 含 "Minimize prompts"；Layer 2 含 "Prefer dedicated tools" 与 "auto-allowed"；Layer 3 含 "Sensitive system paths" 与 "→" 符号；四条 PF1 正则 `/bash/` `/pipe/` `/glob/` `/grep|find/` 全部命中
    5. 命令示例：`node /tmp/verify_layer3.mjs` 或等价的一行 `node -e` 输出全部 PASS
  - 分系统影响：extension-orchestration（tier-small）——仅 `BASH_GUARDRAILS` 常量的字面量内容
  - 依赖：无

- [x] T1.2 跑 `npm test -- extensions/index.test.ts` 确认 PF1 测试全绿
  - 文件：无（跑测试）
  - 风险：low（预期全绿；若某条正则不匹配，按 T4 加断言前缀或补关键词）
  - 验证：`npm test -- extensions/index.test.ts 2>&1 | tail -5` 输出 `# pass N # fail 0`（N 应为既有数量，无新增失败）
  - 分系统影响：无（仅测试验证）
  - 依赖：T1.1

- [x] T1.3 跑 `npm test` 全量回归，确认 448+ pass / 0 fail
  - 文件：无（跑测试）
  - 风险：low（本 change 不涉及 `src/lib` 与 spec delta，理论上无回归面）
  - 验证：`npm test 2>&1 | tail -5` 输出 `# pass N # fail 0`（N ≥ 448，与前序 change 完成时的数字一致）
  - 分系统影响：无（仅测试验证）
  - 依赖：T1.2

## 2. 同步 README "Prompt guardrails" 小节

- [x] T2.1 更新 `README.md:233-271` 的 bullet 引用为新的三层结构，并在 "How it works" 节里补充 Layer 1/2/3 的组织意图说明
  - 文件：`README.md`
  - 风险：low（纯文档更新，不影响代码或测试）
  - 验证：
    1. `grep -c "Layer 1\|Layer 2\|Layer 3" README.md` 输出 ≥ 3（三层结构都有提及）
    2. `grep -c "Minimize prompts" README.md` 输出 ≥ 1（Layer 1 的核心信息点）
    3. `grep -c "Sensitive system paths" README.md` 输出 ≥ 1（Layer 3 新增条目）
    4. `grep -n "prompt guardrails\|Prompt guardrails" README.md` 定位到唯一小节
  - 分系统影响：无（仅文档）
  - 依赖：T1.1

## 3. 全量回归与可观测性核对

- [x] T3.1 跑 `npm test` 全量测试，确认无回归
  - 文件：无（跑测试）
  - 风险：low（预期全绿）
  - 验证：`npm test 2>&1 | tail -10` 输出 `# pass N # fail 0`（N ≥ 448）
  - 分系统影响：无（仅测试验证）
  - 依赖：T2.1

- [x] T3.2 跑 `node test/security-probe.mjs` 确认安全探针 35/35 通过（防御性验证，本 change 不涉及安全逻辑，但作为回归兜底）
  - 文件：无（跑测试）
  - 风险：low（预期全绿）
  - 验证：`node test/security-probe.mjs 2>&1 | tail -5` 输出 `35/35 passed` 或等价
  - 分系统影响：无（仅测试验证）
  - 依赖：T3.1

## 4. 新增 Layer 1/2/3 关键词覆盖断言（Feed 支线，与 T1 并行不阻塞关键链）

- [x] T4.1 在 `extensions/index.test.ts` 的 PF1 测试内追加三条断言，验证新稿的三层结构关键词覆盖
  - 文件：`extensions/index.test.ts`
  - 风险：low（追加断言，不改既有断言；若新稿文案微调，可能需要同步关键词）
  - 验证：
    1. Layer 1 关键词："Minimize prompts"（case-sensitive）
    2. Layer 2 关键词："Prefer dedicated tools"（case-sensitive）与 "auto-allowed"（case-sensitive）
    3. Layer 3 关键词："Sensitive system paths"（case-sensitive）与 `→` 符号（Unicode U+2192）
    4. 命令示例：`npm test -- extensions/index.test.ts 2>&1 | grep -E "PF1.*✓|PF1.*✗"` 输出 PF1 全绿
  - 分系统影响：无（仅测试追加）
  - 依赖：T1.1

## 5. 缓冲收尾（Project buffer 承接）

- [x] T5.1 若 T1.3 / T3.1 / T3.2 中任一回归失败，按失败点定位并修复；buffer 10 min 用于承接 README 引用漂移、关键词断言微调等意外
  - **未触发**：T1.3 / T3.1 / T3.2 均一次通过（520 pass / 0 fail；security-probe 35/35）。buffer 全额留作 change 级收尾的余量
  - 文件：视失败点而定
  - 风险：low（预期不触发；若触发则按失败点走 RED-GREEN-REFACTOR 补齐）
  - 验证：所有 test 命令最终输出 `# pass N # fail 0`
  - 分系统影响：视失败点而定
  - 依赖：T3.2
