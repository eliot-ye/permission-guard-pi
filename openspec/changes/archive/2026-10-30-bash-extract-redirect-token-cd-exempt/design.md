# Design: bash-extract-redirect-token-cd-exempt

## Context

参见 proposal.md「Why」。核心现状（实测确认）：

- `tokenize` 不拆分重定向形态的 token：`2>/dev/null`、`>foo`、`2>&1`、`&>log`、`foo>bar`、`<in`、`<<EOF` 都被保留为单个 token。
- `collectStagePathRefs`（shell-forwarder.ts:570）的位置参数循环把 FILE_ARG_COMMANDS 命令（`ls`/`cat`/`sort` 等）的上述 token 无条件 `refs.push(t)` 收集。
- 后果分两种：`2>/dev/null` 因 `looksLikePath=false`（无 `.` 后缀）被 D2a 条件 9 当「不可提取裸词」排除豁免 → `cd <绝对> && ls <绝对> 2>/dev/null` 误弹 `cd_chdir`；而 `2>>/abs/err.log` 因 `.log` 后缀碰巧 `looksLikePath=true` 不触发条件 9 → 豁免成立（正确但不稳定，写目标无扩展名时如 `2>>/tmp/x` 又弹）。
- 重定向扫描（`collectStagePathRefs` 末尾的逐字符循环）**已经正确覆盖** `>`/`>>`/`2>`/`2>>`/`2>&`/`<` 等形态并提取其 target（`2>&1` 明确跳过 fd 复制）。位置参数循环的重复收集是多余且有害的。
- **`&>`/`&>>` 例外**：重定向扫描不覆盖 `&>`（`extractRedirects` 操作符列表无 `&>`）；`&>log` 等价 `>log 2>&1`，`log` 是真实写目标。现状 `&>log` 因 `looksLikePath=false` 保守弹 `cd_chdir`（安全）。若笼统跳过 `&>log`，写目标 `log` 完全丢失 → cd 豁免成立 → **静默放行相对写目标**（安全洞）。

## Goals / Non-Goals

**Goals:**
- 修复「重定向 token 被误当位置参数收集」导致 `cd <绝对> && ls <绝对> 2>/dev/null` 这类纯 `&&` 链 + 全绝对下游命令误弹 `cd_chdir` 的 bug，使其回归既有契约（全绝对下游豁免 D2b）。
- 修复面精确到「重定向扫描已覆盖其目标的 token」——只跳过这类 token 的位置参数收集。
- 不改变 `2>>/abs/err.log` 已放行的行为（但使其不再依赖 `.log` 扩展名碰巧命中，改为稳定跳过）。

**Non-Goals:**
- 不修复 `&>`/`&>>` 的写目标覆盖缺口（重定向扫描不覆盖 `&>`，是独立已知边界，见 Risks）。
- 不改变 `extractRedirects`/重定向扫描逻辑。
- 不改变 D2a/D2b 的条件编号、判据语义或 reason code。
- 不新增公共导出符号（新 helper 为模块内私有）。

## Decisions

### 决策 1：跳过判据 = token 以重定向操作符开头（前缀匹配）

新私有 helper：

