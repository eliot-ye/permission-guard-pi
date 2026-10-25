## Why

bash 可靠提取下符号链接目标的持久 grant 不生效、反复弹窗。根因：`handleBash` reliable 分支 prompt 时以 `resolvedPath`（realpath）存持久 grant（符合 grant-memory spec "记忆键结构" requirement 的 `absPath = realpath 解符号链接` 契约），但下次同命令 `decideTarget` 第一次调用以 `target.path`（命令字面路径）查 `hasGrant`——键不匹配，持久 grant 永不命中；altDecision 用 `resolvedPath` 命中但 severity 更低（auto_allow=1 < prompt=2）不替换，走第一次 prompt → 反复弹窗。

已用 `test/probe-v3-bash-symlink-grant.mjs` 探针复现确认：第二次同命令 `promptCount=1`（仍弹窗），`target.path`（命令字面）≠ `resolvedPath`（realpath）。

## What Changes

- 修 `extensions/index.ts` 的 `decideTarget` grant 查询段（L770-787）：`hasGrant(state, action, absPath)` → `hasGrant(state, action, absPath) || hasGrant(state, action, canonicalPath)`（`canonicalPath` 在 L751 已算出）。
- 文件工具链路不受影响：`resolveToAbsolute`（L1064）内含 `tryRealpath`，`handleFileTool` 传入的 `absPath` 已是 realpath，`canonicalPath === absPath`，查两键等价，行为不变。
- 不改公共契约：`Decision` 类型不变，`TrustStore` 接口不变，audit 记录结构不变。
- 不改 spec：grant-memory spec "记忆键结构" requirement 已定义 `absPath = realpath 解符号链接`，本 change 是实现追上既有契约，无 spec 行为变更（故 `skip_specs: true`）。
- 加 bash 符号链接目标 grant 复用回归测试（沿用 SYS7 风格，覆盖"第一次 Always allow → 第二次免弹"）。

## Capabilities

本 change 不新增/修改任何 capability。grant-memory spec 的"记忆键结构" requirement 已要求 `absPath = realpath 解符号链接`，实现层 `decideTarget` 的 grant 查询偏离此契约（用字面 `target.path` 查询），修复让实现追上 spec。无 spec-level 行为变更，`.openspec.yaml` 设 `skip_specs: true`。

## Impact

- **代码**：`extensions/index.ts` 的 `decideTarget` grant 查询段一处（L770-787），单行改双键查询。
- **测试**：新增 bash 符号链接 grant 复用回归测试（`test/sys-integration.test.ts` 追加一条 SYS 场景）。
- **spec**：无变更（grant-memory spec 已覆盖）。
- **依赖**：无新增。
- **系统**：fail-safe 方向噪音修复（不放松安全，仅减少误弹窗）；bash 可靠提取 + 符号链接目标 + 持久 grant 三者同时成立时触发，边界清晰。

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"——专家判断 + 数据 + 模型反复迭代上升到定量认识）

- **影响哪些分系统**：extension-orchestration（`decideTarget` 在集成层 `extensions/index.ts`）+ grant-memory（查询语义对齐写入端契约）。policy-core（config / decision / trust / path-utils）与 side-effects（audit / bash-extract / sensitive）不受影响。
- **整体性能预期变化**：无行为变化，见 caller impact 分析。bash 符号链接目标持久 grant 从"永不命中 → 重弹 tier=three"变为"命中 → auto_allow 免弹"——fail-safe 方向噪音减少，无安全放松。
- **这是局部优化还是全局协调**：局部优化。改 `decideTarget` grant 查询一处，bash 与文件工具两条链路语义对齐（文件工具已隐式靠 `resolveToAbsolute` 内含 realpath 命中，bash 链路补齐 canonicalPath 键）。
- **如果是局部优化，对全局失调的风险**：低。`canonicalPath` 在 L751 已算出（`tryRealpath(resolvedAbs)`），无新 IO；grant 查询多一次 `Set.has`（O(1)），性能无感。失调风险在"键归一化语义"——`canonicalPath` 是 `tryRealpath` 失败时回退原路径，与写入端 `tryRealpath` 语义一致，不会引入"查询键比写入键更宽"的越权。
- **预期行为模型**：bash 可靠提取 + 符号链接目标 + 用户选"总是允许"持久 grant 后，同会话/跨会话再次执行**同一 rawCommand** → auto_allow（不弹窗）。验证：`probe-v3-bash-symlink-grant.mjs` 第二次 `promptCount=0` 且 `result=undefined`；新增 SYS 回归测试覆盖"第一次 Always allow → 第二次免弹"。
- **与既有架构/风格的遵循关系**：遵循既有"`decideTarget` 内 `canonicalPath` 已算出、`handleBash` reliable 分支已有 `target.path` + `resolvedPath` dual-call 取更严"的架构风格；修法沿用同一 `canonicalPath`，不引入新模式、不偏离既有分系统边界。

