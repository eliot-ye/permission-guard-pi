# Design: Bash Stage B 安全修复的实现

## Context

本 change 回滚 spec.md 里三处"已知风险"设计（SILENT_COMMANDS 过宽、shell-forwarder 只覆盖 `-c`、`<` 输入重定向未覆盖），并新增 UNRELIABLE_COMMANDS 守卫与 C5 grant-vs-unread 优先级契约。所有改动集中在 `src/lib/bash-extract.ts`（纯函数模块）+ `extensions/index.ts`（pi 集成层）；`policy-core`、`trust`、`decision`、`audit` 均不变。

关键现状（供实现者定位，避免重复探索）：

- `SILENT_COMMANDS`（`bash-extract.ts` L880-883）是 `Set<string>`，仅包含命令名：`git`、`npm`、`npx`、`yarn`、`pnpm`、`make`、`tsc`、`go`、`cargo`、`openspec`、`rg`、`jq`。命中即视为 0-target 静默。
- `isForBodyReadOnly`（L1821-1841）和 `extractBashTargets` 主流程（L2141）都调用 `SILENT_COMMANDS.has(cmdName)` 判定是否豁免。
- `isShellForwarder`（L1989-2042）只匹配 `bash|sh|dash|zsh` + `-c`；spec.md 明确把 "bash /tmp/x.sh 不触发" 写为反例。
- `extractRedirects`（L1171-1243）只处理 `>`、`>>`、`2>`、`2>>`、`>&`，不处理 `<`。
- `handleBash`（`extensions/index.ts` L453-472）的 bash grant 命中分支直接 `return undefined`，未做任何目标扫描。
- `state.policy.resolve(absPath)`（`config.ts` L201）返回 `MatchedEntry | undefined`，其中 `permission === "unread"` 表示硬拒绝。

## Goals / Non-Goals

**Goals:**

- 堵住 5 类实测的高危漏洞（C1/C2/C3/C4/C5）。
- 保留合法降噪用例行为不变（收窄后 SILENT 白名单内的 `git status`/`npm test`/`git log --oneline` 等；stage-a 已建立的所有降噪豁免）。
- 提供 `UNRELIABLE_COMMANDS` 与结构化的 `SILENT_COMMANDS`，让"命令能否静默"的判定集中、可枚举、可扩展。
- 让 unread 是真正的"硬拒绝、不可覆盖"——包括不能被 bash-command grant 覆盖。

**Non-Goals:**

- 不改 "unknown command → 0 target" 的 fail-open 默认（属于 D6 已知设计边界，spec.md 未声明这是漏洞，本 change 不推翻）。
- 不处理包装器解包（`env`/`nohup`/`timeout`/`watch` + SILENT/UNRELIABLE 命令）——留待下一轮决策。
- 不处理 macOS 大小写绕过 unread（policy-core 分系统，独立提案）。
- 不新增分系统、不引入新模块、不动 `policy-core`（decision/config/trust/sensitive/path-utils/audit）。
- 不做完整"授权撤回"重构（如"配置变更触发清除所有相关 bash-command grant"）——本 change 只做"unread 优先于 grant"的兜底检查，其他授权撤回机制留给未来。
- 不改 `extractBashTargets` 返回值形状。

## Decisions

### D1: `SILENT_COMMANDS` 结构改为 `{ cmdName: Set<subcommand> }`

**决策**：把 `SILENT_COMMANDS` 从 `Set<string>` 命令名集合改为结构化白名单：

```typescript
// 收窄后的 SILENT 白名单：命令名 + 允许的子命令集合
// 命令名本身必须命中；后续第一个非 flag token 若是允许的子命令，则豁免
// 若命令名命中但无子命令（如 `git` 单独），视为 SILENT（等价于 "help/version" 查询，无副作用）
const SILENT_COMMANDS: Record<string, Set<string>> = {
  git:    new Set(["status", "log", "diff", "branch", "tag", "remote", "config", "rev-parse", "rev-list", "shortlog", "blame", "show"]),
  npm:    new Set(["test", "lint", "audit", "run"]),  // npm run 允许（子命令是 script 名，非文件）
  npx:    new Set(["--yes"]),                          // 仅允许 npx <flag>（无实际包执行）；`npx <pkg>` 判 unreliable
  yarn:   new Set(["test", "lint", "audit"]),
  pnpm:   new Set(["test", "lint", "audit"]),
  tsc:    new Set(),                                  // tsc 无子命令，全 flag
  cargo:  new Set(["check", "metadata", "metadata"],), // 仅 cargo check 静默；cargo run 判 unreliable
  go:     new Set(["version", "env"]),                // 仅 go version/env 静默；go run/build/install 判 unreliable
  make:   new Set(),                                  // make 无静默（make -f 可指任意 Makefile）
  rg:     new Set(),                                  // rg pattern 可扫任意路径，无静默
  jq:     new Set(),                                  // jq 可读任意文件，无静默
  openspec: new Set(),                                // openspec status/list/show 等本项目工具，全静默
};
```

