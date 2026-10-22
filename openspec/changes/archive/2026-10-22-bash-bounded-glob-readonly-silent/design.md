## Context

实现里**已有** for-loop 迭代集 glob 豁免（`isForLoopIterationGlobExempt`，src/lib/bash-extract.ts:451，由 `isBoundedGlobSafe` 在 line 885 调用，测试 BMG88-96 覆盖）。本 change 不引入新机制，仅在既有豁免框架内放宽一个明确窄场景——**空 prefix**。

约束：
- 现有 `isBoundedPrefix(prefix, projectRoot)`（src/lib/bash-extract.ts:295）显式拒绝空 prefix：`if (!prefix) return false`，理由是"Empty prefix means the glob is at token start (e.g. `*` alone). We conservatively reject"。
- `isBoundedGlobSafe` 在 line 877 先调用 `isBoundedGlobSafe`（针对 stage 首命令），失败后才 line 885 调用 `isForLoopIterationGlobExempt`（针对 for-loop 迭代集）。两处调用关系不变。
- `for` 不在 READ_ONLY_COMMANDS（src/lib/bash-extract.ts:61），所以 `for` 作为 stage 首命令时 3a 失败，必须由 3c 处理——这正是 `isForLoopIterationGlobExempt` 存在的原因。
- 既有 `isForBodyReadOnly`（src/lib/bash-extract.ts:2707）已负责 body 只读判定，本 change 不动它。

## Goals / Non-Goals

**Goals:**
- `for x in *.log; do wc -l "$x"; done`（空 prefix 相对 glob + 只读 body）从 `glob_expansion` 降为 `reliable: true`（走静默路径）。
- 不放宽绝对路径 prefix（`/etc/*.conf`、`~/*.conf`、`C:\*.conf`）——仍判 `glob_expansion`。
- 不放宽写 body（`rm`）——仍由 `isForBodyReadOnly` 拒绝。
- 同步 BASH_GUARDRAILS 文案（Layer 2 新增示例，Layer 3 移除或限定示例）。
- 保持既有 BMG88-96 测试全部通过（非空 prefix 场景行为不变）。

**Non-Goals:**
- 不改 `isBoundedGlobSafe` 的非 for-loop 路径（`ls *.log`、`rm *.log` 仍判 `glob_expansion`）。
- 不改 `isBoundedPrefix` 函数本身（保持空 prefix 拒绝语义）——放宽只在 `isForLoopIterationGlobExempt` 内部局部应用。
- 不引入新模块、新导出、新公共 API。
- 不处理非空 prefix 的 for-loop glob（已走静默，无需改）。
- 不处理 BODY 内的 glob（仍走常规 bounded-glob 判定）。
- 不引入新的 for-loop 结构解析逻辑（复用既有解析）。

## Decisions

### D1: 放宽点放在 for-loop glob 豁免的两个调用点内部，不改 `isBoundedPrefix`

**理由**：
- `isBoundedPrefix` 是通用函数，被多处调用（line 295、line 222、line 508、line 608 等）。改它会让所有空 prefix 场景放宽，包括非 for-loop 路径的 `ls *.log`——超出本 change 的 Non-Goals。
- 放宽点放在两个 for-loop glob 豁免函数内部，仅影响 for-loop 迭代集 glob 判定，影响面被精确框定。

**实施发现（2026-10-22 apply 阶段）**：for-loop glob 豁免有两条独立路径，两者都调用 `isBoundedPrefix` 检查 prefix，必须同步放宽：
1. `isForLoopIterationGlobExempt`（line 451，由 `scanUnreliable` 调用，处理 glob_expansion 检查）——line 608 附近的 `isBoundedPrefix` 调用
2. `isGlobForLoopExempt`（line 2524，由 `scanControlFlow` 调用，处理 control_flow 检查）——line 2532 的 `isBoundedPrefix` 调用

只放宽路径 1 不够——BT-S21 实测显示 scanUnreliable 返回 undefined 后，scanControlFlow 在后续步骤仍会捕获 `for` 关键字并返回 `control_flow`。两条路径都放宽后，BT-S21/BT-S24b 才通过。

**路径 1 修改位置**（`isForLoopIterationGlobExempt` 内，约 line 605-608）：

