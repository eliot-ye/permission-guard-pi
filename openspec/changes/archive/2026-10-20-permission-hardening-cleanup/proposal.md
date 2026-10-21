## Why

两次扫描确认了同一条根因链：审计日志与 trusted.json 都以 `0644` 权限落盘明文（含 git commit 全文、bash 命令原文），任何同机进程或用户可读；同时 `extensions/index.ts` 与 `test/decision.test.ts` 里存在不会执行 / 不会失败的死代码与占位测试，`UNRELIABLE_COMMANDS` 集合与 `SILENT_COMMANDS` 语义冲突把 `cargo check/metadata/fmt` 这类只读命令误判为不可靠，`package.json` 的 test glob 与实际目录结构不匹配。这些都属于权限系统本身的安全性 / 可靠性缺陷——权限扩展自身不该成为安全漏洞的载体。

本 change 只做安全加固与死代码清理，不涉及 bash extractor 的误报收敛（另开 Change B）。

## What Changes

- **审计日志目录与文件权限收敛**：`createAuditLogger` 在首次创建 `logs/` 目录时以 `0o700` 权限创建；已存在的日志文件在首次写入前被 `chmod 0o600`（若文件属主为当前用户且当前不是 `0o600`）。
- **trusted.json 权限收敛**：`createTrustStore` 在首次创建父目录时以 `0o700` 权限创建；`atomicWrite` 落盘后确保目标文件权限为 `0o600`（若属主为当前用户）。
- **bash 命令字段的审计字段脱敏**：`AuditLogger.log` 在写入前对 `record.command` 与 `record.path` 做长度截断（默认上限 512 字符，超出以 `…` 结尾并追加 `note: "command truncated"`）。**不做**基于内容的关键字脱敏（保留可读性，长度截断足以阻断绝大多数敏感信息外泄路径）。
- **`UNRELIABLE_COMMANDS` 集合保持 `cargo`**：本 change 早期草稿曾计划从 `UNRELIABLE_COMMANDS` 中移除 `cargo`——理由是它同时存在于 `SILENT_COMMANDS`（allow-set 含 `check`/`metadata`），两者冲突导致 `cargo check`、`cargo metadata`、`cargo fmt` 等只读子命令被误判为不可靠。但 code review 发现这个改动会重新打开 4b D6 fall-through 绕过：
  - `echo hi; cargo publish`（复合命令）——4b silent-form 检查仅在 `cmdFragments.length === 1` 时执行，复合命令走 D6 fall-through 返回 `reliable: true, targets: []`
  - `cargo check --manifest-path /etc/evil/Cargo.toml`——即使允许 allow-set 内 subcommand，`--manifest-path` 仍指向任意路径，静默放行等价于授权任何路径的 Cargo.toml 读
  因此本 change 最终**保留 `cargo` 在 `UNRELIABLE_COMMANDS`**（回归 BT-CARGO-1 到 BT-CARGO-11 全部断言 `unreliable_command`）。`cargo check`/`metadata` 的静默放行诉求若确需保留，应由后续 change 通过"4b 检查遍历所有 fragment + 每个 pipeline stage + `--manifest-path` 越界检测"的完整设计实现，而非本 change 范围。
