# Design: Bash Stage A 安全修复的实现

## Context

本 change 收窄 `bash-extract.ts` 里 4 处降噪豁免的判定面。所有改动集中在一个纯函数模块，不涉及 IO、pi runtime、跨分系统调用。

关键现状（供实现者定位，避免重复探索）：

- `extractRedirects`（`bash-extract.ts` L792-853）在 L847 用 `abs.startsWith("/dev/")` 一刀切豁免所有 `/dev/*` 路径。
- `isBoundedGlobSafe`（L92-183）、`isForBodyReadOnly`（L1241-1258）、`isForwarderDownstreamReadOnly`（L464-496）三处都用 `READ_ONLY_COMMANDS.has(cmdName)` 判定命令是否只读。`READ_ONLY_COMMANDS` 常量（L43-50）含 `find`/`less`/`more` 等。
- `extractBashTargets` 主流程（L1505-1518）的转发器扫描循环 `for (let i = 1; i < stages.length; i++)` 从非首 stage 起，首 stage 的转发器完全跳过检查。
- `isForwarderDownstreamReadOnly`（L464-496）只分析下游 stage，不看 upstream。

## Goals / Non-Goals

**Goals:**

- 堵住 4 类实测的高危漏洞（`/dev/tcp`/`/dev/udp`/`/dev/fd/N` 网络套接字、`find -delete`/`-exec` 家族、转发器首 stage、转发器 upstream 污染）。
- 保持合法降噪用例行为不变（`echo > /dev/null`、`find . -name "*.ts"`、`xargs grep` downstream、`for f in ...; do find ...; done`）。
- 提供一个统一接口 `isReadOnlyWithArgs`，让 `for-loop-iteration-glob-bounded` change 能复用同一套判定，避免两个 change 的判定逻辑分叉。

**Non-Goals:**

- 不反转 D6（`unknown command → 0 target`）——留给 Stage B。
- 不处理元命令（`eval`/`exec`/`trap`/`.`/`!`/`{}`）——留给 Stage B。
- 不处理包装器解包（`env`/`nohup`/`timeout`/`watch`）——留给 Stage B。
- 不处理 macOS 大小写绕过 unread（policy-core 分系统，独立提案）。
- 不新增 `reason` 值——沿用现有 `forwarding_command`、`unreliable` 等。
- 不新增分系统、不引入新模块、不动公共导出（`extractBashTargets` 返回值形状不变）。

## Decisions

### D1: `/dev/*` 黑名单检查在 `extractRedirects` 内部，紧跟豁免判定之前

**决策**：在 `extractRedirects` L847 的 `if (abs.startsWith("/dev/")) continue;` **之前**插入黑名单检查：

```typescript
const abs = toAbsolutePath(expandHome(path), projectRoot);
// 网络套接字与 fd 重定向不被 /dev/* 豁免——它们是可以外传数据/访问任意文件的实际 IO 目标
if (isDevSocketOrFd(abs)) {
  targets.push({ action: "write", path: abs });
  continue;
}
if (abs.startsWith("/dev/")) continue;
targets.push({ action: "write", path: abs });
```

新增辅助函数 `isDevSocketOrFd(absPath: string): boolean`，判定：

- `/dev/tcp/...`（以 `/dev/tcp/` 开头，含子路径）
- `/dev/udp/...`（以 `/dev/udp/` 开头）
- `/dev/fd/[0-9]+`（以 `/dev/fd/` 开头且下一段是纯数字——`/dev/fd/` 本身、`/dev/fd/../` 不算）
- `/dev/stdin`、`/dev/stdout`、`/dev/stderr` **不算**——这些是标准流的别名，属于 shell 惯用输出目标

**理由**：黑名单必须在豁免 `continue` **之前**判定。若放在豁免之后，`abs.startsWith("/dev/")` 会先跳过，黑名单永远进不到。

**替代方案（拒绝）**：
- (A) 在 `scanUnreliable` 层直接判 unreliable——拒绝，因为 `extractRedirects` 是路径提取层，网络套接字仍是可静态判定的目标路径（`/dev/tcp/host/port` 就是明确的字符串），只是不能豁免，应作为 write target 走决策，而不是整条命令判 unreliable。这样用户仍能针对这类路径配置授权。
- (B) 只把 `/dev/tcp`、`/dev/udp` 判为 unreliable（不放 targets）——拒绝，理由同上。

### D2: 新增 `isReadOnlyWithArgs(cmdName, tokens)` 统一接口