**判定接口**：新增辅助函数 `isSilentCommand(cmdName: string, tokens: string[]): boolean`——

```typescript
function isSilentCommand(cmdName: string, tokens: string[]): boolean {
  const allowSet = SILENT_COMMANDS[cmdName];
  if (!allowSet) return false;                        // 命令名不在白名单
  // 扫描后续 token，跳过 flag 与 flag-value，找第一个非 flag token 作为子命令
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") { i += 1; continue; }             // -- 之后全部是位置参数
    if (t.startsWith("-")) {
      // 跳过 flag（含 -x=val 与 -x val 两种形式）
      if (!t.includes("=") && /^[a-zA-Z]$/.test(t.slice(1)) && i + 1 < tokens.length && !tokens[i+1].startsWith("-")) {
        // -x val 形式：跳过下一 token
        i += 1;
      }
      continue;
    }
    // 首个非 flag token：判是否为允许的子命令
    return allowSet.has(t);
  }
  // 命令名后无 token 或全 flag（如 `git --version`、`npm --help`）
  return allowSet.size === 0 || allowSet.has("");  // 简写：allowSet 空则允许
}
```

**理由**：命令名单独匹配无法区分 `git status`（安全）与 `git log /etc/passwd`（越界），必须能识别子命令。结构化白名单是最直接的表达。

**替代方案（拒绝）**：
- (A) 保留 `Set<string>` 命令名集合，用另一个白名单 `SILENT_SUBCOMMANDS: Set<string>` 存 `git-status`/`npm-test` 等组合键——拒绝，用组合键（`git-status`）不如结构化清晰，且调用点判定时要自己拼组合键
- (B) 把 `git`/`npm`/`npx`/`yarn`/`pnpm`/`make`/`cargo`/`go`/`tsc`/`rg`/`jq` 全部从 SILENT 移除，仅保留 `openspec`——拒绝，用户明确拍板"收窄到纯只读子命令"（explore Q2），保留 `git status`/`npm test` 等合法用例
- (C) 用正则匹配命令字符串——拒绝，可读性差、维护成本高

**调用点改动**：
- `isForBodyReadOnly`（L1821-1841）：`SILENT_COMMANDS.has(cmdName)` → `isSilentCommand(cmdName, tokens)`
- `extractBashTargets` 主流程（L2141）：`SILENT_COMMANDS.has(cmdName)` → `isSilentCommand(cmdName, tokens)`
- **不改**任何调用点外的接口

**Implementation delta（Phase 10.4 实现时的偏差）**：

上表代码块是**设计示例**，最终实现相对该示例有以下偏差（都在 `src/lib/bash-extract.ts` 落地）：

1. **`git` 集合补齐 `ls-files`**——既有回归测试 `BTP22: silent_command_does_not_mask_forwarder` 依赖 `git ls-files | xargs rm` 的 `git ls-files` 静默部分。设计时漏列，实现时补上。

2. **`npm` 集合移除 `run`**——决策过程中一度考虑允许 `npm run`（script 名是标识符而非路径），但 `npm run build` 可能触发任意 script（`preinstall`、`postinstall`）；最终收窄到 `{test, lint, audit}`，与设计示例不符。同理 `yarn`/`pnpm` 也是 `{test, lint, audit}`。

3. **`SILENT_ALLOW_ALL` 常量**——`openspec` 是唯一"任何形式都静默"的项目工具（无文件副作用）。为避免 `isSilentCommand` 里堆 if 分支，抽成单独集合：`SILENT_ALLOW_ALL = new Set(["openspec"])`。逻辑上"空 allow-set 且非 SILENT_ALLOW_ALL"（如 `make`/`rg`/`jq`/`npx`）走最严的"完全无 positional token"模式。

4. **`make`/`npx`/`rg`/`jq`/`cargo` 的双重归属**——这些命令既在 `SILENT_COMMANDS`（因为存在合法静默形式：`cargo check`），又在 `UNRELIABLE_COMMANDS`（因为可能带脚本/路径参数）。实际行为：`UNRELIABLE_COMMANDS` 的守卫（`isAnyUnreliableCommand`）在 `extractBashTargets` 主流程中**先**于 SILENT 判定运行，因此任一形式都会走 `unreliable_command`——`SILENT_COMMANDS` 里保留它们是**历史标记**，让"曾经的静默命令"可读；实际不生效。README 表格已明确说明。

5. **`isSilentCommand` 的 flag-value 组合处理**——设计示例的 flag 扫描过于简化（只按 `/^[a-zA-Z]$/` 判 `-x val`）。实现改用长/短 flag 分开处理：`--flag value`（无 `=`）与 `-x val` 都消费下一 token，`--flag=value` 与 `-x=value` 不消费。

