# Design

## 决策清单

### D1：控制流检查在 pipeline 拆分前执行

**决策**：`scanControlFlow` 在 `extractBashTargets` 主流程最早位置执行（早于 pipeline 拆分、stage 提取、forwarder 守卫、SILENT_COMMANDS 分支）。

**理由**：
- 控制流命令整体语义不可静态分析，拆分 stage 无意义
- 与 `FORWARDING_COMMANDS` 守卫不同——转发器只影响 pipeline 后续 stage，控制流影响整条命令

### D2：Shell 转发器检查同样在 pipeline 拆分前

**决策**：`isShellForwarder` 在 `scanControlFlow` 之后、pipeline 拆分之前执行。

**理由**：
- `bash -c "cmd"` 整体是一个"字符串参数"，无法拆分
- 若先拆 pipeline 再检查，`bash -c "cmd" | head` 会把整条命令错误地按 stage 拆分成 `bash -c "cmd"` 和 `head`，但第一个 stage 本身仍是 shell 转发器

### D3：控制流检查只针对"独立 token"，不匹配 token 子串

**决策**：控制流关键字必须前后为空白或命令分隔符（`;`、`&`、`|`、`(`、`)`）时才匹配；`if.txt`、`whileLoop`、`forfoo` 等作为更长 token 的一部分**不触发**。

**理由**：文件名、变量名、路径中可能出现关键字子串（如 `/tmp/if.txt`、`$whileX`），误伤率会过高。

### D4：控制流检查是 quote-aware

**决策**：`scanControlFlow` 维护 `quote` 与 `escaped` 状态（与 `scanUnreliable` 完全一致的状态机），只在外层引号外检测关键字。

**理由**：`echo "while"` 中的 `while` 是字面字符，不触发。

### D5：Shell 转发器检测基于"第一个 token 是 shell 名 + 后续 token 含 `-c`"

**决策**：`isShellForwarder` 检查逻辑：
1. 取第一个 pipeline stage 的第一个 token（命令名）
2. 若命令名是 `bash`/`sh`/`dash`/`zsh` → 检查后续 token 中是否有 `-c`（独立 token）或以 `-` 开头且后续字符包含 `c` 的组合 token（如 `-xc`、`-lc`、`-xec` 等，bash 会将 `-xc` 解释为 `-x -c` 两个标志）
3. 若命令名是 `env` → 遍历其参数，跳过 `KEY=VALUE` 形式的环境变量赋值，找到第一个 shell 名后检查后续是否有 `-c`
4. 若命令名是 `command` → 同上（`command bash -c "..."` 也会执行）

**理由**：
- `bash -c "..."` 才是转发器；`bash /path/to/script.sh` 是"执行脚本文件"，脚本路径本身是可静态分析的 target（extractor 已能提取）
- `env` 是环境修饰符，需穿透

### D6：两个守卫独立触发，reason 各自标记

**决策**：控制流命中 → `reason: "control_flow"`；shell 转发器命中 → `reason: "shell_forwarder"`。两条不合并，因为它们是不同安全类别。

**理由**：审计时可区分"是因为控制流关键字"还是"是因为 shell 转发器"，便于后期调优。

### D7：与 FORWARDING_COMMANDS 的优先级

**决策**：控制流检查、shell 转发器检查都在 `FORWARDING_COMMANDS` 检查**之前**执行——即"整条命令层"的守卫（控制流、shell -c）先于"pipeline stage 层"的守卫（xargs/parallel）。

**理由**：如果一条命令既有控制流又有管道转发器（如 `for x in /etc; do ls $x | xargs rm; done`），控制流守卫先命中，直接判不可靠，无需继续拆 pipeline。

### D8：引号感知状态机的统一

**决策**：`scanControlFlow` 复用 `scanUnreliable` 的 quote/escaped 状态机逻辑（不提取公共函数，因为两者状态转移规则不同——`scanUnreliable` 关心 `$(`、反引号、`<<`、glob 等语法字符，`scanControlFlow` 关心关键字 token）。**保持两个函数独立**，但状态机初始化和更新逻辑保持一致。

**理由**：两个函数的关注点不同，强行提取公共逻辑会引入不必要的耦合。

### D9：`bash` 命令名不进 SILENT_COMMANDS

**决策**：`bash`/`sh`/`dash`/`zsh` 明确不加入 `SILENT_COMMANDS`（当前也未加入，本 change 保持）。

**理由**：与 FORWARDING_COMMANDS 一样，shell 转发器是"执行其他命令的元命令"，其实际访问的文件系统无法静态分析，不能视为 0-target 静默。

## 代码结构