**决策**：新增一个统一入口，包装 READ_ONLY_COMMANDS 和 `find` 参数条件性判定：

```typescript
const FIND_WRITE_FLAGS = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir",
  // -newer/-newermt/-newerXY 不在此列——它们是过滤条件，不产生写操作
]);

function isFindReadOnly(tokens: string[]): boolean {
  // tokens 是从 cmdName 之后开始的参数数组
  for (const t of tokens) {
    if (FIND_WRITE_FLAGS.has(t)) return false;
    // -name 的引号包裹参数（如 -name "*.ts"）是字面量，不改变 find 语义
  }
  return true;
}

function isReadOnlyWithArgs(cmdName: string, tokens: string[]): boolean {
  if (cmdName === "find") return isFindReadOnly(tokens);
  return READ_ONLY_COMMANDS.has(cmdName);
}
```

`READ_ONLY_COMMANDS` 从集合中**移除 `find`**（因为 find 走独立分支）。`less`、`more` 保留在集合中（写 `.lesshst` 属于"副作用但目标不可预测"的争议——本 change 不处理，留给 Stage B 独立决策）。

**理由**：所有原用 `READ_ONLY_COMMANDS.has(cmdName)` 的地方（`isBoundedGlobSafe` L128、`isForBodyReadOnly` L1253、`isForwarderDownstreamReadOnly` L470 附近、以及新加的 `extractBashTargets` 首 stage 检查）都改成调用 `isReadOnlyWithArgs`。这一处改动就能让所有调用点同步获得参数条件性判定，不需要每个调用点各自实现 find 判定。

**替代方案（拒绝）**：
- (A) 每个调用点自己实现 find 判定——拒绝，4 个调用点会重复代码，且未来扩展 `find` 的判定逻辑要改 4 处。
- (B) 从 `READ_ONLY_COMMANDS` 保留 `find`，另加 `FIND_WRITE_FLAGS` 检查——拒绝，逻辑分叉，`isBoundedGlobSafe` 里如果只用 `READ_ONLY_COMMANDS.has(cmdName)` 检查会漏掉 write flag。

### D3: `find` 判定采用"黑名单 flag"而非"白名单 flag"

**决策**：`isFindReadOnly` 用**黑名单**判定——含 `-delete`/`-exec`/`-execdir`/`-ok`/`-okdir` 中任一即写。其他所有 flag 都判 read-only。

**理由**：`find` 的绝大多数用法（`-name`/`-type`/`-size`/`-mtime`/`-user`/`-group` 等 100+ 个 flag）都是过滤条件，不含写操作。用黑名单只列已知写操作 flag（5 个）比用白名单列 100+ 过滤条件更简洁、更可维护。

**边界**：`-exec` 的下游命令可以是任意命令（`find . -exec rm {} \;`），本 change 直接把 `-exec` 判为 write——不尝试分析 `-exec` 的下游。这是保守判定，用户如果误触弹窗可以手动 allow。

**替代方案（拒绝）**：
- (A) 白名单所有 find flag——100+ 条，维护成本极高。
- (B) 尝试分析 `-exec` 的下游命令——技术上可行（tokenize `-exec` 之后的内容），但复杂度远超收益：`-exec rm {} \;`、`-execdir sh -c 'rm {}' \;`、`-exec find ...` 各种嵌套形式都要处理，且 `-exec` 下游可以是任意命令（包括 `python -c`），本 change 不处理元命令，因此 `-exec` 直接判 write 更安全。

### D4: `isForwarderDownstreamReadOnly` 更名并扩展为 `isForwarderStageSafe`

**决策**：把 `isForwarderDownstreamReadOnly` 重命名并扩展为 `isForwarderStageSafe(stageIdx, stages): boolean`，同时分析：

1. **当前 stage 的 downstream**（原行为，转发器之后的下游命令）
2. **upstream stages**（转发器之前的所有 pipeline stages）

upstream 判定：upstream 中任一 stage 的命令**不是** read-only（`!isReadOnlyWithArgs`），或含 forwarder、或含 subshell 等不可靠语法时，整体判不安全。

**理由**：原函数只分析下游，导致 `find . -exec rm {} \; | xargs cat` 因为 `cat` 只读而豁免。扩展为同时分析 upstream 后，upstream 的 `find -exec rm` 会被检出。

**接口变化**：非导出函数，仅 `extractBashTargets` 主流程调用，caller 只有一个（`bash-extract.ts` 内两处），改名影响面可控。