6. **`bash --version /dev/null` 类边界**——设计示例里"纯 flag 不触发"的边界，在实现中有一个未修复的误判：`bash --version /dev/null` 会被判为 shell_forwarder（因为 `/dev/null` 是非 flag 位置参数）。**接受此误判**——`bash` 收到未知参数通常会报错退出，实际危害极低；修复需要维护 shell 参数表，成本 > 收益。

### D2: 新增 `UNRELIABLE_COMMANDS` 常量与判定

**决策**：新增文件级常量：

```typescript
// 明确列入的"不可执行命令"——命令名精确匹配即判 unreliable
// 这些命令可以执行任意 shell、访问任意文件、或通过网络外传数据
const UNRELIABLE_COMMANDS = new Set([
  // 脚本解释器（通过 -c/-e 执行任意代码）
  "sed", "awk", "perl", "python", "python2", "python3", "python3.11", "python3.12",
  "node", "nodejs", "ruby", "php", "lua", "deno", "bun",
  // macOS/Windows 脚本执行器
  "osascript", "powershell", "pwsh", "cmd",
  // 网络工具（可以外传数据）
  "scp", "sftp", "rsync", "ssh", "telnet", "nc", "netcat", "ncat", "socat",
  // 容器/云编排（可执行任意命令）
  "kubectl", "docker", "podman", "nerdctl", "crictl",
  // 元命令 / shell 转发器（stage-a 明确留给 Stage B）
  "eval", "exec", "trap",
]);
```

**判定位置**：在 `extractBashTargets` 主流程的 `isShellForwarder` 检查之后、`splitCommands` 拆分之前插入：

```typescript
// 5.5 UNRELIABLE_COMMANDS 检查（C2）
if (isAnyUnreliableCommand(rawCommand)) {
  return { reliable: false, rawCommand, reason: "unreliable_command" };
}
```

`isAnyUnreliableCommand` 遍历所有 command fragment 的首命令（跳过 wrapper 前缀如 `env`/`command`），任一命中即返回 true。

**理由**：
- 命令名单独判定比 tokenize + 参数分析更简单可靠——`sed -i 'x' /etc/passwd`、`sed 's/a/b/' file` 无论参数是什么都判 unreliable
- 命令白名单是可枚举、可维护的（新增一类命令只需加一行）
- 明确列入 vs 反查 "未在 COMMAND_TABLE 也未在 SILENT 的命令" ——前者比后者更清晰、更保守

**替代方案（拒绝）**：
- (A) 用反查逻辑："命令不在 COMMAND_TABLE 也不在 SILENT_COMMANDS 即判 unreliable"——拒绝，这是把 "unknown → fail-open" 改为 "unknown → fail-closed"，属于 D6 设计边界变更（proposal 明确 Non-Goals 不改），影响面远大于本 change 范围
- (B) 不新增 UNRELIABLE_COMMANDS，只把 `sed`/`perl`/`python` 等命令加入 COMMAND_TABLE 但 extractor 内部判 unreliable——拒绝，逻辑混乱，COMMAND_TABLE 是"如何提取 target"，unreliable 是"是否提取 target"，两件事不该混

**边界**：UNRELIABLE_COMMANDS 命中即整条命令判 unreliable，不做任何 target 提取。这意味着 `sed -i 'x' /etc/passwd` 走 tier=two 弹窗而非 tier=three 弹窗——tier=two 无 "Always allow" 选项。这是刻意保守：sed/python/node 这类工具实际执行内容依赖参数，用户如果每次都要点 allow 会累，但如果给了 "Always allow"，等于授权了"执行任意 sed/python/node 命令"，风险太高。**若用户反馈频繁弹窗**，可以在 `bashSubtitleForReason` 里加提示"此类命令建议添加显式 config 声明，或改用专用工具（read/grep/find）"。

### D3: `isShellForwarder` 扩展覆盖脚本路径与 source/dot-source

**决策**：修改 `isShellForwarder` 检测逻辑：

```typescript
function isShellForwarder(cmd: string): boolean {
  const stages = splitPipelines(cmd);
  const firstStage = stages[0]?.trim();
  if (!firstStage) return false;

  const tokens = tokenize(firstStage);
  if (tokens.length === 0) return false;

  // ... 保持既有 env/command wrapper 处理 ...

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const base = tok.split("/").pop()!;

    if (SHELL_WRAPPER_NAMES.has(base)) { /* 既有 wrapper 处理 */ continue; }

    if (SHELL_NAMES.has(base)) {
      // 判定 1: -c 标志（既有）
      for (let j = i + 1; j < tokens.length; j++) {
        const arg = tokens[j];
        if (arg === "-c" || /^-[A-Za-z]*c/.test(arg)) return true;  // 既有
        if (arg.startsWith("--")) break;
        // 判定 2: 非 flag 位置参数（脚本路径）—— 新增
        if (!arg.startsWith("-")) return true;  // ← 新增：bash /tmp/x.sh、bash -x /tmp/x.sh
      }
      return false;
    }

    // 判定 3: source 与 . (dot-source) —— 新增
    if (base === "source" || base === ".") {
      // source 与 . 后必须有位置参数（脚本路径）
      for (let j = i + 1; j < tokens.length; j++) {
        if (!tokens[j].startsWith("-")) return true;
      }
      return false;  // source 无参数不触发（罕见的 `source` 单独调用）
    }

    return false;
  }

  return false;
}
```

