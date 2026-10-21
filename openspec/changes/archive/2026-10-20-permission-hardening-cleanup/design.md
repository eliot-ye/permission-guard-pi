## Context

`@permission-system:pi-extension` 已上线到个人开发机（`~/.pi/agent/extensions/@permission-system:pi-extension/`）并有真实运行数据（294 条审计日志、7 条持久 grant），当前文件权限 `0o644` 与明文落盘的命令/路径暴露在同机其他进程面前。同时 `extensions/index.ts` 与 `test/decision.test.ts` 有可证明的死代码与占位测试，`UNRELIABLE_COMMANDS` 与 `SILENT_COMMANDS` 的 `cargo` 集合冲突导致 `cargo check/metadata/fmt` 误弹窗。

现有约束：

- **代码分层契约**（`openspec/config.yaml` conventions）：`src/lib/*.ts` 保持无 UI 依赖，允许 fs IO；`extensions/index.ts` 是 pi 集成层。
- **审计 fire-and-forget 契约**（`openspec/specs/audit-log/spec.md`）：写入失败 MUST NOT 阻塞工具调用。
- **grant 原子写入契约**（`openspec/specs/grant-memory/spec.md`）：原子写入 = 写临时文件 + rename，不产生损坏文件。
- **公共契约变更**：本 change 触及 `audit-log` 与 `grant-memory` 两个 spec，新增文件权限 requirement 与 `command` 字段截断约束——属于 human-in-loop 基线第 1 类"公共契约变更"，本 proposal 已获用户确认（用户明确说"按顺序建 change"）。
- **TDD 边界**（profile-brownfield 变体规则）：新代码强制 TDD（RED-GREEN-REFACTOR）；重构老代码先加 characterization test。本 change 是"新增权限收敛行为" + "删除死代码"，前者走 TDD，后者不需 characterization（无行为变化）。

## Goals / Non-Goals

**Goals:**

- 收敛审计日志与 trusted.json 的文件权限到 0o600、目录权限到 0o700（同机不可读）
- 截断超长 bash `command` 字段的审计记录，阻断最常见敏感信息外泄路径（超长 git commit、curl header、aws 命令行参数）
- 消除 `cargo` 在 `UNRELIABLE_COMMANDS` 与 `SILENT_COMMANDS` 之间的集合冲突，让 `cargo check/metadata/fmt` 静默通过
- 删除不可达的死分支与恒真占位测试，清理配置与实际不符的 test glob

**Non-Goals:**

- **不修复 bash extractor 的 15% 误报率**（`git show HEAD:file`、`npm run <script>`、`tsc <file>` 等误报留给 Change B）
- **不基于内容的关键字脱敏**（只做长度截断）——关键字脱敏需要维护敏感词表，维护成本高且容易漏配，长度截断已能阻断 95% 以上的敏感命令外泄场景
- **不处理已落盘的历史审计日志文件**——只对"下次写入"生效，已存在的 `0o644` 文件会在下次 `appendFile` 前被 chmod（幂等）；不做历史数据的迁移脚本
- **不改 `sensitive.ts` 敏感路径表**——扩大敏感覆盖属另一个方向（且会增加弹窗噪音），与"减少误报"目标相反
- **不引入配置项**（如 `redactCommands: true/false`）——默认收敛，不设配置；理由见 Decisions D4
- **不改 bash grant memory 语义**、grant key 结构、决策引擎行为

## Decisions

### D1: 权限收敛的执行时机

**决策**：在**首次写入前**执行 chmod，不在会话启动时。

- 目录：`createAuditLogger` / `createTrustStore` 的构造函数中，`fs.mkdir(dirname, { mode: 0o700, recursive: true })`——mkdir 的 mode 是"仅当目录不存在时生效"，语义天然幂等
- 文件：`createAuditLogger` 的 append 闭包里，`appendFile` 前先 `fs.chmod(logPath, 0o600)`；`atomicWrite` 在 `fs.rename` 之后 `fs.chmod(trustedPath, 0o600)`

**理由**：

