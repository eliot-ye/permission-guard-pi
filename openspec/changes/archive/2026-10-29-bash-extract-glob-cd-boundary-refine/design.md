## Context

两个改动都在 `bash-extract` 子系统（tier-medium）内部，属于对既有保守判定的窄收窄。动机与范围见 `proposal.md`，此处只写设计级边界。

- **边界①（空 prefix 只读 glob）**：`isBoundedGlobSafe`（`readonly.ts:133`）当前在 `isBoundedPrefix`（`readonly.ts:247-254`）对空 prefix 直接 `return false`（`readonly.ts:250`「Empty prefix means the glob is at token start. We conservatively reject」）。既有 for-loop 迭代集豁免（`isForLoopIterationGlobExempt`，`scan.ts:344`）已处理「for 循环内空 prefix」；缺口是**非 for-loop 的只读命令空 prefix**（`ls *.md`）。
- **边界②（cd 跟踪豁免 + 全绝对下游豁免，合并版）**：`scanCdChdir`（`shell-forwarder.ts:370-382`）只检查「任一复合命令片段首 token 为 `cd` 即返回 `cd_chdir`」，不检查下游路径，也不跟踪 cd 之后的 cwd 落点。i18n 文案（`i18n.ts:173`）宣称「使用绝对路径可避免」，但行为上全绝对下游仍触发——文案与行为矛盾。更根本的是：`cd /tmp/x && echo hi > rel.txt` 的真实落点是 `/tmp/x/rel.txt`，但解析器按 `<projectRoot>` 解析成 `<proj>/rel.txt`——**解析器根本没算出 cd 后的真实路径**（只堵不治）。

## Goals / Non-Goals

**Goals:**
- 边界①：`ls *.md` / `ls *` 类「只读命令 + 项目内空 prefix glob」不再触发 `glob_expansion`，静默放行（走正常 read target 提取）。
- 边界②：`cd /tmp/x && grep ... <绝对路径>` 类「cd 后下游全绝对」不再触发 `cd_chdir`；`cd /tmp/x && grep ... file.txt` 类「纯 `&&` 链 + 绝对 cd 目标 + 相对路径下游」**cd 跟踪豁免**——解析器真实算出 cd 后的落点（`/tmp/x/file.txt`），不再判 `cd_chdir`；同时修正 `i18n.ts` 文案与行为一致。

**Non-Goals:**
- **不改 `isBoundedPrefix` 对非空 prefix 的判定**（非空 prefix 已有 bounded 逻辑，不触碰）。
- **不改变写命令空 prefix glob**（`rm *.log`、`tar xzf *.tgz`）——仍触发 `glob_expansion`，写操作目标集合不可静态枚举。
- **不改变 cd 后相对路径下游在 `;`/`||` 分隔下的判定**（`cd /tmp/x; cat src/main.ts`）——仍触发 `cd_chdir`，`;`/`||` 下 cwd 不可静态确定。
- **不改变相对 cd 目标、`cd ~`、`cd $VAR`、`cd -` 的判定**——仍触发 `cd_chdir`，均依赖运行时环境不可静态确定。
- **不改变 cd 后 `.`/`..` cwd 锚点、未加引号 glob 的判定**——仍触发 `cd_chdir`（cwd 锚点提取盲区 / glob 展开依赖漂移 cwd）。
- **不改 `decision.ts` tier 分派语义**、不改 `permission.json`/`trusted.json` 契约。
- **不做完整 shell 解析**（Non-Goal 延续：`README`/spec 声明的「不做完整 shell 解析」边界不变）。

## Decisions

### D1：边界① 豁免放在 `isBoundedGlobSafe` 内，复用既有只读判定

**决策**：不改 `isBoundedPrefix`，而是在 `isBoundedGlobSafe` 的 glob 分支里，当检测到**空前缀**时，额外判断「命令只读（条件 3）且 glob 不以绝对路径标志开头」，满足则视为 bounded 放行。

**理由**：
- `isBoundedPrefix` 被多处调用（不只 glob 判定），改它会波及非 glob 场景，风险面大。
- `isBoundedGlobSafe` 内部已有条件 3 的只读判定（`isReadOnlyWithArgs`，`readonly.ts:174`）——空前缀豁免复用同一判定，逻辑内聚，且「只读」是豁免的必要条件（写命令空 prefix glob 绝不放行）。
- 与既有 `isForLoopIterationGlobExempt` 同构（都是「窄条件豁免」），不引入新架构模式。