**具体修改位置**：line 605-608 处，现有代码：
```ts
const prefix = cmd.slice(tokenStart, globPos);
if (!isBoundedPrefix(prefix, projectRoot)) return false;
return true;
```
改为：
```ts
const prefix = cmd.slice(tokenStart, globPos);
if (!prefix) {
  // 空 prefix：glob 是迭代词整体（如 `*.log`）。检查迭代词是否相对路径。
  // 迭代词以 `/`、`~` 或 Windows 盘符开头 → 绝对路径，仍拒绝。
  const iterWord = cmd.slice(tokenStart, semicolonPos); // 迭代词直到 `;`
  // 实际上 tokenStart 到 semicolonPos 之间可能含多个迭代词，但我们已知
  // globPos 在 tokenStart..semicolonPos 之间，所以迭代词就是 tokenStart 到 tokenEnd。
  // 取 tokenStart 之后的字符判断是否相对路径：
  const afterPrefix = cmd[globPos]; // glob 元字符
  const wordStart = tokenStart;
  const wordFirstChar = cmd[wordStart];
  // 检查迭代词是否以绝对路径标志开头：
  if (wordFirstChar === "/" || wordFirstChar === "~") return false;
  // Windows 盘符：`C:\` 或 `C:/`
  if (/^[A-Za-z]:[\\/]/.test(cmd.slice(wordStart))) return false;
  // 通过：空 prefix + 相对路径 → 视为 bounded
  return true;
}
if (!isBoundedPrefix(prefix, projectRoot)) return false;
return true;
```

**简化方案（实际实施）**：空 prefix 直接返回 true——`tokenStart` 向前扫至空白即停，空 prefix 意味着 `tokenStart === globPos`，此时 `cmd[tokenStart]` 必然是 glob 元字符（`*`/`?`/`[`），不会是 `/` 或 `~`。绝对路径（`/etc/*.conf`、`~/*.conf`、`C:/*.conf`）的迭代词在 glob 元字符之前有非空 prefix，走 `isBoundedPrefix` 拒绝，不经过空 prefix 分支。
```ts
const prefix = cmd.slice(tokenStart, globPos);
if (!prefix) return true;
if (!isBoundedPrefix(prefix, projectRoot)) return false;
return true;
```

### D2: 绝对路径由 `isBoundedPrefix` 拒绝，不经过空 prefix 分支

**理由**：
- `/etc/*.conf`、`~/*.conf`、`C:/*.conf` 的迭代词在 glob 元字符之前有非空 prefix（`/etc/`、`~`、`C:/`），tokenStart 向前扫至空白即停，tokenStart < globPos，prefix 非空。
- 非空 prefix 走 `isBoundedPrefix(prefix, projectRoot)`，因 `toAbsolutePath` 解析出的绝对路径不在 projectRoot 内，`isInside` 返回 false，被正确拒绝。
- 空 prefix 分支（`if (!prefix) return true`）只处理 glob 元字符在 tokenStart 处的情况（如 `*.log`、`*`）——此时 `cmd[tokenStart]` 必然是 glob 元字符本身，不可能是 `/`、`~` 或 `C:`。

**反例验证**（实测确认）：
- `for f in /etc/*.conf; do cat "$f"; done` → prefix=`"/etc/"`（非空），走 `isBoundedPrefix` → 拒绝 ✓
- `for f in ~/*.conf; do cat "$f"; done` → prefix=`"~"`（非空），走 `isBoundedPrefix` → 拒绝 ✓
- `for f in C:/*.conf; do cat "$f"; done` → prefix=`"C:/"`（非空），走 `isBoundedPrefix` → 拒绝 ✓
- `for x in *.log; do wc -l "$x"; done` → prefix=`""`（空），走空 prefix 分支 → 放行 ✓

### D3: 不放宽 BODY 内的 glob

**理由**：
- BODY 内的 glob 前缀通常含 `$VAR`（如 `"$d"/*.md`），其前缀无法静态解析到具体路径。
- 既有判定已正确拒绝 BODY 内 glob（"字面量 for 循环豁免"requirement 保持一致）。
- 本 change 只放宽迭代集内的空 prefix glob，不动 BODY 内判定。

### D4: BASH_GUARDRAILS 文案同步

**Layer 2**（静默允许列表）新增示例：
- `for x in *.log; do wc -l "$x"; done`

**Layer 3**（弹窗陷阱列表）原示例 `for x in *.log; do rm "$x"; done`（如有）保留（写 body 仍弹窗）；如果原 Layer 3 列了 `for x in *.log` 不带 body 限定，需改为"写 body 或非相对 prefix 的 for-loop"。

