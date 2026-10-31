## Context

`sed` ∈ `UNRELIABLE_COMMANDS`（silent.ts:46，脚本解释器类），`isAnyUnreliableCommand`（silent.ts:654）对任一 fragment 首命令精确匹配即返回 true，entry.ts 步骤 4a 判整条命令 `unreliable_command`。这使 sed 只读形态（`sed -n '1,5p' file`）也被弹窗。

现状判定链（entry.ts）：`scanFindWriteFlags`（0）→ `scanUnreliable`（1）→ `scanControlFlow`（2）→ `scanCdChdir`（2b）→ `isShellForwarder`（3）→ `isAnyUnreliableCommand`（4a）。**关键顺序事实**：`scanUnreliable`（步骤 1）在 `isAnyUnreliableCommand`（步骤 4a）之前——sed 含命令替换（`$(...)`）时，command_substitution 先被步骤 1 拦截，reason 为 `command_substitution`，不会走到 sed 判定。实证：`sed "s/$(date)/x/" file.txt` → `{reliable:false, reason:"command_substitution"}`。

实证（repro3/repro4）：
- `sed -n '335,345p' test/decision.test.ts` → `unreliable_command`（本 change 的目标形态）
- `sed "s/$(date)/x/" file.txt` → `command_substitution`（命令替换先拦截，reason 不同）
- `looksLikePath("a.b")` → `true`（sed 脚本含点号且字母结尾会被误判为路径）；`looksLikePath("335,345p")`/`looksLikePath("s/./x/")`/`looksLikePath("1,5p")` → `false`（常规 sed 脚本安全）

## Goals / Non-Goals

**Goals:**
- sed 只读窄形态（无 `-i`、脚本无 `w`/`W`/`e`、无写重定向、无命令替换）从 `unreliable_command` 改为按 read target 提取放行。
- 保留所有写/执行形态（`-i`、`w`/`W`、`e`/`E`）的 `unreliable_command` 弹窗。
- 不改变 awk/perl/python 等脚本解释器的行为（非目标）。

**Non-Goals:**
- 不修复 2026-10-20 archive"不可执行命令守卫"requirement 未并入主 spec 的独立缺口（超出本 change 范围，归档层问题，后续单独处理）。
- 不新增 UNRELIABLE_COMMANDS 集合成员/移出成员。
- 不改变 `ExtractResult` 结构、`extractBashTargets` 签名、或任何非 sed 命令的结果。

## Decisions

### D1：sed 豁免判据的实现位置——entry.ts 加专用守卫，而非改 silent.ts 的集合判定

**决策**：在 entry.ts 的 `isAnyUnreliableCommand`（4a）之前加 sed 专用判定——`isSedReadonlyForm(rawCommand)`，命中 sed 且满足只读判据时不返回 `unreliable_command`，落到正常提取流程。

**理由**：`isAnyUnreliableCommand` 是纯命令名集合判定（遍历 fragment 首命令），把 sed 参数形态分析塞进去会破坏其"命令名精确匹配"的单一职责。sed 豁免需要**参数形态分析**（读脚本、查 `-i`/`w`/`W`/`e`、查写重定向），是独立逻辑。且 `npx --no-install` 已有先例（entry.ts 4a 内的 `isSilentNpx` 窄化豁免）——sed 豁免与之同构，都是"UNRELIABLE 集合命令 + 窄形态豁免"，放 entry.ts 判定链一致。

**替代方案**：
- (A) 改 `isAnyUnreliableCommand` 在 sed 命中时内联分析——拒绝，职责混淆，函数变成"集合匹配 + 参数分析"两件事。
- (B) 把 sed 移出 UNRELIABLE_COMMANDS 加进 COMMAND_TABLE——拒绝，写形态 `-i` 会误放行（COMMAND_TABLE 的 extractor 无写形态感知，需额外判据，回到 D1 复杂度但改动面更大）。

### D2：sed 读提取的 extractor——专用 `sedExtract`，不复用 `readExtract`

**决策**：新增 `sedExtract`，跳过**全部** sed 脚本来源（所有 `-e`/`--expression` 值、`-f`/`--file` 值、首个非 flag 位置参数）与 `-n` flag，只把剩余文件位置参数作为 read target。仅当豁免成立时到达（写/执行形态仍被 4a 拦截，不会进 extractor）。

