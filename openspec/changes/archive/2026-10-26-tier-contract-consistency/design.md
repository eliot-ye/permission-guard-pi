# Design — tier-contract-consistency

## 设计决策概览

本 change 由四个正交子决策组成，实现顺序不影响正确性（每个子决策都能独立测试），但**测试 TDD 顺序**必须先写测试再改代码：

- **D1**：A2 — sensitive 规则分流（`src/lib/sensitive.ts`）
- **D2**：A1 — bash unreliable tier 升级 + promptUser 简化（`extensions/index.ts`）
- **D3**：A4 — 配置加载期通配覆盖 warning（`src/lib/config.ts`）
- **D4**：A3 — 文档同步（`README.md` / `docs/security/permission-model.md`）

## D1：sensitive 规则分流

### 现状

`src/lib/sensitive.ts` SSH 规则当前把 5 类文件混在一条规则里判 hard：

```ts
return (
  b.startsWith("id_rsa") || b.startsWith("id_dsa") ||
  b.startsWith("id_ecdsa") || b.startsWith("id_ed25519") ||
  b === "known_hosts" || b === "authorized_keys" ||
  (b === "config" && (d.endsWith("/.ssh") || d === ".ssh"))
);
```

问题：`known_hosts`（服务端公钥列表）与 `authorized_keys`（授权公钥列表）是**客户端存储的公钥文件**，泄露不构成不可逆凭证风险；把它们与 `id_rsa` 同 tier 会导致日常读取触发 tier=two 不可持久化弹窗，UX 摩擦过大。

### 拆分方案

**SSH 私钥规则**（保留 hard，仅收窄匹配范围）：

```ts
{
  test: (p) => {
    const b = basename(p).toLowerCase();
    const d = dirname(p).toLowerCase();
    return (
      b.startsWith("id_rsa") || b.startsWith("id_dsa") ||
      b.startsWith("id_ecdsa") || b.startsWith("id_ed25519") ||
      (b === "config" && (d.endsWith("/.ssh") || d === ".ssh"))
    );
  },
  reason: "SSH private key",
  level: "hard",
}
```

**SSH 公钥规则**（新增 soft，追加于所有 hard 规则之后）：

```ts
{
  test: (p) => {
    const b = basename(p).toLowerCase();
    const d = dirname(p).toLowerCase();
    return (
      (b === "known_hosts" || b === "authorized_keys") &&
      (d.endsWith("/.ssh") || d === ".ssh")
    );
  },
  reason: "SSH known_hosts / authorized_keys public key",
  level: "soft",
}
```

### 位置决策

SSH 公钥 soft 规则放在**凭证配置文件 hard 规则之后**、**系统机密 hard 规则之前**。位置不影响正确性（因为 `~/.ssh/config.json` 同时会命中凭证目录规则硬判 hard 和 SSH 公钥 soft，hard 优先），但**放在系统机密之前**能确保 soft 规则与 hard 系统机密规则在 `findSensitiveMatch` 里不互相遮蔽。

**ordering 不变式**：所有 hard 规则在前，所有 soft 规则在后；`findSensitiveMatch` 首次匹配保证 hard 优先。此规则已在既有 `DEFAULT_SENSITIVE_RULES` 中建立（`config.json` / `settings.toml` soft 规则追加于所有 hard 规则之后）。

### 边界

- `known_hosts` / `authorized_keys` **不在 `.ssh` 目录下的其他路径**：不命中 SSH 公钥规则，按普通文件处理（例如 `<proj>/myapp/known_hosts` 走 auto_allow）。
- `~/.ssh/config`：仍 hard（无扩展名，不命中 SSH 公钥规则）。
- `~/.ssh/id_rsa.pub`：`id_rsa.pub` 不匹配 `b === "id_rsa"` 前缀（`.pub` 后缀打断 `startsWith("id_rsa")` 语义），会走后续规则检查；当前没有匹配 `.pub` 的规则，会 fallback 到 "项目内敏感文件默认 tier=three"（因为 dirname 是 `.ssh`，命中"凭证目录规则"hard）。**注**：`id_rsa.pub` 是**公钥**，理论上应该 soft，但当前规则会误判 hard——本 change 不扩展此边界（超出 scope），留给未来 change 处理。

