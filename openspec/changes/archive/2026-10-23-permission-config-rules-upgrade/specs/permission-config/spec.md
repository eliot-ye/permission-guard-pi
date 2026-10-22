# permission-config

## ADDED Requirements

### Requirement: tool+pattern 规则语法

配置文件 SHALL 支持新增的 `rules` 字段，与现有 `paths` 字段并存。`rules` 为数组，每个元素为一条规则：

```jsonc
{
  "paths": {
    "<path-pattern>": "read_write" | "read_only" | "unread"
  },
  "rules": [
    {
      "tool": "<tool-name>",
      "pattern": "<glob-pattern>",
      "action": "allow" | "deny"
    }
  ]
}
```

**字段语义**：
- `tool`：工具名称，匹配大小写不敏感、`_` 不敏感。支持的工具名：`read`（read_file）、`write`（write_file）、`edit`（edit_file）、`bash`（bash 命令）
- `pattern`（可选）：匹配工具参数的 glob 模式。`*` 匹配任意字符（包括 `/`）。省略 pattern 时匹配该工具的所有调用
- `action`：`allow`（允许，跳过弹窗）或 `deny`（拒绝，硬阻止）

**JSONC 支持**：`rules` 字段同样支持 `//` 单行注释、`/* ... */` 多行注释与尾部逗号。

**缺失 `rules` 字段**：视为空数组（不报错、不创建）。

#### Scenario: 含 rules 的配置正常解析

- **WHEN** 配置文件为 `{ "rules": [{ "tool": "bash", "pattern": "git *", "action": "allow" }] }`
- **THEN** 解析后 rules 表包含一条 `{ tool: "bash", pattern: "git *", action: "allow" }` 条目

#### Scenario: 无 pattern 的规则匹配所有调用

- **WHEN** 配置声明 `{ "tool": "bash", "action": "deny" }`（无 pattern）
- **THEN** 该规则匹配所有 bash 命令调用

#### Scenario: 缺失 rules 字段不报错

- **WHEN** 配置文件不包含 `rules` 字段
- **THEN** rules 解析为空数组，合并过程继续

#### Scenario: 非法 action 值被忽略并告警

- **WHEN** 配置声明 `{ "tool": "bash", "action": "maybe" }`（非法 action）
- **THEN** 该规则被跳过不进入合并结果，配置加载警告列表包含该条信息

### Requirement: tool+pattern 规则合并

系统 SHALL 将 `rules` 与 `paths` 一样按 local > project > global 的优先级合并。合并规则：

- **来源优先级**：local (3) > project (2) > global (1)
- **同优先级多条**：保留文件内顺序，后声明者在前（排序时靠后者优先）
- **deny 优先于 allow**：当同一 tool+pattern 同时存在 allow 和 deny 规则时，deny 胜出（不论优先级来源）

合并后系统 SHALL 暴露一个 `resolveRule(toolName: string, toolPattern: string)` 方法，返回匹配的最高优先级规则（`{ tool, pattern, action, source }`），或 `undefined`（无匹配）。

#### Scenario: 本地规则覆盖项目规则

- **WHEN** 项目声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，本地声明 `{ "tool": "bash", "pattern": "git *", "action": "deny" }`
- **THEN** resolveRule("bash", "git status") 返回 `deny`（本地优先 + deny 优先）

#### Scenario: 跨源 deny 优先于 allow

- **WHEN** 全局声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，项目声明 `{ "tool": "bash", "pattern": "git *", "action": "deny" }`
- **THEN** resolveRule("bash", "git push") 返回 `deny`（deny 优先于 allow，不论优先级）

#### Scenario: 无匹配规则

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，查询 resolveRule("bash", "rm -rf /")
- **THEN** 返回 `undefined`（`rm -rf /` 不匹配 `git *` pattern）

### Requirement: 规则 pattern 匹配语义

规则中的 `pattern` MUST 使用 glob 匹配，语义为：
- `*` MUST 匹配任意数量的任意字符（包括 `/` 和空格）
- `**` MUST 等价于 `*`（shell 语义下递归，本系统简化为同一语义）
- pattern 匹配工具参数时，bash 工具 MUST 匹配 `rawCommand`（空格规范化后的命令文本），文件工具 MUST 匹配 `absPath`（规范化后的绝对路径）

#### Scenario: git * 匹配 git status

- **WHEN** 规则 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，bash 命令为 `git status`
- **THEN** pattern 匹配成功

#### Scenario: git * 不匹配 rm -rf

- **WHEN** 规则 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，bash 命令为 `rm -rf /`
- **THEN** pattern 不匹配

#### Scenario: 空格规范化匹配

- **WHEN** 规则 `{ "tool": "bash", "pattern": "git status", "action": "allow" }`，bash 命令为 `git    status`（多空格）
- **THEN** pattern 匹配成功（空格规范化为单空格后匹配）

#### Scenario: 文件工具 pattern 匹配路径

- **WHEN** 规则 `{ "tool": "read", "pattern": "/tmp/**", "action": "allow" }`，工具访问 `/tmp/app/deep.log`
- **THEN** pattern 匹配成功