```typescript
// 新增：控制流关键字表
const CONTROL_FLOW_KEYWORDS = new Set([
  "while", "for", "until", "if", "then", "else", "elif", "fi",
  "case", "in", "esac", "do", "done",
]);

// 新增：shell 转发器表
const SHELL_NAMES = new Set(["bash", "sh", "dash", "zsh"]);
const SHELL_WRAPPER_NAMES = new Set(["env", "command"]);

// 新增函数 1：控制流扫描（quote-aware）
function scanControlFlow(cmd: string): boolean {
  // 字符级扫描，维护 quote/escaped 状态
  // 遇到空白分隔的关键字 token，若在 CONTROL_FLOW_KEYWORDS 中 → return true
}

// 新增函数 2：shell 转发器检测（基于 token 层，非字符串扫描）
function isShellForwarder(cmd: string): boolean {
  // splitPipelines 拆第一个 stage
  // 取第一个 token 作为命令名
  // 若是 SHELL_NAMES 成员，检查后续 token 是否含 -c
  // 若是 SHELL_WRAPPER_NAMES 成员，跳过 env KEY=VAL 后继续检查
}

// 修改：extractBashTargets 主流程
// 1. scanUnreliable (既有)
// 2. findUnresolvedVariable (既有)
// 3. **scanControlFlow (新增)** → 命中则 return { reliable: false, reason: "control_flow" }
// 4. **isShellForwarder (新增)** → 命中则 return { reliable: false, reason: "shell_forwarder" }
// 5. expandSafeVariables (既有)
// 6. splitCommands + splitPipelines + FORWARDING_COMMANDS 检查 (既有)
// 7. SILENT_COMMANDS 分支 (既有)
```

## 与既有分系统的交互

| 分系统 | 交互 | 说明 |
|---|---|---|
| side-effects | 主改动 | `bash-extract.ts` 新增两个守卫函数 + 主流程整合 |
| policy-core | 不变 | `decide.ts` 消费 `{reliable: false}` 走 tier=two，行为不变 |
| extension-orchestration | 不变 | `extensions/index.ts:346` 用 `${extraction.reason}` 拼接，字符串透传 |
| audit | 不变 | audit schema 不变，仅 `reason` 字段值域扩展 |

## 兼容性

- **`reason` 字段值域扩展**：新增 `"control_flow"`、`"shell_forwarder"` 两个值。既有值（`"pipeline"`、`"command_substitution"`、`"glob_expansion"` 等）语义不变。
- **`extractBashTargets` 返回值形状不变**：仍是 `{ reliable: true, targets } | { reliable: false, rawCommand, reason }` 联合类型。
- **caller 兼容性**：`extensions/index.ts:346` 用 `${extraction.reason}` 拼接副文本，字符串透传，无需改。

## 已知边界

1. **控制流检测无法识别复合关键字的深层结构**：`if [ -f foo ]; then cat foo; fi` 中我们只识别 `if`、`then`、`fi` 独立 token，不验证结构完整性（如 `if` 是否有配对的 `fi`）。这是合理简化——只要出现任一关键字就判不可靠。
2. **`bash -lc "..."` 等复合 token 的 `-c` 检测**：我们检测 `-c` 是独立 token **或** 以 `-c` 开头的组合 token（如 `-xc`、`-lc`），但**不检测** `-foo-c`（`-c` 不是开头）这类异常用法。实际 bash 只识别 `-c` 为独立或开头的组合 token，所以行为对齐。
3. **`env` 嵌套深度**：`env env bash -c "..."` 我们支持——`env` 循环跳过自己的 `KEY=VAL` 参数后能找到下一个 `env` 或 shell 名。但 `env --env KEY=val bash -c "..."` 这种带 `--env` 的形式（GNU env）我们**不检测**（GNU env 特有，非常用）。

## 测试策略

- **12 个新增测试**（BMG1-BMG12），覆盖：9 个控制流关键字中的 5 个（while/for/until/case/if，其他关键字 do/done/then/else/fi/esac 通过 while/if 测试间接覆盖）、`bash -c` / `sh -c` / `zsh -c` 三种 shell、`env bash -c` 嵌套、`bash /tmp/x.sh` 不触发（反例）、引号内关键字不触发（反例）、关键字作为 token 子串不触发（反例）
- **重点回归**：BMG7 (`bash -c "rm -rf /"`) 是本 change 最关键的测试——上一 change 落地时该命令静默放行，本 change 落地后必须判不可靠

## 不做的事（明确排除）

- 不检测 `python -c`、`ruby -e`、`node -e` 等脚本语言的字符串参数——这些语言的执行语义不同（有各自的语言解析器），不属于 bash 转发器范畴
- 不检测 `eval` 命令（bash 内置命令）——虽然语义上类似，但很少见；如需要可在后续 change 加
- 不修改 `SILENT_COMMANDS`——`bash`/`sh` 明确不在其中（D9）
- 不修改 `FORWARDING_COMMANDS`——`xargs`/`parallel`/`pforeach` 保留原样
