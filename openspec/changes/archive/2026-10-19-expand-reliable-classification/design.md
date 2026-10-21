## 决策清单

### D1：引号定界 heredoc 的识别时机——在 `scanUnreliable` 内部，不抽独立前置扫描

**决策**：在 `scanUnreliable` 的字符级扫描循环里，遇到 `<<` 时就地判断后跟字符是否引号。是引号 → 读取定界符、跳过内容、继续扫描；不是引号 → 保持原 `return "heredoc"`。

**理由**：
- `scanUnreliable` 是所有不可靠检测的入口，heredoc 识别在这里做最自然
- 不抽独立前置扫描——独立扫描会重复遍历命令字符串，且需要与 `scanUnreliable` 的 quote 状态机同步，增加耦合
- 就地处理允许复用现有的 quote/escaped 状态机上下文

**替代方案（拒绝）**：在 `extractBashTargets` 主流程最前面加一步"预处理：把引号定界 heredoc 内容替换为空"。拒绝理由：字符串替换会改变 `rawCommand`（audit log 需要原始命令），且替换逻辑本身需要完整的 heredoc 解析器。

### D2：引号定界 heredoc 内容跳过的精确边界

**决策**：`scanUnreliable` 遇到 `<<'` 或 `<<"` 或 `<<-'` 或 `<<-"` 时：
1. 读取引号内的定界符 `DELIM`（直到闭合引号）
2. 找到 `<<` 所在行的结束（`\n` 或字符串末尾）
3. 从下一行开始，逐行检查——若某行去除前导 tab（dash 形式时）后等于 `DELIM`，则该行是结束定界符行
4. 跳过从 heredoc 开始到结束定界符行之间的所有字符，继续扫描结束定界符行之后的内容
5. 若找不到结束定界符 → 回退到 `return "heredoc"`（保守判不可靠）

**理由**：bash 的 heredoc 结束定界符必须是**单独一行**且等于 `DELIM`（dash 形式允许行首 tab）。精确匹配这个语义才能正确识别内容边界。

**边界 case**：
- `DELIM` 含空格（如 `<<'END OF DOC'`）→ 合法，bash 允许
- 多个 heredoc 在同一命令（如 `cat <<'A' <<'B'`）→ bash 只执行最后一个，但我们仍需正确跳过每个引号定界 heredoc 的内容（避免内容被误扫描）
- heredoc 内容包含 `<<` → 不影响（我们在内容跳过阶段不扫描字符）

### D3：转发器 read-only 下游豁免的判定位置——在 `extractBashTargets` 主流程的 FORWARDING 检查处

**决策**：在 `extractBashTargets` 主流程（`bash-extract.ts:1111-1116` 附近）的 FORWARDING_COMMANDS 检查处，原来命中即 `return { reliable: false, reason: "forwarding_command" }`，现在改为：
1. 命中转发器在非首 stage
2. 调用新增 `isForwarderDownstreamReadOnly(stage)` 分析下游命令
3. 满足豁免 → 不 return，继续走正常 stage 提取流程（下游命令的 read target 会被提取）
4. 不满足豁免 → 维持原 `return { reliable: false, reason: "forwarding_command" }`

**理由**：转发器检查在 `splitPipelines` 拆出的 stage 层，不在 `scanUnreliable` 层。豁免判定也应在同一层，避免跨层耦合。

### D4：`isForwarderDownstreamReadOnly` 的判定逻辑

**决策**：
1. 取转发器 stage 的 tokens（`tokenize(stage)`）
2. 跳过转发器自身（第一个 token）及其 flag 参数（以 `-` 开头的 token，如 `-I`、`-n`、`--replace`）
3. 第一个非 flag token 就是下游命令名
4. 检查下游命令名是否属于 `READ_ONLY_COMMANDS`（含 `git_<sub>` 形式）
5. 检查下游命令的剩余参数是否可静态判定——无 `$`（除 `$?`/`$!`/`$#`/`$$` 白名单）、无反引号、无 `$(...)` 、无未引号 glob
6. 全部满足 → 返回 true（豁免）；任一不满足 → 返回 false（维持不可靠）

**理由**：转发器的 flag 参数（如 `xargs -I {}`、`xargs -n 1`）不改变下游命令的 read-only 性质。跳过 flag 找到真正的下游命令是正确语义。

