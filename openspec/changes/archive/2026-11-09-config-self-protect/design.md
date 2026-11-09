# Design: config-self-protect

## Context

见 proposal.md - Why。现有行为：`decide()` 对项目内非敏感写判 `auto_allow`（`src/lib/decision.ts:302-315`）——`<proj>/.pi/permission.json` 写因此**静默放行**；`trusted.json` / `settings.json` 是项目外非敏感写 → `prompt tier=three`。`sensitive.ts` 清单不含这些文件；且"配置声明优先"语义意味着用敏感规则覆盖会被配置声明绕过。

本 change 引入**决策层自身的配置与运行时状态自保护**，两层：

- **L1 运行时状态**（`trusted.json` / `settings.json`）写/delete → `deny_hard`（不可豁免）；
- **L2 配置写**（`permission.json` global/project/local）写/delete → `prompt tier=two`（非静默、不可持久化）。

## Goals / Non-Goals

**Goals**
- agent 无法通过工具调用（read/write/edit/bash）写或 delete `trusted.json`（伪造 grant）、`settings.json`（设 `enabled:false` 关闭整门）。
- agent 无法**静默**写 `permission.json`（自我提权）；配置写需用户确认且不可持久化"总是允许"。
- L1 不可被配置声明 / grant 记忆 / `!` 否定绕过；L2 不可被配置声明静默化（但 session grant 可放行本会话）。
- 保持 `decide()` 纯函数签名不变（`src/lib/*` 可单测约束）。

**Non-Goals**（用户拍板 2026-11-09）
- **不做** `<proj>/.pi/**`、`~/.pi/agent/**` 通用路径保护（用户明确否决，只保具体文件）。
- **不挡读**：读受保护文件按常规规则判定（读不构成提权；用户未要求读保护）。
- 不做 `permission.json` 的 `deny_hard`（用户选择 prompt 而非 deny，保留"agent 帮编辑配置需确认"工作流）。

## Decisions

### D1. 保护对象

- **L1 运行时状态**：`trusted.json`（授权记忆）+ `settings.json`（设置）。写/delete → `deny_hard`。
- **L2 配置写**：`permission.json`（global/project/local）。写/delete → `prompt tier=two`。

依据（用户拍板 2026-11-09，两次确认）：提权向量 = 伪造 grant（trusted.json）+ 关闭整门（settings.json `enabled:false`）+ 静默改策略（permission.json `{"**":"read_write"}`）；`permission.json` 是用户声明的策略文件，用 prompt 而非 deny 保留"agent 帮编辑配置需确认"工作流。
备选（否决）：`.pi/**` / `~/.pi/agent/**` 全路径保护——用户明确否决，认为 blast radius 过大。

### D2. 写/delete 保护；读放行

写/delete 受保护文件 → 保护（L1 deny_hard / L2 prompt）；读 → 常规规则。
依据：读不构成提权；用户收窄范围信号表明要最小 blast radius。
备选（否决）：读也保护——本项目"项目内默认静默"哲学下过激，用户未要求。

### D3. 检查位置：`decideTarget` 两层 pre-check + 纯函数谓词

- 新纯函数模块 `src/lib/config-protect.ts`（零 IO/UI，可单测）：
  - `isProtectedRuntimeState(absPath, trustedPath, settingsPath): boolean`（L1，规范化等值）。
  - `isConfigWritePath(action, absPath, paths: string[]): boolean`（L2，action ∈ {write,delete} 且规范化等值；`paths` = 三个 `permission.json` 路径数组，来自 `state.configPaths`）。
- `extensions/index.ts` `decideTarget()` 内做两层 pre-check（统一覆盖 file 工具 + bash 目标，因二者都经 `decideTarget`，见 :944）。

依据：reverse-spec 报告指示"不改 `decide()` 签名，保持纯函数可测"；`decideTarget` 是 file/bash 的公共装配点，加一处即可覆盖两类。运行时状态路径需集成层知识（`state.trust.path`、`join(trustedDir,"settings.json")`），不进 `decide()`。
备选（否决）：并入 `decide()`——需改签名传路径，污染纯决策层；只在 `handleBash`/`handleFileTool` 分别加——重复，且遗漏统一语义。

### D4. 判定顺序（在 `decideTarget` 内）

```
1. L1 运行时状态检查：isProtectedRuntimeState && action≠read → deny_hard（grant 检查之前）
2. 既有 unread 检查（:969）
3. 既有 grant 检查（:993）→ auto_allow
4. L2 配置写检查：isConfigWritePath（无 grant 落到此）→ prompt tier=two, declaration="config_write"
5. 既有 decide()（:1017）
```

- L1 在 grant **之前**：不可被 grant 记忆/配置声明/`!` 否定豁免（对齐既有 unread 不变量）。
- L2 在 grant **之后**：session grant（用户本会话批准）可放行；但 tier=two **无**"总是允许"→ 不可持久化绕过。配置声明在 `decide()`（step 5）才评估，故 L2 不可被配置声明静默化。
- L1 在 unread **之前**：运行时状态文件总是受保护（无论配置如何声明）。