**理由**：
- `bash /tmp/x.sh` 与 `bash -c "..."` 在安全语义上等价——都执行了"字符串/文件内容里的命令"，无法静态分析
- spec.md 现有 scenario "bash 不带 -c 不触发" 是明确写死的反例，本 change 删除该反例并新增正向 scenario（proposal 已声明 BREAKING）
- `source` 与 `.` 是 bash 的两种"执行脚本文件"方式，与 `bash /tmp/x.sh` 等价

**替代方案（拒绝）**：
- (A) 只把 `bash /tmp/x.sh` 提取为 read target（不判 unreliable）——拒绝，脚本文件本身可读，但脚本**内容**执行了哪些命令不可静态分析；用户拍板选择"识别为 shell_forwarder"而非"提取 read target"（explore Q3）
- (B) 只在命令片段的首 token 检查 source/`.`——拒绝，`env FOO=1 source /tmp/x.sh` 也是常见形式，需要 wrapper 透传

**边界**：
- `bash --version`、`bash -h` 等纯 flag 形式不触发（既有逻辑保持）
- `bash -x` 单独（无位置参数）不触发——`-x` 是 trace 模式但无后续命令
- `bash -x /tmp/x.sh` 触发（`-x` 是 flag，`/tmp/x.sh` 是位置参数）

**Implementation delta（Phase 10.4 实现时的偏差）**：

设计示例的 `isShellForwarder` **只扫首 pipeline stage 的首 token**——这在 Phase 10 独立 LLM 审核中被发现是 P0 漏洞：`echo hi && bash /tmp/evil.sh` 会因 `echo` 不是 shell 而 return false，绕过整个检测。最终实现：

1. **compound separator 感知**——外层新增 `splitCommands(rawCommand)` 循环，对每个 fragment 再 `splitPipelines(fragment)`，对每个 stage 走 token 扫描。这样 `&&`/`||`/`;`/`&`/`\n` 分隔的 shell forwarder 都能被抓到（测试 BT-B25..BT-B31 覆盖）。

2. **抽出 `skipWrapperTokens` helper**——`isAnyUnreliableCommand` 与 `isShellForwarder` 的 wrapper 跳过循环原本是复制粘贴的（同源 bug 漂移），抽取为共用函数。

3. **wrapper 短 flag 感知**——原实现只跳 `--flag` 与 `KEY=VAL`，不跳短 flag `-v`/`-u`。这导致两个 bug：
   - `command -v sed` 误判 unreliable_command（fail-closed，噪音）
   - `env -u FOO bash /tmp/x.sh` 因 `-u` 中断 wrapper 扫描而逃过 shell_forwarder（P0 变体）

   最终 helper 感知 wrapper 类型：`command` builtin 的 `-v`/`-V` 是"查询目标"（消费下一个 token 作为查询名），`env` 的 `-u`/`-C`/`-P`/`-S`/`-I` 是"取值 flag"（消费下一个 token 作为值）。测试 BT-B32..BT-B36 覆盖。

4. **`bash --version /dev/null` 误判**——见 D1 delta 第 6 条，此处同样适用；`isShellForwarderTokenStream` 对 shell 参数的扫描不做白名单过滤，遇到任何非 flag token 都视为脚本路径。

5. **`isShellForwarderTokenStream` 内部函数**——设计示例把 token 扫描写在 `isShellForwarder` 内，实现中抽出为独立函数便于 per-stage 调用与单测。

### D4: `extractRedirects` 新增 `<` 分支

**决策**：修改 `extractRedirects`（`bash-extract.ts` L1171-1243），在既有 `>`/`>>`/`2>`/`2>>`/`>&` 分支基础上，新增 `<` 输入重定向：