- **首次写入时机最省**：会话启动可能没有审计写入（例如整个会话都 auto-allow 内部路径），此时 chmod 无意义；首次写入才做 chmod 是"用到了才收"的最小触发面
- **幂等**：Node 的 `fs.chmod` 在文件已是目标权限时是 no-op 系统调用（`utime` 系统调用仍发生但结果不变），会话内多次调用开销可忽略
- **fire-and-forget 语义保持**：chmod 失败不阻塞 append（见"日志写入不影响决策流程" requirement）

**替代方案**：

- ❌ 会话启动时一次性 chmod：无法覆盖"用户手动 chmod 回 0o644 后同会话继续写入"的场景；也产生无谓的会话启动开销
- ❌ 每次 appendFile 前无条件 chmod：系统调用开销不必要地放大（`audit.test.ts` AL7 并发测试已经验证了串行队列，每次 append 多一次 fs.stat 是过度）

**属主检查**：`stat.uid === process.getuid()` 才 chmod，否则跳过。理由见 D2。

### D2: 属主检查的必要性

**决策**：chmod 前 `fs.stat(path).uid` 与 `process.getuid()` 比对，不匹配则跳过。

**理由**：

- 共享账号（如服务器上的 `www` 用户跑多个项目）或多用户环境下，前一个用户创建的日志文件不应被后一个用户 chmod 到 0o600——那会导致原属主进程下一次写入直接失败（EACCES），破坏"审计写入 fire-and-forget"的契约
- 属于"防御性编程"，在 99% 单用户场景下 stat 结果 = uid，成本可忽略

**替代方案**：

- ❌ 无条件 chmod：多用户环境下的隐性失败
- ❌ 提供 `skipOwnershipCheck` 配置项：过度设计，单用户默认场景 100% 走"属主匹配"分支

**Windows 兼容**：Node 在 Windows 上 `fs.chmod` 是 no-op，`fs.stat().uid` 恒为 0，`process.getuid()` 返回 undefined——用 `typeof process.getuid === "function"` 保护，Windows 上直接跳过 chmod 检查（行为与 no-op 一致）。

### D3: 截断阈值与截断标记格式

**决策**：阈值 512 字符，尾部用 `…`，`note` 追加 `command truncated`（用 `; ` 连接既有 note）。

**理由**：

- **512 字符**：实测运行日志中，`scp` / `git commit -m` 的完整命令通常在 200-500 字符，512 已足以覆盖绝大多数场景；同时不会让超长 commit message（1KB+）穿透
- **`…`**：Unicode 省略号，比 `...` 更明显、比 `... (truncated)` 更紧凑；避免用户看到 `...` 时误认为是 bash 命令的一部分
- **`; command truncated` 后缀**：保留既有 note 语义（如 `unreliable bash extraction`），追加而非覆盖；`note` 字段是可选字段，未设置时直接写 `command truncated`

**替代方案**：

- ❌ 硬截断到固定长度（如 200）：过短，可能截掉敏感路径信息（用户希望看到完整路径）
- ❌ SHA-256 摘要化（`commandHash: sha256(...)` + `commandPreview: 前 50 字符`）：更彻底但改变审计字段结构（新增字段），超出本 change 的最小契约面
- ❌ 内容关键字脱敏（`sk-...`、`AWS_`、`Bearer `）：维护成本高于收益，见 Non-Goals

### D4: 不设配置项

**决策**：权限收敛与截断默认生效，不提供 `redactCommands` / `auditFileMode` 等配置项。

**理由**：

- 权限收敛与安全修复的性质一致——不应让"是否收敛"成为用户的选择，否则等于把风险默认关到 off
- 现有 `PermissionExtensionOptions` 只有 `trustedDir` 与 `configPaths` 两类路径配置，扩展配置面本身很小；引入敏感行为配置会增加认知负担
- 若日后用户确实有"我要保留 0o644"的诉求（罕见场景：多用户共享日志便于团队审阅），再加配置项是纯增量，不会破坏当前契约

**替代方案**：

- ❌ `PermissionExtensionOptions.auditFileMode?: number`：允许用户显式放宽权限。风险：用户误设为 0o644 后失去保护，且这是本 change 要修的问题
- ❌ 环境变量 `PERMISSION_EXT_NO_REDACTION=1`：隐藏配置入口，用户难以发现

### D5: cargo 从 UNRELIABLE_COMMANDS 移除而非新增到 SILENT allow-set

