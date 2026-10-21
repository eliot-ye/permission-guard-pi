## Purpose

定义分层配置文件（全局 / 项目 / 项目本地）的加载、优先级合并与路径匹配语义，让用户用 JSONC 声明每条路径的权限级别。

## ADDED Requirements

### Requirement: 三档配置文件位置

系统 SHALL 从以下三个固定位置加载配置文件（若不存在则视为空），并按 local > project > global 的优先级合并：

- **全局**：`~/.pi/agent/permission.json`
- **项目**：`<projectRoot>/.pi/permission.json`
- **项目本地**：`<projectRoot>/.pi/local/permission.json`

缺失文件 MUST 被视为空配置（不报错、不创建）。格式错误（非 JSONC 可解析）MUST 记入配置加载警告列表并在会话启动时通过 UI 通知一次，同时把该文件视为空处理。

#### Scenario: 三档配置全部存在时按优先级合并

- **WHEN** 全局声明路径 `A = read_write`、项目声明 `A = unread`、项目本地声明 `A = read_only`
- **THEN** 合并后路径 `A` 的解析结果为 `read_only`（本地覆盖项目覆盖全局）

#### Scenario: 缺失的项目本地配置不报错

- **WHEN** 项目本地配置文件不存在
- **THEN** 合并过程不产生错误，全局与项目配置正常生效

#### Scenario: 格式错误的配置被降级为空并告警

- **WHEN** 项目配置文件的 JSONC 解析失败
- **THEN** 该文件被当作空配置，合并过程继续；会话启动时向用户 UI 输出一次警告，标注错误文件路径

### Requirement: JSONC 语法

配置文件 SHALL 使用 JSONC 语法（JSON 允许 `//` 单行注释、`/* ... */` 多行注释与尾部逗号），以支持用户在配置中添加说明。

配置文件结构 MUST 为：
```jsonc
{
  "paths": {
    "<path-pattern>": "read_write" | "read_only" | "unread"
  }
}
```

#### Scenario: 含注释和尾逗号的配置正常解析

- **WHEN** 配置文件为 `{ "paths": { "/tmp/x": "read_write", /* note */, } }`
- **THEN** 解析后 paths 表包含一条 `{ "/tmp/x": "read_write" }` 条目

#### Scenario: 非法权限值被忽略并告警

- **WHEN** 配置文件声明 `"paths": { "/x": "delete" }`（非法权限）
- **THEN** 该条目被跳过不进入合并结果，配置加载警告列表包含该条信息

### Requirement: 路径模式分类

系统 SHALL 把配置中的每个路径 key 分为两类：

- **绝对路径模式**：以 `/` 开头（Unix）、`~` 开头、或匹配 Windows 盘符（如 `C:\`）。语义为字面匹配，规范化后精确匹配目标路径。
- **相对路径 glob**：其他形式。以 `**` / `*` / `?` / `[...]` 等 glob 元字符触发匹配。仅在 `<projectRoot>` 内部生效（对绝对路径模式与 `<projectRoot>` 之外的绝对路径不匹配）。

#### Scenario: 绝对路径精确匹配

- **WHEN** 配置声明 `"/Users/eliot/.ssh" = "read_write"`，工具访问 `/Users/eliot/.ssh/id_rsa`
- **THEN** 判定为不匹配（绝对路径模式是精确匹配，非前缀匹配）；若需要前缀语义需另声明

#### Scenario: `~` 展开匹配

- **WHEN** 配置声明 `"~/.aws" = "read_only"`，`HOME=/Users/eliot`，工具访问 `/Users/eliot/.aws/credentials`
- **THEN** 判定为不匹配（同上，绝对路径精确匹配）

#### Scenario: 项目内 glob 匹配

- **WHEN** 项目配置声明 `"**/*.pem" = "read_write"`，工具访问 `<proj>/vendor/certs/root.pem`
- **THEN** 匹配成功，权限为 `read_write`

#### Scenario: 项目内 glob 不跨越项目边界

- **WHEN** 项目配置声明 `"**/*.pem" = "read_write"`，工具访问 `<other-proj>/x.pem`
- **THEN** 不匹配（相对 glob 只在项目根下生效）

#### Scenario: 项目外绝对路径 glob 支持

- **WHEN** 全局配置声明 `"/tmp/**/*.log" = "read_only"`，工具访问 `/tmp/app/deep/nested.log`
- **THEN** 匹配成功（绝对路径 glob 允许在任意位置生效）

### Requirement: 优先级解析

解析阶段，同一目标路径可能命中多条配置（同层多条 / 跨层多条）。系统 SHALL 按以下规则选出最终权限：

- **优先级顺序**：local (3) > project (2) > global (1)。同优先级多条 → 后声明者胜（保留文件内顺序）
- **glob 优先级**：字面精确匹配 > glob 匹配（若同层同时命中，字面胜出）

#### Scenario: 本地配置覆盖项目配置

- **WHEN** 项目声明 `A = read_write`，本地声明 `A = read_only`
- **THEN** 解析 `A` 得到 `read_only`，来源标记为 `local`

#### Scenario: 字面优先于 glob（同层）

- **WHEN** 项目同时声明 `"src/**" = "read_only"` 与 `"src/x.ts" = "read_write"`，访问 `src/x.ts`
- **THEN** 解析得到 `read_write`（同层字面胜 glob）

### Requirement: 跨源冲突标记

同一目标路径若在不同优先级来源上被声明为**不同权限级别**，系统 SHALL 标记为"跨源冲突"。冲突标记传递给决策引擎，由决策引擎决定弹窗策略（详见 access-decision capability，仅 `unread` 相关组合触发弹窗询问，其他级别差异静默应用优先级）。

#### Scenario: global=unread 与 project=read_write 触发冲突标记

- **WHEN** 全局声明 `/srv = unread`，项目声明 `/srv = read_write`
- **THEN** 合并后解析返回本地覆盖后的 `read_write`（优先级），同时冲突标记为 true

#### Scenario: 同权限不触发冲突

- **WHEN** 全局与项目都声明 `A = read_only`
- **THEN** 解析结果为 `read_only`，冲突标记为 false

#### Scenario: read_only 与 read_write 冲突标记为 true 但不弹冲突窗口

- **WHEN** 全局声明 `A = read_only`，项目声明 `A = read_write`
- **THEN** 解析结果为 `read_write`（本地覆盖），冲突标记为 true；access-decision 层看到不含 unread 的冲突后不弹冲突窗口，直接按本地权限决策

### Requirement: 配置文件热更新

配置文件变更 MUST 在下次会话开始时生效；同会话内若用户手动编辑配置文件，下次决策时 SHOULD 使用最新内容（通过文件 mtime 检查或 session_start 重载）。

#### Scenario: 会话内删除某路径声明后回退

- **WHEN** 用户在会话中删除项目配置里 `A` 的声明并触发一次新决策
- **THEN** `A` 的路径解析回退到默认敏感兜底 / 未配置状态，无需重启 pi 会话
