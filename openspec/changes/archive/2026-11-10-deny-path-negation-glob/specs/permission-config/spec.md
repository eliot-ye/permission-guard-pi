# permission-config Specification

## ADDED Requirements

### Requirement: path-based deny 段与 `!` 否定豁免

配置文件 SHALL 支持新增的 `deny` 字段，与 `paths`/`rules` 并存。`deny` 为字符串数组，每个元素为一条 path glob 模式，命中则无条件硬拒（`deny_hard`）。`!` 前缀条目为否定豁免（例外集语义，非 gitignore last-match-wins）。

```jsonc
{
  "paths": { "<path-pattern>": "read_write" | "read_only" | "unread" },
  "rules": [{ "tool": "...", "pattern": "...", "action": "allow" | "deny" }],
  "deny": [
    "**/*.pem",
    "!**/public.pem"    // ! 前缀 = 例外豁免
  ]
}
```

**glob 语义**（deny 段专用，最小语义）：
- `*` MUST 匹配单段内任意字符（不含 `/`）
- `**` MUST 跨段匹配（含 `/`）
- 其余字符字面匹配（正则元字符转义）

**`!` 否定豁免语义**（顺序无关例外集，非 last-match-wins）：
- 拆分正向（无 `!` 前缀）与否定（`!` 前缀）两组
- 正向组为空 → 不命中任何路径（纯否定列表不拦任何东西）
- path 未命中任一正向 → 不命中
- path 命中任一否定 → 豁免（不命中）
- 否则 → 命中

**`!` 作用边界**：`!` 否定豁免**只作用于用户配置的 `deny` 段**，对 `sensitive.ts` 硬编码的 hard 敏感规则**不生效**（hard 保护不可配豁免，比 ta-agent 更强的安全基线保留）。

**negation 跨源豁免**：三档 `deny` 段 additive 合并后，negation 与 positive 条目进入同一列表——低优先级源（local）的 `!` 豁免**会作用于**高优先级源（global/project）的正向 deny（例外集语义不隔离来源）。例：global `["**/*.pem"]` + local `["!**/*"]` 会使 global 的 pem deny 全失效。此为 additive 例外集语义（对齐 ta-agent）的固有张力，用户须知：任一档的 `!` 可豁免其它档的正向 deny；三档 config 自身受配置写硬保护，agent 无法注入 negation 绕过。

**JSONC 支持**：`deny` 段同样支持 `//` 单行注释、`/* ... */` 多行注释与尾部逗号。

**缺失 `deny` 字段**：视为空数组（不报错、不创建），行为与引入前逐字节一致。

#### Scenario: deny 段命中 path 硬拒

- **WHEN** 配置声明 `"deny": ["**/*.pem"]`，工具写 `<proj>/certs/root.pem`
- **THEN** deny-path 命中，决策为 `deny_hard`

#### Scenario: `!` 否定豁免命中 path 不硬拒

- **WHEN** 配置声明 `"deny": ["**/*.pem", "!**/public.pem"]`，工具写 `<proj>/certs/public.pem`
- **THEN** deny-path 未命中（`!**/public.pem` 否定豁免），按后续规则判定

#### Scenario: `!` 否定豁免未命中 path 仍硬拒

- **WHEN** 配置声明 `"deny": ["**/*.pem", "!**/public.pem"]`，工具写 `<proj>/certs/root.pem`
- **THEN** deny-path 命中（正向命中 + 否定未命中），决策为 `deny_hard`

#### Scenario: 纯否定列表不拦任何路径

- **WHEN** 配置声明 `"deny": ["!**/public.pem"]`（无正向条目）
- **THEN** deny-path 对任何路径都不命中（纯否定列表无正向命中，恒返 false）

#### Scenario: `*` 单段 glob 不跨越 `/`

- **WHEN** 配置声明 `"deny": ["*.env"]`，工具访问 `/x/.env`
- **THEN** deny-path 命中

#### Scenario: `*` 单段 glob 不匹配深层路径

- **WHEN** 配置声明 `"deny": ["*.env"]`，工具访问 `/x/deep/.env`
- **THEN** deny-path 未命中（`*` 不含 `/`，深层路径需 `**`）

#### Scenario: `**` 跨段 glob 匹配深层路径

- **WHEN** 配置声明 `"deny": ["**/.env"]`，工具访问 `/a/b/c/.env`
- **THEN** deny-path 命中

#### Scenario: 顺序无关例外集语义

- **WHEN** 配置声明 `"deny": ["!**/public.pem", "**/*.pem"]`（否定在前）
- **THEN** 与 `"deny": ["**/*.pem", "!**/public.pem"]`（否定在后）等价——`public.pem` 豁免、其余 `.pem` 命中

#### Scenario: `!` 不豁免 hard 敏感规则

- **WHEN** 配置声明 `"deny": ["!~/.ssh/id_rsa"]`，工具读 `~/.ssh/id_rsa`
- **THEN** `sensitive.ts` hard 敏感规则仍命中（`!` 只作用于用户 deny 段，不豁免硬编码保护），决策按敏感规则判定（非 deny-path 命中）

#### Scenario: 三档 deny 段 additive 合并

- **WHEN** global 声明 `"deny": ["**/*.pem"]`，project 声明 `"deny": ["**/*.key"]`，local 声明 `"deny": ["!**/public.pem"]`
- **THEN** 合并为 `["**/*.pem", "**/*.key", "!**/public.pem"]`（additive 拼接，非优先级覆盖）

#### Scenario: 缺失 deny 字段向后兼容

- **WHEN** 配置文件不含 `deny` 字段
- **THEN** deny 段解析为空数组，`resolveDenyPath` 恒返 false，行为与引入前一致