**替代方案（拒绝）**：
- (A) 保留原名，加参数扩展语义——拒绝，`isForwarderDownstreamReadOnly` 名字表达的是下游语义，扩展后名字与实现不符，会误导。
- (B) 新增独立函数 `isUpstreamSafe`，两个函数分别调用——拒绝，upstream/downstream 是两个正交维度，用同一个函数统一判定更清晰；且两个函数的调用点都要改，改动量相同。

### D5: 首 stage 扫描通过改主循环起点实现

**决策**：`extractBashTargets` 主流程 L1505 的 `for (let i = 1; i < stages.length; i++)` 改为 `for (let i = 0; i < stages.length; i++)`。

**理由**：首 stage 的转发器（如 `xargs rm -rf`）此前完全跳过检查。改为从 0 起后，首 stage 也纳入 `isForwarderStageSafe` 判定。首 stage 是转发器时 upstream 为空，`isForwarderStageSafe` 只判定 downstream，与原语义一致（downstream 只读 → 豁免，downstream 写 → unreliable）。

**注意**：首 stage 的转发器豁免后，仍然会走"下游命令按 read target 提取"的路径——例如 `xargs grep pattern` 首 stage，downstream 是 `grep`，豁免后 grep 会按 read-only 处理。这条路径在既有代码中已支持（非首 stage 场景），本改动只是让首 stage 也走同一套逻辑。

**替代方案（拒绝）**：
- (A) 单独在 `isShellForwarder` 里加首 stage 检查——拒绝，`isShellForwarder` 只处理 shell forwarder（`bash -c` 等），转发器（xargs/parallel/pforeach）的判定在 `extractBashTargets` 主流程的 pipeline stage 层，不是一回事。
- (B) 在 `splitPipelines` 里加首 stage 特殊处理——拒绝，`splitPipelines` 只做拆分，不做判定。

### D6: `isReadOnlyWithArgs` 复用范围——不改 `isForBodyReadOnly` 签名

**决策**：`isForBodyReadOnly` 保持签名不变（`body: string`），但内部把 `READ_ONLY_COMMANDS.has(cmdName)` 调用改为 `isReadOnlyWithArgs(cmdName, tokens.slice(1))`。

**理由**：`isForBodyReadOnly` 被 `isLiteralForLoop` 调用，签名改动会传染到 `isLiteralForLoop` 的调用点（`scanControlFlow`）。用最小改动范围让 `isForBodyReadOnly` 获得参数条件性判定。

**具体改动**：

```typescript
function isForBodyReadOnly(body: string): boolean {
  if (!body.trim()) return true;
  const parts = splitCommands(body);
  for (const part of parts) {
    if (!part.trim()) continue;
    const tokens = tokenize(part);
    if (tokens.length === 0) continue;
    const cmdName = tokens[0].split("/").pop();
    // 改动点：从 READ_ONLY_COMMANDS.has(cmdName) 改为 isReadOnlyWithArgs
    if (!isReadOnlyWithArgs(cmdName!, tokens.slice(1))
        && !SILENT_COMMANDS.has(cmdName!)
        && !HARMLESS_BUILTINS.has(cmdName!)) {
      return false;
    }
  }
  return true;
}
```

**效果**：`for f in a b; do find "$f" -name "*.ts"; done` 中，`find` 走 `isReadOnlyWithArgs`，参数 `["$f", "-name", "*.ts"]` 不含 write flag → read-only → 循环体只读 → 豁免命中。

**替代方案（拒绝）**：
- (A) 扩展 `isForBodyReadOnly` 签名，让 `isLiteralForLoop` 传入 token 级信息——拒绝，`isForBodyReadOnly` 已经内部 tokenize，不需要外部传参。

### D7: `extractBashTargets` 主流程改动集中在一处

**决策**：主流程改动集中在 3 处，避免分散修改：

1. L1505 `for (let i = 1; ...)` → `for (let i = 0; ...)`（D5）
2. L1511 `isForwarderDownstreamReadOnly(stage)` → `isForwarderStageSafe(i, stages)`（D4）
3. L1534 处 `COMMAND_TABLE[cmdName]` 的 extractor 分发逻辑不变，但 extractor 内部（`readExtract`、`writeExtract`）中所有涉及 READ_ONLY_COMMANDS 的判定改为 `isReadOnlyWithArgs`——但检查后发现 readExtract/writeExtract 内部**没有** `READ_ONLY_COMMANDS.has` 调用，所以这一条实际上不用改。

因此实际改动 2 处，加上 `isBoundedGlobSafe` 和 `isForBodyReadOnly` 内部各 1 处调用替换，共 4 处调用点改动。