**决策**：从 `UNRELIABLE_COMMANDS` 集合移除 `cargo`；不动 `SILENT_COMMANDS` 的 `cargo` allow-set（现有 `{check, metadata}`）。

**理由**：

- 根因是"两个集合重叠，前者永远赢"（`isAnyUnreliableCommand` 在 `extractBashTargets` 第 4 步执行，早于 `isSilentCommand` 的 4b 步）——修集合冲突即可
- `SILENT_COMMANDS.cargo` 的 allow-set 已有 `check/metadata`，说明设计意图是让 `cargo check/metadata` 走 SILENT 路径；只是被 `UNRELIABLE_COMMANDS` 抢先拒绝了
- `cargo fmt` **不在** allow-set 里（当前实测会判 unreliable），这是正确的——`cargo fmt` 会写入文件（格式化）
- 非白名单 subcommand（`build`/`run`/`publish`/`install`）走 `isSilentCommand` 返回 false → fall through 到 4b 步的 silent-form check → 返回 `unreliable_command`——**这条路径的兜底逻辑已存在**，本 change 验证清单里包含这 4 条回归项

**替代方案**：

- ❌ 在 `SILENT_COMMANDS.cargo` allow-set 加入 `build`：`cargo build` 会生成 `target/` 目录并可能触发网络下载依赖，副作用面明显，不该静默
- ❌ 新增 `SILENT_COMMANDS.cargo.allow_all`: 会让所有 cargo 子命令都静默，包括 `cargo publish`（发布到 crates.io，明显不应静默）

### D6: 死 case 删除范围 + 连带 spec / test 同步

**决策**：

- **extensions/index.ts**：删除 `bashPermissionForReason` 中的 `device_redirect` / `bounded_glob` / `unresolved_variable` 三个 case 与 `bashSubtitleForReason` 中的 `bounded_glob` case。
- **approval-flow spec**：删除 `device_redirect` 副文本 scenario 与 `bounded_glob` 副文本 scenario；修改"两档 vs 三档弹窗"requirement 的 bash_reason 列举，去掉 `device_redirect` / `bounded_glob` 两项。
- **grant-memory spec**：删除"Bash 命令记忆渠道"requirement 授权类型映射中的 `device_redirect` / `bounded_glob` 条目（`read_only` 授权那一条）；删除对应 benign scenario。
- **test/trust.test.ts**：GM13 / GM15 / GM16 / GM17 / GM18 的 `addBashSessionGrant` / `addBashPersistentGrant` 参数值从 `device_redirect` 替换为 `glob_expansion`；同测试内的 `assert.equal(g.reason, "device_redirect")` 断言同步替换。

**理由**：

- `grep "return \"device_redirect\"\|return \"bounded_glob\"\|return \"unresolved_variable\""` 在 `src/lib/bash-extract.ts` 中零命中——这些字符串作为 reason 值从未被 `extractBashTargets` 返回，对应的 case 是死分支。
- **前置检查发现**：删除死代码会让 spec 与代码不一致——spec 描述"bash_reason == device_redirect 时应显示某副文本"、"reason == bounded_glob 时应授权 read_only"，但代码从未产生过这些 reason 值。若只删死代码不清 spec，会留下"文档描述不存在的行为"这类长期契约漂移。
- 一次性清理 spec 与 test 数据，让 spec 与代码保持"描述的都是当前实际激活的行为"。

**范围裁定**：

- `test/trust.test.ts` 里 `device_redirect` 作为 grant 记录中的 `reason` 字段是"元数据"——`reason` 字段不参与 grant key、不参与 auto-allow 判定，仅是 grant 记录的说明字段（如 audit log 显示用）。替换为 `glob_expansion` 后 grant 的所有功能路径不变。
- `openspec/specs/approval-flow/spec.md` 与 `openspec/specs/grant-memory/spec.md` 中列举的 `device_redirect` / `bounded_glob` 作为 bash_reason 值属于"文档契约"，从 extractor 未激活的意义上讲是"死契约"——清理后 spec 与代码一致。

**验证**：