```typescript
function extractRedirects(command: string, targets: Array<{ action: ExtractAction; path: string }>, projectRoot: string) {
  let i = 0;
  while (i < command.length) {
    const start = i;
    let op = "";
    let action: ExtractAction = "write";  // 默认 write（>）

    // 输入重定向：N< 或 <
    if (command[i] === "<") {
      if (command[i + 1] === "<") {
        // << 是 heredoc 起始，跳过（由 scanUnreliable 处理）
        i += 1;
        continue;
      }
      op = "<";
      action = "read";  // 输入重定向是 read
      i += 1;
      // 前面可能还有数字（如 `0< file`），但 tokenize 阶段已处理，此处只看 `<`
    } else if (command[i] === "2" && command[i + 1] === ">") {
      // 既有 2> 处理
      // ...
    } else if (command[i] === ">") {
      op = ">";
      i += 1;
    } else {
      i += 1;
      continue;
    }

    // ... 既有 skip-whitespace + read-path-token 逻辑 ...

    // 新增：读目标分支（< 走这里）
    if (action === "read") {
      const abs = toAbsolutePath(expandHome(path), projectRoot);
      if (!looksLikePath(abs)) continue;
      targets.push({ action: "read", path: abs });
      continue;
    }

    // ... 既有 write 目标逻辑（含 /dev/* 豁免与 isDevSocketOrFd 检查）...
  }
}
```

**理由**：
- `<` 是 bash 的输入重定向操作符，语义上就是"从文件读数据喂给命令"，与 `>` 输出重定向对称
- 现有实现完全跳过 `<`，导致 `bash < /tmp/evil.sh` 中 `/tmp/evil.sh` 完全不可见
- 提取为 read target 而非判 unreliable：`<` 后面的路径是可静态判定的字符串（不像 `$(...)` 是命令替换），走正常决策路径允许用户按路径配置授权

**替代方案（拒绝）**：
- (A) 把 `<` 判为 unreliable——拒绝，过于保守，`< /tmp/x.sh` 是可明确的路径，用户应该能授权这个具体路径
- (B) 把 `<` 提取为 read target 但仍走原有 write-target 处理分支——拒绝，语义混乱（`<` 是读、`>` 是写，混用 action 字段会破坏既有测试的语义）

**边界**：
- `<<` (heredoc 起始) 不触发——由 `scanUnreliable` 的 heredoc 判定处理
- `<(...)` (process substitution) 不触发——由 `scanUnreliable` 的 process_substitution_input 判定处理
- `0<` 单独（fd 指定）—— 现有 tokenize 阶段已处理 fd 数字，此处只需看 `<`
- `<>` (read-write 模式)——bash 里极罕见，本 change 不处理，视为无操作（既不是 `<` 也不是 `>`）

### D5: bash-command grant 命中后仍跑 unread 检查（C5）

**决策**：修改 `extensions/index.ts` L453-472 的 bash grant 命中分支，从"直接 return undefined"改为"命中后仍扫裸路径 token 跑 unread 检查"：

```typescript
if (
  !extraction.reliable &&
  (state.trust.hasBashSessionGrant(state.projectHash, command) ||
    state.trust.hasBashPersistentGrant(state.projectHash, command))
) {
  // C5: grant 命中后仍扫描命令字符串里的裸路径 token 跑 unread 检查
  // 用 tokenize 提取所有看起来像路径的 token，expandHome + toAbsolutePath 后调 policy.resolve()
  const scanTokens = tokenizeBashCommand(command);
  for (const t of scanTokens) {
    if (!looksLikePathToken(t)) continue;
    const absPath = toAbsolutePath(expandHome(t), state.projectRoot);
    const entry = state.policy.resolve(absPath);
    if (entry?.permission === "unread") {
      // unread 硬拒绝——grant 不生效
      state.audit.log({
        event: "hard_deny",
        tool: "bash",
        project: state.projectHash,
        projectRoot: state.projectRoot,
        path: absPath,
        command,
        region: entry ? "project_inner" : "project_outer",
        declaration: "unread",
        permission: null,
        toolCallId: event.toolCallId,
        note: `Bash command grant bypassed: unread hard-deny for ${absPath} (config wins over bash grant)`,
      });
      return { block: true, reason: `Unread config overrides bash command grant for ${absPath}` };
    }
  }

  // 无 unread 命中，走原逻辑
  state.audit.log({ /* 既有 auto_allow 记录 */ });
  return undefined;
}
```

新增辅助函数 `tokenizeBashCommand(command: string): string[]` 与 `looksLikePathToken(token: string): boolean`——复用 `bash-extract.ts` 的 `tokenize` 与 `looksLikePath`（如果未导出则改为导出，或在 `extensions/index.ts` 内部实现同名工具函数）。

**理由**：
- unread 是 spec.md 声明的"硬拒绝、不可覆盖"契约（`grant-memory` 契约）
- 用户如果配了 unread，即使之前对某 bash 命令点过 "Always allow"，配置变更应该撤回授权——这是"配置作为契约"的核心
- 保守实现："扫裸路径 token"比"完整 target 提取"简单、比"不检查"安全
- 只对 unreliable 命令的 bash grant 生效（reliable 命令走原有 target 提取路径，本身会命中 unread）

