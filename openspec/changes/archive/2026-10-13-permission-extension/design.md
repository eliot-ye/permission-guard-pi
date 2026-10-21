## Context

Greenfield pi-coding-agent 扩展。目标：让 pi 用户用 JSONC 配置文件声明"哪些路径可读 / 可写 / 硬拒"，跨会话持久记忆，并留下可审计的决策日志。

代码分层已由 openspec/config.yaml 约定：`src/lib/*.ts`（无 UI/IO 依赖的纯模块，可单元测试）+ `extensions/index.ts`（pi ExtensionAPI 集成层）。运行时打包为 npm pi-package，通过 jiti 加载，无编译步骤。

参见 proposal.md 了解动机与范围。

## Goals / Non-Goals

**Goals:**

- 6 个 capability 的行为契约都有 TDD 单元测试覆盖（specs 里每个 Scenario 对应至少 1 个 test 用例）
- 决策引擎是纯函数：无 fs、无 UI、无 pi import，可以在任何 Node 环境跑
- 扩展对 pi 只依赖公开 API（`ExtensionAPI`、`tool_call` event、`ctx.ui.select`、`ctx.hasUI`），不依赖内部实现
- 与 pi 内置的 `permission-gate`、`protected-paths`、`project-trust` 扩展共存，不冲突
- 零运行时 npm 依赖（仅 `@earendil-works/pi-coding-agent` peerDep）；无 wasm/native

**Non-Goals:**

- 不监听 `project_trust` 事件（决策 a1）——不依赖 pi 原生信任机制
- 不引入 tree-sitter 或其他语言解析器（决策 b1）——用正则 + 明确"不可靠"标记
- 不提供 revoke 命令——用户手工编辑 trusted.json 撤销
- 不做多工作区（monorepo）支持——`<projectRoot>` 是单一根目录
- 不做 macOS Gatekeeper / Windows ACL 之外的操作系统级权限集成
- 不处理 `edit` 工具的部分行编辑语义（编辑敏感文件整体作为写访问处理）

## Decisions

### D1: 决策引擎是纯函数，memory 检查在 extension 层前置

`src/lib/decision.ts` 的 `decide(opts)` 只接受纯数据输入（`policy`、`absPath`、`projectRoot`、`action`、`isInside`、`sensitive`），返回纯数据输出（`Decision` union type）。任何 UI、fs、pi 调用都不在里面，memory 查询也**不在**里面。

**授权记忆检查**发生在 **extension 层**：extension 在调用 `decide()` **之前**查询会话级 + 持久化 grants，命中直接放行；未命中才调 `decide()`。access-decision 中"已授权后免弹"的场景实际由 extension 层前置过滤实现，spec 中的"决策"表述包含这个前置过滤步骤（见 access-decision spec 中的“memory 前置过滤”注）。

**Why**：纯函数是 TDD 的关键——所有测试都是同步、无 mock、可跑在 `node --test` 里的普通断言。把 fs 读入、UI 调用、memory 查询都推到 extension 层，让 `decide()` 保持同步、可单测。同时让 memory 查询与决策解耦——未来的 memory 存储实现（SQLite / LevelDB / 云同步）只需改 extension 层，不影响 decision 层测试。

**Alternatives considered**：
- 把 fs 读入放在 decision 内部——放弃，会导致每个测试都要 mock fs
- 把 grants 作为 `decide(opts)` 的入参（一个 `GrantLookup` 接口）——放弃，会让决策逻辑与 memory 查询耦合，测试时需要 mock lookup
- **采纳的方案**：extension 层前置过滤——decide() 看到的都是“未授权”路径，保持纯函数

### D2: 配置文件 JSONC（保留注释能力）

用轻量自研 JSONC 解析器（`stripJsonComments` + `JSON.parse`），不引入外部 JSON5 / jsonc-parser 依赖。

**Why**：注释支持是用户需求；引外部依赖会与"零运行时依赖"目标冲突。JSONC 语法范围很小（`//` 单行、`/* */` 多行、尾逗号），自研解析器 < 50 行。

**Alternatives considered**：改用 TOML（跟 issue #1517 原文一致）——放弃，用户明确决策用 JSON。

### D3: 项目外 glob 支持（决策 a3）

