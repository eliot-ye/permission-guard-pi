# Changelog

本文件记录 permission-guard-pi 的版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-10-28

### Added

- **UI 多语言支持（en / zh）**：弹窗选项、副文本、notify 消息全部本地化。新增 `src/lib/i18n.ts` / `lang-detect.ts` / `settings.ts` / `reason-codes.ts` 四个纯函数模块。用户可通过 `~/.pi/agent/extensions/permission-guard-pi/settings.json` 的 `lang` 字段或 `$PI_LANG` env var 选择语言；默认 `$LANG` 前缀，最终 fallback 到 `en`。详见 `openspec/changes/ui-i18n/proposal.md`。
- **ReasonCode 稳定契约**：`src/lib/reason-codes.ts` 定义 13 个 Decision code + 7 个 Sensitive code + 15 个 Bash code + 15 个 UI code，命名 snake_case / 无域前缀 / past tense。UI 层通过 code + lang 查 bundle；audit 日志保持英文稳定字符串，跨版本兼容。
- **整体启用/关闭 + `/permission` 斜杠命令（P3）**：`settings.json` 新增 `enabled?: boolean`（缺省视为 `true`，fail-safe 向后兼容）。`settings.enabled === false` 时 gate 在 `tool_call` 入口 no-op（`return undefined`，pi 原生处理）。`pi.registerCommand("permission")` 提供 `/permission` 显示状态、`/permission on|off` 切换并持久化到 settings.json；session_start 与切换后通过 `ctx.ui.setStatus` 更新 footer 状态标记（🔒 已启用 / 🔓 已关闭）。所有文本走 i18n（en/zh）。详见 `openspec/changes/permission-enable-toggle/proposal.md`。

### Changed

- **tier 语义收敛**：`Decision.PromptTier` 从"敏感语义标签"收敛为"可持久化能力标签"。unreliable bash 命令（heredoc、subshell、`bash -c`、未引号 glob 等无法静态解析的命令）从 tier=two 升为 **tier=three**，弹窗提供"总是允许本命令"选项，将 rawCommand 持久化到 `trusted.json.bashGrants` 段（跨会话静默）。unreliable bash 持久化是独立于 path 通道的"raw-command 通道"，仅存原始命令文本，不涉敏感路径。详见 `openspec/changes/tier-contract-consistency/proposal.md` A1 节。
- **SSH 公钥文件降级 soft**：`~/.ssh/known_hosts` / `~/.ssh/authorized_keys` 从 hard sensitive（tier=two 不可持久化）移至独立的 soft SSH 公钥文件规则（tier=three 可持久化）。理由：两者是客户端存储的公钥列表（已知主机公钥 / 授权公钥），泄露可重生成，无"不可逆凭证"风险，误伤日常读取。`~/.ssh/config` 仍为 hard（可能引用私钥路径）。
- **配置加载期通配覆盖 warning**：`mergePolicies` 新增 `checkWildcardOverrideWarning` 校验——当用户声明的通配路径（如 `{"~/.ssh/**": "read_write"}`）覆盖至少一条硬敏感锚点（`HARD_SENSITIVE_ANCHORS`，从 `DEFAULT_SENSITIVE_RULES.anchor` 字段派生，共 26 条）时，启动阶段通过 `ctx.ui.notify` 提示单行 warning（含命中锚点样本 + 覆盖权限 + 缩窄建议）。不阻断启动，用户显式配置优先；精确路径与 `unread` 不提示。详见 `design.md` A4 D3 节。
- **Decision 与 SensitiveRule 新增 code 字段**：`Decision.reasonCode?: ReasonCode`（可选，向后兼容），`SensitiveRule.code: SensitiveReasonCode`（必填，因为所有实例都在 `DEFAULT_SENSITIVE_RULES` 中定义）。审计层不变，UI 层可基于 code 稳定分派。
- **`promptUser()` 选项匹配规则**：`allow_once` / `allow_session` / `deny` 按 identity 匹配；`always_allow` / `always_allow_command` 按前缀匹配（`Always allow` / `总是允许`），兼容 bash 命令类弹窗的"总是允许本命令"变体。