**替代方案（拒绝）**：
- (A) 修改 `decide` 让 unread 永远优先于 grant——拒绝，`decide` 是纯函数，grant 是 extension 层注入的，架构上不该让 decide 知道 grant
- (B) 修改 `handlePromptDecision` 让 tier=two prompt 也提供 "Always allow"——拒绝，C5 不是给 tier=two 加持久化选项，而是限制已有 bash-command grant 的语义
- (C) 配置变更时自动清除相关 bash-command grant——拒绝，实现复杂（要 diff 配置、匹配 bash command 字符串里的路径），本 change 不做；这是"完整的授权撤回机制"，留给未来独立 change
- (D) 不修改，把 C5 归入"授权语义模糊"的已知风险——拒绝，用户明确拍板 Q4 "grant 命中后仍扫命令里的裸路径跑 unread 检查"

**边界**：
- 只扫**裸路径 token**（quote-aware 的 tokenize 结果里看起来像路径的 token）——不尝试解析 `$(...)`、`$VAR` 等复杂表达（这些已经在 unreliable 命令里，bash grant 覆盖它们本来就靠用户信任整条命令）
- `bash -c "cat /etc/passwd"` 中 `/etc/passwd` 在双引号内，tokenize 后 token 是 `cat /etc/passwd`（带空格），不是裸路径——**这是 C5 实现的一个已知限制**：只对"路径作为独立 token"的 bash 命令生效，对"路径嵌在字符串参数里"的 bash 命令不生效。**决策**：接受这个限制，用户如果配了 unread 且担心绕过，应该用 tier=two prompt（不能 "Always allow"）。

### D6: 新增 reason 值 `unreliable_command` 的优先级

**决策**：`UNRELIABLE_COMMANDS` 检查在 `isShellForwarder` 之后、`findUnresolvedVariable` 之前插入。优先级顺序：

```
1. scanFindWriteFlags         (stage-a)
2. scanUnreliable             (含 command_substitution / glob_expansion 等)
3. scanControlFlow            (stage-a)
4. isShellForwarder           (含本 change 的脚本路径扩展)
5. isAnyUnreliableCommand     (本 change 新增，C2)
6. findUnresolvedVariable     (既有)
7. expandSafeVariables + splitCommands + extract
```

**理由**：
- UNRELIABLE_COMMANDS 命令（如 `sed`、`python`）本身可能包含 `$()`、`$(...)` 等复杂语法，如果先扫描这些语法，reason 会被 `command_substitution` 抢占，用户看不到"这条命令被判 unreliable 是因为它本身是危险命令"这一关键信息
- 放在 `isShellForwarder` 之后是因为 `bash -c 'sed -i ...'` 应该判 shell_forwarder（外层是 bash），而不是 unreliable_command（内层是 sed）

**替代方案（拒绝）**：
- (A) 放在 `scanUnreliable` 之前——拒绝，会让 `sed -i "$(cat /etc/passwd)"` 判 unreliable_command 而非 command_substitution，信息量降低
- (B) 放在 `findUnresolvedVariable` 之后——拒绝，`sed -i 'x' $FOO/file` 会判 unresolved variable 而非 unreliable_command，同样信息量降低

### D7: 不修改 spec.md 现有 scenario 的既有语义（除明确的 BREAKING）

**决策**：除 proposal 明确的 3 处 BREAKING（SILENT_COMMANDS 收窄、shell-forwarder 覆盖脚本路径、`<` 输入重定向）外，既有 spec.md 的 scenario 全部保留。

**BREAKING 处理**：
- "静默命令白名单" requirement：改写 requirement 主体，把"命令名 ∈ SILENT_COMMANDS 集合"改为"命令名 + 子命令 ∈ 结构化白名单"，替换既有 3 个 scenario（`git log`/`npm test`/`openspec status`）+ 2 个 scenario（`git` 在 SILENT 但 xargs 守卫仍生效、`rm` 不在 SILENT 仍提取 write target），保留后两个 scenario（前者改为"git status" 保留 SILENT 但 xargs 仍触发、后者不改）
- "Shell 转发器守卫" requirement：删除反例 scenario "`bash /tmp/x.sh` 不触发 shell_forwarder"，新增正向 scenario "bash 带脚本路径触发 shell_forwarder"
- "支持的重定向" requirement：追加 scenario "`<` 输入重定向提取 read target"

## Risks / Trade-offs

**[R1] `SILENT_COMMANDS` 结构变更后，`isForBodyReadOnly` 循环内的调用可能因 tokens 切片不同而判错** → 中等风险。`isForBodyReadOnly` 拿到的是完整命令字符串（不含 cmdName），需要自己 tokenize 拿 tokens 数组。**缓解**：调用点显式传 `tokens` 而非 cmdName + slice(1)，避免边界错位。任务 3 明确列出这个接入点。