需读现有 BASH_GUARDRAILS 实际内容再决定具体修改——见 task T4。

### D5: 测试策略

**RED**：先写测试，确认失败。
- `BT-S21`：`for x in *.log; do wc -l "$x"; done` → `reliable: true`
- `BT-S22`：`for x in *.log; do rm "$x"; done` → `reliable: false, reason: "glob_expansion"`（写 body 仍拒绝）
- `BT-S23`：`for f in /etc/*.conf; do cat "$f"; done` → `reliable: false, reason: "glob_expansion"`（绝对路径仍拒绝，走 `isBoundedPrefix`）
- `BT-S24`：`for f in ~/*.conf; do cat "$f"; done` → `reliable: false, reason: "glob_expansion"`（home 路径仍拒绝，走 `isBoundedPrefix`）
- `BT-S25`：`for f in C:/*.conf; do cat "$f"; done` → `reliable: false, reason: "glob_expansion"`（Windows 盘符仍拒绝，走 `isBoundedPrefix`）
- `BT-S24b`：`for x in *.ts; do cat "$x"; done` → `reliable: true`（第二种只读 body）
- `BT-S24c`：`for x in ./*.log; do wc -l "$x"; done` → `reliable: true`（非空 prefix 边界，已走 `isBoundedPrefix`）

**GREEN**：实施 D1，确认测试通过。

**REFACTOR**：无重构需求（修改极窄）。

**回归**：既有 BMG88-96 测试必须全部通过（非空 prefix 场景行为不变）。

## Risks / Trade-offs

### R1: cwd == projectRoot 假设

**风险**：放宽基于"cwd == projectRoot"假设。如果用户 cd 到子目录后运行 for 循环，`for x in *.log` 会在子目录展开，仍 bounded 于 projectRoot（因为子目录在 projectRoot 内）。但若用户 cd 到 projectRoot 之外的目录（如 `/tmp`），`*.log` 会在 `/tmp` 展开——超出 projectRoot。

**缓解**：
- pi-coding-agent 的 cwd 通常就是 projectRoot（项目根目录），用户 cd 到外部目录的场景罕见。
- 即使发生，后果是弹窗（用户会被询问确认），不是静默执行——保守失败。
- 实际场景中，bash 命令执行时的 cwd 是 pi 会话的 cwd，由 pi 控制，通常等于 projectRoot。

**接受**：低概率 + 后果是保守弹窗（不破坏安全模型），接受该 trade-off。

### R2: 空 prefix 与 `*` alone 的区分

**风险**：`*` alone（tokenStart 指向 `*`，prefix 为空）与 `*.log`（tokenStart 指向 `*`，prefix 为空）在技术上都是空 prefix。`*` alone 会匹配所有文件（包括隐藏文件之外的所有），可能比 `*.log` 更广。

**缓解**：
- `*` alone 与 `*.log` 都是 cwd-relative，bounded 于 projectRoot。
- 放宽后两者都走静默路径——但 `*` alone 匹配所有文件，可能意外匹配大文件集。
- 这是既有豁免框架的固有特征，不是本 change 引入的新风险。

**接受**：cwd-relative 的 `*` 与 `*.log` 同等处理，bounded 于 projectRoot，接受。

### R3: 迭代词以 glob 元字符开头但非空 prefix 的混淆

**风险**：`*.log` 与 `../*.log` 都以 glob 元字符或相对路径开头，但后者是 `../` 越界。

**缓解**：
- 本 change 只放宽**空 prefix**（tokenStart == globPos）。
- 非空 prefix（如 `../`、`src/`）走 `isBoundedPrefix` 判定，`../` 被显式拒绝。
- 空 prefix 时，迭代词就是 glob 元字符开头（`*.log`、`*`、`?*`），没有 prefix 可越界。

**接受**：判定分支清晰，无混淆风险。

### R4: Windows 盘符正则误伤

**风险**：正则 `/^[A-Za-z]:[\\/]/` 可能误伤以 `A:` 开头的相对路径（如 `A:b/foo.txt`）。

**缓解**：
- bash 在 Unix/macOS 上不会处理 `A:` 形式的路径（Windows 专有）。
- 在 Windows bash（Git Bash、WSL）上，`A:` 开头确实是盘符路径。
- 误伤代价是弹窗（保守失败），不是静默执行。

**接受**：误伤代价是保守弹窗，接受。
