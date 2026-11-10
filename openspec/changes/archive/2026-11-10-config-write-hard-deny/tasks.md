# Tasks: config-write-hard-deny

TDD（RED-GREEN-REFACTOR）。运行：`node --experimental-strip-types --test test/`；类型检查：`npm run typecheck`。

## 关键链与缓冲（critical-buffer，tier-medium → project buffer 35%）

- **关键链**：`1.1`（集成测试改写先行）→ `2.1`（decideTarget L2 改 deny + 提前）→ `2.2`（bash scan 收窄）→ `2.3`（副文本移除）→ `3.1` → `3.2`（验证）。每条标 `**[关键链]**`。
- **project buffer**：关键链末端留 35%（tier-medium，表 1）。**不压缩**。
- 本 change 无独立 feeding 链（纯调用侧处置改动，无新纯函数模块）。

## Caller Impact 实测（步骤 4，实测产出）

| 变更点 | caller 实测 | 兼容结论 |
|---|---|---|
| `decideTarget` L2 分支（:1204-1213）改 deny_hard + 提前到 grant 前 | 调用点 `:918/:920/:1003/:1005` 签名未改 | 内部逻辑改 → 兼容 |
| `scanBashProtectedPaths`（:518）返回类型收窄为 `"deny_hard"\|null` | 调用侧 `:779/:850` 的 `"config_write-prompt"` 分支 | 联合收窄 → 调用侧**需同步删分支**，否则 typecheck fail |
| `bashConfigWriteDecision()`（:553）删除 | 调用侧仅 `:784/:855`（随分支删除） | 删符号 → 同步删调用 |
| 副文本分派（:1276-1277）移除 `config_write` 分支 | 无外部 caller | 死代码移除 → 兼容 |
| `UiCode` 移除 `subtitle_config_write_not_persistable` | i18n bundle `i18n.ts:119/:226` + 分派处 `:1277` | additive 逆操作 → **需同步移除 bundle 键**，否则遗留冗余 |
| `Declaration` 保留 `"config_write"` | 无 union 变更 | 不改 → 兼容（:1376 三元成无害死代码，保留） |

**结论**：变更点含返回类型收窄 + 删符号，非纯新增；调用侧同步改动已逐点定位。**实测通过**（tsc 兜底）。

## 1. RED — 测试先行

- [x] 1.1 **[关键链]** 改写 `test/sys-integration.test.ts` 的 config-write 断言从 prompt → deny_hard（TDD RED：先改断言预期 deny，运行确认 fail）：
  - `SYS-CP3`（写项目 permission.json）：断言从 `promptChoices.length>0 + 无 always-allow + 副文本` 改为 `block:true + 无 prompt + audit declaration=config_write + authorization=presumed`。
  - `SYS-CP4`（配置声明不静默）：断言从"仍 prompt"改为"仍 deny_hard"。
  - `SYS-CP7`（不可靠 bash 无 grant 写 permission.json）：断言从 prompt + 副文本改为 `block:true` + audit `hard_deny` + `declaration=config_write`。
  - `SYS-CP9`（不可靠 bash 有 grant 写 permission.json）：断言从"两次都 prompt config_write"改为"两次都 deny_hard（grant 不豁免）"；删除 `allow_session` 断言（不再弹窗）。
  - `SYS-CP10`（不可靠 bash $PWD 写 permission.json）：断言从 prompt + 副文本改为 `block:true`。
  运行 `node --experimental-strip-types --test test/sys-integration.test.ts`，预期 **SYS-CP3/4/7/9/10 fail**（实现仍 prompt，RED 确认）。SYS-CP1/2/5/6/8/11 不改（L1 deny / 读放行 / 可靠 bash L1 已是 deny_hard，不受影响）。
  - 文件：`test/sys-integration.test.ts`；风险：medium；分系统影响：extension-orchestration + policy-core；依赖：无；估时：10m。

## 2. GREEN — 装配实现

- [x] 2.1 **[关键链]** `extensions/index.ts` `decideTarget`：L2 配置写检查从 grant 之后（:1190-1214）**移到 grant 之前**（与 L1 运行时状态检查同段，unread 之后），处置从 `prompt tier=two` 改为 `deny_hard`，`declaration` 保留 `"config_write"`，移除 `tier` 字段（deny_hard 不带 tier）。验证：SYS-CP3/4 **pass**（GREEN）。
  - 文件：`extensions/index.ts`；风险：high；分系统影响：extension-orchestration + policy-core；依赖：1.1；估时：8m。
- [x] 2.2 **[关键链]** `extensions/index.ts` bash 保护扫描：
  - `scanBashProtectedPaths`（:518）返回类型从 `"deny_hard" | "config_write-prompt" | null` 收窄为 `"deny_hard" | null`——L2 命中（:544-546）改 `return "deny_hard"`。
  - 调用侧两分支（有 grant :779-791、无 grant :850-862）删除 `"config_write-prompt"` 分支（L2 已并入 deny_hard）。
  - 删除 `bashConfigWriteDecision()`（:553-562，不再产生 config_write prompt）。
  验证：SYS-CP7/9/10 **pass**。注：`logBashSelfProtectDeny`（:567-591）已带 `declaration: "unconfigured"`——需改为透传 `"config_write"` 以保审计溯源（或加 declaration 参数）。
  - 文件：`extensions/index.ts`；风险：high；分系统影响：extension-orchestration；依赖：2.1；估时：10m。
- [x] 2.3 **[关键链]** 副文本移除：`src/lib/reason-codes.ts` `UiCode` 移除 `subtitle_config_write_not_persistable`；`src/lib/i18n.ts` 移除 zh/en bundle 对应键（:119/:226）；`extensions/index.ts` 副文本分派（:1276-1277）移除 `config_write` 分支。验证：typecheck 通过（无残留引用）；i18n 测试 pass。
  - 文件：`src/lib/reason-codes.ts`、`src/lib/i18n.ts`、`extensions/index.ts`；风险：low；分系统影响：policy-core + extension-orchestration；依赖：2.2；估时：5m。

## 3. REFACTOR / 验证

- [x] 3.1 **[关键链]** `npm run typecheck` → 通过（`tsc --noEmit`，兜底捕获 `scanBashProtectedPaths` 收窄遗漏的调用侧分支）。
  - 文件：—；风险：low；分系统影响：全 change；依赖：2.3；估时：1m。
- [x] 3.2 **[关键链]** `npm test`（全量）→ 无新增回归（SYS-CP3/4/7/9/10 全绿；SYS-CP1/2/5/6/8/11 仍绿；其余基线测试无回归）。⚠️ 注：基线本身非全绿（既存一致失败 + flaky），本 change 满足"无新增回归"。
  - 文件：—；风险：low；分系统影响：全 change；依赖：3.1；估时：3m。
- [x] 3.3 **[关键链]** `openspec validate config-write-hard-deny --type change` → 通过。
  - 文件：—；风险：low；分系统影响：全 change；依赖：3.2；估时：1m。