**[R2] UNRELIABLE_COMMANDS 白名单可能误伤合法用例** → 低风险。误伤场景：用户写 `node /path/to/script.js` 而不是 `node -e "..."`（本 change 判定为 unreliable）。**缓解**：如果用户确实想跑，可以选 "Allow for this session" 或添加显式 config。**不追加缓解**——错误放行的危害远大于误伤合法用例。

**[R3] `isSilentCommand` 的子命令扫描逻辑遇到 `--` 分隔符可能误判** → 低风险。例如 `git -- foo bar` 中 `--` 之后是位置参数（不是子命令），本实现把 `--` 之后的第一个 token 判为子命令。**缓解**：D1 实现里对 `--` 特殊处理——跳过 `--` 之后的所有 token 判定（即认为无子命令）。

**[R4] C5 的裸路径 token 扫描对 `bash -c "cat /etc/passwd"` 无效** → 已知限制，见 D5 边界。这是 C5 的保守实现代价：只对"路径作为独立 token"生效。**缓解**：文档明确说明这一限制（README），并对 tier=two prompt 副标题加提示"bash 命令访问的路径若嵌在字符串参数里，grant 不会自动覆盖 unread"。

**[R5] UNRELIABLE_COMMANDS 命中时 reason 字段新增枚举值 `unreliable_command`** → 低风险，`reason` 字段是 `string` 类型，无类型约束。**缓解**：更新 audit log 的 README 说明。

**[R6] `source` / `.` 检查可能与既有 tokenize 逻辑冲突** → 低风险。`tokenize` 对 `.` 单独出现时视为一个 token（`.` 不含空白），与 bash 语义一致。**缓解**：写针对性测试覆盖 `source` / `.` 的正反例。

**[R7] `extractRedirects` 新增 `<` 分支后，既有 `2>`/`2>>` 分支可能因 `<` 判定顺序错误而失效** → 中等风险。当前实现是从字符 `2` 或 `>` 开始判定，插入 `<` 判定后需要确保 `<` 分支在最前面（因为 `2>` 中的 `<` 不存在，但 `<` 单独出现必须先判定，否则会被 skip）。**缓解**：把 `<` 判定放在所有 `>` 判定之前；写针对性测试覆盖 `2>`/`<` 混合的命令。

**[R8] 收窄 SILENT 后，部分既有测试（如 `test/bash-extract.test.ts` 里 `git log /etc/passwd` 相关测试）可能失败** → 中等风险。既有测试如果断言"某命令 reliable"但按新规则应变 unreliable，需要更新期望。**缓解**：Phase 4 明确列出"跑全套测试，逐条确认失败用例属于行为扩展还是回归"；如果确实属于预期行为扩展（合法用例变弹窗），更新测试期望并注释说明。

**[R9] `npx --yes` 允许但 `npx <pkg>` 判 unreliable——npx 的合法用例被切断** → 中等风险。用户如果 `npx prettier --write src/foo.ts` 期望被授权为 SILENT，本实现会判 unreliable（因为第一个非 flag token 是 `prettier`，不在白名单）。**决策**：这是有意收窄——npx 可以下载并执行任意 npm 包，比 npm 更危险。**缓解**：README 明确说明这个收窄的理由。

**[R10] C5 的 audit 记录可能与既有 audit 记录重复** → 低风险。C5 在 grant 命中分支里新增 hard_deny 记录，如果用户拒绝了一个已被 grant 覆盖的命令，会同时产生 `hard_deny`（C5 兜底）而无 `deny`（用户拒绝）。这是语义正确的（命令被系统硬拒绝，不是用户拒绝），但审计消费者可能困惑。**缓解**：note 字段明确写 "Bash command grant bypassed: unread hard-deny for <path>"，让审计可区分。

## Migration Plan

**分阶段部署**（避免一次改动过大，与 stage-a 一致的 phase 结构）：

1. **Phase 1**：`bash-extract.ts` 内新增结构化 `SILENT_COMMANDS`、`UNRELIABLE_COMMANDS`、`isSilentCommand`、`isAnyUnreliableCommand` 4 个常量/函数（不接入调用点）。写单元测试验证每个函数独立行为。此时主流程 0 改动，全测试套件应该全绿（除 SILENT 收窄导致的期望变更）。
2. **Phase 2**：`extractRedirects` 接入 `<` 分支。跑 BT-B19..BT-B21 测试，同时回归 `>`/`>>`/`2>`/`2>>` 的既有测试。
3. **Phase 3**：`isShellForwarder` 扩展覆盖脚本路径 + source/`.`。跑 BT-B15..BT-B18、BT-B22 测试，同时回归既有 shell-forwarder 测试（BTP- 组）。
4. **Phase 4**：`isForBodyReadOnly` + `extractBashTargets` 主流程接入 `isSilentCommand`。跑 BT-B1..BT-B6、BT-B23..BT-B26 测试，同时回归 BMG 系列的 SILENT 相关测试。
5. **Phase 5**：`extractBashTargets` 主流程接入 `isAnyUnreliableCommand`。跑 BT-B7..BT-B14 测试。
6. **Phase 6**：`extensions/index.ts` `handleBash` 接入 C5 兜底检查。跑 SYS-B1..SYS-B4 测试，同时回归既有 bash grant 测试（BGM-* 组）。
7. **Phase 7**：跑完整测试套件 `node --experimental-strip-types --test test/`，确保零回归。
8. **Phase 8**：安全探针 `test/security-probe.mjs` 追加 5 条原始审计 payload，运行确认全部不再静默通过。

