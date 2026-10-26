# Changelog

本文件记录 permission-guard-pi 的版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-10-27

### Changed

- **tier 语义收敛**：`Decision.PromptTier` 从"敏感语义标签"收敛为"可持久化能力标签"。unreliable bash 命令（heredoc、subshell、`bash -c`、未引号 glob 等无法静态解析的命令）从 tier=two 升为 **tier=three**，弹窗提供"总是允许本命令"选项，将 rawCommand 持久化到 `trusted.json.bashGrants` 段（跨会话静默）。unreliable bash 持久化是独立于 path 通道的"raw-command 通道"，仅存原始命令文本，不涉敏感路径。详见 `openspec/changes/tier-contract-consistency/proposal.md` A1 节。
- **SSH 公钥文件降级 soft**：`~/.ssh/known_hosts` / `~/.ssh/authorized_keys` 从 hard sensitive（tier=two 不可持久化）移至独立的 soft SSH 公钥文件规则（tier=three 可持久化）。理由：两者是客户端存储的公钥列表（已知主机公钥 / 授权公钥），泄露可重生成，无"不可逆凭证"风险，误伤日常读取。`~/.ssh/config` 仍为 hard（可能引用私钥路径）。
- **配置加载期通配覆盖 warning**：`mergePolicies` 新增 `checkWildcardOverrideWarning` 校验——当用户声明的通配路径（如 `{"~/.ssh/**": "read_write"}`）覆盖至少一条硬敏感锚点（`HARD_SENSITIVE_ANCHORS`，从 `DEFAULT_SENSITIVE_RULES.anchor` 字段派生，共 26 条）时，启动阶段通过 `ctx.ui.notify` 提示单行 warning（含命中锚点样本 + 覆盖权限 + 缩窄建议）。不阻断启动，用户显式配置优先；精确路径与 `unread` 不提示。详见 `design.md` A4 D3 节。

### Fixed

- **文档漂移**：README "How decisions work"、`docs/security/permission-model.md` 与 `bash-target-extraction` spec 中 tier=two 弹窗描述与实现不一致，本次同步修复。
- **SensitiveRule 接口可发现性**：新增 `anchor?: string[]` 可选字段作为锚点声明入口，与 `HARD_SENSITIVE_ANCHORS` 常量建立单一事实源，避免多处硬编码漂移。soft 规则不声明 anchor（不参与 warning 判断）。

### Notes

- BREAKING 语义（用户可见）：unreliable bash 弹窗从两档变为三档，新增 rawCommand 持久化能力。若不希望某条 rawCommand 跨会话持久化，编辑 `~/.pi/agent/extensions/permission-guard-pi/trusted.json` 的 `bashGrants` 段手动移除。
- 已知限制：warning 仅统计锚点覆盖，不代表通配实际覆盖的所有敏感路径。通配若跨用户目录边界（如 `{"/": "read_write"}`），锚点检测覆盖度受 `HARD_SENSITIVE_ANCHORS` 声明精度限制，私有 key 扩展名仅覆盖 `.pem` / `.key` 两条代表性锚点（设计已接受）。

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
