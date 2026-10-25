## Context

见 `proposal.md` - Why。当前实现：

- `sensitive.ts` 单一 `DEFAULT_SENSITIVE_RULES` 数组（5 条规则），`findSensitiveMatch` 返回 `SensitiveRule`（`test` + `reason`，**无分级字段**）。
- `decide()` step 2b（`decision.ts:242-251`）`tier: isInside ? "three" : "two"`——所有 sensitive 不分类型按区域分派。
- 约束：项目外 `config.*` 读走 step 2e `auto_allow`（盲区）；`~/.ssh/config` 由 SSH key 规则的 `b === "config" && d.endsWith("/.ssh")` 覆盖（hard）。

## Goals / Non-Goals

**Goals:**
- 引入 hard/soft 分级：soft（`config.*`/`auth.*`/`settings.*`/`models.*` + 凭证扩展名）项目外读从 `auto_allow` 变 tier=three（堵盲区，可持久化赦免）。
- hard 不变（`~/.ssh/id_rsa` 等外区仍 tier=two 不可持久化）。
- 最小改动：`sensitive.ts`（分级字段 + soft 规则集）+ `decide()` step 2b 分派一处 + `extensions/index.ts` 透传。

**Non-Goals:**
- 不改 hard 集合（既有 5 条规则行为不变，仅补 `level: "hard"` 标注）。
- 不改 grant-memory 存储格式（soft 持久化沿用既有 `Grant` 结构）。
- 不加 `.ini`/`.conf` 等更宽泛扩展名（噪音风险高，暂不加）。
- 不改 sensitive-path-classification 分系统边界（`sensitive.ts` 仍是纯函数 path-shape，无 IO）。

## Decisions

### Decision 1：`SensitiveRule` 加 `level` 字段，而非新增并列数组

**选择**：`SensitiveRule` 接口加 `level: "hard" | "soft"` 字段。既有 5 条规则标 `level: "hard"`，新增 soft 规则集标 `level: "soft"`。

**理由**：`findSensitiveMatch` 返回单一 `SensitiveRule`，`decide()` 读 `sensitive.level` 分派 tier——调用方（`decideTarget`）无需改签名，透传 `sensitive` 给 `decide()` 即可。

**替代方案 A（新增 `PARDONABLE_RULES` 并列数组 + `findSoftSensitiveMatch`）**：`decideTarget` 要调两次 find（hard + soft）+ 处理 hard/soft 同时命中的优先级。复杂，破坏 `findSensitiveMatch` 单一返回值契约。否决。

**替代方案 B（soft 混入 `DEFAULT_SENSITIVE_RULES` 不分级，靠 `reason` 字符串区分）**：`decide()` 无法从 `reason` 字符串可靠判 tier（reason 是人读文本，非枚举）。等同加 `level` 但更脆弱。否决。

### Decision 2：`decide()` step 2b 分派逻辑

**选择**：`tier: sensitive?.level === "soft" ? "three" : (isInside ? "three" : "two")`。

**理由**：soft 不论内外 tier=three（可持久化）；hard 沿用 `isInside` 分派（外区 tier=two 不可持久化）。最小改 `decide()` 一处，`Decision` 类型不变。

**替代方案（`findSensitiveMatch` 后加 wrapper 分派 tier）**：重复 `decide()` 已有 tier 逻辑，破坏决策引擎内聚。否决。

### Decision 3：soft 集合文件名 + 扩展名选择

**选择**：basename `config`/`auth`/`settings`/`models` + 扩展名 `.json`/`.toml`/`.yml`/`.yaml`（精确 `<name>.<ext>` 形态匹配）。

**理由**：这 4 个文件名是常见凭证存储约定（CLI 工具的 token/config 存储）；扩展名限定配置格式，不含 `.ts`/`.js`/`.py` 避免误伤项目内代码模块（`config.ts`/`auth.py` 不命中）。

**替代方案 A（只 `auth.*`）**：覆盖窄，`config.*` 盲区仍在（`~/.config/gh/config.yml` 仍静默读）。否决。

**替代方案 B（加 `.ini`/`.conf`）**：`.ini`/`.conf` 也是配置格式但更宽泛（项目内 `config.ini` 常见），噪音风险高。暂不加，留待用户反馈。

**`~/.ssh/config` 边界**：soft 要求扩展名，`config` 无扩展名不命中 soft；`~/.ssh/config` 仍由 hard SSH key 规则（`b === "config" && d.endsWith("/.ssh")`）覆盖。两规则不冲突。

## Risks / Trade-offs

- **[偏离"敏感路径永远弹窗"硬底线]** → 用户已通过选 B1 接受；`access-decision` spec 显式声明 hard/soft 分级与 override 语义。soft 外区可持久化 = 永久静默读 apikey，但 soft 只含可撤销凭证（apikey 可吊销重置），非不可撤销私钥。
- **[soft 集合噪音]** → 项目内 `config.json` 首弹 tier=three（可"总是允许"持久化消除后续打扰）；项目外 `~/.config/gh/config.yml` 首弹后可持久化。首弹是堵盲区的必要代价。
- **[`~/.ssh/config` 边界]** → soft 要求扩展名，`config` 无扩展名不命中 soft，`~/.ssh/config` 仍 hard。测试覆盖此边界。
- **[soft 持久化 grant 永久读 apikey]** → 用户可编辑 `trusted.json` 撤销；`grant-memory` spec"可赦免敏感路径外区持久化授权"requirement 明确撤销语义不变。

## Migration Plan

无迁移。hard 不变（既有 5 条规则补 `level: "hard"` 标注，行为不变），soft 新增。既有 `trusted.json` 的 hard grant 不受影响。回滚：删 soft 规则集 + 还原 `decide()` step 2b 单行 tier 即可。
