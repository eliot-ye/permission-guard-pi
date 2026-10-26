# permission-config delta — tier-contract-consistency

本 change 在 permission-config 新增 requirement "配置加载期通配覆盖 warning"。当用户在配置中声明某个非 `unread` 权限（`read_write` 或 `read_only`）的 pattern，且该 pattern 是"通配形态"并覆盖至少一个 hard sensitive 锚点路径时，`mergePolicies` 向 `warnings[]` 追加一条结构化 warning；`session_start` handler 通过既有的 `ctx.ui.notify(...)` 循环承接呈现。

## ADDED Requirements

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