## D2：bash unreliable tier 升级 + promptUser 简化

### 现状

`extensions/index.ts` 三处相关代码：

**A. `handleBash` unreliable 分支构造 `Decision`（第 545 行附近）**：

```ts
const decision: Decision = {
  kind: "prompt",
  region: "project_outer",
  declaration: "unconfigured",
  configured: false,
  tier: "two",  // ← 硬编码
  reason: `Bash command could not be reliably parsed...`,
};
```

**B. `promptUser` 的 tier=two + bashReason 分支（第 276-293 行）**：

```ts
if (tier === "two") {
  // Bash-command tier=two prompts get a THIRD option: "Always allow" that
  // writes a bash-command-scoped persistent grant.
  if (bashReason) {
    // 提供 4 选项：allow_once / allow_session / allow_persistent / deny
    ...
  }
  // Plain tier=two (path-based, sensitive default, etc.)
  ...
}
```

**C. `handlePromptDecision` 的 tier=two 副文本分派（第 847-858 行）**：

```ts
if (decision.tier === "two") {
  if (bashCommand && bashReason) {
    subtitle = bashSubtitleForReason(bashReason);
  } else if (bashCommand) {
    subtitle = "命令无法静态解析...";
  } else if (decision.declaration === "sensitive_default") {
    subtitle = "敏感系统路径不能持久化...";
  }
}
```

### 修改

**A**：`tier: "two"` → `tier: "three"`（unreliable bash 走 tier=three）

**B**：删除 `if (bashReason)` 分支——因为 unreliable bash 现在走 tier=three，不再进入 tier=two 分支。tier=three 分支本身就提供 4 选项（allow_once / allow_session / allow_persistent / deny），"Always allow this command" 的语义就是 rawCommand 持久化（`handlePromptDecision` 的 `allow_persistent` 分支根据 `bashCommand` 是否为 null 分派 path vs bash 持久化通道，已有实现，无需改）。

**C**：删除 tier=two 分支的 bash 相关分派（`if (bashCommand && bashReason)` 和 `else if (bashCommand)`）——因为 unreliable bash 现在走 tier=three，副文本分派需要新增 tier=three + bash 分支：

```ts
if (decision.tier === "three" && bashCommand && bashReason) {
  subtitle = bashSubtitleForReason(bashReason);
} else if (decision.tier === "two" && decision.declaration === "sensitive_default") {
  subtitle = "敏感系统路径不能持久化...";
}
```

**注意**：`bashSubtitleForReason` 函数（副文本按 reason 分派的具体生成）不动，因为副文本语义本身正确，只是触发前提从"tier=two + bashReason"更新为"tier=three + bashReason"。

### 不变

- `bashPermissionForReason` 函数（决定 bash grant 授权类型）不动——它的授权类型映射（glob_expansion/unresolved variable → read_only；其他 → read_write）与 tier 无关。
- `handlePromptDecision` 的 `allow_persistent` 分支不动——它已经根据 `bashCommand` 是否为 null 正确分派 path-based vs bash-based 持久化通道。
- `handlePromptDecision` 的 `allow_session` 分支不动——同上。

## D3：配置加载期通配覆盖 warning

### 位置

`src/lib/config.ts` 的 `mergePolicies` 函数内，`allEntries` 构造完成后（`addEntries` 全部调用后）追加校验循环。

### 实现

#### 3.1 SensitiveRule 新增 anchor 可选字段（派生式锚点，方案 A）

为避免 `DEFAULT_SENSITIVE_RULES` 与 `HARD_SENSITIVE_ANCHORS` 双事实源漂移风险（P1-3），锚点与规则**同侧维护**：`SensitiveRule` 新增可选 `anchor: string[]` 字段，每条 hard 规则声明若干代表性 canonical 路径，`HARD_SENSITIVE_ANCHORS` 从 rules 派生。未来新增 hard 规则时开发者只需在规则里加 `anchor` 字段，锚点集合自动更新。

