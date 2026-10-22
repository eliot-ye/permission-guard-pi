## Context

当前 `MergedPolicy` 接口暴露 `resolve(absolutePath)` 和 `isDeclared(absolutePath)`，仅处理 path 维度。`decide()` 函数签名固定为 `(policy, absPath, projectRoot, action, isInside, sensitive)`，不接受 tool+pattern 信息。

配置加载 `loadAllConfigs()` 在 `extensions/index.ts:98` 处调用 `mergePolicies()` 返回 `{ policy, warnings }`，注入到 `SessionState.policy`。决策调用在 `extensions/index.ts` 的 `before_tool_call` 事件中触发。

atomcode 的 `PermissionRule` 语法（`Bash(git *)`、`Read(~/.zshrc)`）已被确认作为设计参考，但本系统的 schema 形态不同（JSONC 对象 vs 字符串），需适配为本系统的语法风格。

## Goals / Non-Goals

**Goals:**
- 在 `MergedPolicy` 内加宽，新增 `allRules` 字段和 `resolveRule()` 方法
- `decide()` 新增可选参数 `toolName?` / `toolPattern?`，实现 rule 检查阶段
- 保持现有 paths 配置 100% 向后兼容（不加宽策略）
- allow 规则受敏感路径硬底线约束（安全不变量）
- deny 规则无条件优先（安全不变量）

**Non-Goals:**
- 不支持 `mcp__server__tool` 规则（本系统无 MCP 工具集成）
- 不支持 shell-style 通配符（如 `git [a-c]*`），仅支持 `*` 和 `**`
- 不实现规则的 UI 可视化编辑器（仅文档 + JSONC 配置）
- 不改变 grant-memory 的键结构（rules 命中不写入记忆，但记忆结构不变）

## Decisions

### D1: rules 作为独立顶层字段，与 paths 并存

**配置形态**：
```jsonc
{
  "paths": { "...": "..." },   // 现有，不变
  "rules": [                   // 新增
    { "tool": "bash", "pattern": "git *", "action": "allow" }
  ]
}
```

**理由**：paths 是 path→permission 映射，rules 是 tool+pattern→action 列表——两者维度正交，形态不同（对象 vs 数组），不适合混合。加宽策略要求 paths 配置不变，rules 作为新字段并存。

**替代方案**：把 rules 嵌入 paths 的 value（如 `"/x": "read_write"` → `{ "paths": {"/x": "read_write"}, "rules": [...] }`）——破坏向后兼容，且语义混乱。

### D2: resolveRule() 在 MergedPolicy 内，与 resolve() 并列

**接口扩展**：
```typescript
export interface MergedPolicy {
  allEntries: PathEntry[];       // 现有
  allRules: RuleEntry[];          // 新增
  resolve: (absolutePath: string) => MatchedEntry | undefined;  // 现有
  resolveRule: (toolName: string, toolPattern: string) => RuleMatch | undefined;  // 新增
  isDeclared: (absolutePath: string) => boolean;  // 现有
}
```

**理由**：`resolveRule()` 与 `resolve()` 是同一策略面的两个维度——path 维度 vs tool 维度。放在同一个 `MergedPolicy` 内保持策略查询的单一入口，决策引擎无需知道策略来自哪个数据源。

**替代方案**：单独的 `RulePolicy` 接口——但决策引擎需要同时查询两个接口，增加耦合。

### D3: decide() 新增可选参数，rule 检查在 path 解析之前

**签名变更**：
```typescript
export function decide(opts: {
  // 现有参数...
  policy: MergedPolicy;
  absPath: string;
  projectRoot: string;
  action: Action;
  isInside: boolean;
  sensitive: SensitiveRule | undefined;
  // 新增可选参数
  toolName?: string;
  toolPattern?: string;
}): Decision;
```

**检查顺序**：deny rules → path 解析 → allow rules → 默认兜底

**理由**：deny 必须先于所有检查（硬拒绝）；path 声明优先于 allow rules（用户显式配置优先于通配规则）；allow rules 在敏感检查之前（非敏感路径可跳过 prompt）。

**替代方案**：把 rules 检查放在 path 解析之后——但 deny 必须无条件优先，放在后面会被 path 声明覆盖。

### D4: allow 规则不绕过敏感路径检查

**安全不变量**：allow 规则命中后，若目标路径命中敏感规则表（默认敏感路径或配置声明的敏感），仍弹 prompt。

**理由**：这是安全硬底线——用户配置 `Bash(git *)` 允许后，若 `git push` 的操作目标路径命中敏感规则（如 `git push` 到远程含敏感路径），仍会弹窗。allow 规则是便利机制，不是安全绕过。

**替代方案**：allow 规则绕过敏感检查——但这会破坏"敏感路径永远弹窗"的安全不变量，与现有 access-decision spec 矛盾。

### D5: bash 工具 pattern 匹配 rawCommand（空格规范化）

**匹配语义**：bash 工具的 `toolPattern` 是 `rawCommand`（空格规范化为单空格后的命令文本），pattern 中的 `*` 匹配任意字符（包括空格和 `/`）。

**理由**：bash 命令的参数不是路径，无法做路径语义匹配。字符串匹配是唯一可行的方案。空格规范化避免 `git  status`（双空格）不匹配 `git status`。

**替代方案**：解析 bash 命令为 argv 再匹配——但 bash 解析复杂（引号、转义、管道等），且 atomcode 的 `Bash(git *)` 也是字符串匹配语义。

## Risks / Trade-offs

- **规则爆炸**（用户写大量 rules）→ O(n) 线性扫描，rules 数组通常 <50 条，可忽略。但若用户写 1000+ 条，需考虑优化（如按 tool 分组索引）——当前不优化，留待实际性能数据。
- **语义混乱**（paths 和 rules 同时命中但结果不同）→ 检查顺序固定：deny → path → allow → 默认。path 声明优先于 allow rules，deny 优先于 path。用户需理解这个顺序。在文档中显式说明。
- **敏感硬底线被误解**→ 用户可能以为 allow 规则覆盖了所有情况，但敏感路径仍弹窗。在弹窗文案中标注"allow 规则命中但目标路径敏感"，并在文档中明确说明。
- **规则 pattern 注入**→ 用户写 `pattern: "*"` 匹配所有 bash 命令。这是预期行为（用户显式允许），但需配合 deny 规则做保护（`deny: "*"` 可阻止所有命令）。文档中需示例说明。