`config.ts` 的 `classifyPath` 除了识别项目内相对 glob，还对**绝对路径 glob**（以 `/` 或 `~` 开头且含 `*`/`?`/`[`）走 glob 匹配路径，不受 `<projectRoot>` 限制。

**Why**：实现成本几乎为 0（复用同一 `matchesGlob` 函数），用户能表达 `/tmp/**/*.log = read_only` 这类实用规则。

**Alternatives considered**：不实现（issue #1517 开放项 2）——放弃，本 change 顺便补上。

### D4: 跨源冲突检测（决策 c3）

`decision.ts` 里的 `hasCrossSourceConflict` 对**所有**匹配（含 glob）枚举冲突，不再 skip glob。冲突策略：全局 `unread` vs 项目 `read_write`（或反向）→ 强制弹三档询问用户。

**Why**：原型 `decision.ts` 明确 skip 了 glob 冲突；补上让行为语义完整。glob-vs-glob 冲突（罕见）按"最高优先级胜 + 不视为冲突"处理（同权限级视为一致）。

**Alternatives considered**：保持原型 skip——放弃，语义不完整。

### D5: 运行时数据目录使用扩展自身标识

`trusted.json` 与 `logs/permission-review.jsonl` 放在 `~/.pi/agent/extensions/@permission-system:pi-extension/` 下。

**Why**：这是 pi 社区惯例（见 pi 官方 examples 里 `sandbox/`、`subagent/` 扩展）；pi 没有提供跨会话的全局持久化 API（`pi.appendEntry()` 绑定到单个会话），扩展自建文件是标准做法。

**Alternatives considered**：放到 `~/.pi/agent/permissions/`——放弃，会与其他扩展冲突；放到项目 `.pi/`——放弃，跨项目持久授权是核心需求。

### D6: bash 提取使用"reliable" 二分

`bash-extract.ts` 输出 `{ reliable: true, targets }` 或 `{ reliable: false, rawCommand }`。决策引擎对 `reliable: false` 走 tier=two 弹窗，不尝试猜测。

**Why**：正则不能覆盖所有 bash 语法。明确"不可靠"边界比"尽力提取"更安全——漏检时是弹个"我不理解这条命令"的弹窗，而不是误放行危险命令。tree-sitter 未来若引入，`reliable` 语义保持不变。

**Alternatives considered**：尽力提取，无法识别的当"目标为当前目录"处理——放弃，不安全。

### D7: TDD 强制

任务顺序严格按 RED-GREEN-REFACTOR：
1. 先写测试文件（引用尚不存在的模块）
2. 跑测试，全红
3. 写最小实现让测试变绿
4. Refactor（如需要）

