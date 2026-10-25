## 关键链与缓冲

- **关键链（critical chain）**：1.1（sensitive RED）→ 1.2（decide RED）→ 2.1（sensitive GREEN）→ 2.2（decide GREEN）→ 3.1（集成测试）→ 4.1（系统级验证）。串行依赖：TDD 测试先于实现、sensitive 规则先于 decide 分派、单元先于集成。
- **关键链估时**：1.1 ≈ 15min、1.2 ≈ 10min、2.1 ≈ 15min、2.2 ≈ 5min、3.1 ≈ 20min、4.1 ≈ 10min，合计 ≈ 75min。
- **project buffer**：75min × 35%（tier-medium，strength-matrix 表 1）≈ 26min，留在 3.1 集成测试（soft 持久化 + hard 不回归的跨场景）与 4.1 全套回归上。
- **任务主体约束**：每条 task 主体均为编程性动作（写测试 / 改代码 / 跑 CLI），非编程性动作降级为该 task 的验证字段。

## 1. 单元测试（RED）

- [ ] 1.1 在 `test/sensitive.test.ts` 追加 soft 规则匹配用例：`findSensitiveMatch("~/.config/gh/config.yml")` 命中 soft（`level: "soft"`，reason 标 soft）；`auth.json`/`settings.toml`/`models.json` 同理命中 soft。`config.ts`/`auth.py`/`config`（无扩展名）**不**命中 soft。`~/.ssh/id_rsa`/`~/.ssh/config` 仍命中 hard（`level: "hard"`）。验证：实现前跑该组 FAIL（soft 规则未实现，返回 undefined 或无 level）。
  - 验证：`node --experimental-strip-types --test --test-name-pattern="soft" test/sensitive.test.ts` 实现前 FAIL、2.1 后 PASS。
- [ ] 1.2 在 `test/decision.test.ts` 追加 decide 分派用例：soft sensitive + 项目外 → tier=three；soft sensitive + 项目内 → tier=three；hard sensitive + 项目外 → tier=two（不变）；hard sensitive + 项目内 → tier=three（不变）。验证：实现前 FAIL（decide 不读 level，soft 走既有 isInside 分派 → 外区 tier=two）。
  - 验证：`node --experimental-strip-types --test --test-name-pattern="soft" test/decision.test.ts` 实现前 FAIL、2.2 后 PASS。

## 2. 实现（GREEN）

- [ ] 2.1 `src/lib/sensitive.ts`：`SensitiveRule` 接口加 `level: "hard" | "soft"` 字段；既有 5 条 `DEFAULT_SENSITIVE_RULES` 标 `level: "hard"`；新增第 6 条 soft 规则（test 匹配 `config`/`auth`/`settings`/`models` + `.json`/`.toml`/`.yml`/`.yaml` 的 basename，reason "Soft credential config file"，`level: "soft"`）。验证：1.1 测试 PASS。
  - 验证：`node --experimental-strip-types --test test/sensitive.test.ts` 全绿（含 soft 用例 + 既有 hard 不回归）。
- [ ] 2.2 `src/lib/decision.ts` `decide()` step 2b（L242-251）：`tier: isInside ? "three" : "two"` 改为 `tier: sensitive?.level === "soft" ? "three" : (isInside ? "three" : "two")`。验证：1.2 测试 PASS。
  - 验证：`node --experimental-strip-types --test test/decision.test.ts` 全绿（含 soft 分派 + 既有 hard 不回归）。
- [ ] 2.3 `extensions/index.ts`：确认 `decideTarget`（L755 `findSensitiveMatch(absPath)`）已透传 `sensitive` 对象给 `decide()`（L790-799）——`SensitiveRule` 加 `level` 字段后透传自动携带，无需改调用点。验证：集成测试 3.1 覆盖。
  - 验证：无代码改动则此 task 为确认性，证据是 3.1 集成测试 PASS。

## 3. 集成测试

- [ ] 3.1 在 `test/sys-integration.test.ts` 追加 SYS 场景：(a) 项目外 `~/.config/app/config.yml` 首次读 → tier=three prompt → "总是允许"持久化 → 第二次读 auto_allow；(b) 项目外 `~/.ssh/id_rsa` 读仍 tier=two 不可持久化（"总是允许"选项不出现）；(c) `~/.ssh/config` 仍 hard（外区 tier=two）。验证：跑通过。
  - 验证：`node --experimental-strip-types --test --test-name-pattern="SYS-SOFT" test/sys-integration.test.ts` PASS。

## 4. 系统级验证

- [ ] 4.1 typecheck + 全套测试。验证：`npm run typecheck` 0 error；`npm test` 0 失败（含 sensitive / decision / sys-integration / trust / grant-memory 跨分系统回归）。
- [ ] 4.2 系统级验证（td-apply 步骤 6.2）：跨分系统边界 sensitive-path-classification × access-decision × grant-memory——soft 持久化 grant 跨会话生效 + hard 持久化边界不变。验证：3.1 集成测试覆盖 + 全套测试绿。