**边界 case**：
- `xargs` 无下游命令（如 `find /tmp | xargs`）→ 无下游 → 不满足豁免 → 维持 `forwarding_command`
- `xargs` 后跟 SILENT_COMMANDS（如 `find /tmp | xargs git log`）→ `git log` 在 READ_ONLY_COMMANDS（`git_log` 形式）→ 满足豁免

### D5：`for` 字面量迭代豁免的判定位置——在 `scanControlFlow` 内部

**决策**：在 `scanControlFlow` 的 token 扫描循环里，遇到 `for` 作为独立 token 时：
1. 不立即返回 true
2. 调用新增 `isLiteralForLoop(cmd, forKeywordPos)` 分析整个 `for ... done` 块
3. 满足豁免 → 跳过这个 `for ... done` 块，继续扫描 `done` 之后的内容
4. 不满足豁免 → 返回 true（维持 `control_flow`）

**理由**：`scanControlFlow` 在 pipeline 拆分前执行，是控制流判定的唯一入口。`for` 豁免必须在这里做，否则 `for` 永远被判 `control_flow`。

### D6：`isLiteralForLoop` 的判定逻辑

**决策**：
1. 从 `for` 关键字位置开始，解析 `for VAR in WORD1 WORD2 ... ; do BODY; done` 结构
2. **迭代集判定**：`WORD1 WORD2 ...` 必须全部是字面量词——不含 `$`（除白名单）、反引号、`$(...)`、未引号 glob。引号包裹的词（`"a b"`）允许。
3. **循环体判定**：`BODY`（`do` 到 `done` 之间的内容）：
   - 用 `splitCommands` 拆成多个体命令（`do cmd1; cmd2; done` → `["cmd1", "cmd2"]`）
   - 每个体命令的首命令名属于 `READ_ONLY_COMMANDS` 或 `SILENT_COMMANDS`
   - 循环变量 `$VAR` 视为已解析——不触发 `unresolved variable`（值域已被条件 2 静态确定）
   - 体内不含未引号 glob、`$(...)`、反引号、子 shell、process substitution、heredoc
   - 体内不含其他控制流关键字（`while`/`if`/`case` 等嵌套）
4. **结构完整性**：必须找到配对的 `done`；找不到 → 不满足豁免（回退到 `control_flow`）

**理由**：字面量迭代集 + read-only 体 = 实际访问集是"迭代词 × 体 read targets"的笛卡尔积，静态可确定。循环变量在体内的引用等价于"迭代集中的某个字面量词"，不构成 unresolved。

**边界 case**：
- `for f in a b c; do grep "$f"; done` → 迭代集 `[a,b,c]` 字面量，体 `grep "$f"` read-only + `$f` 是循环变量 → 豁免
- `for f in a b; do echo "$f"; grep "$f"; done` → 体拆成 `["echo \"$f\"", "grep \"$f\""]`，`echo` 0 target、`grep` read-only → 豁免
- `for f in a b; do cat > "$f"; done` → 体含重定向到循环变量（write）→ 不满足 read-only 体 → 不豁免
- `for f in a b; do cat $(cmd); done` → 体含 `$(...)` → 不豁免

### D7：`for` 豁免时循环变量的 target 提取

**决策**：豁免命中后，`scanControlFlow` 不返回 true，`extractBashTargets` 主流程继续走正常 `splitCommands` + `splitPipelines` + stage 提取。循环变量 `$f` 在体命令中被 `findUnresolvedVariable` 检测到时，MUST 被视为已解析——通过在 `findUnresolvedVariable` 中新增"循环变量白名单"机制（豁免命中时把循环变量名加入白名单）。

**理由**：`findUnresolvedVariable` 目前只白名单 `$?`/`$!`/`$#`/`$$`。循环变量在豁免命中时等价于"已解析的迭代集字面量"，需要同样的白名单处理。否则豁免命中后 `$f` 仍会触发 `unresolved variable`，导致最终判不可靠，豁免形同虚设。

**实现**：`scanControlFlow` 返回一个额外的"循环变量名集合"（而非简单的 boolean），`extractBashTargets` 主流程把它传给 `findUnresolvedVariable`。

### D8：三类豁免之间的交互