```ts
/**
 * 判断 token 是否以重定向形态开头（tokenize 不拆分这些形态，如
 * `2>/dev/null`、`>foo`、`2>&1`、`<in`）。这类 token 的重定向目标已由
 * collectStagePathRefs 末尾的重定向扫描单独提取（`N>`/`N>>`/`2>&N`/`>`/
 * `>>`/`<`），位置参数循环重复收集是多余且有害的——它把 `2>/dev/null`
 * 整串当非绝对引用，杀 cd 豁免（D2a 条件 9 / D2b）。
 *
 * 只跳过「目标已由扫描提取」或「确无文件目标」的形态（逐项对齐扫描）：
 *  - `^[0-9]*>&(?:[0-9]+|-)$`：纯数字 fd 复制/关闭（`2>&1`、`>&2`、`2>&3`、
 *    `2>&-`）——扫描明确跳过（无文件目标）。
 *  - `^[0-9]*(?:>>|>|<).+` 且不含 `&` 且非 `<<` 前缀：文件重定向（`1>`、`2>`、
 *    `3>`、`>`、`>>`、`1>>`、`<`）——扫描逐字符推进到 `>`/`<` 处识别并提取
 *    其后目标（`N>` 的 `N` 被当普通字符跳过，`>` 处仍识别）。**`.+` 要求操作符
 *    后至少一个字符**：`>&file`/`2>&file` 经 splitCommands 在 `&` 处拆分会
 *    产生裸 `>`/`2>`（如 "ls /tmp/x >"），裸操作符不匹配 `. +` → 不跳过（被
 *    收集为不可提取裸词 → 条件 9 排除，保守 cd_chdir）；若不带 `. +`，裸 `>`
 *    被跳过 → `>&rel.txt` 的写目标 `rel.txt` 完全丢失 → D2b 豁免成立 → 静默
 *    放行写相对目标（安全洞，架构 review critical 修复的关键判据）。
 *
 * 不跳过（保持收集 → 保守 cd_chdir，与现状一致）：
 *  - `>&file` / `2>&file` / `N>&file`（文件词 fd 复制，等价 `>file 2>&1`）：
 *    扫描对 `>&` 一律 `continue` 不提取其文件目标；跳过会丢失写目标 →
 *    cd 豁免静默放行相对写目标（安全洞，架构 review critical 修复）。
 *  - `&>` / `&>>`：扫描不覆盖 `&>` 写目标（`&>log` 等价 `>log 2>&1`），同因。
 *  - `<<EOF` / `<<<str`（heredoc / here-string）：splitCommands 可能拆分其
 *    内容为独立片段，保守维持现状弹窗（实测 `cd /abs && ls /abs/x <<EOF`
 *    实际 reason 为 `heredoc`——由 scanUnreliable 在 cd 守卫之前拦截，方向
 *    安全；判据不跳过 `<<` 前缀，整 token 被收集为不可提取裸词 → 条件 9
 *    排除，双保险维持保守）。
 *  - `foo>bar`（位置参数 + 重定向混合）：`foo` 是真实位置参数，不以操作符
 *    开头，不命中。
 *  - 引号内 `>`（`cat "a>b"`）：token 以 `a` 开头，不命中。
 */
function isRedirectPrefixToken(token: string): boolean {
  if (!token) return false;
  // 纯数字 fd 复制/关闭（扫描明确跳过，无文件目标）。
  if (/^[0-9]*>&(?:[0-9]+|-)$/.test(token)) return true;
  // 文件重定向（扫描提取其目标）；排除含 `&` 的形态与 `<<` 前缀。
  // `.+`：操作符后必须有至少一个字符（内嵌目标）——`>&file`/`2>&file` 经
  // splitCommands 在 `&` 处拆分会产生裸 `>`/`2>`，裸操作符不匹配 → 不跳过
  // （保守 cd_chdir，否则静默放行写目标，见上方 rationale）。
  if (/^[0-9]*(?:>>|>|<).+/.test(token) && !token.includes("&") && !/^[0-9]*<</.test(token)) {
    return true;
  }
  return false;
}
```

**为什么前缀匹配而非「token 含操作符」**：`foo>bar` 含 `>` 但 `foo` 是真实位置参数，不能跳过（否则丢 `foo` 导致 `cd /etc && ls foo>bar` 的 `foo` 引用漏收集 → 豁免静默放行读 `foo`）。前缀匹配把「整个 token 是重定向形态」（`2>/dev/null`、`>foo`、`2>&1`、`<in`）与「token 混合位置参数 + 重定向」（`foo>bar`）区分开。