**备选方案**：
- 改 `isBoundedPrefix` 直接接受空 prefix——**否决**：`isBoundedPrefix` 无只读上下文，无法区分 `ls *.md`（可放行）与 `rm *.log`（不可放行），会误放行写命令。
- 在 `scan.ts:336` 调用点前特判——**否决**：调用点不持有只读判定所需的 stage 上下文，需重复 `isReadOnlyWithArgs` 逻辑。

### D2：边界② 豁免放在 `scanCdChdir` 内——cd 跟踪豁免 + 全绝对下游豁免两条路径

**决策**：`scanCdChdir` 在返回 `cd_chdir` 前，新增**两条**豁免判定（任一成立则返回 `undefined`，不判 cd_chdir）：

- **D2a（cd 跟踪豁免，治本）**：复合命令满足以下**全部**条件时豁免，改为**顺序模拟 cwd**（见 D2c）——
  1. **纯 `&&` 链**：`splitCommands` 拆出的所有片段之间都是 `&&` 分隔（无 `;`/`||`/`&`/`\n`）；分隔符判定 MUST 复用 `splitCommands` 的 quote-aware 分隔扫描，不得裸扫 `;`/`||`/`&`/`\n`（引号内的 `;` 不是分隔符，如 `cd /tmp/x && echo "a;b"` 仍应判纯 `&&` 链）。理由：`&&` 短路语义保证「下游片段执行 ⇒ 前面所有 cd 都成功 ⇒ cwd = 最后一个成功 cd 的目标」——这是 cwd 跟踪确定性的基础（实验已验证：`&&` 下 cd 失败 → 下游不执行；`;` 下 cd 失败 → 下游仍执行，cwd 不更新，不可静态确定）。
  2. **所有 cd 目标都是显式绝对路径**：每个 `cd <target>` 的 `<target>` 以 `/` 开头或满足 Windows 盘符 `C:\`，且不含 `$VAR`、`~`、未加引号 glob 元字符、相对前缀（`./`/`../`）；**绝对性判定作用于 `tokenize` 去引号后的 token 形式**（如 `cd "/tmp/x"` 去引号后为 `/tmp/x`，判绝对）。理由：相对 cd 目标依赖当前 cwd 与 `CDPATH`（实验已验证 CDPATH 完全改变 `cd sub` 的目标）；`~`/`$VAR`/`cd -` 均依赖运行时环境——均不可静态确定。
  3. **无管道**：每个片段的 `splitPipelines` 结果恰好 1 stage（cd 与管道交互不可静态确定）。
  4. **无 cwd 锚点路径引用**：cd 片段之后的任何下游片段 MUST NOT 含 cwd 锚点路径引用（`.`、`..`、`./`、`../`、或以 `.`/`..` 结尾/含 `.`/`..` 片段的相对路径，含重定向目标与位置参数）。理由：`.`/`..` 是 cwd 的锚点，`looksLikePath`/`extractRedirects` 不把它们提取为 target（实测 `rm -rf .` 在非 cd 场景提取 0 target），若在 cd 跟踪下放行会**静默放行 cwd 锚点操作**（`cd /etc && rm -rf .` 真实删 `/etc` 内容，但跟踪下提取 0 target 绕过拦截）——这是 cd 跟踪豁免的**安全洞**，必须显式排除。
  5. **无未加引号 glob**：cd 片段之后的任何下游片段 MUST NOT 含未加引号的 glob 元字符（`*`、`?`、`[`，含位置参数与重定向目标）。理由：glob 展开依赖执行时的 cwd，cd 跟踪下 cwd 已漂移；且「有界 glob 免不可靠标记」的空 prefix 放宽（边界①情形 B）假设 `cwd == projectRoot`，该假设在 cd 链下**失效**——`cd /tmp/x && ls *.md` 的真实展开在 `/tmp/x`，不在 projectRoot，若放行会误解析到 projectRoot。故 cd 跟踪豁免统一排除 glob。
  6. **无网络套接字 / 数字 fd 重定向目标**：cd 片段之后的任何下游片段 MUST NOT 含网络套接字 / 数字 fd 重定向目标（`/dev/tcp/`、`/dev/udp/`、`/dev/fd/[0-9]+` 前缀）。理由：它们是网络外传 / 任意 fd 访问目标，不是「cd 造成的 cwd 漂移影响文件系统路径解析」的场景，cd 跟踪豁免的语义（cwd 模拟解析真实落点）对其不适用；含此类目标的片段使 D2a 豁免不适用，维持 `cd_chdir`（网络外传不因 cd 豁免被放行）。
  7. **无不可提取的非绝对路径参数**：cd 片段之后的任何下游片段，其**写/删命令**（COMMAND_TABLE 中提取为 write/delete action 的命令，如 `rm`、`mkdir`、`rmdir`、`mv`、`cp`）的每个**位置参数**要么是显式绝对路径，要么是 `looksLikePath` 能提取的路径形式；任何非绝对且 `looksLikePath` 判定为 false 的位置参数（如 `sub/`、`sub`、`file`——`looksLikePath` 对不含 `/` 前缀/`.`/`..`/扩展名的裸词返回 false，实测 `rm -rf sub/` 提取 0 target）使 D2a 豁免不适用。理由：此类非绝对参数的真实落点依赖漂移后 cwd（`cd /tmp/x && rm -rf sub/` 真实删 `/tmp/x/sub`），但 `looksLikePath` 不把它提取为 target（实测提取 0 target）——若在 cd 跟踪下放行会**静默放行外区删除**（0 target → decision 层不弹窗），这是 cd 跟踪豁免的**安全洞**，必须显式排除。
  8. **无 `$PWD` / `$OLDPWD`**：cd 片段之后的任何下游片段 MUST NOT 含 `$PWD` / `$OLDPWD`。理由：`$PWD` 是 SAFE_VAR（`expandSafeVariables` 用真实进程 env["PWD"] 展开），不随模拟 cwd 漂移——`cd /tmp/x && cat $PWD/foo` 的真实落点是 `/tmp/x/foo`，但 `$PWD` 展开为真实 cwd（如 projectRoot），解析器按 env["PWD"] 解析错位；且 D2a 的「相对路径按模拟 cwd 解析」假设被 `$PWD` 破坏。故排除，维持 `cd_chdir`。

- **D2b（全绝对下游豁免，兜底）**：按 `splitCommands` 拆出所有片段，定位**任一 `cd` 片段之后**的所有下游片段，对每个下游片段检查其**全部路径引用**（`looksLikePath` 判定的位置参数 + `extractRedirects` 语义的重定向目标）是否**显式绝对路径**（以 `/` 开头或 Windows 盘符）。豁免成立需同时满足：(1) 至少一个下游片段含显式绝对路径引用；(2) 所有下游片段的全部路径引用均为显式绝对路径。任一 cwd-relative 引用（相对参数、相对重定向目标、空 prefix glob、`$VAR`）或全部下游无显式路径引用 → 仍返回 `cd_chdir`。网络套接字/数字 fd 重定向目标（`/dev/tcp/`、`/dev/udp/`、`/dev/fd/[0-9]+` 前缀）即使以 `/` 开头也不构成豁免证据——它们是网络外传/任意 fd 访问目标，豁免语义（绝对路径解析不依赖 cwd）对其不适用。

**理由**：
- **豁免判定的对象是「cd 造成的 cwd 漂移是否影响路径解析」**——D2a 通过真实算出落点消除影响（相对路径按跟踪 cwd 解析），D2b 通过「路径与 cwd 无关」（全绝对）规避影响。两条路径互补：D2a 处理相对路径下游（纯 `&&` 链 + 绝对 cd 目标），D2b 处理任何分隔符下的显式全绝对下游（绝对路径本就 cwd 无关）。
- **必须同时检查重定向目标**：`extractRedirects`（`parse.ts:425`）把重定向目标提取为 write target（如 `echo hi > rel.txt` 的 `rel.txt`）。若豁免只看位置参数，`echo hi > rel.txt` 会因「无位置参数」被误豁免，`rel.txt` 被解析到 projectRoot 而非真实 cwd——这正是 `cd_chdir` 规则本应防住的误解析类别（`cd /etc && rm -rf .` 被误解析为 `<root>/.` 同源）。故豁免判据必须覆盖位置参数 + 重定向目标两类路径引用。
- **D2a 要求「纯 `&&` 链」而非任何分隔符**：`;`/`||` 下 cwd 不可静态确定（实验 6：`;` 下 cd 失败 → 下游仍执行，cwd 不更新；`||` 下失败分支执行），只有 `&&` 链的短路语义保证「下游执行 ⇒ cd 成功 ⇒ cwd 确定」。这是 D2a 与 D2b 的关键差异——D2b 因「绝对路径 cwd 无关」不受分隔符影响，D2a 因「相对路径依赖 cwd」必须限 `&&` 链。
- **D2a 要求「绝对 cd 目标」**：相对 cd 目标受 `CDPATH`/当前 cwd 影响（实验 1），`~`/`$VAR`/`cd -` 依赖运行时环境——均不可静态确定，只能维持 `cd_chdir` 保守。
- 放在 `scanCdChdir` 内而非外层，保证豁免与 cd 判定内聚（同一个函数里「先判 cd，再判是否豁免」）。
- 路径引用的绝对性判定复用既有 `looksLikePath`（`parse.ts:410`）与 `extractRedirects`（`parse.ts:425`）的语义，不引入新解析逻辑。

**备选方案**：
- 不改行为、只改 i18n 文案（删掉「建议使用绝对路径」）——**否决**：用户实际被噪音弹窗打断（真实案例 `cd /tmp/pi-ui-ext-inspect/package && grep ... extensions/index.ts`），文案修正不解决行为问题。但文案修正**仍会做**（见 D3），两者不冲突。
- 只在 `cd` 片段本身判绝对路径（`cd /tmp/x` 绝对 → 豁免）——**否决**：`cd /tmp/x` 后跟相对路径 `cat src/main.ts` 仍会解析错（真实 cwd 是 `/tmp/x`，解析器按 projectRoot），豁免必须看**下游**而非 cd 目标。
- 豁免只看位置参数（不查重定向）——**否决**：`cd /tmp/x && echo hi > rel.txt` 被误豁免，cwd-relative 写目标错位（见理由第 2 条），构成安全洞。已否决并被架构 review 判为 critical。
- D2a 只做「cd 目标绝对」而不做「纯 `&&` 链」——**否决**：`cd /tmp/x; echo hi > rel.txt` 的 `;` 下 cwd 不可静态确定（实验 6），跟踪会算出错误落点，必须限 `&&` 链。
- D2a 不排除 `.`/`..` cwd 锚点——**否决**：`cd /etc && rm -rf .` 在跟踪下提取 0 target（`.` 不被 `looksLikePath` 识别），静默放行删 `/etc` 内容，构成安全洞（实测确认）。
- D2a 不排除未加引号 glob——**否决**：`cd /tmp/x && ls *.md` 的真实展开在 `/tmp/x`，跟踪下若按 projectRoot 解析会误判；且边界①空 prefix 放宽的 `cwd==projectRoot` 假设在 cd 链下失效，必须排除。

### D2c：cwd 模拟的落地——`scanCdChdir` 拆分为「判定 + 跟踪」，entry.ts 步骤 5 注入解析基准

**决策**：
1. **`scanCdChdir` 保持判定职责**（决定是否 fire `cd_chdir`），内部用共享的 `analyzeCd(cmd)` 辅助——`analyzeCd` 返回 `{ hasCd: boolean; d2a: boolean; d2b: boolean }`，`scanCdChdir` 据此返回 `undefined`（D2a 或 D2b 成立，或无 cd）或 `"cd_chdir"`（有 cd 且两豁免均不成立）。
2. **新增 `shouldTrackCdCwd(cmd: string): boolean`**（`shell-forwarder.ts` 导出）——返回 `analyzeCd(cmd).d2a`（仅 D2a 成立时需 cwd 模拟；D2b 下游全绝对，路径与 cwd 无关，无需模拟）。
3. **entry.ts 步骤 5 注入解析基准**：逐片段循环维护 `let resolveBase = projectRoot`；若 `shouldTrackCdCwd(rawCommand)` 为 true，则每遇到一个首 token 为 `cd` 的片段（目标为绝对路径），将 `resolveBase` 更新为该 cd 目标；随后该片段及其后的 `extractRedirects(trimmed, targets, resolveBase)` 与 `extractor(tokens, targets, resolveBase)` 均用 `resolveBase` 而非固定 `projectRoot` 作解析基准。cd 片段自身不提取 target（cd 是内建，无文件访问），其解析基准不影响结果。

**理由**：
- **cwd 模拟只需在 D2a 下生效**：D2a 处理相对路径下游（落点依赖 cwd），必须用跟踪 cwd 解析；D2b 处理显式全绝对下游，绝对路径按自身解析（`toAbsolutePath` 对绝对路径直接返回，不读 projectRoot），用不用 projectRoot 结果相同——无需模拟。
- **拆分而非改签名**：`scanCdChdir` 的既有调用点（`entry.ts:52`）只判 `=== "cd_chdir"`，保持其返回 `string | undefined` 可避免破坏既有调用与测试断言；cwd 模拟需要的是「是否跟踪」这一独立布尔，由 `shouldTrackCdCwd` 提供。两者共享 `analyzeCd` 避免 D2a 判定重复。
- **解析基准注入点是 `extractRedirects` / `COMMAND_TABLE` 提取器的第三个参数**（`entry.ts:295,304`）——它们当前都接收 `projectRoot`，cd 跟踪下换成 `resolveBase`。`toAbsolutePath`（`path-utils.ts:35`）对相对路径用传入基准解析、对绝对路径按自身解析，故 `resolveBase` 替换后绝对路径不受影响、相对路径正确解析到跟踪 cwd。
- **cd 片段顺序更新**：`cd /tmp/a && cd /tmp/b && cat x` → `resolveBase` 依次 `/tmp/a`、`/tmp/b`，`cat x` 按 `/tmp/b` 解析（最后一个成功 cd 的目标），符合 `&&` 链的「cwd = 最后一个成功 cd 目标」语义。

**备选方案**：
- 改 `scanCdChdir` 签名返回对象 `{ fire, track }`——**否决**：破坏既有 `entry.ts:52` 调用点与测试断言，改动面大；且 `track` 与 `fire` 的消费方不同（fire 在守卫判断处，track 在步骤 5），拆成两个函数更清晰。
- 在 entry.ts 步骤 5 内联 cd 目标解析（不新增函数）——**否决**：把 D2a 判定逻辑散进 entry.ts，与 `scanCdChdir` 的豁免判定重复，违反「豁免判定内聚在 shell-forwarder」的设计。
- 用 `projectRoot` 作为 cd 链的初始解析基准、不模拟——**否决**：`cd /tmp/x && cat file.txt` 会把 `file.txt` 解析为 `<proj>/file.txt` 而非真实 `/tmp/x/file.txt`，治本目标落空（正是要修的问题）。

### D3：i18n 文案修正——「建议使用绝对路径」改为与实际行为一致

**决策**：`i18n.ts:173`（`cd_chdir` 中文文案）改为明确说明「cd 后仍有相对路径命令时无法静态解析；改用绝对路径。当下游全部为显式绝对路径时本系统会自动放行；若命令是 `cd <绝对路径> && …` 链（无 `;`/`||`/`&`/管道、cd 目标绝对、下游无 `.`/`..`/glob），本系统会自动解析出 cd 后的真实路径」。英文文案同步。保证用户看到的是真实边界，而非「照做也不生效」的建议。

**理由**：原文案「建议使用绝对路径；选择「允许本会话」可避免重复弹窗」在 D2 实现后部分正确（相对路径下游用绝对路径确实可避免），但需补充「显式全绝对下游自动豁免、cd 跟踪豁免自动解析真实路径、无显式引用下游仍拦截」的事实，避免用户困惑。

### D4：spec 采用 MODIFIED（完整块复制），不新增 capability

**决策**：`bash-target-extraction` 是既有 capability，两个 requirement 是行为变化，用 `## MODIFIED Requirements` 复制完整块。不新增 capability（无新子系统）。

**理由**：OpenSpec MODIFIED 要求完整块（`instructions specs` 明确「Paste the ENTIRE requirement block」），否则 archive 丢细节。

## Risks / Trade-offs

- **[边界① 空 prefix 放宽依赖 cwd==projectRoot 假设]** → 缓解：该假设与既有 `isBoundedPrefix` 的 cwd 基准假设同类（非空 prefix 也依赖 cwd），本 change 未扩大假设面；且只读命令豁免无写副作用（只影响 read target 判定），误判最坏情况是「多放行一个只读 ls」，无删除/写入风险。
- **[边界① 误放行「cd 后空 prefix glob」]** → 缓解：cd 复合命令会先被 `scanCdChdir` 判 `cd_chdir`（D2a 条件 5 排除 glob、D2b 只针对显式全绝对下游），故 `cd /tmp/x && ls *.md` 仍判不可靠，不会因边界① 单独放行。
- **[边界② D2a 误放行 cwd-relative 写重定向]** → 缓解：**cd 跟踪豁免判据已收紧**——D2a 条件 4 排除 `.`/`..` cwd 锚点（`cd /etc && rm -rf .` 的 `.` 提取 0 target，若放行会静默放行删 `/etc` 内容）、条件 5 排除未加引号 glob（`cd /tmp/x && ls *.md` 的真实展开在 `/tmp/x`，放行会误解析到 projectRoot）；D2b 重定向目标（`extractRedirects` 语义）纳入路径引用检查，任何 cwd-relative 引用（相对重定向、相对参数、空 prefix glob、`$VAR`）都使豁免不适用。架构 review 曾判重定向检查为 critical，已在此修复。
- **[边界② 豁免空转反转既有安全断言]** → 缓解：D2a 限「纯 `&&` 链 + 绝对 cd 目标」——`cd /etc && ls` 在 D2a 下**豁免**（纯 `&&` 链 + 绝对 cd 目标 + 无路径引用，`ls` 0 target），既有 `security-probe.mjs:113` 断言**反转**为 `reliable:true`（预期行为变化，apply 阶段同步更新）；`cd /etc; ls`（`;` 分隔）不豁免，保持 `cd_chdir`（既有断言不变）。D2b 要求「至少一个显式绝对路径引用」——`cd /etc && ls` 无显式引用，D2b 不豁免。
- **[边界② D2a 依赖 `&&` 短路假设]** → 缓解：已实验验证（`&&` 下 cd 失败 → 下游不执行，cwd 落点确定；`;` 下 cd 失败 → 下游仍执行，cwd 不更新）。仅纯 `&&` 链适用，`;`/`||`/`&`/换行一律排除。
- **[边界② D2a 依赖绝对 cd 目标假设]** → 缓解：已实验验证（CDPATH 完全改变 `cd sub` 目标；`~`/`$VAR`/`cd -` 依赖运行时环境）。仅绝对 cd 目标适用，相对/`~`/`$VAR`/glob/`cd -` 一律排除。
- **[边界② D2c 解析基准注入复杂度]** → 缓解：`shouldTrackCdCwd` 只遍历片段判断 D2a 是否成立（线性），`resolveBase` 是单个字符串变量，每片段 O(1) 更新；对 O(命令长度) 总复杂度无实质影响。
- **[边界② 豁免判定复杂度]** → 缓解：豁免只遍历 cd 之后的下游片段，线性扫描，O(片段数 × 参数数)，对 O(命令长度) 总复杂度无实质影响。
- **[i18n 文案变更影响既有测试]** → 缓解：文案是展示层，若有测试断言文案字符串需同步更新（`test/` 内 grep 确认，apply 阶段处理）。

## Migration Plan

- 无 schema/config 变更（`permission.json`/`trusted.json` 契约不变）。
- 无部署步骤（纯代码行为变化，jiti 热加载）。
- 回滚：`git revert` 即可，无数据迁移。
- 兼容性：旧行为（更保守）→ 新行为（更宽松）是单向收窄，已授权语义不变。
- 既有测试断言反转（`cd /etc && ls` → `reliable:true` 等）是**预期行为变化**，apply 阶段同步更新断言；不视为回归（真实行为确实是 cd 跟踪豁免解析出真实路径）。

## Open Questions

无。