**决策**：三类豁免独立判定，无优先级冲突：
- 引号定界 heredoc 在 `scanUnreliable` 内处理——heredoc 内容被跳过后，`scanControlFlow` 和 `isBoundedGlobSafe` 都看不到 heredoc 内的字符
- forwarder 下游豁免在 `extractBashTargets` 主流程的 FORWARDING 检查处处理——晚于 `scanUnreliable` 和 `scanControlFlow`
- `for` 豁免在 `scanControlFlow` 内处理——早于 pipeline 拆分和 forwarder 检查

**理由**：三类豁免作用在不同层级、不同位置，天然正交。唯一的交互是"引号定界 heredoc 内容跳过"对其他扫描器的影响——heredoc 内容被跳过后，其他扫描器不会看到 heredoc 内的 `$` / glob / 控制流关键字，这是正确行为（引号定界 heredoc 内容是字面数据）。

### D9：`reason` 字段不新增值

**决策**：本 change 不新增任何 `reason` 字符串值。三类豁免命中时直接返回 `reliable: true`，不产生任何 audit 事件。

**理由**：与 bounded-glob 机制一致——豁免是"不再判不可靠"的例外，不产生 reason。

## 代码结构

```typescript
// -------- scanUnreliable 扩展：引号定界 heredoc 跳过 --------
function scanUnreliable(cmd: string, projectRoot?: string): string | undefined {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    // ... 现有 quote/escape 状态机 ...

    // 修改：遇到 << 时判断引号定界
    if (ch === "<" && next === "<") {
      // 检查 << 后是否引号定界（含 dash 形式）
      const heredocInfo = parseHeredocDelimiter(cmd, i);
      if (heredocInfo.quoted) {
        // 引号定界：跳过内容到结束定界符行
        i = heredocInfo.contentEnd; // 跳过 heredoc 内容
        continue;
      }
      // 未引号定界：保持原行为
      return "heredoc";
    }
    // ... 其余现有逻辑不变 ...
  }
}

// 新增辅助函数
function parseHeredocDelimiter(cmd: string, pos: number): {
  quoted: boolean;
  delimiter: string;
  contentEnd: number; // 结束定界符行后的位置
} {
  // 从 << 位置开始，跳过可选 -，检查是否引号
  // 读取引号内定界符
  // 找到结束定界符行（单独一行等于 DELIM，dash 形式允许行首 tab）
  // 返回 contentEnd（跳过到结束定界符行之后）
  // 找不到结束定界符 → quoted: false（回退到原 heredoc 不可靠行为）
}

// -------- scanControlFlow 扩展：for 字面量迭代豁免 --------
function scanControlFlow(cmd: string): {
  hit: boolean;
  loopVars?: string[]; // 豁免命中时的循环变量名集合
} {
  // ... 现有 token 扫描 ...
  // 遇到 for 作为独立 token 时：
  const forResult = isLiteralForLoop(cmd, forKeywordPos);
  if (forResult.exempt) {
    // 跳过 for...done 块，收集循环变量名
    i = forResult.doneEnd; // 跳到 done 之后
    loopVars.push(forResult.varName);
    continue;
  }
  // 不豁免 → return { hit: true }
}

// 新增辅助函数
function isLiteralForLoop(cmd: string, pos: number): {
  exempt: boolean;
  varName?: string;
  doneEnd?: number;
} {
  // 解析 for VAR in WORDS; do BODY; done
  // 判定迭代集字面量 + 体 read-only + 无嵌套控制流
}

// -------- isForwarderDownstreamReadOnly 新增 --------
function isForwarderDownstreamReadOnly(stage: string): boolean {
  const tokens = tokenize(stage);
  // 跳过转发器自身 + flag 参数
  // 找到下游命令名
  // 检查 READ_ONLY_COMMANDS + 参数可静态判定
}

// -------- extractBashTargets 主流程修改 --------
export function extractBashTargets(rawCommand, projectRoot, env) {
  // 1. scanUnreliable (扩展：引号定界 heredoc 跳过)
  // 2. scanControlFlow (扩展：for 豁免，返回 loopVars)
  // 3. isShellForwarder (不变)
  // 4. findUnresolvedVariable (扩展：接收 loopVars 白名单)
  // 5. expandSafeVariables (不变)
  // 6. splitCommands + splitPipelines
  //    → FORWARDING 检查：命中时调 isForwarderDownstreamReadOnly
  //      满足豁免 → 继续 stage 提取
  //      不满足 → return forwarding_command
  // 7. SILENT_COMMANDS 分支 (不变)
}
```

