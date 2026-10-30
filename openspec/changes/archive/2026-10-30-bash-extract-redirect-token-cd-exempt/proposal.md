# Proposal: bash-extract-redirect-token-cd-exempt

## Why

cd 守卫（`analyzeCd`/`scanCdChdir`，`src/lib/bash-extract/shell-forwarder.ts`）的豁免判定把**重定向 token 误当位置参数收集**：`tokenize` 不拆 `2>/dev/null`、`2>&1`、`>foo`、`>>foo` 等 `N>target` 形态，而 `collectStagePathRefs` 的位置参数循环（FILE_ARG_COMMANDS 下的 `ls`/`cat` 等命令）把这些完整 token 当作路径引用收集。结果是：`cd <绝对> && ls <绝对路径> 2>/dev/null` 这种**纯 `&&` 链 + 下游全显式绝对路径**的命令仍被判 `cd_chdir` 弹窗——违反既有 baseline 契约「全绝对下游豁免（D2b）：下游显式引用路径且全部绝对时 MUST NOT 判 cd_chdir」（spec 全绝对下游豁免节）。真实噪音案例即本仓库日常命令 `cd /proj && ls openspec/changes/... 2>/dev/null`（2026-10-30 实测）。

这是 587ae43（`2>&1` 的 `&` 分隔符误判修复）的**同类残留**：那次修复只处理了 `splitCommands` 把 `&` 当后台分隔符的拆错，没处理 `tokenize` 保留 `2>/dev/null` 完整 token 导致 `collectStagePathRefs` 把它当非绝对位置引用的收集错。实测：`2>/dev/null` 被 `tokenize` 切为单个 token `["ls","/abs/x","2>/dev/null"]`，`looksLikePath("2>/dev/null")` 判定非路径，但仍被 `collectStagePathRefs` 收集 → D2b 的 `hasCwdRelativePathRef` 视为相对引用、D2a 条件 9 视为不可提取裸词，两豁免都被杀。

## What Changes

- 修复 `collectStagePathRefs` 的位置参数收集循环：跳过**重定向形态 token**（`tokenize` 不拆分这些形态，如 `2>/dev/null`、`>foo`、`2>&1`、`<in`）。重定向目标**已由 `collectStagePathRefs` 末尾的重定向扫描单独处理**（`<`/`>`/`2>`/`2>>`/`>>`/`2>&` 逐字符扫描并提取 target 到 refs），位置参数循环的重复收集是多余且有害的——它把 `2>/dev/null` 整串当非绝对引用，而重定向扫描正确提取 `/dev/null` 后该 ref 是绝对路径、不构成豁免障碍。
- 判据（防过宽，逐项对齐重定向扫描的实际提取覆盖）：仅当 token **确为「目标已由扫描提取」或「纯数字 fd 复制（无文件目标）」** 形态时跳过——(a) `/^[0-9]*>&(?:[0-9]+|-)$/`（`2>&1`、`>&2`、`2>&-`，扫描明确跳过无文件目标）；(b) `/^[0-9]*(?:>>|>|<)/` 且不含 `&` 且非 `<<` 前缀（`1>`/`2>`/`3>`/`>`/`>>`/`<`，扫描提取其目标）。
- **不跳过（保持收集 → 保守 cd_chdir，与现状一致）**：
  - `>&file` / `2>&file` / `N>&file`（文件词 fd 复制，等价 `>file 2>&1`）——扫描对 `>&` 一律 `continue` 不提取其文件目标；跳过会丢失写目标 → cd 豁免静默放行相对写目标（**架构 review critical 修复**）。现状该形态保守 cd_chdir（安全），保持。
  - `&>` / `&>>`（如 `&>log`）——扫描不覆盖 `&>` 写目标，同因。现状保守 cd_chdir，保持。
  - `foo>bar`（位置参数 + 重定向混合 token）——`foo` 是真实位置参数，不以操作符开头，不命中。保持收集。