- **删除 `extensions/index.ts` 中永不触发的 3 个 case 分支**：`bashPermissionForReason` 的 `case "device_redirect"`、`case "bounded_glob"`、`case "unresolved_variable"`，以及 `bashSubtitleForReason` 的 `case "bounded_glob"`——`extractBashTargets` 永远不会返回这些 reason 值（`grep` 已确认）。
- **`bashPermissionForReason` / `bashSubtitleForReason` 改前缀匹配 `unresolved variable:`**：code review 发现原实现用字面量 `"unresolved variable"`，但 extractor 实际产出的 reason 是 `` `unresolved variable: ${unresolved}` ``——原实现**永远不匹配**，落到 `default` 返回 `read_write`，grant 授权比意图宽一级。修复：改为 `reason?.startsWith("unresolved variable:")` 前缀匹配，并给 `bashSubtitleForReason` 加对应分支。
- **审计日志写入路径用 `fs.open(logPath, "a", 0o600)` 替代 `fs.appendFile`**：code review 发现 `ensureFileMode` 在 `appendFile` 之前调用，首次写入时文件不存在→ENOENT→跳过 chmod；文件以默认 0o644 创建，**首行在宽松模式下落盘**。修复：改用 `fs.open` 让创建即带 0o600 mode，再用 `fd.writeFile` 追加；保留 `ensureFileMode` 作为"既有文件权限收敛"的 belt-and-braces。
- **`createTrustStore` 显式 `chmod(dirname, 0o700)`**：code review 发现 `fs.mkdir({recursive, mode})` 对已存在目录**不改 mode**——若父目录由更早版本以更宽 umask 创建（如 0o755），`trusted.json` 会落在一个其他用户可枚举的目录里。修复：mkdir 之后显式 `fs.chmod(parentDir, 0o700)`，与 `ensureFileMode` 对称。
- **同步清理 spec 中已废弃的 reason 值**：`approval-flow` spec 的"两档 vs 三档弹窗"与"弹窗内容包含关键信息"requirement 中列举了 `device_redirect` / `bounded_glob` 作为 bash_reason 值——本 change 同步删除或标注为过时。`grant-memory` spec 的"Bash 命令记忆渠道"requirement 的授权类型映射中列举了 `device_redirect` / `bounded_glob` 的 `read_only` 授权——本 change 同步删除该授权条目及对应 scenario。**原因**：这两个 reason 值从未被 `extractBashTargets` 返回，是历史遗留的死代码与死契约；若不清理，删除死 case 后 spec 与代码不一致。
- **同步更新 `test/trust.test.ts` 中使用 `device_redirect` 作为 grant 参数值的测试数据**：GM13 / GM15 / GM16 / GM17 / GM18 的 `addBashSessionGrant` / `addBashPersistentGrant` 参数从 `device_redirect` 改为 `glob_expansion`（后者是 extractor 实际会返回的 reason 值，且同属 `read_only` 授权级别）——**不改断言逻辑与语义**，只替换测试输入。
- **删除 `test/decision.test.ts` 中的占位测试**：`AD19: unreliable bash extraction (integration-covered placeholder)` 是恒真断言（`assert.equal(1, 1)`），行为已由 SYS4 / SYS8 覆盖。
- **修正 `package.json` 的 test glob**：`test/**/*.test.ts extensions/**/*.test.ts` → `test/*.test.ts`——当前 `extensions/` 下无测试文件，且 `test/` 是单层目录，`**` 不产生额外匹配。

**不修改**：`src/lib/bash-extract.ts` 的 `isSilentCommand`、`SILENT_COMMANDS` allow-set、`bash-extract` 的 git blob 语法处理、`npm run`/`tsc <file>` allow-set 扩展、`sensitive.ts` 的敏感路径表——这些属于 Change B 的范畴。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `openspec/specs/audit-log/spec.md`：为"日志记录字段"requirement 追加 `command` 字段长度截断约束；为"日志文件目录自动创建"requirement 追加目录与文件权限要求（0o700 目录 / 0o600 文件）。
- `openspec/specs/grant-memory/spec.md`：为 trusted.json 落盘行为追加文件权限要求（0o600）；**修改**"Bash 命令记忆渠道"requirement 的授权类型映射，删除 `device_redirect` / `bounded_glob` 条目，删除对应 scenario。
- `openspec/specs/approval-flow/spec.md`：**修改**"两档 vs 三档弹窗"requirement 的 bash_reason 列举，**修改**"弹窗内容包含关键信息"requirement——删除 `device_redirect` 与 `bounded_glob` 两条 scenario。

## Impact

- **代码文件**：
  - `src/lib/audit.ts`：目录 `chmod` 与文件 `chmod`、`command` 字段截断
  - `src/lib/trust.ts`：目录 `chmod`、`atomicWrite` 后文件 `chmod`
  - `src/lib/bash-extract.ts`：从 `UNRELIABLE_COMMANDS` 集合移除 `cargo`
  - `extensions/index.ts`：删除 3 个 case 分支
  - `test/decision.test.ts`：删除占位测试
  - `package.json`：修正 test glob
  - `test/trust.test.ts`：GM13/GM15/GM16/GM17/GM18 的测试输入从 `device_redirect` 替换为 `glob_expansion`