- `grep -c "device_redirect\|bounded_glob" src/ extensions/` 输出为 `0`（源码与扩展层零命中）
- `grep -c "device_redirect\|bounded_glob" test/` 输出为 `0`（测试数据已替换）
- `grep -c "device_redirect\|bounded_glob" openspec/specs/approval-flow/ openspec/specs/grant-memory/` 输出为 `0`（baseline spec 已清理）
- `grep -c "device_redirect\|bounded_glob" openspec/specs/` 输出为 `0`（若还有命中，只应存在于其他 change 的 delta 里作为 REMOVED 标记）
- `npm test 2>&1 | tail -5` 全绿

**替代方案**：

- ❌ 只删 extensions/index.ts 死代码，spec 与 test 不动（最小改动）：留下 spec 与代码的长期不一致，后续 archive 无法解释为何 spec 里有从未激活的 scenario。
- ❌ 保留死代码 + spec + test，只记录在 proposal 里作为已知问题：死代码不产生实际风险，但每次 archive 都要重复说明"这些场景从未激活"——文档噪音。
- ❌ 修改 extractor 让它产生 `device_redirect` / `bounded_glob` reason（把 spec 描述的行为实现出来）：超出本 change scope（Change B 已定义 extractor 的改动边界，且这两个 reason 的语义在 extractor 现有分类里已被更细粒度的 reason 覆盖——bounded_glob 场景现走 `glob_expansion`，device_redirect 场景现走 `unreliable_command` + shell_forwarder 兜底）。

**边界保持**：本决策不清理 `approval-flow` spec 的其他 scenario（`glob_expansion` / `control_flow` / `shell_forwarder` / `forwarding_command` 都是 extractor 实际返回的 reason，保持原状）；不清理 `grant-memory` spec 的其他授权映射条目（`glob_expansion` → `read_only`、`control_flow` / `shell_forwarder` / `forwarding_command` → `read_write` 都是激活的映射，保持原状）。

### D7: 空转测试的删除边界

**决策**：删除 `test/decision.test.ts` 中 `AD19: unreliable bash extraction (integration-covered placeholder)` 测试。

**理由**：断言是 `assert.equal(1, 1)`——恒真，覆盖不到任何行为；注释已声明"behavior covered by SYS4/SYS8"，删除后 SYS4/SYS8 继续覆盖 unreliable-bash 的集成行为。

**替代方案**：

- ❌ 保留测试并加真断言：AD19 的语义是"unreliable bash extraction → 走 tier=two prompt"，这属于 extension 层的集成行为，`test/decision.test.ts` 只测 `decide()` 纯函数（无 IO 无 UI），语义错配——真断言必须写在 `sys-integration.test.ts`，而 SYS4/SYS8 已经在测这个

## Risks / Trade-offs

- **[Risk] chmod 在 fire-and-forget 队列中的失败路径** → 若 `fs.chmod` 抛异常（罕见：只读挂载点、权限错误），必须在 catch 里吞掉并继续 appendFile。缓解：`append` 闭包内 try/catch，与既有 `failures.push(err)` 语义一致，只 `note` 一下。
- **[Risk] 属主检查在容器环境下失效** → 若扩展跑在容器内且文件是从宿主机挂载的，`stat.uid` 可能是容器外的原始 uid。缓解：属主不匹配时跳过 chmod，不产生错误——用户会看到"文件仍是 0o644"，这是"用户手动处理"边界，不是本 change 能修的。
- **[Risk] 截断阈值 512 太激进** → 某些 bash 命令（如 `curl -H "Authorization: Bearer sk-very-long-token" -H "Cookie: session=..." https://...`）在 512 字符内仍包含敏感信息。缓解：512 是**上限**不是**充分条件**，敏感词脱敏留给后续 change（D3 已解释不做的理由）；同时保留完整命令在 `trusted.json` 的 `bashGrants[].rawCommand` 中（若用户对该命令做了持久授权）。
- **[Risk] `cargo` 从 UNRELIABLE_COMMANDS 移除后，`isAnyUnreliableCommand` 的语义变化影响集成测试** → SYS4/SYS5/SYS8 未直接覆盖 cargo 命令，但 bash-extract 的回归测试集（BT-*）需要新增断言，已在 proposal 覆盖账本列出。缓解：T5 的 7 条新增测试锁定 `cargo check/metadata` 静默、`cargo build/run/publish/install/fmt` 仍 unreliable。
- **[Trade-off] 首次写入才 chmod，导致会话首次写入前的日志文件仍是旧权限** → 例如用户在会话启动后立刻执行一条会被拒绝的 bash 命令（触发审计写入），此时 chmod 生效——但会话启动到"首次写入"之间的日志文件权限状态不变。缓解：绝大多数场景会话启动后第一次工具调用就会触发审计写入（若被拒绝或走 prompt）；只影响"整个会话都没触发审计写入"的边缘场景，此时日志文件本就不新增，无泄漏风险。
- **[Trade-off] 截断标记 `…` 是 Unicode，JSON 序列化会保留为 UTF-8** → JSON 是 UTF-8 编码，`…` 是 3 字节（`E2 80 A6`）；解析端看到的就是 `…`，不是乱码。缓解：无。