## 与既有分系统的交互

| 分系统 | 交互 | 说明 |
|---|---|---|
| side-effects | 主改动 | `bash-extract.ts` 内 `scanUnreliable`/`scanControlFlow`/`extractBashTargets` 扩展 + 3 个新增辅助函数 |
| policy-core | 不变 | `decide.ts` 消费 `{reliable: boolean}`，形状不变 |
| extension-orchestration | 不变 | `extensions/index.ts:346` 用 `${extraction.reason}` 拼接，本 change 不新增 reason 值 |
| audit | 不变 | audit schema 不变；本 change 让原本判不可靠的三类命令变为 reliable（不写入 audit） |

## 兼容性

- **`reason` 字段值域不变**：本 change 不新增任何 reason 值
- **`extractBashTargets` 返回值形状不变**
- **`scanControlFlow` 返回类型变化**：从 `boolean` 变为 `{ hit: boolean; loopVars?: string[] }`——非导出函数，仅 `extractBashTargets` 内部消费，无外部影响
- **caller 兼容性**：`extensions/index.ts` 无改动

## 已知边界

1. **嵌套 heredoc**：`cat <<'EOF' \n cat <<'INNER' \n ... \nINNER\nEOF`——外层引号定界 heredoc 内容里的 `<<'INNER'` 是字面数据，不应被识别为内层 heredoc。本 change 的内容跳过逻辑天然处理这个 case（跳过到外层 `EOF` 结束行，中间的所有字符都被跳过）。
2. **`for` 体含 heredoc**：豁免条件明确排除——体内 heredoc（引号定界或未引号均）判不满足豁免。理由：for 体内的 heredoc 边界与循环边界交互复杂（heredoc 内容跨多行，do/done 边界判定会被干扰）。
3. **forwarder 下游是 `git log` 等 git 子命令**：`git_log` 形式在 READ_ONLY_COMMANDS 中，满足豁免。但 `xargs git rm` 中 `git_rm` 不在 READ_ONLY_COMMANDS → 不豁免。
4. **`for` 的 `do` 关键字位置**：bash 允许 `for f in a b; do ...; done` 和 `for f in a b\ndo ...; done` 两种形式。`isLiteralForLoop` 必须容忍 `do` 在新行。
5. **`for` 迭代集为空**：`for f in; do ...; done`——迭代集为空，循环体不执行。豁免判定：迭代集为空是"全字面量"的平凡情况（空集 ⊂ 字面量集），但循环体仍需满足 read-only 条件。本 change 允许空迭代集豁免。

## 测试策略

- **20 条新增测试**（BMG64-BMG83），覆盖：
  - 引号定界 heredoc 正例（单引号/双引号/dash 形式/含 `$` 内容/前命令提取）5 条
  - 未引号定界 heredoc 反例 1 条
  - forwarder + read-only 下游正例（grep/wc）2 条
  - forwarder + write 下游反例（rm）1 条
  - forwarder 下游含 `$`/glob 反例 2 条
  - 字面量 `for` 正例（单命令体/多命令体/用户原始命令）3 条
  - `for` 反例（迭代集 glob/迭代集变量/体含 write）3 条
  - 其他控制流不受豁免（while/if/case）3 条
- **回归面**：既有 260+ 测试必须零回归。重点回归组：
  - BT-extra heredoc 组（`cat <<EOF\nhello\nEOF` 仍判不可靠）
  - BMG1-BMG14 控制流 + shell 转发器组
  - BTP-audit-97/102（真实 audit 回归）
  - 新增的 bounded-glob-compound-separators change 的 BMG52-BMG63

## 不做的事（明确排除）

- **不修改** `splitPipelines`、`splitCommands`（上一个 change 已处理分隔符扩展）
- **不修改** `isBoundedGlobSafe`（上一个 change 已处理 fragment 级别）
- **不引入** 新的 reason 值
- **不处理** `while`/`until`/`if`/`case` 的豁免——这些控制流的条件/分支是运行时决定的，没有静态判定条件
- **不处理** `for` 体内的 heredoc——边界交互复杂，明确排除
- **不处理** 转发器下游是 SILENT_COMMANDS 但非 READ_ONLY 的情况（如 `xargs npm test`）——SILENT_COMMANDS 已是 0 target，不需要豁免