### D8: 不保留 `isForwarderDownstreamReadOnly` 别名

**决策**：直接删除原函数，改为新函数。不保留 `isForwarderDownstreamReadOnly` 作为别名指向 `isForwarderStageSafe`。

**理由**：这是非导出内部函数，仅一个文件内可见，保留别名会让阅读者误以为两个函数有不同语义。直接改名，用 git blame 追溯即可。

### D9: 新增测试位置与命名

**决策**：新增测试加在 `test/bash-extract.test.ts` 末尾，命名格式 `test("BT-S{n}: <description>", () => {...})`，与既有 `BT{N}: <description>` 命名一致。

**理由**：沿用现有测试文件的命名和结构约定。BT-S 前缀（S = Stage A）区分本 change 的测试与既有测试。

### D10: 不修改 `spec.md` 的既有 scenario，只用 delta 追加

**决策**：本 change 的 spec delta 只对 4 个既有 requirement 做 **MODIFIED**（追加新 scenario），不重写整个 requirement。追加的 scenario 沿用既有格式。

**理由**：既有 spec.md 已经有 786 行、大量 scenario，重写整个 requirement 会引入不必要的 diff 噪音。delta 追加是新 scenario 的标准写法。

## Risks / Trade-offs

**[R1] `isForwarderStageSafe` 分析 upstream 时可能触发性能回归** → 中等风险。upstream 分析需要遍历 stages 数组（O(n)），且对每个 upstream stage 调用 `isReadOnlyWithArgs`。但 pipeline 长度通常 < 10，实际性能影响可忽略。**缓解**：加 characterization test 验证 100 条 pipeline 命令的耗时增量 < 5ms。

**[R2] `isReadOnlyWithArgs` 的 tokens 参数在部分调用点可能不存在** → 高风险。`isBoundedGlobSafe` L128 判定的是单个 token 的 read-only 属性，不是完整命令。改动时需要从单 token 判定改为需要 tokens 数组——需要重新组织 `isBoundedGlobSafe` 的循环结构。**缓解**：`isBoundedGlobSafe` 里已有 stage 字符串，可以 tokenize 拿到 tokens 数组后传入。这是本次改动里最复杂的一处，任务分解里单独拆出来做。

**[R3] `/dev/fd/[0-9]+` 判定可能误伤合法用例** → 低风险。`/dev/fd/3` 通常是脚本内部创建的 fd，用户不会主动重定向到它。若误伤，用户会看到 tier=two 弹窗但选择 allow 即可。**不缓解**——误伤合法用例比漏放危险用例好。

**[R4] `for-loop-iteration-glob-bounded` change 与本 change 并行 apply 时可能冲突** → 中风险。`isForBodyReadOnly` 的两处改动都在同一行（`READ_ONLY_COMMANDS.has(cmdName)` → `isReadOnlyWithArgs(cmdName, tokens.slice(1))`），若 `for-loop-iteration-glob-bounded` 也改了同一行会冲突。**缓解**：本 change 先 apply，`for-loop-iteration-glob-bounded` 后 apply。任务里显式要求 apply 顺序。

**[R5] `find` 从 READ_ONLY_COMMANDS 移出后，某些边界用例行为改变** → 低风险。移出后 `find . -name "*.ts"` 走 `isFindReadOnly` 判定，参数 `[". -name *.ts"]`（或类似）不含 write flag → read-only。行为等价。但 `find . | head` 这种无参数的 find 之前靠 READ_ONLY_COMMANDS 判定，现在也要走 `isFindReadOnly`——空参数数组遍历为 true，行为等价。**缓解**：BT-S10、BT-S11 覆盖边界回归。

**[R6] 首 stage 转发器扫描改为 `i=0` 后，某些既有测试可能失败** → 中风险。既有 forwarding_command 测试（BMG24-BMG32）都是非首 stage 场景，不改动。首 stage 之前完全不检转发器，现在检查了，如果既有测试里恰好有首 stage 是 xargs 但下游 read-only 的用例，会新触发豁免。**缓解**：跑完整测试套件，逐条检查失败用例的原因——如果是新豁免命中，是行为扩展（合法，因为 xargs grep 首 stage 确实是只读）；如果是新 unreliable 命中，说明首 stage xargs rm 之前静默现在弹窗（预期行为，测试需要更新）。

