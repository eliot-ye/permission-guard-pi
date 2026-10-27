## MODIFIED Requirements

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

#### Scenario: 单引号不是字符串分隔符（B3 边界条款）

- **WHEN** 配置文件中出现单引号（如注释 `it's a note` 或结构性位置的单引号）
- **THEN** 单引号 MUST NOT 被当作字符串起点；注释内的单引号被注释处理器消费，结构性位置的单引号使 `JSON.parse` 报错并记入配置加载警告列表（该文件视为空）
- **契约边界**：配置文件 SHALL NOT 使用单引号字符串（JSONC 严格只支持双引号字符串）