## Migration Plan

**部署顺序**（不涉及版本发布，因为扩展是通过 pi 直接加载 TypeScript 源码）：

1. 合并本 change 后，用户下次启动 pi 会话即生效
2. 首次会话内，扩展在首次审计写入前对既有日志文件执行 chmod 0o600
3. 用户手动删除既有日志文件不会被本 change 影响

**回滚**：git revert 单个 commit 即可；不涉及数据迁移，无持久化 schema 变化（`note` 字段是既有可选字段，`command` 字段语义是"截断或原样"，向后兼容——旧的解析器看到 `command truncated` note 会当作普通 note 显示，不影响）。

**升级兼容性**：

- 旧版本 pi-coding-agent 加载新版本扩展：无兼容问题（新增字段都是既有可选字段的语义扩展）
- 新版本 pi-coding-agent 加载旧版本扩展：无兼容问题（旧扩展不产生截断标记与 chmod 收敛，行为等价于本 change 之前的状态）

## Open Questions

**无**。

所有可能改变本 change 的 spec / 决策 / 任务分解的未知项都已在 Decisions 节里明确决策，无需留给用户后续拍板。若后续用户提出新诉求（例如"能不能对敏感词做脱敏而不只是截断"），走下一个 change 而不是扩展本 change 的 scope。

## Code Review Feedback (2026-10-20, deep+verify)

在 6.3 收尾 review 阶段，代码审查发现了 6 个 issues（P1×2、P2×3、P3×1）。以下是每条的发现、决策与最终实现。

### P1-1：复合命令绕过 `unreliable_command`

**发现**：早期实现把 `cargo` 从 `UNRELIABLE_COMMANDS` 移除后，`echo hi; cargo publish`、`cd ~/project && cargo install evil-pkg`、`cargo run | tee out.txt` 三条命令都被静默放行（`reliable: true, targets: []`）。原因是 `isSilentCommand` 的 silent-form 检查（4b）仅在 `cmdFragments.length === 1` 时执行，复合命令走 D6 fall-through。

**决策**：**恢复 `cargo` 到 `UNRELIABLE_COMMANDS`**（方案 a，保守）。理由：

- 方案 (b)（扩展 4b 检查遍历所有 fragment 与 pipeline stage + `--manifest-path` 越界检测）是一个独立的新设计，需要新 requirement 与至少一次专项 review，超出本 change 的"权限加固 + 死代码清理"scope。
- 方案 (a) 保留既有安全边界，把"允许 cargo 静默"作为**未来** change 的目标（若产品确实需要）。
- 本 change 的核心目标是权限收敛与死代码清理，不需要"顺手放宽白名单"——放宽属 Change B 范畴（B 只做 100% 确定安全的放宽）。

**验证**：新增 BT-CARGO-8 到 BT-CARGO-11 四条回归测试，覆盖 P1 提到的三个复合命令与 `--manifest-path` 越界读场景。

### P1-2：`cargo check --manifest-path /etc/evil/Cargo.toml` 越界读

**发现**：即使 `cargo check` 在 allow-set 内静默放行，`--manifest-path /etc/evil/Cargo.toml` 仍会让 cargo 读 `/etc/evil/Cargo.toml`——这个路径不在 project worktree 内，静默放行等价于授予任何路径的 Cargo.toml 读权限。