- 引号安全：`>` 在单/双引号内（`echo "a>b"`）不构成操作符——判据只看 token 开头，`tokenize` 已把引号内的 `>` 作为字面文本保留在同一 token 内且不以 `>` 开头（实测 `echo "a>b"` → `["echo","a>b"]`），无需额外 quote-aware 扫描。
- 不改变 `extractRedirects`/重定向扫描（它已正确处理 `2>` 并提取 `/dev/null`）；不改变 `analyzeCd` 的条件编号语义；不新增公共导出符号。
- **净效果**：`cd <绝对> && ls <绝对> 2>/dev/null`、`cd <绝对> && cat <绝对> 2>&1 | head` 等从 `cd_chdir` 弹窗变为静默放行（D2b 豁免成立）。**含相对路径引用的命令不受影响**（`cd /etc && ls sub 2>/dev/null` 仍弹——`sub` 是真实相对引用，非重定向 token）。**`>&file`/`&>log`/`foo>bar` 维持保守弹窗**（现状安全行为不变）。**无路径引用的 `cd <绝对> && ls` 维持既有 D2a 放行**（`&&` 链走 cd 跟踪豁免 D2a，`ls` 无路径引用不违反任何条件 4~11；`;` 分隔的 `cd <绝对>; ls` 才弹——D2a 条件 1 不满足且 D2b 条件 1 要求至少一个显式绝对路径引用，与既有契约一致）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bash-target-extraction`：「cd cwd 变更判不可靠」requirement 的 cd 跟踪豁免 / 全绝对下游豁免——补充"重定向 token 不是位置参数"的判定细节，新增对应 scenario（重定向 token 不构成豁免障碍 + 含相对路径引用仍弹的反例）。

## Impact

- 代码：`src/lib/bash-extract/shell-forwarder.ts`（`collectStagePathRefs` 位置参数循环加重定向操作符跳过判据 + 新 helper 函数）。
- 测试：`test/bash-extract.test.ts` 补 cd 链 + 重定向 token 场景断言（≥4：豁免成立 + 相对引用反例 + 引号内 `>` 不误跳 + `;` 分隔无路径引用仍弹——本 change 的 10 个用例覆盖豁免成立/相对引用反例/混合 token/`&>`/heredoc/文件词 fd 复制反例）。
- 不改变 `ExtractResult` 数据结构、不改 `decision.ts` 分派逻辑、不新增公共导出符号（新 helper 为模块内私有）。

## caller impact 分析

- 变更点清单：`collectStagePathRefs`（shell-forwarder.ts:570，模块内私有函数）内部判定逻辑收紧收集面——属第 4 类（内部实现细化），非公共符号签名变更；`analyzeCd`（:723）/`scanCdChdir`（:976）/`shouldTrackCdCwd`（:960）导出签名不变（返回值类型与枚举不变），仅**内部判定结果的返回值分布变化**（部分含重定向 token 的命令从 `"cd_chdir"` 变为 `undefined`），属第 1 类符号但**签名与语义枚举不变**，标**高危待确认**——见下方已知 caller。
- 已知 caller：
  - `src/lib/bash-extract/entry.ts:53` `scanCdChdir(rawCommand) === "cd_chdir"` → 预判**兼容**：豁免时返回 `undefined`，entry 继续走后续守卫（shell-forwarder / 转发器 / 管道 stage 提取），不跳过任何安全扫描——重定向 token 的写目标（如 `ls ... 2>/tmp/x`）仍被后续重定向扫描提取为 target 并走正常授权，无静默放行风险。
  - `src/lib/bash-extract/entry.ts:269` `shouldTrackCdCwd(rawCommand)` → 预判**兼容**：返回值分布变化（部分命令从 `false` 变 `true`，进入 cwd 模拟解析分支），该分支的路径解析与既有 D2a 豁免语义一致，无安全增量变化。
  - `src/lib/i18n.ts` reason 文案映射 → 预判**需适配**（文案描述的豁免边界变化，非代码适配，仅当需要时更新 cd_chdir 文案的边界描述）。

## 系统工程影响评估

- 影响哪些分系统：bash-extract（tier-medium）单一分系统——`collectStagePathRefs` 是 cd 豁免判定的内部 helper，全部调用点（:654/:668/:840/:942）都在 `analyzeCd` 的 D2a/D2b 判定内，不跨分系统。decision / policy-core / extension-orchestration 不受影响（ExtractResult 结构与 decision 分派逻辑均不变）。
- 整体性能预期变化：无性能变化——新增的 quote-aware 操作符扫描是 O(token 长度) 线性复杂度，豁免判定仍是纯函数静态分析，复杂度不变量级。
- 这是局部优化还是全局协调：局部修复（重定向 token 被误收集导致豁免失败），与全局协调一致——全局安全不变量「cwd 漂移下的相对路径引用必须可静态解析或判不可靠」保持完整。重定向 token 的**写目标**（如 `2>/tmp/x`）由重定向扫描提取为真实绝对路径，不会因豁免被静默放行。
- 如果是局部优化，对全局失调的风险：低。风险点是「重定向 token 被跳过导致真实相对路径引用漏收集」——由判据的引号安全（引号内 `>` 不跳过）与重定向扫描兜底排除：`cd /etc && ls sub 2>/dev/null` 的 `sub` 仍被收集（非重定向 token），`2>/dev/null` 的目标 `/dev/null` 被重定向扫描提取为绝对 ref（不构成豁免障碍）；真实相对写目标如 `cd /etc && ls > sub` 的 `sub` 由重定向扫描提取为相对 ref → D2b 的 `hasCwdRelativePathRef` 命中、D2a 条件 9 命中，豁免不成立，维持 `cd_chdir`。
- 预期行为模型：`cd <绝对路径> && <下游命令含重定向 token + 其余路径引用全绝对>` 输入 → 静默放行（无弹窗），targets 含重定向提取的绝对写目标（如有）；`cd <绝对路径> && <含真实相对路径引用（位置参数或重定向目标），无论是否伴重定向 token>` 输入 → 弹窗 `cd_chdir`；`cd <绝对路径> && ls`（无路径引用，纯 `&&` 链）→ **放行**（D2a 豁免成立，与既有契约一致——T3 探针 `L3_cd_etc_then_ls` 既有断言即 `cd /etc && ls` → OK）；`cd <绝对路径>; ls`（`;` 分隔）→ 弹 `cd_chdir`。验证数据：test/bash-extract.test.ts 新增 10 个场景断言全绿（豁免成立 + 相对引用反例 + 混合 token + `&>` + heredoc + 文件词 fd 复制反例）；`node --experimental-strip-types --test test/` 全量用例无回归（837 pass）。
- 与既有架构/风格的遵循关系：完全遵循既有风格——豁免条件逐条编号 + 理由注释的模式（D2a 条件 1~11）、`containsUnquotedGlob` 的 quote-aware 扫描模式（新 helper 复用同一模式）、纯函数无 IO。无架构偏离。

## Scenario→Test 覆盖账本

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| cd cwd 变更判不可靠 | cd 后绝对路径命令含重定向 token 豁免（本 change 新增） | test/bash-extract.test.ts | BMG-CD-redirect-token-abs-exempt | 🟢 |
| cd cwd 变更判不可靠 | cd 后绝对路径命令含 fd 复制重定向 token 豁免（本 change 新增） | test/bash-extract.test.ts | BMG-CD-redirect-token-fd-copy-exempt | 🟢 |
| cd cwd 变更判不可靠 | cd 后绝对路径命令含绝对写重定向豁免（本 change 新增） | test/bash-extract.test.ts | BMG-CD-redirect-token-abs-write-exempt | 🟢 |
| cd cwd 变更判不可靠 | cd 后相对路径引用伴重定向 token 仍判不可靠（本 change 新增） | test/bash-extract.test.ts | BMG-CD-redirect-token-rel-posarg-reject | 🟢 |
| cd cwd 变更判不可靠 | cd 后相对重定向写目标伴重定向 token 仍判不可靠（本 change 新增） | test/bash-extract.test.ts | BMG-CD-redirect-token-rel-redirect-reject | 🟢 |
| cd cwd 变更判不可靠 | cd 后混合位置参数与重定向 token 仍判不可靠（本 change 新增） | test/bash-extract.test.ts | BMG-CD-redirect-token-mixed-reject | 🟢 |
| cd cwd 变更判不可靠 | cd 后 &> 重定向仍判不可靠（已知边界，本 change 新增） | test/bash-extract.test.ts | BMG-CD-redirect-token-amp-reject | 🟢 |
| cd cwd 变更判不可靠 | cd 后无路径引用纯 heredoc 仍判不可靠（本 change 新增） | test/bash-extract.test.ts | BMG-CD-redirect-token-heredoc-reject | 🟢 |
| cd cwd 变更判不可靠 | cd 后文件词 fd 复制重定向仍判不可靠（本 change 新增，架构 review critical 修复） | test/bash-extract.test.ts | BMG-CD-redirect-token-fileword-amp-reject | 🟢 |
| cd cwd 变更判不可靠 | cd 后数字 fd 文件词重定向仍判不可靠（本 change 新增，架构 review critical 修复） | test/bash-extract.test.ts | BMG-CD-redirect-token-fd-fileword-reject | 🟢 |

- **机械校验**：测试文件 `test/bash-extract.test.ts` 实际存在（已核对文件系统）；scenario 名与 spec delta 现文逐字一致（已打开 spec 复制核对，10 个 scenario 名称全对齐）。全部 10 条状态 🟢（测试已实现并验证通过——`node --experimental-strip-types --test --test-name-pattern="BMG-CD-redirect-token" test/bash-extract.test.ts` → 10 tests pass / 0 fail，T1 落地实现、T2 实现后验证 GREEN）。

## 实际系统工程影响 vs 预期（td-archive 复盘，2026-10-30）

| proposal 侧（预期） | archive 侧（实际） | 结论 |
|---|---|---|
| 影响哪些分系统：bash-extract（tier-medium）单一分系统，`collectStagePathRefs` 是 cd 豁免判定内部 helper，全部调用点在 `analyzeCd` 内，不跨分系统；decision/policy-core/extension-orchestration 不受影响 | 实际影响 bash-extract 单一分系统：改动仅 `shell-forwarder.ts` 的私有 helper `isRedirectPrefixToken` + `collectStagePathRefs` 位置参数循环一处守卫；`entry.ts`/`decision.ts`/`extractors.ts` 零改动；`ExtractResult` 结构与 decision 分派逻辑未变（端到端 extract→decide 实测验证） | 一致 |
| 整体性能预期变化：无性能变化（O(token 长度) 线性、纯函数静态分析、复杂度不变量级） | 实际无性能变化：新 helper 是单次正则前缀匹配，豁免判定仍纯函数无 IO，无新增遍历 | 一致 |
| 这是局部优化还是全局协调：局部修复（重定向 token 被误收集导致豁免失败），与全局协调一致——全局安全不变量「cwd 漂移下的相对路径引用必须可静态解析或判不可靠」保持完整 | 实际是局部修复：全局安全不变量保持完整，实测端到端三态 + critical 反例（`>&rel.txt`/`2>&rel.txt` 均保守 `cd_chdir`）确认无静默放行 | 一致 |
| 如果是局部优化，对全局失调的风险：低（引号安全 + 重定向扫描兜底排除真实相对路径引用漏收集） | 实际全局影响低：判据对真实相对引用不跳过（`ls sub` 的 `sub` 仍收集 → 保守弹窗）；重定向扫描兜底提取相对写目标（`ls > out.txt` → D2b 排除）。**实施中额外发现**：裸 `>`/`2>`（`>&file` 经 `splitCommands` 在 `&` 处拆分产生）不匹配 `.+` rest 检查 → 不跳过 → 保守，此为判据安全性的关键加固（6.3 收尾 review subagent #1 实证文档-实现漂移，已回写三份文档） | 一致（含加固） |
| 预期行为模型：`cd <绝对> && <重定向 token + 其余全绝对>` → 放行；`cd <绝对> && <真实相对引用>` → cd_chdir；`cd <绝对> && ls`（纯 && 无引用）→ 放行（D2a）；`cd <绝对>; ls` → cd_chdir | 模型验证通过：端到端三态实测——`cd /tmp/x && ls /tmp/x 2>/dev/null` → OK[read:/tmp/x=>auto_allow]；`cd /tmp/x && ls sub 2>/dev/null` → UNRL[cd_chdir]；`cd /tmp/x && ls` → OK[]（D2a）；`cd /tmp/x; ls` → UNRL[cd_chdir] | 已验证（第三态原写「仍弹」失实，apply 6.2 实测发现后回写勘误——D2a 无需 D2b 的「至少一个显式绝对路径引用」条件，方向唯一故回写 proposal 而非改代码） |

**补充字段**：

- **预期之外的副作用**：
  1. **extractor 层幽灵 target**（T1 实测发现）：`ls /tmp/x 2>>/tmp/err.log` 的 targets 含幽灵 `{read, /proj/2>>/tmp/err.log}`——`tokenize` 把 `2>>...` 当位置参数传给 `readExtract`，`looksLikePath` 碰巧 true（`.log` 后缀）。改动前就存在（非 cd 场景复现），安全中性（多一噪音 target，偏保守，非静默放行），独立于 cd 豁免，**记录为已知边界**（tasks.md「已知边界」节），待独立 change 修 `readExtract`/`tokenize` 层。本 change 不修（超出 Impact 范围：proposal 只列 shell-forwarder.ts）。
  2. **heredoc reason 差异**（T1 实测）：`cd /etc && cat <<EOF` 实际 reason 为 `heredoc`（scanUnreliable 在 cd 守卫之前拦截），非 `cd_chdir`——两者同为「判不可靠」拦截、安全语义一致，属守卫链顺序实现细节。已回写 spec 用例 8 THEN / tasks.md 期望。
  3. **判据 `.+` 文档-实现漂移**（6.3 收尾 review subagent #1）：design/spec/tasks 三份判据未同步实现的正则（缺 `.+`），按文档实现会重现 `>&file` 静默放行洞——已回写三份文档补 `.+`（实现本身正确，实证裸 `>` 不匹配 `.+` → 保守）。
  4. **proposal 预期行为模型第三态失实**（6.2 端到端验证发现）：`cd <绝对> && ls` 实测放行（D2a），原写「仍弹」——已回写勘误（proposal 净效果/测试描述/预期行为模型三处）。
- **scenario→test 覆盖账本状态**：10/10 🟢 全绿，无 N/A 条目。账本测试名与实际实现一一对应（BMG-CD-redirect-token-* 10 个用例，T1 落地、T2 后验证 GREEN），全量 `npm test` 837 pass / 0 fail。
- **对照源 2（主 spec baseline）契约对照**：`openspec show --diff` 确认 spec delta 对 baseline **零删除、零弱化**——仅新增「重定向 token 的位置参数收集细化」细节与 10 个新 scenario，未触碰既有 D2a 条件 1~11 / D2b 条款 / 反例节的任何既有契约或不变量。