- **测试文件**：新增 `test/audit-permissions.test.ts`（权限与截断行为）；`test/bash-extract.test.ts` 增补 `cargo check` / `cargo metadata` / `cargo fmt` 静默放行断言；`test/trust.test.ts` 补 trusted.json 权限断言
- **spec 文件**：修改 `openspec/specs/approval-flow/spec.md` 与 `openspec/specs/grant-memory/spec.md` 的过时 reason 值描述（对应 spec delta）
- **运行时数据**：`~/.pi/agent/extensions/@permission-system:pi-extension/logs/permission-review.jsonl` 与 `trusted.json` 在新会话首次写入时被收敛到 0o600；历史文件（当前 294 条审计记录 / 7 条 grant）会在下一次 flush 或 addPersistentGrant 时自动收敛
- **不影响**：bash extractor 的整体误报行为（Change B 覆盖）、审计字段结构（新增 `note: "command truncated"` 是既有可选字段的复用）、grant key 结构、bash grant memory 语义、`approval-flow` spec 的其他 requirement、`grant-memory` spec 的其他 requirement

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"——专家判断 + 数据 + 模型反复迭代上升到定量认识）

- **影响哪些分系统**：
  - `side-effects` 子系统的 `audit`（tier-small）：审计写入侧的权限收敛与字段截断
  - `side-effects` 子系统的 `bash-extract`（tier-small）：`UNRELIABLE_COMMANDS` 集合收缩
  - `extension-orchestration` 子系统（tier-small）：3 个死 case 分支删除
  - `policy-core` 子系统的 `trust`（tier-medium）：文件权限收敛
  - `policy-core` 子系统的 `grant` 语义（tier-medium）：清理 spec 中已废弃的 `device_redirect` / `bounded_glob` 授权条目
  - `approval-flow` 子系统（tier-medium）：清理 spec 中已废弃的 `device_redirect` / `bounded_glob` 弹窗副文本 scenario
  - 测试基础设施：`package.json` test glob 修正、`test/decision.test.ts` 清理、`test/trust.test.ts` 的 grant reason 参数值同步
  - 分系统边界**未变**，无新增模块，无跨分系统依赖新增
- **整体性能预期变化**：无行为层面性能变化。审计写入每次 flush 新增一次 `chmod` 系统调用（幂等，若已是 0o600 直接返回），在 tier-small 层级的审计 fire-and-forget 队列里不构成可感知开销。文件权限收敛属于一次性动作，会话内仅发生一次。
- **这是局部优化还是全局协调**：**局部优化**（4 个子系统的独立加固 + 1 次 spec 死代码清理，不牵动决策引擎或 grant 语义），但触及三个公共契约（`audit-log` spec 的字段语义 + 文件权限、`grant-memory` spec 的落盘权限 + Bash 命令记忆渠道的授权类型映射、`approval-flow` spec 的弹窗副文本 scenario），因此走 td-propose 完整流程。
- **如果是局部优化，对全局失调的风险**：低风险。所有改动都收敛在既有模块内部，无新增公共符号、无跨分系统契约变更（除了 spec 层的字段级补充，且是补充性质——不删改既有字段）。已知的一个潜在失调点是 `cargo` 从 `UNRELIABLE_COMMANDS` 移除后，`cargo` 的 subcommand 判定完全走 `isSilentCommand`，若 allow-set 之外的 subcommand（如 `cargo publish`、`cargo install`）未被 `unreliable_command` 兜底拦截，可能引入新的静默放行面——本 change 的验证清单里已包含"cargo publish 仍判不可靠"回归项。
- **预期行为模型**：
  - **可测量**：新会话首次运行后，`stat -c %a ~/.pi/agent/extensions/@permission-system:pi-extension/logs/permission-review.jsonl` 返回 `600`；`trusted.json` 同。审计日志中单条 `command` 字段长度上限 512 字符。`cargo check`、`cargo metadata`、`cargo fmt` 三条命令的 `extractBashTargets` 返回值从 `{reliable:false, reason:"unreliable_command"}` 变为 `{reliable:true, targets:[]}`。`cargo build`、`cargo run`、`cargo publish`、`cargo install` 仍返回 `{reliable:false, reason:"unreliable_command"}`。
  - **技术无关**：用户日常开发时无需手动 chmod 审计目录；扩展不会因文件权限不足而阻塞工具调用（审计写入 fire-and-forget 语义不变）；命令字段截断后审计可读性下降但完整性保留（截断标记 `…` + `note` 字段）。
  - **用户视角**：同机其他进程无法读扩展的审计日志与 trusted.json；日常执行 `cargo check` 不再触发弹窗；`npm test` 输出稳定（448 pass / 0 fail，不含空转占位）。
  - **可验证**：新增 `test/audit-permissions.test.ts` 断言目录/文件权限与 command 截断行为；`test/bash-extract.test.ts` 断言 `cargo check/metadata/fmt` 静默放行、`cargo build/run/publish/install` 仍判不可靠；`npm test` 448+ pass / 0 fail。