**Why**：用户明确决策走 TDD。6 个 capability 都有清晰的行为契约（specs/*.md 里的 Scenario），每个 Scenario 直接映射为一个 test case。

### D8: 决策函数接口签名

```ts
type Action = "read" | "write" | "delete";
type Region = "project_inner" | "project_outer";
type PromptTier = "three" | "two";

type Decision =
  | { kind: "auto_allow"; region: Region; declaration: Declaration; configured: boolean; reason: string }
  | { kind: "deny_hard"; region: Region; reason: string; source?: string }
  | { kind: "prompt"; region: Region; tier: PromptTier; declaration: Declaration; configured: boolean; reason: string; conflict?: boolean };

type Declaration = "read_write" | "read_only" | "unread" | "sensitive_default" | "unconfigured";
```

**Why**：明确返回类型避免 extension 层猜字段。`declaration` 字段带出决策来源，UI 与 audit 都能直接用。

### D9: 冲突弹窗文案约定

跨源冲突的三档弹窗文案包含"跨源冲突"字样，reason 明确说明"全局标记 X 但项目标记 Y"。审计记录 `event=conflict_prompt`。

**Why**：让用户能识别这是"两层配置打架"而不是普通审批，帮助他们排查配置。

### D10: 项目 hash 算法

`hashProject(projectRoot)` 使用 `node:crypto.createHash("sha256")` 对**规范化后的绝对路径**（`realpath` + 小写化）做 sha256，取前 12 hex chars。

**Why**：稳定、跨平台、无碰撞风险（12 位 hex ≈ 2^48，对单用户 <100 个项目的场景远超需求）。同一目录不同大小写 / 符号链接前缀 → 同 hash；不同 worktree（不同 realpath）→ 不同 hash。

**Alternatives considered**：目录名哈希——放弃，重命名就失效。

### D11: audit 串行队列实现

`createAuditLogger` 用 `let queue = Promise.resolve(); queue = queue.then(() => append(record)).catch(() => {})` 链式串接。任何 append 失败被 catch 吞掉。

**Why**：无锁串行 + 不阻塞主流程，是"日志失败不影响业务"的最简实现。并发工具调用通过 promise 链自然排队，无文件描述符争用。

### D12: extension 层拦截 `tool_call` event

`extensions/index.ts` 只挂 `pi.on("tool_call", handler)`。handler 判断 `event.toolName ∈ {read, write, edit, bash}` 后翻译输入、调用 `decide()`、根据结果调用 `ctx.ui.select` / 返回 `{ block: true }` / 返回 `undefined`（放行）。

**Why**：`tool_call` 是 pi 官方推荐的拦截点，返回 `{ block: true }` 会阻止工具执行。不需要注册新的 tool 或用 `context` 事件。

## Risks / Trade-offs

- **bash 正则漏检危险命令** → **Mitigation**：任何"reliable: false"命令走 tier=two 兜底弹窗，宁误弹不漏放行；审计日志记录每次兜底触发，可追溯漏检模式。未来若反馈量大再引入 tree-sitter（作为独立 change）。
- **配置格式错误导致扩展异常** → **Mitigation**：JSONC 解析失败降级为空配置 + 会话启动告警一次；决策引擎对空配置退化到"默认敏感兜底 + 项目外写弹审批"，绝不因配置错而 block 工具调用。
- **trusted.json 写入损坏** → **Mitigation**：原子写入（写 temp + rename）；读入时 JSON parse 失败视为空 grants + 告警；audit 记录加载失败事件。
- **符号链接逃逸未检测** → **Mitigation**：`path-utils.tryRealpath()` 在判定 isInside 前尝试 realpath；失败时按原路径判定（保守，不放大信任），并记入 audit note。用户可通过 `unread` 硬拒绝关键路径作为兜底。
- **会话级 Map 内存增长** → **Mitigation**：session_start 清空；单会话内 Map 大小与"用户授权操作数"成正比，正常开发一天几十条以内，无风险。
- **审计日志文件无限增长** → **Mitigation**：本期不做轮转，日志目录由用户手工管理（如 `tail -n 1000` 或 `rm`）；README 明确说明。若成为痛点，独立 change 增加轮转。
- **pi 版本演进导致 tool_call 事件签名变更** → **Mitigation**：peerDep 用 `*`，测试在开发时的 pi 版本跑；发布前人工验证最新 pi 版本的扩展契约。

## Migration Plan

Greenfield change，无迁移。用户安装方式：

```bash
pi install npm:@permission-system:pi-extension
```

首次运行时：
1. 扩展加载，检查 `~/.pi/agent/extensions/@permission-system:pi-extension/` 目录不存在则创建
2. 加载三份配置文件（缺失视为空）
3. 启动时输出一次配置告警（若有）与"扩展已加载"提示
4. 后续每次工具调用走决策流程

**卸载**：`pi remove @permission-system:pi-extension`；配置与 trusted.json 保留在磁盘（用户可手工删除）。

**回滚**：卸载即可；无数据迁移。

## Open Questions

- **审计日志轮转策略**：本期不做。若日志超过 100 MB 用户反馈，独立 change 引入按大小 / 日期轮转。
- **`edit` 工具的部分行编辑**：`edit` 是"精确文本替换"，理论上可能改敏感行也可能不改。本期把整个 `edit` 调用视为"对该路径的写访问"处理，不做行级判断。若用户报告"误报编辑"再考虑细化。
- **Windows UNC 路径**：`//server/share` 形式的处理在原型里未测。若目标用户含 Windows，独立 change 加支持。
- **多工具并发审批的串行化**：多个工具调用同时触发弹窗时，pi 的 UI 是否会自动排队？本期按 pi 的行为走，不做扩展层的额外同步。

以上开放项**不阻塞** tasks.md 的任务分解——它们都可以在实现完成后独立处理，不影响本 change 的验收。