## caller impact 分析

- **变更点清单**：
  - `decideTarget` 内 grant 查询（`extensions/index.ts:770-787`）：从单键 `hasGrant(state, action, absPath)` 改为双键 `hasGrant(state, action, absPath) || hasGrant(state, action, canonicalPath)`。属**第②类**（内部实现变更，不改公共契约）——`decideTarget` 是集成层内部函数（非导出 API），返回类型 `Decision` 不变，调用签名不变。
  - 无第①类（公共符号/导出 API）、无第③类（装配点/公共契约）、无第④类（配置/数据格式）变更点。`Decision` 类型、`TrustStore` 接口、`AuditRecord` 结构、trusted.json 格式均不变。
- **高危标记**：无高危变更点（不涉及①③类）。
- **已知 caller**：`decideTarget` 的 caller 仅在 `extensions/index.ts` 内——`handleBash`（L632、L634）与 `handleFileTool`（L681、L683）。预判：
  - `handleFileTool`（L681/L683）：兼容——`absPath` 经 `resolveToAbsolute` 已是 realpath，`canonicalPath === absPath`，查两键等价，行为不变。
  - `handleBash`（L632，target.path 调用）：兼容且修复生效——`target.path`（字面）≠ `resolvedPath` 时，原 `hasGrant(target.path)` miss，现 `hasGrant(canonicalPath)` 命中，正是预期修复。
  - `handleBash`（L634，resolvedPath 调用）：兼容——`canonicalPath === resolvedPath`，行为不变。

## 实际系统工程影响 vs 预期（archive 复盘）

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统：extension-orchestration + grant-memory | 实际同预期：extension-orchestration（`decideTarget` grant 查询）+ grant-memory（查询语义对齐写入端）。policy-core / side-effects 未受影响。 |
| 整体性能预期变化：无行为变化，bash 符号链接目标持久 grant 从"永不命中重弹"变"命中免弹" | 实际同预期：SYS-GRANT 测试第二次 `promptCount=0` / `result=undefined` + 探针结论"V3 证伪"，双重确认。多一次 `Set.has`（O(1)）无性能退化。 |
| 这是局部优化还是全局协调：局部优化 | 实际同预期：改 `decideTarget` 一处，bash + 文件工具两链路对齐。 |
| 局部优化对全局失调的风险：低（canonicalPath 与写入端 tryRealpath 同源） | 实际：风险未发生。6.3 review 确认 `canonicalPath ===` 写入端 `resolvedPath`（同源同函数 `tryRealpath`），无双键越权。 |
| 预期行为模型：bash 可靠提取 + 符号链接 + Always allow → 第二次 auto_allow | **模型验证：预期行为模型已验证**。SYS-GRANT 测试（第二次 `promptCount=0`、`result=undefined`）+ 探针（结论"V3 证伪：第二次 auto_allow，grant 键一致"）双重确认。 |

**补充字段**：
- 预期之外副作用：无行为副作用。6.3 review 指出注释推理瑕疵（文件工具链路真实不破坏原因是第 1 键 `expandedInput` 直接匹配写入键，非 `canonicalPath === absPath`）——已修正注释；同源瑕疵亦见于本 proposal caller impact 预判"handleFileTool absPath 已是 realpath"（L681 实传 `expandedInput` 非 realpath），但"兼容"结论正确（真实原因：第 1 键匹配），非行为偏差。
- scenario→test 账本：本 change `skip_specs: true`（无 specs artifact），无账本。

**baseline 对照**：`grant-memory` spec"记忆键结构"requirement 声明 `absPath = realpath 解符号链接`，本 change 实现追上 spec 契约（查询端改用 `canonicalPath` 对齐写入端 realpath），不破坏 baseline。`skip_specs` 无 spec delta sync。