### D5. bash 处理

- **可靠 bash**：每个 target 经 `decideTarget`（:775-777）→ L1/L2 天然覆盖（target 的 path+action 过 pre-check）。
- **不可靠 bash + 有 bash grant**（C5 扫描分支，:640-665）：在既有 unread token 扫描旁**追加** L1/L2 token 检查——L1 命中 → `deny_hard`（覆盖 grant，对齐 unread 语义）；L2 命中 → `prompt config_write`（不因 grant 自动放行）。
- **不可靠 bash + 无 grant**（:697 分支）：在 tier=three prompt **之前**追加 L1/L2 token 检查——L1 命中 → `deny_hard`；L2 命中 → `prompt config_write`。

依据：`echo '...' > trusted.json` / `echo '...' > permission.json` 的写目标必须被捕获；review 发现 C5 扫描只在 grant-hit 分支（:633-637 条件内），无 grant 不可靠命令会绕过 L1 非旁路——故三个分支全覆盖。实现上抽一个 `scanBashProtectedPaths(command, state)` 辅助（对 `tokenizeBashCommand` 的裸路径 token 跑 L1/L2 谓词，返回 `deny_hard | config_write-prompt | null`），三个分支复用。

### D6. `declaration: "config_write"` + 副文本

- `decision.ts` `Declaration` 联合加 `"config_write"`（additive，已核对无穷尽 switch，仅等值检查 → 安全）。
- `reason-codes.ts` `UiCode` 加 `subtitle_config_write_not_persistable`；`i18n.ts` zh/en 加字符串（zh：`权限配置写操作不可持久化。如需长期允许，请直接编辑 permission.json。`；en：`Permission config write cannot be persisted. To allow permanently, edit permission.json.`）。
- `extensions/index.ts` tier=two 副文本分派（:1076-1081）加 `declaration === "config_write"` 分支。

依据：tier=two 副文本 MUST 按来源分派（approval-flow 既有要求）；配置写需明确"不可持久化"引导，避免用户困惑为何无"总是允许"。
备选（否决）：不加副文本、仅靠 `reason` 文案——tier=two 副文本分派契约要求按来源分派，缺 case 不完整。

### D7. SessionState 增 `configPaths`

`loadAllConfigs`（:112-136）改为**返回**已解析的 `{ global, project, local }` 配置路径（与 `opts.configPaths` 同一形状，即 `configLocations()` 结果重命名为 `{global, project, local}` 字段），`initSession` 存入 `state.configPaths`，供 `decideTarget` 的 L2 判定。
依据：`decideTarget` 需要三个 `permission.json` 路径；当前 SessionState 只存 `policy` 不存路径。复用 `loadAllConfigs` 同一来源避免**重复计算**与**键形状错配**（`configLocations` 返回 `globalConfigPath/projectConfigPath/localConfigPath`，`opts.configPaths` 用 `global/project/local`——需在 `loadAllConfigs` 统一为后者）。
备选（否决）：每次 `decideTarget` 重算 `configLocations`——重复、且引入 homedir() 到判定热路径。

### D8. 路径规范化

谓词比较用 `toAbsolutePath`（展开 `~`、resolve `..`）+ `toKeyPath`（Windows 大小写不敏感），杜绝 `..` / 大小写 / 分隔符变体绕过。**双输入**：`decideTarget` 里对 `resolvedAbs` **与** `canonicalPath`（`tryRealpath` 结果）各调一次谓词（OR 合并），使符号链接别名指向受保护文件也命中（canonicalPath = realpath = 实际受保护路径）；记入风险。

## Risks / Trade-offs

- **[读受保护文件仍允许] → 轻微信息泄露**（agent 可见已批准路径 / 配置内容）。→ 缓解：读不构成提权；用户明确收窄范围。
- **[不可靠 bash 写目标漏捕] → 保守兜底**。→ 缓解：D5 三分支全覆盖（可靠 per-target + 不可靠有 grant + 不可靠无 grant 均跑 L1/L2 token 检查）；宁可 deny/prompt 不放行受保护路径。
- **[符号链接别名绕过] → 边缘风险**。→ 缓解：D8 双输入（`resolvedAbs` + `canonicalPath` OR）命中 realpath 别名；realpath 全量加固记为后续。
- **[L2 覆盖"agent 帮编辑配置"] → 预期内**：写 `permission.json` 需用户确认（tier=two），不可静默。→ 缓解：属用户决策（选择 prompt 而非 deny），非缺陷。
- **[session grant 放行 L2] → 可接受**：用户本会话批准即知情授权；tier=two 无持久 grant，不可长期绕过。

## Migration Plan

无数据迁移。行为变更纯加严（deny 更多 / prompt 更多）；回滚 = 移除 `decideTarget` 两层 pre-check 与相关声明。无 schema 变更。

## Open Questions

无（读行为已按用户收窄裁定为"读放行"；配置写 tier 已裁定为 tier=two 非持久化——若用户后续要求"总是允许"配置写，是 D2 的可逆调整，不改变 spec 核心条款，只改一个 scenario 的 THEN 与 tier）。
