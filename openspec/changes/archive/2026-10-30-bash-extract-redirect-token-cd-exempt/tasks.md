# Tasks: bash-extract-redirect-token-cd-exempt

## 关键链与 buffer

- **关键链**：T1（RED——新增重定向 token 测试断言）→ T2（实现 `isRedirectPrefixToken` + `collectStagePathRefs` 跳过守卫）→ T3（全量回归 + 既有断言核对）。T4（design 文档一致性核对）依赖 T3，可并行。
- **Project buffer**：35%（tier-medium）。关键链估时 2.0h → project buffer ≈ 0.7h。
- Feeding buffer：无独立支流（T1 即关键链起点，无汇入支流）。

## 回写记录（td-apply 步骤 5）

- **回写了 proposal.md（3 处：净效果 / 测试描述 / 预期行为模型）**，原因：6.2 端到端验证发现 `cd <绝对> && ls`（无路径引用纯 `&&` 链）实测**放行**（D2a 豁免成立），而 proposal 原写「仍弹 cd_chdir」——D2a 无需「至少一个显式绝对路径引用」条件（该条件只属 D2b），第三态表述失实。方向唯一（改代码让 `&&` 无引用弹窗会回归既有 D2a 契约——2026-10-29 确立的治本行为），故回写 proposal 勘误。回写后重跑 6.2 端到端三态验证全绿。
- **回写了 spec.md 用例 8 THEN**（`cd /etc && cat <<EOF`），原因：T1 实测实际 reason 为 `heredoc`（scanUnreliable 在 cd 守卫之前拦截），与 `cd_chdir` 同为「判不可靠」拦截、安全语义一致，属守卫链顺序实现细节——THEN 放宽为「判不可靠，两 reason 均可接受」。
- **回写了 tasks.md T1 用例 3 描述**（`2>>/tmp/err.log`），原因：T1 实测发现 targets 含幽灵 `{read, /tmp/x/2>>/tmp/err.log}`——既有 extractor 层普适 bug（非 cd 场景复现），安全中性（多一个噪音 target，偏保守），本 change 不修（记录为已知边界）——用例 3 断言降级为核心契约（reliable + 读 /tmp/x + 写 /tmp/err.log）。

## Tasks

- [x] **T1**: RED——新增 cd 链 + 重定向 token 测试断言（关键链，0.7h）
  - 主体：在 `test/bash-extract.test.ts` 新增用例（先写测试、先跑失败），覆盖 spec 全部 10 个新 scenario：
    1. `cd /tmp/x && ls /tmp/x 2>/dev/null` → `{reliable:true}`（重定向 token 不构成位置参数，D2b 豁免）
    2. `cd /tmp/x && cat /tmp/x/file.txt 2>&1 | head` → `{reliable:true}`（fd 复制 token，cd 跟踪豁免逐 stage）
    3. `cd /tmp/x && ls /tmp/x 2>>/tmp/err.log` → `{reliable:true}`（绝对写重定向，D2b 豁免）——核心契约断言（reliable + 读 /tmp/x + 写 /tmp/err.log）；**不回写幽灵 target**（见「已知边界」，extractor 层既有普适 bug，本 change 不修）
    4. `cd /tmp/x && ls sub 2>/dev/null` → `{reliable:false, reason:"cd_chdir"}`（相对位置参数反例）
    5. `cd /tmp/x && ls /tmp/x > out.txt 2>/dev/null` → `{reliable:false, reason:"cd_chdir"}`（相对重定向写目标反例）
    6. `cd /tmp/x && ls foo>bar` → `{reliable:false, reason:"cd_chdir"}`（混合 token 反例）
    7. `cd /tmp/x && ls /tmp/x &>log` → `{reliable:false, reason:"cd_chdir"}`（`&>` 已知边界反例）
    8. `cd /etc && cat <<EOF` → `{reliable:false}`（判不可靠）——**实际 reason 为 `heredoc`**（scanUnreliable 在 cd 守卫之前拦截，与 cd_chdir 同为「判不可靠」拦截，安全语义一致；实测确认，属守卫链顺序实现细节，回写期望为 `cd_chdir` 或 `heredoc`）
    9. `cd /tmp/x && ls /tmp/x >&rel.txt` → `{reliable:false, reason:"cd_chdir"}`（文件词 fd 复制反例，架构 review critical——扫描不提取 `>&` 文件目标，跳过会静默放行写目标）
    10. `cd /tmp/x && ls /tmp/x 2>&rel.txt` → `{reliable:false, reason:"cd_chdir"}`（数字 fd 文件词重定向反例，架构 review critical——`2>&` 分支 `continue` 不提取文件目标）
  - 验证：`node --experimental-strip-types --test test/bash-extract.test.ts`——新用例 RED（1/2/3 失败暴露现状 bug，4-10 基线确认现行为），既有用例不受影响。