- **与既有架构/风格的遵循关系**：
  - **遵循**：`src/lib/*.ts` 保持无 UI/IO 依赖的纯函数边界（`chmod` 是 fs 系统调用，属 IO 层——但现有 `src/lib/audit.ts` 与 `src/lib/trust.ts` 已直接 import `node:fs/promises`，未引入新依赖类别）；测试文件命名沿用 `test/<module>.test.ts` 约定；新增测试沿用 AL / GM 编号体系
  - **未偏离**：无新分系统、无新依赖、无新装配点

## caller impact 分析

（tier-medium 必填；命中"change 跨分系统"（≥ 4 分系统受影响）+ "数据流 / 返回值语义变更"（④ 类）→ 触发三层防护）

### 变更点清单

| # | 变更点 | 类别 | 位置 | 高危 |
|---|---|---|---|---|
| C1 | `createAuditLogger` 目录/文件权限收敛 + `command` 字段截断 | ③ 装配点变更（新增定义点：目录创建时的 `mode` 选项、写入后的 `chmod` 调用） + ④ 数据流语义变更（`command` 字段可能被截断） | `src/lib/audit.ts:52-73` | 是 |
| C2 | `createTrustStore` 目录权限收敛 + `atomicWrite` 后文件权限收敛 | ③ 装配点变更（新增定义点：`mkdir` 的 `mode`、`rename` 后的 `chmod`） | `src/lib/trust.ts:85-107, 195-206` | 是 |
| C3 | `UNRELIABLE_COMMANDS` 集合移除 `cargo` | ② 协议/接口方法语义变更（`isAnyUnreliableCommand` 对 `cargo` 前缀的返回值从 `true` 变为 `false`） | `src/lib/bash-extract.ts:925-939` | 是 |
| C4 | `bashPermissionForReason` / `bashSubtitleForReason` 死 case 删除 | ④ 数据流语义变更（删除死分支，返回值不变） | `extensions/index.ts:166-169, 205-206` | 否 |
| C5 | `test/decision.test.ts` 占位测试删除 | — | `test/decision.test.ts:428-430` | 否 |
| C6 | `package.json` test glob 修正 | — | `package.json:30` | 否 |
| C7 | `approval-flow` spec 清理过时 reason 值（`device_redirect` / `bounded_glob`） | ③ 公共契约变更（REMOVED scenarios） | `openspec/specs/approval-flow/spec.md:76-99` | 是 |
| C8 | `grant-memory` spec 清理过时 reason 值（授权映射 + benign scenario） | ③ 公共契约变更（REMOVED reason 条目 + REMOVED scenario） | `openspec/specs/grant-memory/spec.md:153, 183-186` | 是 |
| C9 | `test/trust.test.ts` GM13/15/16/17/18 的 grant reason 参数值替换 | — | `test/trust.test.ts:245, 270, 283, 297, 322, 330` | 否 |

**判断依据**：C1/C2/C3 都影响本分系统外的 caller（`audit` 与 `trust` 的调用方是 `extensions/index.ts`；`bash-extract` 的调用方包括 `extensions/index.ts` 与所有 bash 相关的集成测试 SYS4 / SYS5 / SYS8）；C4 只删死分支，语义不变；C5/C6 是测试与配置调整；C7/C8 是本 change 新增的 spec 契约变更（删除从未激活的 reason 值），需要 caller impact 分析；C9 是 C7/C8 的连带测试数据同步。