**回滚策略**：每个 phase 独立提交。任何 phase 出问题，直接 revert 该 phase 的 commit——每个 phase 都是独立接入点，前序 phase 都是纯新增或独立调用点改动，不会互相依赖到无法回滚。

**apply 顺序**：本 change 应在 stage-a 之后 apply（stage-a 已归档），且是独立的下一个 change（无并行冲突）。

## Open Questions

**Q1**: `npx <pkg>` 判 unreliable 后，用户如果想跑某个 npm 包，怎么恢复？

选项：
- (a) 添加 `npx` 到 config 的 `read_write` 声明（针对整个 npx 命令，无路径粒度）
- (b) 用 `npm install -g <pkg>` 全局安装后直接调用 `<pkg>`
- (c) 接受每次弹窗，选 "Allow for this session"

**决策延后**：本 change 走 (c)——用户接受弹窗。README 明确说明这个收窄的理由，若未来用户反馈强烈再考虑 (a)/(b)。

**Q2**: `python3 script.py` 应该判 unreliable 还是提取 `script.py` 为 read target？

选项：
- (a) 判 unreliable（本 change 的选择）——脚本内容不可静态分析
- (b) 提取 `script.py` 为 read target，仍 reliable——用户可以授权这个具体脚本文件

**决策**：本 change 走 (a)。理由同 D2——`sed`/`python`/`node` 等脚本解释器可以执行任意代码，与 `bash /tmp/x.sh`（D3 判 shell_forwarder）语义等价。若未来需要区分 "运行本地脚本" vs "执行内联代码"，可以在 UNRELIABLE_COMMANDS 上扩展子命令判定（类似 `isSilentCommand`），本 change 不做。

**Q3**: `kubectl`、`docker`、`podman` 等容器/云编排工具加入 UNRELIABLE_COMMANDS 是否过于保守？

**决策**：加入。理由：这些工具可以执行任意命令（`kubectl exec`、`docker run`），语义上与 `bash -c` 等价。用户如果确实想跑容器，本 change 让用户弹窗授权；若反馈强烈，未来可以在 UNRELIABLE_COMMANDS 上扩展子命令白名单（如 `kubectl get`/`describe` 允许）。

**Q4**: `eval`/`exec`/`trap` 加入 UNRELIABLE_COMMANDS 是否多余？

**决策**：不删除。`eval` 是 stage-a 明确留给 Stage B 的元命令，`exec` 会替换当前 shell 进程（无法预测后续行为），`trap` 会注册 shell 事件回调（跨命令生效）。虽然这些命令在静态分析里少见，但语义上确实是"不可静态分析"的元命令。加入 UNRELIABLE_COMMANDS 是完备性考虑。

**Q5**: C5 的裸路径 token 扫描是否应该扩展到 `bash -c "..."` 的字符串参数内部？

**决策**：不扩展。理由：字符串内部的路径可能带引号嵌套、转义、变量替换等复杂表达，静态分析不可靠。如果用户需要更严格的 C5，应该用 tier=two prompt（不能 "Always allow"），本 change 保留这个选项。

**Q6**: `SILENT_COMMANDS` 里 `git show`/`git blame`/`git rev-parse` 等子命令是否算"纯只读"？

**决策**：`git show`/`git blame`/`git log` 都判 read-only，但接受"如果给了路径参数可以读仓库外文件"的边界（例如 `git log /etc/passwd` 判 unreliable 是因为**路径参数**，不是因为 `git log` 子命令本身）。收窄后的白名单判定的是**命令名 + 子命令组合**，不检查后续路径参数——如果用户配了 `git log` 到 SILENT 白名单，`git log /etc/passwd` 也会判 SILENT。**这是一个已知漏洞**，本 change 不做路径参数检查。

**替代方案**：给 `isSilentCommand` 加一个"不允许带位置参数"的开关（如 `git log` 允许 `--oneline -n 10` 但不允许裸路径）。**决策**：延后，未来如果用户反馈"git log 可以读仓库外"这个问题被利用，再回来修。本 change 明确记录这个已知限制。
