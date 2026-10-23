## ADDED Requirements

### Requirement: Grant 记录 author 字段

持久化授权记录（`Grant` 与 `BashGrant`）MUST 支持可选字段 `author`，标识该条记录的授权来源：

- `"by_person"`：真人主动授权写入（当前唯一写入路径）
- `"presumed"`：系统/规则命中写入（当前无写入路径，类型能力保留）
- `"migration"`：迁移/导入路径写入（当前无写入路径，用于未来可信性存疑的批量迁移）

**语义约束**：
- `author` 字段是**写入时决定、读取时透传**的元数据——不改变 Grant 的键结构（`<projectHash> | <action> | <absPath>`）与匹配语义
- 决策引擎读取 Grant 时 MUST 使用 `author` 字段派生 `Decision.authorization`（见 access-decision spec 的"grant memory 命中带 by_person 授权" scenario）
- 撤销语义 MUST NOT 因 `author` 字段变化——`session_start` 清空、手动编辑 trusted.json 撤销的既有语义完全不变

#### Scenario: 真人弹窗选择"总是允许"时 Grant 记录 author

- **WHEN** 用户对某路径选"总是允许"，系统写入持久化 Grant
- **THEN** `trusted.json` 中新增的 Grant 条目包含 `author: "by_person"`

#### Scenario: 真人弹窗选择"总是允许"时 BashGrant 记录 author

- **WHEN** 用户对不可靠 bash 命令选"总是允许"，系统写入持久化 BashGrant
- **THEN** `trusted.json` 中新增的 bashGrants 条目包含 `author: "by_person"`

### Requirement: 存量 trusted.json 读取时迁移

系统 MUST 在加载既有 trusted.json（不含 `author` 字段的旧格式）时，把内存中每条 Grant / BashGrant 的 `author` 字段默认为 `"by_person"`——**不做磁盘写入**，只在内存视图上补齐。

**语义约束**：
- 迁移默认值 MUST 为 `"by_person"`，因为当前项目的持久化 grant **唯一写入路径是真人弹窗**（见 extension 层的 `handlePromptDecision` 中 `addPersistentGrant` 与 `addBashPersistentGrant` 调用点）
- 迁移 MUST 是**惰性**的：只在读取时补字段，不触发磁盘写入；下次持久化写入会自然带上新字段
- 若既有 Grant 已有 `author` 字段（新版本写入后再次读取），MUST 保留原值不覆盖

#### Scenario: 存量 trusted.json 无 author 字段加载

- **WHEN** 系统加载一份不含 `author` 字段的 trusted.json
- **THEN** 内存中每条 Grant / BashGrant 的 `author === "by_person"`；`hasSessionGrant` / `hasPersistentGrant` / `hasBashSessionGrant` / `hasBashPersistentGrant` 查询行为不变

#### Scenario: 新版本 trusted.json 有 author 字段保留原值

- **WHEN** 系统加载一份含 `author: "by_person"` 的 trusted.json
- **THEN** 内存中 Grant / BashGrant 的 `author` 保留 `"by_person"`，不覆盖

#### Scenario: 迁移不触发磁盘写入

- **WHEN** 系统首次启动加载旧 trusted.json，但会话中不产生任何持久化授权写入
- **THEN** trusted.json 磁盘文件保持不变（不添加 `author` 字段）

#### Scenario: 首次持久化写入带上新字段

- **WHEN** 加载旧 trusted.json 后，用户在会话中选择"总是允许"
- **THEN** trusted.json 磁盘文件更新，新条目包含 `author: "by_person"`；既有旧条目保持不变（磁盘上仍无 `author` 字段，直到下次重写整个文件时才会带上）