**理由**：实证 `looksLikePath("a.b")` = true——sed 脚本 `a.b`（如 `sed 'a.b' file`，含点号字母结尾）会被 `readExtract` 误收集为 read target。脚本参数不是文件路径，必须显式跳过。`sedExtract` 从 tokens[1] 开始：跳过 `-n`/`-e`/`-f` 及其值（含 `--expression=`/`--file=` 内联形式）、跳过首个非 flag 位置参数（脚本），剩余非 flag token 若 `looksLikePath` 则收集为 read。`-f script.txt` 的 `script.txt` 是脚本文件（内容不可确定，判不豁免），不作为位置参数收集。

**替代方案**：
- (A) 复用 `readExtract`——拒绝，脚本参数 `a.b` 误收集。
- (B) 用 `testExtract` 风格特判——拒绝，语义不同（test 是存在性检查，sed 是读文件）。
- (C) 只跳过首个非 flag 位置参数（原 D2）——**拒绝**，多 `-e` 脚本的后续 `-e` 值（如 `-e 'a.b'`）会被当位置参数误收集为 read target（CRITICAL-3 实现层二次缺陷）。

### D3：sed 脚本的 r/R/w/W/e/E 检测——引号感知 token 扫描 + 分隔符定界形式移除，不依赖完整 bash 解析

**决策**：对 sed 命令做三层判定（命令级 flag 判定 + 脚本内容判定），任一不满足即判不豁免：

1. **命令级 flag 判定**（在脚本内容判定前）：无任何以 `-i` 开头的短 flag 且无任何短 option cluster 含 `i` 字符且无 `--in-place`/`--in-place=...`；无任何以 `-f` 开头的短 flag 且无任何短 option cluster 含 `f` 字符且无 `--file`/`--file=...`。合法只读短 flag（`-n`/`-e`/`-s`/`-z`/`-E`/`-r`/`-l`/`-u`/`-b`）主体不含 `i`/`f`（`-f` 本身是脚本文件 flag，被排除；`-e` 含 `e` 但 `e` 是合法脚本 flag，不含 `i`/`f`，不误伤），不误伤 `-n`/`-e` 等。
2. **脚本内容判定**：对**每个** sed 脚本（所有 `-e`/`--expression` 值 + 首个非 flag 位置参数）先移除全部"分隔符定界形式"（替换式 `s/RE/REP/`、transliteration `y/src/dst/`、正则地址 `/RE/`——三者内未转义 `/` 为定界符；**内含转义 `\/` 时**：该 `\/` 是字面量 `/`，正确识别定界并移除——实测 `s/a\/b/c/` 判安全（纯只读替换）；**定界不完整**（如 `s/a\/b` 缺第二个未转义 `/`）时保守判不豁免），对剩余"命令位置"文本检测是否含**任一 sed 命令字符**：读文件命令 `r`/`R`、写文件命令 `w`/`W`、执行命令 `e`/`E`。任一命中即判不豁免（读任意文件 / 写 / 执行形态保留弹窗）。

**替换式 flag 位置的判定**：`s/RE/REP/e`、`s/RE/REP/w FILE`、`s/RE/REP/W FILE` 的 `e`/`w`/`W` 位于替换式前缀移除**之后**的剩余文本——`s/foo/bar/e` 移除 `s/foo/bar/` 后剩余 `e` 是命令 flag（执行），命中；`s/foo/bar/w /etc/passwd` 移除前缀后剩余 `w /etc/passwd`（写文件），命中。故替换式前缀移除**不含** flag 之后的文本，flag 落在命令位置检测范围。

**理由**：sed 脚本是 shell 单引号/双引号包裹的字符串 token，tokenize 已剥离外层引号。脚本内容里 `r FILE`（读任意文件）、`w FILE`（写文件）、`e cmd`（执行）是 sed 命令语法，需检测。但 `r`/`w`/`e` 出现在替换式（`s/w/x/`）、transliteration（`y/abc/rwx/`）、正则地址（`/error/`）或地址（`1,5p`）中不是命令——判定需区分 sed 命令位置 vs 文本位置。`r`/`R` 读任意路径文件，目标在脚本内不被位置参数提取，静默放行会读敏感文件（如 `sed '1r /etc/shadow' file`），MUST 判不豁免。命令级 flag 判定覆盖 `-i.bak`（备份后缀原地改写）、`-f scriptfile`（脚本文件内容不可确定）、多 `-e`（第二个脚本的 r/w/e）、短 option cluster（`-ni`/`-nf`）——这些形态的写/读任意文件/执行目标均无法被静态提取，MUST 判不豁免。

