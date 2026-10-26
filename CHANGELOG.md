# Changelog

本文件记录 permission-guard-pi 的版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
