## Context

5 处边界卫生修复（B2/B3/B4/B5/B6），全部为加宽兼容 / 向后兼容的契约修复，不改变既有合法输入的决策结果。现状事实链（td-explore 现场判读）：

- **B2**：`BashGrantInput = Omit<BashGrant, "createdAt">` 允许调用方传 `commandHash: ""` 假值，store 内部覆盖（`trust.ts:266-275`）——类型系统未表达"哈希由 store 派生"
- **B5**：`truncateCommand`（`audit.ts:108-119`）截断到 511 字符 + U+2026，但截断后的命令无法再反推出 grant 键（bash 键按 `sha256(rawCommand)` 键控，见 `trust.ts:144-149`）
- **B3**：`stripJsonComments`（`config.ts:92-139` + `settings.ts:26-70`）把 `'` 当字符串起点——JSONC 严格只支持双引号
- **B4**：`isDefaultTmpPath`（`decision.ts:344-346`）只识别 `/tmp` + `/private/tmp`，漏 `/var/tmp`
- **B6**：`package.json` `files` 不含 `docs/` + `examples/`，npm 安装后看不到 permission model 与配置示例

## Goals / Non-Goals

**Goals:**
- B2：`BashGrantInput` 收窄为 `Omit<BashGrant, "commandHash" | "createdAt">`，类型系统表达"哈希由 store 派生"
- B5：截断时补写 `commandHash: sha256(原始命令)` 到 audit record
- B3：`stripJsonComments` 只认双引号字符串；结构性单引号由 `JSON.parse` 报错
- B4：`isDefaultTmpPath` 补 `/var/tmp` 前缀
- B6：`package.json` `files` 补 `docs/` + `examples/`

**Non-Goals:**
- 不改 bash grant 的**匹配语义**（仍为精确 `sha256(rawCommand)` 键控；whitespace 规范化属 P1 独立设计，本 change 不碰）
- 不做完整 shell 解析 / 命令等价判定（与 `security-boundary-docs` 的 Non-Goal 一致）
- 不改任何既有合法输入的决策结果

## Decisions

- **B2**：收窄类型而非改 store 实现——`store` 已派生正确哈希（`hashCommand(grant.rawCommand)`），类型收窄只是禁止调用方传假值，运行时零变化
- **B5**：`commandHash` 为**可选**字段（`commandHash?: string`）——未截断记录不写，旧记录无此字段仍解析，向后兼容；sha256 仅在 `>511` 字符时计算一次（性能零影响）
- **B3**：删除 `'` 分支而非保留——JSONC 严格只支持双引号；注释内的单引号由注释处理器消费（PC4b 已验证），结构性单引号落到 `JSON.parse` 报错并走 `loadConfigFile` 的 `error` 路径
- **B4**：沿用既有前缀匹配模式，加 `/var/tmp` + `/var/tmp/` 两行
- **B6**：`files` 补 `"docs/"` + `"examples/"`（目录通配，含子文件）

**备选考虑**：
- B3 备选"保留单引号但只在 `//` 注释外识别"——过度复杂，JSONC 标准明确只支持双引号，选删除分支（更简单且符合标准）
- B5 备选"不补 commandHash"——违背"事后审计能匹配 grant"的边界卫生目标，弃
- B4 备选"用 `/^\\/(var|private)?\\/tmp\\//` 正则"——可读性低于显式前缀，弃（沿用既有显式前缀风格）

## Risks / Trade-offs

- **B3 唯一语义收紧**：结构性单引号从"静默返回 `{}`"改为"报错（`error` 字段）"——但这是 JSONC 无效输入，报错是正确契约；风险低
- **B2 类型收窄**：6 处调用方需适配（删 `commandHash` 传参），全部在仓库内，无外部消费者
- **B5 向后兼容**：`commandHash?: string` 可选，旧日志线解析不受影响
- **B6 包体积**：docs/ + examples/ 略增 npm 包体积（可接受，文档/示例是用户价值）