### Fixed

- **bash grant 键词法 whitespace 规范化（P1 e2）**：`hashCommand`（grant 键派生）在哈希前做 `replace(/\s+/g," ").trim()` 规范化，与 rule 通道（`normalizeWhitespace`）对齐。此前同一命令 `git status`（单空格）与 `git  status`（双空格）被 grant 通道判定为不等价而重复弹窗，rule 通道却视为等价——用户可见的不一致。等价性仅为词法 whitespace，不做 grammar 级等价（AST 方案 e3 被否决：grammar 级等价会错误自动放行 `cd /etc && git status`，有负面安全价值）。
- **audit auto-allow 记录补全（D1/D2）**：`audit-log` 契约要求"所有决策必须记录（唯一例外：项目内未配置非敏感常规读写）"，此前文件工具 + 可靠 bash 的 `auto_allow` 未记录。本次除 `in_project_default_allowed` 例外外补齐 `audit.log({ event: "auto_allow", ... })`（透传决策对象的 `authorization` / `grant_source`）；可靠 bash `hard_deny` 补 `authorization: "presumed"`（与文件工具 hard_deny 对齐）。
- **平台/解析器/审计边界卫生（B2-B6）**：`addBashPersistentGrant` 的 input type 改为 `Omit<BashGrant, "commandHash" | "createdAt">`（把"哈希由 store 派生"写进类型系统）；audit log 长命令截断到 511 字符时补写 `commandHash: sha256(原始命令)` 兜底（让事后审计能精确匹配 trusted.json 里的 grant）；`stripJsonComments` 去掉单引号字符串起点处理（JSONC 严格只支持双引号），并在 `permission-config` spec 加"不支持单引号字符串"约束；`isDefaultTmpPath` 补 `/var/tmp` + `/var/tmp/` 前缀；`package.json` `files` 白名单补 `docs/` + `examples/`。
- **grant 与 rule 通道对齐**：`trust.ts` grant 键做词法 whitespace 规范化（见上 P1 e2），与 `config.ts` `normalizeWhitespace` 对齐。
- **文档漂移**：README "How decisions work"、`docs/security/permission-model.md` 与 `bash-target-extraction` spec 中 tier=two 弹窗描述与实现不一致，本次同步修复。
- **SensitiveRule 接口可发现性**：新增 `anchor?: string[]` 可选字段作为锚点声明入口，与 `HARD_SENSITIVE_ANCHORS` 常量建立单一事实源，避免多处硬编码漂移。soft 规则不声明 anchor（不参与 warning 判断）。

### Refactor

- **bash-extract 拆分独立子系统**：`src/lib/bash-extract.ts`（3421 行 / 29 requirement）拆分为 `src/lib/bash-extract/` 目录 8 个文件，按语义域组织（`index.ts` barrel / `entry.ts` / `parse.ts` / `scan.ts` / `readonly.ts` / `silent.ts` / `extractors.ts` / `control-flow.ts` / `shell-forwarder.ts`）。对外 API 契约（13 个 export 符号）与 import 符号完全不变，spec 文本不变（行为契约不是组织契约）；`profile-tier.yaml` 将 `bash-extract` 从 `side-effects` 拆出独立子系统条目。
- **extension-orchestration 清理死代码**：删除纯死变量 `ctxRef`（`extensions/index.ts` 3 行赋值从未被读）与纯死方法 `clearBashGrants`（`src/lib/trust.ts` 生产 + 测试调用均为 0）。保留测试 seam `clearSessionGrants`（生产 0 + 测试 2 调用）并加注释防复发；`session_start` 清空会话记忆的契约由 `initSession` 整体重建 `TrustStore` 满足，无需显式调用 clear。

### Notes