```ts
// src/lib/sensitive.ts
export interface SensitiveRule {
  test: (absolutePath: string) => boolean;
  reason: string;
  level: "hard" | "soft";
  // NEW (A4): canonical representative paths for this rule. Anchors are
  // used by config.ts's checkWildcardOverrideWarning to detect when a user
  // pattern (glob) would cover sensitive files. Anchors are canonical `~/`
  // or absolute paths that this rule's `test` would match on. Not required
  // for soft rules (they don't trigger override warnings).
  anchor?: string[];
}

// ... 规则定义中每条 hard 规则加 anchor，例如：
{
  test: (p) => { /* SSH 密钥规则 */ },
  reason: "SSH private key",
  level: "hard",
  anchor: [
    "~/.ssh/id_rsa", "~/.ssh/id_dsa", "~/.ssh/id_ecdsa", "~/.ssh/id_ed25519",
    "~/.ssh/config",
  ],
}

// 派生锚点集合（单一事实源：从规则派生，非静态常量）
export const HARD_SENSITIVE_ANCHORS: readonly string[] =
  DEFAULT_SENSITIVE_RULES
    .filter((r) => r.level === "hard")
    .flatMap((r) => r.anchor ?? []);
```

**锚点选择原则**：
- 每条 hard 规则至少一个代表性 anchor（避免漏检）
- 不含 soft sensitive 规则（soft 不触发 override warning）
- 用 canonical `~/` 形式（`matchesGlob` 不处理 `~` 展开，锚点与 pattern 都用 `~` 表示）
- **已知精度边界（设计接受）**：私有 key 扩展名规则（`.pem`/`.key`/`.pfx`/`.p12`/`.jks`/`.kdbx`/`.asc`/`.gpg`）只放 2 个代表性 anchor（`.pem` / `.key`），若用户声明 `~/.ssh/*.jks: read_write` 具体扩展名的 pattern，锚点集合不会匹配该扩展名 anchor，warning 不触发。这是**软约束**（warning 是提醒，非硬拒），设计接受此精度。未来若需完整覆盖，可在私有 key 扩展名规则的 `anchor` 数组中补上剩余 6 个扩展名的代表性路径。

**anchor 数量**：5 类 hard 规则各若干 anchor，合计约 **26 条** canonical 路径（SSH 密钥 5 + 私钥扩展名 2 + 凭证目录 7 + 凭证配置文件 3 + 系统机密 8 + 少量代表性重复）——精确数字以 implementation 为准，proposal / spec / tasks 都用"约 26 条"表述（P1-2 一致性修复）。

#### 3.2 校验函数

校验函数按 `entry.isRelative` 分支处理，与 `resolve()` 的匹配语义对齐（P1-1 修复）：

```ts
function checkWildcardOverrideWarning(
  entry: PathEntry,
  projectRoot: string,
): string | undefined {
  if (entry.permission === "unread") return undefined;
  if (!entry.isGlob) return undefined;

  const rootNorm = projectRoot.replace(/\\/g, "/");
  const matched: string[] = [];

  for (const anchor of HARD_SENSITIVE_ANCHORS) {
    // 展开 anchor 中的 `~` 为绝对路径（用于相对匹配）
    const anchorAbs = expandHome(anchor);
    
    let candidate: string;
    if (entry.isRelative) {
      // 相对 pattern：与 resolve() 一致，将 anchor 转为相对 projectRoot 的路径
      const isUnderRoot = anchorAbs === rootNorm || anchorAbs.startsWith(rootNorm + "/");
      if (!isUnderRoot) continue;
      candidate = anchorAbs.slice(rootNorm.length + 1);
    } else {
      // 绝对 pattern：直接使用 anchor 原字符串（保持 `~` 形式与 pattern 一致）
      candidate = anchor;
    }
    
    if (matchesGlob(entry.pattern, candidate)) {
      matched.push(anchor);
      if (matched.length >= 3) break;
    }
  }

  if (matched.length === 0) return undefined;

  const sample = matched.length >= 3
    ? `${matched.join(", ")}, ...`
    : matched.join(", ");
  return `[permission] pattern "${entry.pattern}" from ${entry.source} config grants non-unread access to sensitive paths including ${sample}. Consider using a more specific pattern or setting to "unread".`;
}
```

**在 `mergePolicies` 里调用**：

```ts
// allEntries 构造完成后
for (const entry of allEntries) {
  const warning = checkWildcardOverrideWarning(entry, projectRoot);
  if (warning) warnings.push(warning);
}
```

### 位置决策