**为什么跳过安全**：跳过的 token 其重定向目标已由重定向扫描提取为 ref：
- `2>/dev/null` → `/dev/null`（绝对，`isExplicitAbsolutePath=true`，不构成 D2b 障碍；`/dev/*` 在 extractRedirects 写分支被静默跳过，不加入 targets）→ 无碍。
- `>foo` → `foo`（相对，`hasCwdRelativePathRef` 命中 → D2b 排除；D2a 条件 9 `looksLikePath("foo")=false` 或条件 4 `containsCwdAnchor` 命中）→ 保守弹窗，正确。
- `2>&1` → fd 复制，重定向扫描明确跳过 → 无 ref → 无碍。
- `<in` → `in`（相对读，同上排除）→ 保守弹窗，正确。
- `<<EOF` → heredoc 形态：判据不跳过 `<<` 前缀（见决策 1 例外清单），`<<EOF` 整 token 被位置参数循环收集为不可提取裸词（`looksLikePath=false`）→ 条件 9 / D2b 排除 → 保守 `cd_chdir`。实测 `cd /abs && ls /abs/x <<EOF` 实际 reason 为 `heredoc`（由 scanUnreliable 在 cd 守卫之前拦截），方向安全——本 change 不改变该行为（不跳过），与现状一致。

### 决策 2：修改点（唯一）

`collectStagePathRefs` 位置参数循环（shell-forwarder.ts:577-591）的 `refs.push(t)` 前加一行守卫：

```ts
if (isRedirectPrefixToken(t)) continue;
```

放在 `t.startsWith("-")` 跳过之后、`tar` 操作标志跳过之前。重定向扫描（末尾 while 循环）不变。

### 决策 3：`&>`/`&>>` 保持现状（不纳入本 change）

理由：`&>` 不以标准操作符开头（`&` 非数字、非 `>`/`<`），不命中重定向 token 判据，保持收集。`collectStagePathRefs` 重定向扫描对 `&>log` 兜底：`&` 被当普通字符跳过、`>` 处识别并提取 `log` 为相对 ref → D2b `hasCwdRelativePathRef` / D2a 条件 9 拒绝 → 保守 `cd_chdir`（安全，即使位置参数循环不跳过也不会静默放行）。`extractRedirects`（真实 target 提取，parse.ts:444-533）**不识别** `&>` 操作符（操作符列表无 `&>`），故 `&>log` 的写目标 `log` 不进 targets——这是与 collectStagePathRefs 扫描（逐字符推进，能到 `>` 处）的区别，作为**已知边界**记录在 spec 反例节与 tasks.md，待后续独立 change 扩展 extractRedirects 识别 `&>`。现状 `&>log` 已保守弹窗（安全），无紧迫性。

## Risks / Trade-offs

- [**`&>`/`&>>` 写目标覆盖缺口**] → 保持现状（不跳过），`&>log` 仍保守 cd_chdir，安全；作为已知边界记录，待后续独立 change 扩展重定向扫描。本 change 不触碰，零风险。
- [**`foo>bar` 混合 token 漏收集**] → 前缀匹配判据天然不匹配（`foo` 开头），保留收集；`looksLikePath("foo>bar")=false` → D2a 条件 9 / D2b 排除 → 保守 cd_chdir，现状行为不变。
- [**heredoc `<<EOF` 行为不变**] → 判据不跳过 `<<` 前缀，`<<EOF` 整 token 被收集为不可提取裸词 → 条件 9 / D2b 排除 → 保守 `cd_chdir`；实测 `cd /abs && ls /abs/x <<EOF` 实际 reason 为 `heredoc`（scanUnreliable 在 cd 守卫之前拦截），方向安全。本 change 不改变该行为，无放宽。
- [**引号内 `>` 误判为重定向**] → token 不以操作符开头（`a>b` 以 `a` 开头），不匹配 → 不跳过；`looksLikePath` false → 保守 cd_chdir（现状不变）。`containsUnquotedGlob` 式 quote-aware 扫描**不需要**——因为判据只看 token 开头，而 `tokenize` 已把引号内的 `>` 作为字面文本保留在同一 token 内且不以 `>` 开头（实测 `echo "a>b"` → `["echo","a>b"]`）。
- [**行为放宽面**] → 仅限「重定向 token 的目标可静态解析为绝对或 fd」的命令。所有真实相对路径引用（位置参数 `sub`、重定向目标 `>foo`、混合 token `foo>bar`）仍保守弹窗。无静默放行相对路径引用的新增风险。

## Migration Plan

无迁移（纯函数静态分析修复，无数据/配置迁移）。部署即生效。