**边界**：采用保守近似——命令级 flag 判定排除 `-i`/`-f` 前缀变体与含 `i`/`f` 的 cluster；脚本内容判定先移除分隔符定界形式，剩余文本含 `r`/`R`/`w`/`W`/`e`/`E` 任一字符即判不豁免。近似精度以测试为准（BT-SED-3/4/5/8/9/10/11/14/15/16 覆盖）；`s/w/x/` 替换式内部 `w` 经移除后不在剩余文本，正确判安全；常见只读 sed（`sed -n '/error/p' file`、`sed 'y/abc/rwx/' file`）经分隔符定界形式移除后命令位置不含危险字符，正确判安全；合法只读短 flag `-n`/`-e` 不含 `i`/`f` 主体，不误伤。

**实证验证**（D3 修订近似的判定表，全部通过）：`335,345p`→安全、`s/w/x/`→安全、`1,5p`→安全、`s/a.b/c/`→安全、`1,5d`→安全、`s/foo/bar/e`→危险、`s/foo/bar/w /etc/passwd`→危险、`1r /etc/shadow`→危险、`1,5w /etc/passwd`→危险、`e ls`→危险、`s/a\/b/c/`（转义 `/` 替换，实测判安全——纯只读替换）→安全、`s/foo/bar/w`→危险、`-i.bak`（命令级）→危险、`-e '1,5p' -e 'r /etc/shadow'`（第二脚本）→危险、`-f script.txt`（命令级）→危险、`-ni`/`-nf`（cluster 含 i/f）→危险、`-n '/error/p'`（正则地址，读）→安全、`y/abc/rwx/`（transliteration，读）→安全。

**替代方案**：
- (A) 完整 sed 语法解析——拒绝，Non-Goal"不做完整 shell 解析"，sed 语法解析是过度设计。
- (B) 只查 `-i` 存在——拒绝，漏 `w`/`e`/`r` 形态（`sed '1,5w /etc/passwd'` 无 `-i` 也会写文件、`sed '1r /etc/shadow'` 无 `-i` 也会读文件）。
- (C) 只检测 `w`/`W`/`e`/`E`（原 D3）——**拒绝**，漏 `r`/`R` 读文件命令（CRITICAL-1：`sed '1r /etc/shadow' file` 静默放行读任意文件）。
- (D) 检测所有脚本但只查首个非 flag 位置参数——**拒绝**，漏多 `-e` 脚本（CRITICAL-3：`sed -e '1,5p' -e 'r /etc/shadow' file` 第二脚本 r 漏检）。

### D4：豁免判据与 entry.ts 顺序的协同——命令替换由 scanUnreliable 先行处理

**决策**：sed 豁免条件 5（无命令替换）由 `scanUnreliable`（步骤 1）天然保证——`$()`/反引号在该步骤已拦截为 `command_substitution`，不会到达 sed 豁免判定。豁免函数无需重复检测命令替换。

**理由**：实证 `sed "s/$(date)/x/"` → `command_substitution`（步骤 1 拦截）。豁免判定在 4a 前，命令替换已被更早步骤拦截。

**替代方案**：
- (A) 豁免函数重复检测 `$()`——拒绝，冗余（已被 scanUnreliable 保证），且引号感知规则重复实现易漂移。

## Risks / Trade-offs

- **[sed 脚本 `a.b` 被误判为路径]** → `sedExtract` 显式跳过脚本参数（D2 决策），专用 extractor 而非 readExtract。BT-SED-1 覆盖。
- **[sed 只读判据误放行写形态]** → 判据显式排除 `-i`/`w`/`W`/`e`/`E`（D3），测试 BT-SED-3/4/5 覆盖写形态反例。若判据不完备，`sed '1,5w /etc/passwd'` 会被误放行——这是本 change 的主要安全风险，测试必须覆盖。
- **[sed 脚本 w/W/e 检测的保守近似可能误伤合法只读 sed]** → 保守优先（宁可弹窗不误放行）；`s/w/x/` 替换式内的 `w` 非命令，若近似误判为命令则弹窗（噪音），不产生安全洞。可接受，与全局"宁可弹窗不静默"哲学一致。
- **[awk/perl/python 只读形式不豁免]** → 保持 `unreliable_command`，用户仍可能遇到 awk 只读弹窗噪音，但访问目标静态不可确定（脚本内嵌 system()/open()），维持保守。本 change 不扩范围。

## Migration Plan

无迁移——纯行为变更（sed 只读形态从弹窗改为放行），无持久化状态、无配置格式变更、无 API 破坏。回滚：撤销本次改动即恢复既有行为（two-way door）。

## Open Questions

无。
