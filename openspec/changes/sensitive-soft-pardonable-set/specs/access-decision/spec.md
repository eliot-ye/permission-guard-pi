## ADDED Requirements

### Requirement: 可赦免敏感路径分级与 tier 语义

默认敏感规则表 SHALL 分为 **hard** 与 **soft** 两级，各级的弹窗档位（tier）分派不同：

- **hard sensitive**（不可撤销凭证）：SSH 私钥（`~/.ssh/id_rsa` 等）、私钥扩展名（`.pem`/`.key`/`.pfx`/`.p12`/`.jks`/`.kdbx`/`.asc`/`.gpg`）、凭证目录（`~/.aws`/`~/.kube`/`~/.docker`/`~/.netrc`/`~/.git-credentials`/`~/.gnupg`/`~/.ssh`）、凭证配置文件（`credentials`/`secrets.*`/`.npmrc`/`.netrc`）、系统机密（`/etc/shadow`/`/etc/sudoers`/`/etc/master.passwd`/`/etc/crontab`/`/etc/cron.*`/`/etc/hosts.allow`/`/etc/hosts.deny`）。沿用既有 tier 语义——项目内 tier=three（可持久化）、项目外 tier=two（不可持久化）。
- **soft sensitive**（可撤销凭证）：通用配置文件名 `config`/`auth`/`settings`/`models` + 凭证扩展名 `.json`/`.toml`/`.yml`/`.yaml`（basename 精确匹配，即 `<name>.<ext>` 形态）。不论区域，决策为 prompt **tier=three**（可持久化赦免）。

**override 语义**：soft sensitive 的 tier=three override 本 spec "未配置路径的行为" requirement 中"项目外敏感路径 tier=two"条目——soft sensitive 项目外路径走 tier=three（可"总是允许"）而非 tier=two。hard sensitive 不受 override，沿用既有 tier=two 外区不可持久化。

**范围约束**：
- soft 集合按 basename 精确匹配（`config`/`auth`/`settings`/`models` + 凭证扩展名），不含无扩展名的 `config`——`~/.ssh/config` 仍 hard（由 SSH key 规则的 `b === "config" && d.endsWith("/.ssh")` 覆盖）。
- soft 集合不包含 `~/.ssh/id_rsa` 等不可撤销凭证（仍 hard）。
- soft 集合不含 `.ts`/`.js`/`.py` 等代码扩展名——`config.ts`/`auth.py` 不命中 soft（避免误伤项目内代码模块）。

**理由**：soft 集合含 apikey/token，多可吊销重置（区别于私钥不可撤销）；持久化赦免换取首弹后免打扰，风险可控（用户可编辑 `trusted.json` 撤销持久化 grant）。

#### Scenario: 项目外 config.yml 读弹 tier=three 可持久化

- **WHEN** 无配置，工具读 `~/.config/gh/config.yml`（命中 soft sensitive "config" + `.yml`）
- **THEN** 决策为 prompt tier=three（提供"总是允许"持久化选项），而非既有 tier=two

#### Scenario: 项目外 auth.json 读弹 tier=three

- **WHEN** 无配置，工具读 `~/.config/app/auth.json`（命中 soft "auth" + `.json`）
- **THEN** 决策为 prompt tier=three

#### Scenario: ~/.ssh/id_rsa 外区读仍 tier=two 不可持久化

- **WHEN** 无配置，工具读 `~/.ssh/id_rsa`（命中 hard sensitive SSH key）
- **THEN** 决策为 prompt tier=two（不提供"总是允许"），soft override 不适用

#### Scenario: ~/.ssh/config 仍 hard 不受 soft 集合影响

- **WHEN** 无配置，工具读 `~/.ssh/config`（命中 hard SSH config 规则，basename 精确 `config` 在 `.ssh` 目录，无扩展名）
- **THEN** 决策按 hard sensitive tier 语义（外区 tier=two），soft 集合的 `config.*` 不匹配（要求凭证扩展名）

#### Scenario: 项目内 config.json 读弹 tier=three

- **WHEN** 无配置，工具读 `<proj>/config.json`（命中 soft "config" + `.json`）
- **THEN** 决策为 prompt tier=three（可持久化），与既有"项目内敏感 tier=three"一致

#### Scenario: config.ts 不命中 soft（代码扩展名）

- **WHEN** 无配置，工具读 `<proj>/config.ts`（basename `config` + `.ts`，`.ts` 非凭证扩展名）
- **THEN** 不命中 soft sensitive，按"项目内非敏感 auto_allow"处理

#### Scenario: settings.toml 命中 soft

- **WHEN** 无配置，工具读 `~/.config/app/settings.toml`（命中 soft "settings" + `.toml`）
- **THEN** 决策为 prompt tier=three

#### Scenario: models.json 命中 soft

- **WHEN** 无配置，工具读 `~/.config/app/models.json`（命中 soft "models" + `.json`）
- **THEN** 决策为 prompt tier=three

#### Scenario: 用户配置声明覆盖 soft sensitive

- **WHEN** 全局配置声明 `~/.config/gh/config.yml = "read_only"`，工具读该路径
- **THEN** 决策为 auto_allow（配置声明优先于敏感兜底，soft 与 hard 一致）
