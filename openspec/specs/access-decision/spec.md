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