**[R7] `isForwarderStageSafe` 同时分析 upstream 和 downstream，upstream 里若有 forwarder 本身该如何处理** → 中等风险。例如 `xargs cat | xargs grep`——首 stage `xargs cat`（forwarder，downstream cat read-only），第二 stage `xargs grep`（forwarder，downstream grep read-only）。upstream 分析时，`xargs cat` 本身是 forwarder，判定为 unsafe 会误判。**决策**：upstream 分析时，若 upstream stage 是 forwarder 且其 downstream 是 read-only，视为 safe（豁免链）。具体实现：upstream stage 的判定也调用 `isForwarderStageSafe`（递归），但只判定该 stage 的 downstream 是 read-only，不递归检 upstream。**缓解**：BT-S14、BT-S15 覆盖 forwarder 链的正例和反例。

## Migration Plan

**分阶段部署**（避免一次改动过大）：

1. **Phase 1**：新增 `isReadOnlyWithArgs`、`isFindReadOnly`、`isDevSocketOrFd`、`isForwarderStageSafe` 4 个辅助函数（不接入调用点）。写单元测试验证每个函数独立行为。此时主流程 0 改动，全测试套件应该全绿。
2. **Phase 2**：`extractRedirects` 接入 `isDevSocketOrFd`。跑 BT-S1-BT-S5 测试，同时回归 BT-extra fd-redirect 组。
3. **Phase 3**：`isBoundedGlobSafe` 接入 `isReadOnlyWithArgs`（同时把 `find` 从 READ_ONLY_COMMANDS 移除）。跑 BT-S6-BT-S11、BT-S17-BT-S18，同时回归 BMG24-BMG32 bounded glob 组。
4. **Phase 4**：`isForBodyReadOnly` 接入 `isReadOnlyWithArgs`。跑 BT-S20，同时回归 BMG83-BMG86 for-loop 组。
5. **Phase 5**：`extractBashTargets` 主流程接入 `isForwarderStageSafe`（同时改首 stage 循环起点）。跑 BT-S12-BT-S16、BT-S19，同时回归 BMG70-BMG74 forwarding_command 组。
6. **Phase 6**：跑完整测试套件 `node --experimental-strip-types --test test/`，确保零回归。

**回滚策略**：每个 phase 独立提交。任何 phase 出问题，直接 revert 该 phase 的 commit——前序 phase 都是纯新增辅助函数或独立调用点改动，不会互相依赖到无法回滚。

**apply 顺序**：本 change 应在 `for-loop-iteration-glob-bounded` **之前** apply。本 change 建立 `isReadOnlyWithArgs` 接口后，`for-loop-iteration-glob-bounded` 复用它。若并行 apply，`isForBodyReadOnly` 的同一行会冲突。

## Open Questions

**Q1**: `less`、`more` 是否应从 READ_ONLY_COMMANDS 移出？

`less`、`more` 会写 `~/.lesshst`、`~/.more` 等标记文件，是"目标不可预测"的写操作。但用户不会主动 `less /etc/passwd` 期望权限门弹窗——这些命令在 AI 探索场景里几乎不出现。**决策延后**：本 change 保持它们留在集合中，Stage B 讨论"READ_ONLY_COMMANDS 的严格性"时再决定。若移出，影响面是 BMG52-BMG63 bounded glob 组的 `less`/`more` 用例，需要一并回归。

**Q2**: `find -newer`、`find -newermt` 等过滤条件是否应视为 write？

`-newer` 系列的过滤条件实际上是**读文件**操作（读取 `-newer FILE` 参数的 mtime 以比较），不是写。但 `-newerXY` 变体（如 `-neweracmt FILE`）也是读。**决策**：不视为 write，保持在 read-only 分支。若未来发现 `-newer` 系列的某个变体是写操作（不太可能），再补进 FIND_WRITE_FLAGS。

**Q3**: `isDevSocketOrFd` 是否应覆盖 `/dev/stdin`？

`/dev/stdin` 是标准输入的文件描述符别名。`echo x > /dev/stdin` 是奇怪的用法但技术上合法（把数据塞回 stdin）。这类用法在 AI 探索场景几乎不存在。**决策**：不视为 socket/fd，保持豁免。若未来发现误伤，再考虑加入黑名单。

**Q4**: `-exec` 判定为 write 后，用户如何恢复合法用法？

`find . -exec rm {} \;` 判 unreliable 走 tier=two 弹窗。用户如果确实想跑，可以选择"总是允许本命令"持久化到 trusted.json（`grant-memory` 的 bash command 通道）。这是现有机制，无需本 change 新增。**不需要新问题**。