### 已知 caller

- **C1 `audit.log` caller**：`extensions/index.ts` 的 `handleBash`（L481-510, L559-572）、`handleFileTool`（L610-624）、`handlePromptDecision`（L769-783, L793-808, L823-839, L856-868, L878-890, L906-918, L927-939）。**预判结论**：兼容——所有 caller 传的是完整 `AuditRecord` 对象，`command` 字段的截断在 `log` 内部发生，caller 不感知；`note` 字段是既有可选字段，追加 `"command truncated"` 不改变既有 `note` 语义。
- **C2 `createTrustStore` / `atomicWrite` caller**：`extensions/index.ts:134`（`createTrustStore(trustedPath)`）、`addPersistentGrant` / `addBashPersistentGrant` / `flush` 内部、`test/trust.test.ts:withTmpStore`。**预判结论**：兼容——所有 caller 通过返回的 `TrustStore` 接口使用，接口形状不变；权限收敛在 `atomicWrite` 内部。
- **C3 `isAnyUnreliableCommand` caller**：`extractBashTargets`（`src/lib/bash-extract.ts:2360`）——内部唯一 caller。**预判结论**：兼容（返回值对 `cargo check/metadata` 从 `true` 变为 `false`，但这是本 change 的目标语义，下游 `extractBashTargets` 会 fall through 到 `isSilentCommand` 判定，`cargo` 的 SILENT allow-set 会正确接住 `check`/`metadata`，非白名单 subcommand 仍被 `unreliable_command` 兜底）；集成测试 SYS4/SYS5/SYS8 未覆盖 cargo 命令，无 caller 断言依赖旧行为。
- **C7 `approval-flow` spec caller**：spec 本身是文档契约，代码层由 `bashSubtitleForReason` 与 `bashPermissionForReason` 两个函数按 reason 值 dispatch——本 change 删除的 `device_redirect` / `bounded_glob` 两个 reason 值**从未被 `extractBashTargets` 返回**（`grep "return \"device_redirect\"\|return \"bounded_glob\"" src/lib/bash-extract.ts` 零命中），因此对应的 dispatch case 是死代码（C4 一并删除）。**预判结论**：兼容——spec 描述的是本应激活但从未激活的契约，删除后 spec 与代码一致；无既有 caller 依赖这些 scenario。
- **C8 `grant-memory` spec caller**：spec 的授权类型映射是文档描述，代码层由 `bashPermissionForReason` 函数按 reason 值 dispatch（同 C4 死代码）。**预判结论**：兼容——授权映射条目删除后，对应的授权级别默认走 `read_write`（`bashPermissionForReason` 的 default 分支），不影响现有行为。
- **C9 `test/trust.test.ts` 测试输入**：GM13/15/16/17/18 的 `addBashSessionGrant(projectHash, rawCommand, reason, permission)` 调用把 `device_redirect` 作为 grant 的 `reason` 字段。**预判结论**：兼容——`reason` 字段只是 grant 记录中的元数据（不参与 grant key，不参与 auto-allow 判定），替换为 `glob_expansion` 后既有断言（`assert.equal(g.reason, "device_redirect")`）需要同步改为 `assert.equal(g.reason, "glob_expansion")`——这是 T5.1 展开后的子任务 T5.1e 的验证范围。

## Scenario→Test 覆盖账本