**为什么放在 `mergePolicies` 而非 `addEntries` 内**：`addEntries` 在遍历原始 raw config 时调用（未处理跨源优先级），此时同 pattern 的多 source 声明还未合并；`mergePolicies` 末尾统一遍历 `allEntries` 能保证每个 entry 只检查一次，且能拿到最终 priority（虽然 warning 消息本身不区分 priority，但语义更清晰）。

**为什么 anchors 与 rules 同侧维护**（而非 config.ts 独立常量）：避免 `DEFAULT_SENSITIVE_RULES` 与静态 `HARD_SENSITIVE_ANCHORS` 双事实源漂移——未来新增 hard 规则时开发者在规则里加 `anchor` 字段即可，派生常量自动更新。代价是 `SensitiveRule` 接口加一个可选字段（第②类变更点：类型加宽），但外部消费者（`findSensitiveMatch` 返回值类型）不受影响。

**为什么放在 policy-core 而非 extension 层**：e1 校验本质是 policy-core 层的职责（配置语义校验），不应进入 extension-orchestration 层——违反"src/lib/* 是纯函数无 UI/IO"的既有约定。`sensitive.ts` 与 `config.ts` 都在 policy-core 内。

### 边界

- **锚点匹配语义与 `resolve()` 对齐**（P1-1 修复）：`isRelative` 分支将 anchor 转为相对路径比对，绝对 pattern 直接用 anchor 原字符串（含 `~`）。避免用户声明 `{ "**": "read_write" }` 项目根为 `~` 时 warning 漏触发的错误。
- **anchor 精度**：私有 key 扩展名只覆盖代表性 2 条（`.pem` / `.key`），其余扩展名的具体 pattern 不触发 warning。设计接受。
- **锚点样本上限 3 个**：避免长消息，与 spec 里的 `matched_anchors_sample` 约定一致。
- **warning 数量上限**：本 change 不做限制——若用户配置有 10 条大范围通配，会生成 10 条 warning。`session_start` handler 的 `for...of` 循环会逐条 notify，可能造成 session_start 时的 notification flood。**边界接受**：这是用户配置的显式问题，通知频率与用户配置错误成正比。若实际观察 flood 严重（P95 warning 数 > 5），后续 change `warning-batching` 可考虑合并同类 warning（P2-4 follow-up 锚点）。
- **锚点派生是模块加载期执行**：`HARD_SENSITIVE_ANCHORS` 在 `sensitive.ts` 顶部定义，作为 readonly 数组，加载后不可变，无运行时开销。

## D4：文档同步

### README 更新

"How decisions work" 段落需重写：

**旧文本**（约）：
> Prompts come in two tiers: **three-tier** offers "Always allow" (persists to `trusted.json`), **two-tier** does not. Sensitive paths outside the project, and any bash construct the extractor can't statically reason about, use two-tier.

**新文本**：
> Prompts come in two tiers, defined by **whether "Always allow" is offered**:
> - **tier=three** (Always allow available, persists to `trusted.json`): config-declared paths outside project, in-project sensitive paths, soft sensitive paths (revocable credentials + SSH public key files like `~/.ssh/known_hosts`), unconfigured non-sensitive outer writes, **unreliable bash commands**.
> - **tier=two** (no Always allow, session-only): outer-project hard sensitive paths (private keys, credential stores, system credentials), and dev-socket writes (`/dev/tcp/*`, `/dev/udp/*`).
>
> Revoke a grant by editing `trusted.json`.

**已知敏感文件表**（README "How decisions work" 里若有 sensitive 分级说明）：加入 `~/.ssh/known_hosts` / `~/.ssh/authorized_keys` 到 soft 集合。

### docs/security/permission-model.md 更新

**User Experience Model** 段落：更新 tier=three vs tier=two 描述，与 README 保持一致。

**Explicit Boundary** 段落：
- `access-decision` 子系统的"不受保护什么"添加"用户配置通配覆盖 hard sensitive 兜底"作为已知边界，并**引用 D3 warning 机制**作为软约束提醒（非硬约束）。

### CHANGELOG.md 更新

新增 `## [0.2.1]` 段落：