- **BREAKING 语义（用户可见）**：unreliable bash 弹窗从两档变为三档，新增 rawCommand 持久化能力。若不希望某条 rawCommand 跨会话持久化，编辑 `~/.pi/agent/extensions/permission-guard-pi/trusted.json` 的 `bashGrants` 段手动移除。
- LLM prompt (`BASH_GUARDRAILS`) 保持英文。
- audit 日志 `reason` / `note` 字段保持英文稳定字符串，不消费 i18n。
- settings.json 是用户本地个人偏好（不进 git），与 `trusted.json` 同级同性质。
- 已知限制：warning 仅统计锚点覆盖，不代表通配实际覆盖的所有敏感路径。通配若跨用户目录边界（如 `{"/": "read_write"}`），锚点检测覆盖度受 `HARD_SENSITIVE_ANCHORS` 声明精度限制，私有 key 扩展名仅覆盖 `.pem` / `.key` 两条代表性锚点（设计已接受）。
- Spec 漂移修复：`approval-flow` / `access-decision` spec 里 bash reason 相关断言文本与代码对齐；`glob_expansion` 和 `command_substitution` 均为代码实际产生的 reason（本 change 保留相应 scenario，转为 lang-aware）。
- 契约澄清（纯 spec，无代码变化）：`grant-memory` Req 8 明确"不可靠 bash 只查 deny 规则（deny 优先），allow 规则对不可靠命令不生效；可靠 bash 才经规则解析（allow/deny 均生效）"——安全边界文档化；审计日志字段以 `grant_source` 为权威来源标注（`grant_type` 降级为可选/移除，`saved_to`/`reason` 由 `note` 覆盖）。

## [0.2.0] - 2026-10-26

### Added

- **sensitive hard/soft 分级**：`SensitiveRule` 新增 `level: "hard" | "soft"` 字段。soft 级覆盖通用配置文件名（`config`/`auth`/`settings`/`models`）+ 凭证扩展名（`.json`/`.toml`/`.yml`/`.yaml`），basename 精确匹配——项目外读写 delete 均弹 tier=three prompt（堵凭证泄露盲区），用户"总是允许"后持久化静默。区别于 hard（`~/.ssh/id_rsa` 等不可撤销私钥）仍 tier=two 不可持久化。
- **规则排序不变式**：soft 规则追加于 `DEFAULT_SENSITIVE_RULES` 末尾，`findSensitiveMatch` 首匹配语义保证 hard 永远优先——`~/.aws/config.json`、`~/.docker/config.json`、`config.pem` 等重叠路径仍走 hard。
- **delete 一并放宽**：soft 的 delete 同 tier=three 可持久化（路径粒度，非命令 hash 粒度），已知边界——删除后文件无法通过吊销 token 恢复，用户确认接受并文档化于 spec / proposal / decision.ts 注释。
- npm Trusted Publishing（OIDC provenance）发布工作流，release-driven 模式。

### Changed

- `decide()` step 2b tier 分派从 `isInside ? "three" : "two"` 改为按 `sensitive.level` 分派：soft 不论内外 tier=three，hard 沿用外区 tier=two / 内区 tier=three。

### Fixed

- bash 符号链接目标 grant 键不一致导致反复弹窗——`tryRealpath` 解析后路径与原始路径的 grant 键不匹配，同一符号链接每次访问都重新弹窗。

## [0.1.1] - 2026-10-23

### Added

- 分层文件访问控制扩展：双区域（project_inner / project_outer）× 三档权限（read_write / read_only / unread）。
- 会话级与持久化 grant memory（`trusted.json`），含 `authorization`/`grant_source` 字段区分 Presumed 与 ByPerson。
- 默认敏感路径表（SSH 私钥、凭证目录、env 文件、系统机密等）+ 三层弹窗档位（tier=three 可持久化 / tier=two 不可持久化 / deny_hard）。
- bash 命令守卫：封堵符号链接绕过、glob 展开静默放行、bounded glob 误判三类绕过。
- tool + pattern 规则语法，支持命令族预授权。
- 安全边界文档，明确 Non-Goals / Known Limitations / Explicit Boundary。
- audit log（追加写入 + 文件权限收敛 0o600/0o700 + command 字段截断）。