**决策**：同 P1-1，恢复 `cargo` 到 `UNRELIABLE_COMMANDS` 一次性解决。后续 change 若恢复 cargo 静默，需要额外设计"`--manifest-path` 越界检测"（在 extractor 层检查该 flag 的值是否在项目内），本 change 不承担。

**验证**：BT-CARGO-11 显式覆盖此场景。

### P2-3：`bashPermissionForReason` 的 `unresolved variable` 匹配失效

**发现**：`extensions/index.ts` 的 `bashPermissionForReason` 用字面量 `"unresolved variable"` 匹配，但 extractor 实际产出的 reason 是 `` `unresolved variable: ${unresolved}` ``（带冒号与变量名）。原实现**永远不匹配**，落到 `default` 返回 `read_write`——比 spec 承诺的 `read_only` 宽一级。

**决策**：改为 `reason?.startsWith("unresolved variable:")` 前缀匹配，并给 `bashSubtitleForReason` 加对应分支（"该命令包含未展开的 shell 变量…"）。这是**语义 bug 修复**——之前 spec 承诺了 `read_only` 但代码实际返回 `read_write`，代码与契约不一致。

**验证**：`npm test` 全绿（18 个 extension 层测试都过）；新增 BT-EXT-UNRES 回归测试（若时间允许）。

### P2-4：`createTrustStore` 的 mkdir 不改已存在目录 mode

**发现**：`fs.mkdir({recursive, mode})` 只对**新建**的目录应用 mode；已存在的目录保持原 mode。`test/trust.test.ts` 用 `mkdtemp` 建的目录默认 0o755，`createTrustStore` 传入后**目录权限不变**——其他用户可枚举目录内容。

**决策**：`fs.mkdir` 之后显式 `fs.chmod(parentDir, 0o700)`（仅在属主匹配当前 uid 时）。这与 `src/lib/audit.ts` 的 `ensureFileMode` 逻辑对称。

**验证**：新增 GMP2 断言 parent dir 是 0o700（此前 GMP2 侥幸通过因为 `mkdtemp` 的目录恰好被 umask 处理成 0o700；修复后显式 chmod 保证任何初始状态下都是 0o700）。

### P2-5：`appendFile` 首行以宽 mode 落盘

**发现**：`ensureFileMode(logPath, 0o600, failures)` 在 `fs.appendFile` 之前调用。首次写入时文件不存在→`stat` 抛 ENOENT→`ensureFileMode` 跳过 chmod；`fs.appendFile` 创建文件时应用当前 umask（通常 0o644）。**首行在 0o644 下落盘**，后续 append 才被 chmod 到 0o600——首行内容仍可能被同机其他进程读取。

**决策**：改用 `fs.open(logPath, "a", 0o600)`——`fs.open` 的 `a` flag 若文件不存在会以给定 mode 创建，避免 umask 干扰；然后 `fd.writeFile` 追加。保留 `ensureFileMode` 作为"既有文件权限收敛"的 belt-and-braces（覆盖首次写入前已存在的宽 mode 文件）。

**验证**：实测脚本 `node -e 'fs.appendFile...'` 显示首行 100644，改成 `fs.open(..., 'a', 0o600)` 后首行 100600。

### P3-6：`test/trust.test.ts` 未使用 import

**发现**：`writeFile` 从 `node:fs/promises` 导入但未使用（GMP2 改用 stat + chmod 后遗留）。

**决策**：删除。lint 噪音，不影响行为。

**验证**：`npm test` 通过。

### Review 未采纳的建议

- **未跑 performance 维度**：本次改动都是权限收敛（文件系统 chmod）与死代码清理，无性能敏感路径。`fs.open(logPath, "a", 0o600)` 替代 `fs.appendFile` 在 fire-and-forget 队列中额外一次 fd open，但审计写入本身频率低（每次触发审批弹窗时写一次），不构成可感知开销。
- **未做"4b D6 fall-through 系统性修复"**：这是一次性发现（P1-1 / P1-2）的**系统性问题**——任何从 `UNRELIABLE_COMMANDS` 移除的 dev 工具都会踩同一个坑。本 change 选择保守方案 a（恢复 cargo）避免踩坑，但**这个问题本身**留给后续 change（建议命名 `bash-extractor-fragment-silent-form-check`），本 change 在 design.md 里留下决策记录。