（tier-medium + `applyRequires` 含 specs artifact + 有可执行测试面 → 强制）

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 日志文件目录与文件权限（新增） | 首次写入自动创建 0o700 目录 | `test/audit-permissions.test.ts` | `ALP1: audit_logger_creates_log_directory_with_0700_permissions` | 🔴 |
| 日志文件目录与文件权限（新增） | 已存在日志文件首次写入前收敛到 0o600 | `test/audit-permissions.test.ts` | `ALP2: audit_logger_chmods_existing_log_file_to_0600` | 🔴 |
| 日志文件目录与文件权限（新增） | 属主不匹配时跳过 chmod | `test/audit-permissions.test.ts` | `ALP3: audit_logger_skips_chmod_when_file_not_owned_by_current_user` | 🔴 |
| 日志记录字段（修改：command 截断） | `command` 字段超过 512 字符被截断并追加 note | `test/audit-permissions.test.ts` | `ALP4: audit_logger_truncates_command_field_over_512_chars` | 🔴 |
| 日志记录字段（修改：command 截断） | `command` 字段 ≤ 512 字符保持原样 | `test/audit-permissions.test.ts` | `ALP5: audit_logger_preserves_short_command_field` | 🔴 |
| 日志记录字段（修改：command 截断） | 截断不改变既有 `note` 字段语义 | `test/audit-permissions.test.ts` | `ALP6: audit_logger_truncation_note_coexists_with_existing_note` | 🔴 |
| trusted.json 文件权限（新增） | 首次写入 trusted.json 时以 0o600 创建 | `test/trust.test.ts` | `GMP1: trust_store_writes_trusted_json_with_0600_permissions` | 🔴 |
| trusted.json 文件权限（新增） | 目录首次创建以 0o700 | `test/trust.test.ts` | `GMP2: trust_store_creates_parent_dir_with_0700_permissions` | 🔴 |
| trusted.json 文件权限（新增） | atomicWrite 后既有文件权限收敛到 0o600 | `test/trust.test.ts` | `GMP3: atomic_write_chmods_existing_trusted_json_to_0600` | 🔴 |
| Bash 命令目标提取（bash-extract，本 change 触及 UNRELIABLE_COMMANDS 集合） | `cargo check` 判不可靠（回归 BT-CARGO-1） | `test/bash-extract.test.ts` | `BT-CARGO-1: cargo_check_still_unreliable` | 🔴 |
| Bash 命令目标提取（bash-extract） | `cargo metadata` 判不可靠 | `test/bash-extract.test.ts` | `BT-CARGO-2: cargo_metadata_still_unreliable` | 🔴 |
| Bash 命令目标提取（bash-extract） | `cargo fmt` 判不可靠（不在 SILENT allow-set） | `test/bash-extract.test.ts` | `BT-CARGO-3: cargo_fmt_still_unreliable` | 🔴 |
| Bash 命令目标提取（bash-extract） | `cargo build` 判不可靠 | `test/bash-extract.test.ts` | `BT-CARGO-4: cargo_build_still_unreliable` | 🔴 |
| Bash 命令目标提取（bash-extract） | `cargo run` 判不可靠 | `test/bash-extract.test.ts` | `BT-CARGO-5: cargo_run_still_unreliable` | 🔴 |
| Bash 命令目标提取（bash-extract） | `cargo publish` 判不可靠 | `test/bash-extract.test.ts` | `BT-CARGO-6: cargo_publish_still_unreliable` | 🔴 |
| Bash 命令目标提取（bash-extract） | `cargo install` 判不可靠 | `test/bash-extract.test.ts` | `BT-CARGO-7: cargo_install_still_unreliable` | 🔴 |
| Bash 命令目标提取（bash-extract，review 补充） | 复合命令 `echo hi; cargo publish` 判不可靠 | `test/bash-extract.test.ts` | `BT-CARGO-8: compound_semicolon_cargo_publish_still_unreliable` | 🔴 |
| Bash 命令目标提取（bash-extract，review 补充） | 复合命令 `cd ~/project && cargo install evil-pkg` 判不可靠 | `test/bash-extract.test.ts` | `BT-CARGO-9: compound_logical_and_cargo_install_still_unreliable` | 🔴 |
| Bash 命令目标提取（bash-extract，review 补充） | 管道 `cargo run \| tee out.txt` 判不可靠 | `test/bash-extract.test.ts` | `BT-CARGO-10: pipeline_cargo_run_tee_still_unreliable` | 🔴 |
| Bash 命令目标提取（bash-extract，review 补充） | `cargo check --manifest-path /etc/evil/Cargo.toml` 判不可靠 | `test/bash-extract.test.ts` | `BT-CARGO-11: cargo_check_manifest_path_outside_still_unreliable` | 🔴 |

**验证**：所有 20 条新增测试在 tasks.md 的 T4 / T5 / T6 三处实现，最终由 `npm test` 全绿断言（`pass N+20 / fail 0`，N 是变更前的 448，删除 1 条占位后基线为 447，新增 20 条后总计 467）。