```markdown
### Changed

- **tier 语义收敛**：tier=three = 可持久化（提供"总是允许"），tier=two = 不可持久化。unreliable bash 命令从 tier=two 升为 tier=three，与配置声明 / soft sensitive 归为同一持久化能力类别。
- **SSH 公钥文件降级为 soft sensitive**：`~/.ssh/known_hosts` 与 `~/.ssh/authorized_keys` 从 hard 独立为 soft，外区读写从 tier=two 升为 tier=three（可持久化）——它们是客户端存储的公钥列表，非不可逆凭证。
- **配置加载期通配覆盖 warning**：声明大范围通配（如 `~/.ssh/**: read_write`）覆盖 hard sensitive 兜底时，session_start 会通知 warning，提醒用户可能无意识覆盖了 `id_rsa` 等硬敏感路径。

### Fixed

- bash 命令 tier 语义与敏感默认 tier 语义混淆导致的文档漂移（README、`permission-model.md` 已同步）。
```

## 测试策略（TDD）

按 4 契约（proposal 里定义的 4 条可验证契约）设计 4 组测试：

**T1（契约 1：tier 语义一致）**——`test/decision.test.ts`
- 每个 tier 分派路径构造一个测试用例，断言 `Decision.tier` 与弹窗选项集合一致
- 关键新增：unreliable bash tier=three 断言（当前是 tier=two，改后应是 tier=three）
- 关键新增：`~/.ssh/known_hosts` tier=three 断言（当前是 tier=two hard，改后是 tier=three soft）
- 关键保留：`~/.ssh/id_rsa` 外区 tier=two 断言（仍 tier=two hard，无变化）
- 关键保留：`/dev/tcp/*` 写入 tier=two 断言（仍 tier=two，无变化）

**T2（契约 2：敏感路径分级匹配）**——`test/sensitive.test.ts`
- `findSensitiveMatch("~/.ssh/id_rsa").level === "hard"`（不变）
- `findSensitiveMatch("~/.ssh/known_hosts").level === "soft"`（新增）
- `findSensitiveMatch("~/.ssh/authorized_keys").level === "soft"`（新增）
- `findSensitiveMatch("~/.ssh/config").level === "hard"`（不变）
- `findSensitiveMatch("~/myapp/known_hosts").level === undefined`（新增，边界——非 `.ssh` 目录下的 `known_hosts` 不命中）
- `findSensitiveMatch("~/.aws/config.json").level === "hard"`（不变，规则排序不变式）

**T3（契约 3：unreliable bash tier=three 持久化）**——`extensions/index.test.ts` + `test/sys-integration.test.ts`
- `handleBash` unreliable 分支断言 `Decision.tier === "three"`
- 用户选择 "Always allow this command" 后写入 `trusted.json.bashGrants` 段（既有实现已有，需更新断言前提）
- 下次同 rawCommand auto-allow，`grant_source === "bash_grant_memory"`（既有断言保持）

**T4（契约 4：配置加载期通配覆盖 warning）**——`test/config.test.ts`
- `{ paths: { "~/.ssh/**": "read_write" } }` → warnings 包含 `~/.ssh/**` 与匹配锚点
- `{ paths: { "~/.ssh/known_hosts": "read_write" } }` → warnings 不含通配覆盖 warning（精确路径）
- `{ paths: { "~/.ssh/**": "unread" } }` → warnings 不含（unread 方向一致）
- `{ paths: { "src/**": "read_write" } }` → warnings 不含（不匹配锚点）
- `{ paths: { "~/**": "read_write" } }` → warnings 包含 + 多个锚点样本

## 迁移与向后兼容

- **`trusted.json` 格式**：完全不变。既有 bash grant 与 path grant 都能读取。
- **既有配置**：完全不变。用户配置文件 schema 不变。
- **既有测试**：部分断言需更新（unreliable bash tier 从 "two" 改为 "three"；`~/.ssh/known_hosts` tier 从 "two" 改为 "three"），但**语义**不变——用户看到的行为一致，只是 tier label 更准确。
- **审计日志字段**：完全不变。
- **UI 弹窗**：unreliable bash 弹窗从"3 选项"变为"4 选项"（新增 Always allow）；hard sensitive 外区弹窗从"3 选项"（bash 类变体曾给"总是允许"）统一为"3 选项"（无 Always allow）；soft sensitive 外区弹窗保持"4 选项"。
