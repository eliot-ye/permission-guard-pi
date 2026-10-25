## ADDED Requirements

### Requirement: 可赦免敏感路径外区持久化授权

soft sensitive 路径（见 `access-decision` spec 的"可赦免敏感路径分级与 tier 语义" requirement）的项目外持久化授权 SHALL 允许写入 `trusted.json`——override 本 spec "未配置路径不写入持久化" requirement 的 tier=two 限定。

**语义约束**：
- soft sensitive 项目外路径命中 tier=three（非 tier=two），用户选"总是允许"时 MUST 写入持久化 grant，键含完整路径（按文件粒度，与既有 sensitive 按文件记忆一致）。
- hard sensitive 项目外路径仍 tier=two，"总是允许"选项不出现，不写入持久化（既有"未配置路径不写入持久化" requirement 不变）。
- 撤销语义不变：用户可编辑 `trusted.json` 删除 soft 持久化 grant，删除后该路径重新走 tier=three prompt。

**理由**：soft sensitive 含可撤销凭证（apikey/token），持久化赦免换首弹后免打扰；hard sensitive 含不可撤销私钥，仍不可持久化（既有硬底线不变）。

#### Scenario: soft sensitive 外区"总是允许"写入持久化

- **WHEN** 用户对项目外 `~/.config/gh/config.yml`（soft sensitive）选"总是允许"
- **THEN** `trusted.json` 写入 `{projectHash, action, path: resolvedPath, permission, author: "by_person", createdAt}`，后续同会话/跨会话同路径读 auto_allow

#### Scenario: hard sensitive 外区仍不可持久化

- **WHEN** 用户对项目外 `~/.ssh/id_rsa`（hard sensitive）的 tier=two prompt 选"会话内允许"
- **THEN** 仅会话级记忆更新，`trusted.json` 无新条目（tier=two 不可持久化不变）

#### Scenario: soft 持久化 grant 撤销后重新弹窗

- **WHEN** 用户曾对 `~/.config/gh/config.yml` 选"总是允许"写入持久化，后编辑 `trusted.json` 删除该条目，再读该路径
- **THEN** 重新走 tier=three prompt（撤销语义与既有 grant 一致）

#### Scenario: soft sensitive 按文件记忆不抬开目录

- **WHEN** 用户对项目外 `~/.config/app/config.json` 选"总是允许"
- **THEN** 持久化 grant 仅对 `config.json` 生效，`~/.config/app/settings.json` 的读取仍需重新授权（按文件粒度，与既有 sensitive 按文件记忆一致）