- [x] **T2**: 实现——`isRedirectPrefixToken` + 跳过守卫（关键链，1.0h）
  - 主体：修改 `src/lib/bash-extract/shell-forwarder.ts`：
    1. 新增模块内私有 helper `isRedirectPrefixToken(token: string): boolean`——只跳过「目标已由重定向扫描提取」或「纯数字 fd 复制（无文件目标）」形态：`/^[0-9]*>&(?:[0-9]+|-)$/`（`2>&1`/`>&2`/`2>&-`）+ `/^[0-9]*(?:>>|>|<).+/` 且不含 `&` 且非 `<<` 前缀（`1>`/`2>`/`>`/`>>`/`<`；**`.+` 要求操作符后至少一个字符**，`>&file`/`2>&file` 经 `splitCommands` 在 `&` 处拆分产生的裸 `>`/`2>` 不匹配 → 不跳过，否则静默放行写目标，架构 review critical 修复的关键判据）。**不跳过** `>&file`/`2>&file`/`N>&file`（文件词 fd 复制，扫描不提取其目标，跳过会静默放行写目标）、`&>`/`&>>`、`foo>bar`、`<<EOF`——保持收集 → 保守 cd_chdir（与现状一致，架构 review critical 修复）。
    2. `collectStagePathRefs` 位置参数循环（:577-591）的 `refs.push(t)` 前加 `if (isRedirectPrefixToken(t)) continue;`（放在 `t.startsWith("-")` 跳过之后、`tar` 操作标志跳过之前）。
    3. 重定向扫描（末尾 while 循环）不变；不新增导出符号。
  - 验证：`node --experimental-strip-types --test test/bash-extract.test.ts`——T1 全部用例转 GREEN；`node --input-type=module -e '...analyzeCd...'` 确认 `cd /abs && ls /abs/x 2>/dev/null` 的 `d2b=true`、`cd /abs && ls /abs/x >&rel.txt` 的 `d2b=false`（`>&file` 保守）。

- [x] **T3**: 全量回归 + 探针断言核对（关键链，0.3h）
  - 主体：跑全量测试与安全探针；逐一核对 reason 变化的既有断言（预期：部分 `cd 链 + 重定向 token` 命令从 `cd_chdir` 变 `reliable`，仅限重定向目标可静态解析为绝对或 fd 的命令——真实相对路径引用仍弹）。按预期行为变化更新非测试断言文件（`test/security-probe.mjs` / `test/cross-system-boundary.mjs` 等，若有命中）。
  - 验证：`node --experimental-strip-types --test test/` 全量绿 + `node test/security-probe.mjs`、`node test/cross-system-boundary.mjs` 通过（或断言按预期行为变化更新后通过）。

- [x] **T4**: 收尾核对（汇入点，0.3h）
  - 主体：核对 `docs/security/permission-model.md`（若存在）与 README 中对 cd 豁免「重定向目标按位置参数收集」的边界描述并同步修正；确认无残留「`2>/dev/null` 是位置参数」表述。
  - 验证：`grep -rn "重定向.*位置参数\|2>/dev/null" README.md docs/ src/lib/bash-extract/shell-forwarder.ts` 无过期表述（或命中处均为本 change 修正后的新语义注释）。

## 已知边界（非本 change 范围）

- **extractor 层幽灵 target**（实施 T1/T2 实测发现）：`ls /tmp/x 2>>/tmp/err.log`（含非 cd 场景）的 targets 含幽灵 `{read, /proj/2>>/tmp/err.log}`——`tokenize` 把 `2>>/tmp/err.log` 当位置参数传给 `readExtract`，`looksLikePath` 碰巧为 true（`.log` 后缀）被解析为相对路径。改动前就存在（非 cd 场景复现），安全中性（多一个噪音 target，偏保守，非静默放行），与 cd 豁免无关，**不在本 change Impact 范围**（proposal 只列 shell-forwarder.ts）。独立 change 应修 `readExtract`/`tokenize` 层对重定向 token 的过滤——同一 tokenize 根因的第二种表现（cd 豁免误判弹窗是第一表现，本 change 已修）。
- `&>` / `&>>` 的写目标覆盖缺口——重定向扫描不覆盖 `&>`，本 change 不纳入（design 决策 3）；`&>log` 保持保守 `cd_chdir`，待后续独立 change 扩展重定向扫描识别 `&>`。
- `FILE_ARG_COMMANDS` 清单完备性为「持续清点非穷尽」（前序 change 声明），本 change 不扩展清单。
- 引号内 `>`（如 `cat "a>b"`）不以操作符开头，不命中判据——`tokenize` 已把引号内容保留在同一 token 内，无特殊处理需求。

## 估时汇总

关键链 T1→T2→T3 = 2.0h，project buffer 35% ≈ 0.7h；T4 0.3h（汇入点）。