## 实际 vs 预期复盘（tier-medium，5 字段）

（服务于 `system-engineering` 主基调第 3 条"从定性到定量的综合集成"——综合集成循环的闭合动作。对照源 1：本节"系统工程影响评估"；对照源 2：`openspec/specs/{approval-flow,grant-memory,audit-log,grant-memory}/spec.md` baseline。）

### 1. 影响哪些分系统 — 实际影响的分系统

| proposal 预期 | 实际 | 判定 |
|---|---|---|
| `side-effects.audit` / `side-effects.bash-extract` / `extension-orchestration` / `policy-core.trust` / `policy-core.grant` / `approval-flow`（6 个分系统） | 完全一致（6 个分系统，边界未变，无新增模块，无跨分系统依赖新增） | ✅ 吻合 |

### 2. 整体性能预期变化 — 实际整体性能变化

- **预期**：审计写入每次 flush 新增一次 `chmod` 系统调用；文件权限收敛属一次性动作；tier-small 层级 fire-and-forget 队列里不构成可感知开销。
- **实际**：符合预期。实测 `npm test` 全流程 765 ms（467 用例），其中 `test/audit-permissions.test.ts` 6 用例合计 336 ms（大部分时间在 `setTimeout(50)` 等 fire-and-forget 队列 drain），无一次调用可感知延迟。审计侧新增的 `fs.open(logPath, "a", 0o600)` 替代 `fs.appendFile` 增加了 fd open/close 各一次系统调用，但在 20 次审计写入的实测样本中未观察到吞吐下降。
- **判定**：✅ 符合预期，无性能回归。

### 3. 局部优化还是全局协调 — 实际是局部优化还是全局协调

- **预期**：局部优化（4 个子系统的独立加固 + 1 次 spec 死代码清理），但触及 3 个公共契约（走 td-propose 完整流程）。
- **实际**：**性质仍为局部优化**——所有改动收敛在既有模块内部，无新增公共符号、无跨分系统依赖新增；触及的公共契约面（`audit-log` / `grant-memory` / `approval-flow` 三个 spec 的字段级/条款级修正）与预期一致。
- **判定**：✅ 符合预期。

### 4. 局部优化的全局影响（主基调第 1 条事后回检）

- **预期**：低风险。潜在失调点已识别：`cargo` 从 `UNRELIABLE_COMMANDS` 移除后 `cargo publish` / `cargo install` 等未被 `unreliable_command` 兜底拦截的风险，验证清单已包含回归项。
- **实际**：**风险识别正确，但触发时机在 review 阶段**——不是通过本 change 的验证清单（当时断言的是"cargo publish 判不可靠"，且 `cargo check` 也在断言中"应静默放行"），而是通过 6.3 code review 发现的复合命令绕过（`echo hi; cargo publish`）与 `--manifest-path` 越界读。
- **实际采取的行动**：选择保守方案（恢复 `cargo` 到 `UNRELIABLE_COMMANDS`），把"允许 cargo 静默"留给后续 change（"4b 检查遍历所有 fragment + `--manifest-path` 越界检测"）设计。
- **判定**：⚠️ 预期模型未考虑复合命令与 flag 越界两个绕过向量；主基调第 1 条事后回检**部分成功**（识别了风险类别但未完全枚举）；已把偏差沉淀进 design.md 的 Code Review Feedback 章节，作为后续 change 的预测模型修正。

### 5. 预期行为模型 — 模型验证

**部分验证通过，一处偏差已修正**：

- ✅ **可测量断言**（16/20 项）：
  - 目录 0o700 / 文件 0o600（ALP1/ALP2/GMP1/GMP2/GMP3）—— 全部通过
  - `command` 字段 512 字符截断 + `…` 标记 + `note` 追加（ALP4/ALP5/ALP6）—— 全部通过
  - `cargo build/run/publish/install/fmt` 判不可靠（BT-CARGO-3/4/5/6/7）—— 全部通过
