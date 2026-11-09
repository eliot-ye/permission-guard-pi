# Reverse-Spec 报告：config-self-protect（定向刷新）

> 定向刷新，承接 td-explore（2026-11-09，方向 a1）。主题：**审批配置/授权记忆自保护**——被管控的 agent 能否改写门自身的配置（`.pi/**`、`~/.pi/**`、`trusted.json`）。
> 现场：profile-brownfield / tier-medium；policy-core（tier-medium）+ extension-orchestration（tier-small）。

## 结论（先给答案）

**存在自保护缺口。** 门自身不保护它管控的配置与授权记忆文件——被管控 agent 可写 `.pi/permission.json` 自我提权，或改 `trusted.json` 自批持久 grant。spec 与代码均未覆盖，需新增"决策层自保护"契约。

## 分系统切分（沿用 profile-tier.yaml 缓存）

1. **policy-core**（tier-medium）— config / decision / trust / path-utils / sensitive 决策内核
2. **bash-extract**（tier-medium）— bash 命令目标提取（本主题不涉及，粗粒度）
3. **extension-orchestration**（tier-small）— pi 集成层（本主题涉及 trusted.json/settings.json 路径注入）
4. **side-effects**（tier-small）— audit.ts（本主题不涉及）

## 分系统间接口图（相关段）

```
tool_call 事件
  └─ extensions/index.ts (extension-orchestration)
       ├─ decide(policy, absPath, action, isInside, sensitive) → Decision   [policy-core]
       ├─ findSensitiveMatch(path) → SensitiveRule | undefined             [policy-core]
       ├─ trust.addPersistentGrant(...) → trusted.json                     [policy-core]
       └─ configLocations() → {global, project, local} 路径                 [policy-core]
```

写保护判定插入点（本主题新增）：`extensions/index.ts` 在调 `decide()` 之前，对 `.pi/**` / `~/.pi/**` 命中路径做硬拒或降档——**不**改 `decide()` 的纯函数签名（保持其可测性）。

## 各分系统 spec（相关）

- policy-core：`openspec/specs/access-decision/spec.md`、`openspec/specs/permission-config/spec.md`、`openspec/specs/grant-memory/spec.md`
- extension-orchestration：`openspec/specs/approval-flow/spec.md`

## 反推四问（policy-core）

### 契约
- `decide()`：给定（policy × absPath × projectRoot × action × isInside × sensitive）→ `auto_allow | deny_hard | prompt`，prompt 带 tier（two/three）。
- 配置：三档 JSONC `permission.json`（`~/.pi/agent` / `<proj>/.pi` / `<proj>/.pi/local`）。
- 授权记忆：双通道（会话 Map + `trusted.json`），键 `projectHash|action|absPath`；bash grant 键 `projectHash|sha256(rawCommand)`。

### 依赖
- policy-core 依赖 path-utils（expandHome/toAbsolutePath/toKeyPath/matchesGlob/isInside/tryRealpath/hashProject）+ sensitive + config。纯函数、零 UI/IO。

### 关键不变量
- unread → deny_hard，记忆不可绕过（`access-decision` spec "unread 权限语义"）。
- tier=two 永不持久化（`grant-memory` spec "未配置路径不写入持久化"）。
- 配置声明优先于默认敏感兜底。
- **（缺失）决策层自身配置/记忆文件不可被工具调用改写**——目前无此不变量。

### 已知缺陷 / 技术债（本次检出）
- **a1 自保护缺口**（实证）：`decide()` 对项目内非敏感写判 `auto_allow`（`decision.ts:302-315`）；`sensitive.ts` 清单不含 `.pi`。→ 写 `.pi/permission.json` 与 `~/.pi/.../trusted.json` 均 auto_allow。
  - 验证命令（node 判定引擎直跑）：
    - `write .pi/permission.json → auto_allow (In-project non-sensitive write)`
    - `write ~/.pi/.../trusted.json → auto_allow`
    - `is .pi sensitive? → false`
  - 对照：ta-agent 对 `.ta-ai/**`、`~/.ta-ai/**` 硬 deny 且不可豁免（`../ta-agent/packages/runtime/src/approval/policy.ts:60-68`）。
  - 参考 ta-agent `approval/policy.ts:59-68` 写保护判定（路径级、与 effect 类别无关、优先于 allow/`!` 否定）。

## 已知风险 / 技术债

- **R1（a1，本次）**：配置/记忆自保护缺失 → agent 自我提权。严重度高，属安全修复。
- R2（非本次）：`enabled:false` 连硬拒一起旁路（无 auto 保硬拒档位）——td-explore 方向 a2，本次不动。
- R3（非本次）：不可分析 bash 命令可被持久化 grant——方向 a4，本次不动。

## 建议的下一步

- 对 **policy-core**（access-decision / permission-config / grant-memory 三 spec）提 change：`/td-propose config-self-protect`。
  - 契约变更点：新增"决策层自保护"要求（写 `.pi/**`、`~/.pi/**`、`trusted.json`、`settings.json` 命中 → 硬 deny 或 tier=two 不可持久化）。
  - 实现面：`extensions/index.ts` 前置写保护判定（不改 `decide()` 签名，保持纯函数可测）+ 对应 spec 条款 + TDD 测试。
  - 需 human-in-loop 确认：属对外行为变化（`.pi/**` 写从 auto→deny/prompt），且 spec 公共契约新增条款——propose 时由用户拍板。
