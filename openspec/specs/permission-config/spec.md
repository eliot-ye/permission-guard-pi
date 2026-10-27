# permission-config Specification

## Purpose
定义分层配置文件（全局 / 项目 / 项目本地）的加载、优先级合并与路径匹配语义，让用户用 JSONC 声明每条路径的权限级别。

## Requirements

### Requirement: 三档配置文件位置

系统 SHALL 从以下三个固定位置加载配置文件（若不存在则视为空），并按 local > project > global 的优先级合并：

- **全局**：`~/.pi/agent/permission.json`
- **项目**：`<projectRoot>/.pi/permission.json`
- **项目本地**：`<projectRoot>/.pi/local/permission.json`

缺失文件 MUST 被视为空配置（不报错、不创建）。格式错误（非 JSONC 可解析）MUST 记入配置加载警告列表，同时把该文件视为空处理。

#### Scenario: 三档配置全部存在时按优先级合并

- **WHEN** 全局声明路径 `A = read_write`、项目声明 `A = unread`、项目本地声明 `A = read_only`
- **THEN** 合并后路径 `A` 的解析结果为 `read_only`（本地覆盖项目覆盖全局）

#### Scenario: 缺失的项目本地配置不报错

- **WHEN** 项目本地配置文件不存在
- **THEN** 合并过程不产生错误，全局与项目配置正常生效

#### Scenario: 格式错误的配置被降级为空并告警

- **WHEN** 项目配置文件的 JSONC 解析失败
- **THEN** 该文件被当作空配置，合并过程继续；配置加载警告列表包含该条信息

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

### Requirement: 路径模式分类

系统 SHALL 把配置中的每个路径 key 分为两类维度，二者正交：