- ⚠️ **可测量断言偏差**（4/20 项，review 后修正）：
  - 预期：`cargo check` / `cargo metadata` 静默放行（`{reliable: true, targets: []}`）
  - 实际（保守方案）：`cargo check` / `cargo metadata` 仍判不可靠（`{reliable: false, reason: "unreliable_command"}`）
  - 原因：`isSilentCommand` 的 4b silent-form 检查仅在 `cmdFragments.length === 1` 时执行，复合命令走 D6 fall-through；`--manifest-path` 指向任意路径的越界读无法通过 allow-set 判定
  - 模型修正建议：将"允许 cargo 静默"作为**未来 change 的完整设计**（需要"4b 检查遍历所有 fragment + pipeline stage + flag 值越界检测"三件事同时成立），而非本 change 的局部放宽
  - 补测：新增 BT-CARGO-8..11 四条回归，覆盖复合命令与 `--manifest-path` 越界场景
- ✅ **技术无关性**：日常执行 `cargo check` 仍会弹窗（保守方案的代价，但安全）；审计写入不会因权限不足阻塞工具调用；命令字段截断后审计可读性略降但完整性保留（`…` + `note` 双标记）
- ✅ **可验证性**：467 pass / 0 fail + security-probe 35/35 + `openspec validate` 0 issues 三重背书

### 6. 预期之外的副作用

1. **P2-3 语义 bug 修复**（review 发现）：`bashPermissionForReason` 的字面量匹配 `"unresolved variable"` 永远不匹配 extractor 产出的 `` `unreliable variable: <name>` ``，落到 `default` 返回 `read_write`——比 spec 承诺的 `read_only` 宽一级。这是**本 change 之外的既有 bug**，本 change 顺带修复，因为改动路径正好重叠。
2. **P2-4/P2-5 真实权限缺口**（review 发现）：
   - `fs.mkdir({recursive, mode})` 对已存在目录不改 mode
   - `fs.appendFile` 首次写入以 umask 落盘（`ensureFileMode` 之前 ENOENT 跳过）
   两个缺口都在本 change 的原始意图（权限收敛）里，但**最初的实现没覆盖**。已用显式 chmod + `fs.open(logPath, "a", 0o600)` 修复。
3. **package.json test glob 事实错误**（apply 中发现）：proposal 假设"extensions/ 下无测试文件"，但实际 `extensions/index.test.ts` 有 18 个测试——T5.3 的 glob 修正如果只保留 `test/*.test.ts` 会排除 18 个测试。已修正为 `test/*.test.ts extensions/*.test.ts`。
4. **既有 BT-B14h/j/y 断言需同步更新**：3 条既有 characterization 断言 `isSilentCommand("cargo", ...)` 为 `true`，本 change 恢复 cargo 到 UNRELIABLE_COMMANDS 后需反转为 `false`。属正常的 characterization 更新（brownfield 变体）。

### 7. scenario→test 覆盖账本状态

- **全部 20 条** 均为 🔴（新增），**全部已实现在 test 文件并通过**（见"验证"字段）
- **无 N/A 条目**
- **4 条账本条目在 review 后修订**：BT-CARGO-1/2 由"静默放行"改为"判不可靠"；新增 BT-CARGO-8/9/10/11 覆盖 review 发现的绕过场景
- **未覆盖项**：spec 中 `approval-flow` 的 `bash_reason` 场景描述与 `grant-memory` 的授权类型映射在**代码层的映射函数**（`bashPermissionForReason` / `bashSubtitleForReason`）已通过 P2-3 前缀匹配修复，但没有专项集成测试——这是 approval-flow spec 的既有测试面（`extensions/index.test.ts` 的 18 条 AF* 测试覆盖了弹窗层级，但未覆盖副文本内容），留给后续 change 补充

## 假设

- 目标运行环境的 `fs.chmod` / `fs.open` 支持位模式参数（Node 24 支持，见 config.yaml 声明的 Node 版本）
- 用户在同一机器上运行扩展，属主匹配检查使用 `process.getuid()` 与 `fs.stat().uid` 比对；Windows 上跳过属主检查，直接 chmod（Node 在 Windows 上 `chmod` 是 no-op，行为兼容）
- 已落盘的历史审计日志文件在下次 `appendFile` 前完成 `chmod`——用户主动删除历史文件不受影响
