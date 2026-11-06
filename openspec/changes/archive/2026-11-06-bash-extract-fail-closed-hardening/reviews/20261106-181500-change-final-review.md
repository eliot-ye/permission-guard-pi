## Code Review：bash-extract-fail-closed-hardening（change 级收尾 review）

### Spec Compliance
- [x] 实现符合 tasks.md（21 条任务全 `[x]`）
- [x] 实现符合 design.md（D0-D5 决策逐条对齐）
- [x] 实现符合 proposal 系统工程影响评估边界（未放松既有守卫，5 处绕过均 fail-closed）

### Security
- 4 条 extraction 绕过 + 1 条多 target unread 绕过均正确修复（对抗用例实测 RED→GREEN，spec 13 场景全部满足），无 critical fail-open。安全红线核对：全部对抗形态均 fail-closed 或正确提取写/删目标，未发现 fail-open。

### Code Quality
- 命名：OK
- DRY：OK
- 错误处理：OK
- 测试覆盖：OK（FCH-1..6b + FCH-D5-1 覆盖全部对抗/对照/边界）

### Code Consistency
- 与既有风格一致性：OK
- 实现模式沿用：OK（复用 tokenize/splitPipelines/isReadOnlyWithArgs/isAssignmentPart 既有守卫链）

### Issues

1. **[warning]** 新提取器原因 `unterminated_redirect_quote`（entry.ts:410 返回）未注册进稳定 bash reason-code 契约：不在 `BashReasonCode` 联合、不在 `BASH_REASON_CODES`、不在 `bashReasonCodeAndParams` codes 集合。后果：bash 弹窗副标题回落为 "unreliable_command"。
   - 位置：src/lib/reason-codes.ts:69-84/163-179、extensions/index.ts:267-272
   - 修复：已修复（加入 BashReasonCode/BASH_REASON_CODES/bashReasonCodeAndParams + i18n 双 bundle + TOTAL_CODE_COUNT 57→58 + reason-codes.test.ts 15→16/35→36 + i18n.test.ts 57→58 期望），复验 24/24 GREEN。
2. **[warning]** D4 对「多赋值前缀」只读命令过度收紧：`for f in a; do x=5 y=6 cat /a; done` 降级弹窗（基线经 isAssignmentPart 豁免）。违反 design 非目标「真正只读命令免弹不回归」。
   - 位置：src/lib/bash-extract/silent.ts:960-985
   - 修复：已修复（`isForBodyReadOnly` 剥离改为循环剥离连续赋值前缀：`x=5 y=6 cat /a` 免弹、`x=5 y=6 rm` 仍降级），复验 probe 全正确。

### nit（记录不修）
3. **[nit]** `tokens.indexOf(cArg)` 按值定位 `-c` 参数；同一字符串重复出现会错位。仅病态输入，outerTail 多捕获偏安全。
   - 位置：src/lib/bash-extract/entry.ts:65
4. **[nit]** FCH-4/FCH-6 `false as boolean` 转写规避 TS 收窄（有注释）；可接受，测试风格略晦涩。
   - 位置：test/bash-extract.test.ts

### Verdict
APPROVED_WITH_CHANGES
reviewed-by: subagent
2 处 warning 已修复并复验全 GREEN（bash-extract 622/622、extensions 39/39、reason-codes+i18n 24/24、typecheck exit=0、全量 971 tests 仅 2 EPERM 环境限制）；无 critical，可归档。