- **绝对 vs 相对**（`isAbsolute`）：以 `/` 开头（Unix）、`~` 开头、或匹配 Windows 盘符（如 `C:\`）视为绝对；否则视为相对。
- **字面 vs glob**（`isGlob`）：pattern 中含 `*`、`?` 或 `[` 视为 glob；否则视为字面。

相对模式 MUST 仅在 `<projectRoot>` 内部生效（对 `<projectRoot>` 之外的绝对路径不匹配）。绝对模式在任意位置生效。

#### Scenario: 绝对路径精确匹配

- **WHEN** 配置声明 `"/Users/eliot/.ssh" = "read_write"`，工具访问 `/Users/eliot/.ssh/id_rsa`
- **THEN** 判定为不匹配（绝对字面模式是精确匹配，非前缀匹配）；若需要前缀语义需另声明

#### Scenario: `~` 展开匹配

- **WHEN** 配置声明 `"~/.aws" = "read_only"`，`HOME=/Users/eliot`，工具访问 `/Users/eliot/.aws/credentials`
- **THEN** 判定为不匹配（同上，绝对字面精确匹配）

#### Scenario: 项目内 glob 匹配

- **WHEN** 项目配置声明 `"**/*.pem" = "read_write"`，工具访问 `<proj>/vendor/certs/root.pem`
- **THEN** 匹配成功，权限为 `read_write`

#### Scenario: 项目内 glob 不跨越项目边界

- **WHEN** 项目配置声明 `"**/*.pem" = "read_write"`，工具访问 `<other-proj>/x.pem`
- **THEN** 不匹配（相对 glob 只在项目根下生效）

#### Scenario: 绝对路径 glob 支持

- **WHEN** 全局配置声明 `"/tmp/**/*.log" = "read_only"`，工具访问 `/tmp/app/deep/nested.log`
- **THEN** 匹配成功（绝对 glob 允许在任意位置生效，`isAbsolute` 与 `isGlob` 正交）

### Requirement: 优先级解析

解析阶段，同一目标路径可能命中多条配置（同层多条 / 跨层多条）。系统 SHALL 按以下规则选出最终权限：

- **来源优先级**：local (3) > project (2) > global (1)。同优先级多条 → 后声明者胜（保留文件内顺序）
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

### Requirement: 配置文件加载时机

配置文件 SHALL 在会话初始化时加载一次。会话内若用户手动编辑配置文件，下次决策时 MUST 使用会话初始化时加载的快照（不支持会话内热更新）。

#### Scenario: 会话内删除某路径声明后不立即回退

- **WHEN** 用户在会话中删除项目配置里 `A` 的声明并触发一次新决策
- **THEN** `A` 仍按会话初始化时的声明解析，无需重启 pi 会话；下次会话开始时新配置才生效

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

### Requirement: 配置加载期通配覆盖 warning

`mergePolicies` 处理 `paths` 段时，MUST 对每一条声明检查是否触发"通配覆盖 hard sensitive 兜底"的 warning 条件。若触发，向返回值的 `warnings[]` 数组追加一条 warning 字符串。

**触发条件（三者全部满足才触发）**：

1. **pattern 是通配形态**——`classifyPath(entry.pattern).isGlob === true`（pattern 含 `*` / `?` / `[` 通配符）；非 glob 的精确路径声明（如 `"~/.ssh/known_hosts": "read_write"`）不触发 warning
2. **权限非 unread**——`entry.permission !== "unread"`（`unread` 是硬拒绝，与 sensitive 兜底叠加方向一致，无覆盖风险）
3. **pattern 匹配至少一个 hard sensitive 锚点路径**——遍历 `HARD_SENSITIVE_ANCHORS`（从 `DEFAULT_SENSITIVE_RULES` 中每条 hard 规则的 `anchor` 字段派生，共约 26 条 canonical 路径），按 `entry.isRelative` 分支判定匹配语义（与 `resolve()` 一致，P1-1 修复）：
   - **isRelative=true**：将 anchor 展开为绝对路径，若位于 `projectRoot` 下则转为相对路径，再与 pattern `matchesGlob(pattern, anchorRelative)` 判定
   - **isRelative=false**：直接使用 anchor 原字符串（保持 `~/` 形式）与 pattern 比对

**hard sensitive 锚点路径集合**：从 `DEFAULT_SENSITIVE_RULES` 中每条 `level === "hard"` 规则的 `anchor` 字段派生，共约 **26 条** canonical 路径，覆盖以下规则：

- SSH 密钥规则（5 条 anchor）：`~/.ssh/id_rsa`、`~/.ssh/id_dsa`、`~/.ssh/id_ecdsa`、`~/.ssh/id_ed25519`、`~/.ssh/config`
- 私有 key 扩展名规则（2 条 anchor，代表性）：`~/.ssh/other.pem`、`~/.ssh/other.key`——不含 `.pfx`/`.p12`/`.jks`/`.kdbx`/`.asc`/`.gpg` 的具体代表性路径，设计接受此精度边界（软约束提醒）
- 凭证存储目录规则（7 条 anchor）：`~/.aws/credentials`、`~/.aws/config`、`~/.kube/config`、`~/.docker/config.json`、`~/.netrc`、`~/.git-credentials`、`~/.gnupg/secring.gpg`
- 凭证配置文件规则（3 条 anchor）：`~/.npmrc`、`~/.ssh/credentials`、`~/.ssh/secrets.yaml`
- 系统机密规则（8 条 anchor）：`/etc/shadow`、`/etc/sudoers`、`/etc/master.passwd`、`/etc/crontab`、`/etc/cron.d/job`、`/etc/cron.hourly/job`、`/etc/hosts.allow`、`/etc/hosts.deny`

**warning 消息格式**：

```
[permission] pattern "<pattern>" from <source> config grants non-unread access to sensitive paths including <matched_anchors_sample> (up to 3). Consider using a more specific pattern or setting to "unread".
```

其中 `<matched_anchors_sample>` 是匹配到的锚点路径前 3 条，用 `", "` 结尾连接（超过 3 条时只显示前 3 条 + `", ..."`）。

**行为约束**：

- warning 是**非阻塞**的——配置仍然生效，用户看到的 warning 是"提示存在覆盖"，不是"阻止配置加载"
- warning 通过 `warnings[]` 返回给 `session_start` handler，由既有的 `ctx.ui.notify(..., "warning")` 循环呈现
- 同一条 pattern 只触发一次 warning（即使匹配多个锚点，也只追加一条 warning 字符串）
- 不同 source 的同 pattern 声明分别触发 warning（例如 global 与 project 都声明 `~/.ssh/**: read_write`，会产生两条 warning，因为各自 source 独立）
- `unread` 权限永远不触发 warning（方向一致，无需提醒）
- 精确路径声明（非 glob）不触发 warning——用户明确指定了路径，是显式意图
- 若用户配置有多条大范围通配导致 notification flood（例如 10 条大范围通配产生 10 条 warning），session_start 会逐条 notify——**已知边界**，后续 change `warning-batching` 可考虑合并同类 warning（P2-4 follow-up 锚点，本 change 不处理）

**位置**：本校验位于 `mergePolicies` 的 `allEntries` 构造完成后。锚点路径集合从 `DEFAULT_SENSITIVE_RULES` 中每条 hard 规则的 `anchor` 字段派生（`sensitive.ts` 模块内同侧维护，避免双事实源漂移）。

**范围约束**：本校验只针对 `paths` 段的 path-based 声明，不针对 `rules` 段的 tool+pattern 声明（tool+pattern 规则的匹配语义与 path 段不同，未来变更可独立扩展）。

#### Scenario: 大范围通配匹配 ~/.ssh 触发 warning

- **WHEN** 用户配置声明 `~/.ssh/**: "read_write"`（isGlob=true，isRelative=false，permission=read_write）
- **THEN** `mergePolicies(...).warnings` 包含一条 warning 字符串，包含 `"~/.ssh/**"` 与匹配到的锚点路径样本（如 `~/.ssh/id_rsa`、`~/.ssh/config`）

#### Scenario: 全路径通配触发 warning

- **WHEN** 用户配置声明 `~/**: "read_write"`（isGlob=true，isRelative=false，permission=read_write）
- **THEN** `mergePolicies(...).warnings` 包含一条 warning，包含 `~/**` 与多个锚点样本

#### Scenario: 项目根通配项目根为 ~ 触发 warning

- **WHEN** 用户在项目配置中声明 `**: "read_write"`（isGlob=true，isRelative=true，permission=read_write，项目根为 `~`）
- **THEN** `mergePolicies(...).warnings` 包含一条 warning（**P1-1 修复**：相对 pattern 与 resolve() 一致，将 anchor 转为相对路径后匹配；项目根为 `~` 时 `~/.ssh/id_rsa` 相对路径为 `.ssh/id_rsa`，与 `**` 匹配成功）

#### Scenario: 项目根通配项目根不含敏感路径不触发 warning

- **WHEN** 用户在项目配置中声明 `*: "read_write"`（isGlob=true，isRelative=true，项目根为 `<proj>` 非 `~`，锚点均不在项目根下）
- **THEN** `mergePolicies(...).warnings` **不含** 通配覆盖 warning

#### Scenario: 相对通配 pattern 命中 home 敏感路径触发 warning

- **WHEN** 项目根为 `~/.ssh/workspace`（含 `.ssh` 目录），项目配置声明 `workspace/**: "read_write"`（isRelative=true）
- **THEN** `mergePolicies(...).warnings` 包含一条 warning（相对匹配语义：anchor `~/.ssh/id_rsa` 不在 `~/.ssh/workspace` 下，但 `~/.ssh/config` 也不在 `~/.ssh/workspace` 下，若锚点确不在项目根下则不匹配——此场景取决于具体项目根与锚点相对位置，作为边界测试存在）

#### Scenario: 精确路径声明不触发 warning

- **WHEN** 用户配置声明 `"~/.ssh/known_hosts": "read_write"`（isGlob=false）
- **THEN** `mergePolicies(...).warnings` **不含** 通配覆盖 warning（用户精确指定路径，是显式意图）

#### Scenario: 精确敏感路径不触发 warning

- **WHEN** 用户配置声明 `"~/.ssh/id_rsa": "read_only"`（isGlob=false，permission=read_only）
- **THEN** `mergePolicies(...).warnings` **不含** 通配覆盖 warning（精确指定硬敏感路径是显式意图）

#### Scenario: unread 权限不触发 warning

- **WHEN** 用户配置声明 `"~/.ssh/**": "unread"`（isGlob=true，permission=unread）
- **THEN** `mergePolicies(...).warnings` **不含** 通配覆盖 warning（方向一致，无覆盖风险）

#### Scenario: 不匹配敏感锚点的通配不触发 warning

- **WHEN** 用户配置声明 `"src/**": "read_write"`（isGlob=true，isRelative=true，permission=read_write，锚点集合均不在项目根下）
- **THEN** `mergePolicies(...).warnings` **不含** 通配覆盖 warning

#### Scenario: 多 source 同 pattern 分别触发 warning

- **WHEN** global 配置声明 `"~/.ssh/**": "read_write"` 且 project 配置声明 `"~/.ssh/**": "read_write"`
- **THEN** `mergePolicies(...).warnings` 包含两条 warning，各自 source 分别为 `global` 与 `project`

#### Scenario: warning 消息包含锚点样本

- **WHEN** 用户配置声明 `"~/**": "read_write"`，warning 触发
- **THEN** warning 字符串包含"pattern `~/**`"、至少一个匹配的锚点路径（如 `~/.ssh/id_rsa`）、"from <source> config"、"sensitive paths including"

#### Scenario: warning 通过 session_start handler 呈现

- **WHEN** 用户配置声明触发 warning，session_start 触发
- **THEN** `ctx.ui.notify(...)` 被调用，参数包含 `"config warning: <warning 字符串>"`，level 为 `"warning"`
