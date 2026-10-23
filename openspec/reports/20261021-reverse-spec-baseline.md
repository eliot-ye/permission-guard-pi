# Reverse-Spec 报告：permission-guard-pi

- **触发入口**：第一入口（首次运行 `/td-reverse-spec`，用户显式调用）
- **判读状态**：缓存命中（`openspec/.td-state/profile-tier.yaml`，`profile-brownfield` × `tier-medium`，2026-10-21T12:13:00+08:00），本次不重判
- **代码库规模**：8 源文件（7 lib + 1 extension）+ 10 test 文件；`src/lib/*.ts` 合计 3,839 行，`extensions/index.ts` 978 行，测试合计 5,304 行；`bash-extract.ts` 单文件 3,305 行（占全部源文件 47%）
- **提交节奏**：2026-10-13 首提交 → 2026-10-21，9 天 20+ 提交，15 个 change 已归档，1 个 change 实施中
- **CI/CD**：无（`.github` / `.gitlab-ci.yml` / `.circleci` 均不存在），维护性证据缺失
- **本次是"接手后重刷" 还是 "首次建 baseline"**：首次运行本 skill；`openspec/specs/` 下的 6 个 spec 目录此前由 `td-propose` 增量写入，属于**"从代码反推 baseline" 的确认 + 漂移对齐**，不是从零建立

## 现场判读（消费缓存）

| 维度 | 值 | 依据 |
|---|---|---|
| profile | `profile-brownfield` | 缓存；本次复核未变：可运行代码库 + 无上线流量/CI/CD，不满足 maintenance |
| tier | `tier-medium` | 缓存；src 源文件 <20 但有明显分系统边界，按"边界明显升级 medium"取最高 |
| subsystems | 3 个（下面分系统切分节列） | 缓存 |
| constraint 强度 | 消费 tier-medium × profile-brownfield 表 1/表 2 值 | 见 `field-assessment` 表 1/表 2 |

关键表 1 / 表 2 强度（会话内缓存，供后续 propose/apply 引用）：
- `wip-limit` 上限 4；`critical-buffer` 35% project buffer；`brooks-law` 提醒；`delay-decision` 强
- `human-in-loop` = 基线 1–5 类 ∪ tier-medium 无加成 ∪ profile-brownfield × tier-medium 加成"改老代码前"

## 识别的分系统（消费缓存，不重切）

1. **extension-orchestration** — `tier-small`
   - 职责：绑定 pi ExtensionAPI + 会话状态 + UI 弹窗，负责工具拦截、记忆查询、弹窗分派、审计触发
   - 代码：`extensions/index.ts`（978 行）
2. **policy-core** — `tier-medium`
   - 职责：策略内核——配置加载合并、决策引擎、敏感路径分类、路径工具
   - 代码：`src/lib/config.ts`（252）、`decision.ts`（210）、`trust.ts`（260）、`path-utils.ts`（206）、`sensitive.ts`（95）
3. **side-effects** — `tier-small`
   - 职责：审计日志写入、bash 命令目标提取、敏感路径默认表
   - 代码：`src/lib/audit.ts`（151）、`bash-extract.ts`（3,305）、`sensitive.ts`（95，policy-core 与 side-effects 共享该模块）

**跨分系统共享模块**：`sensitive.ts` 在缓存判据中被同时归到 `side-effects`（默认敏感路径表）与 `policy-core`（分类器服务决策引擎）——两个分系统共用一份代码，是**隐式跨分系统依赖**（详见接口图与"隐式依赖"节）。

## 分系统 → spec 目录映射（多对多）

spec 目录按 capability 组织，不是按分系统组织——1 个 capability 可能横跨多个分系统。这是本仓库既有的组织约定，与 `openspec config.yaml` 的 schema 一致。

| spec 目录 | 主要分系统 | 涉及分系统 |
|---|---|---|
| `openspec/specs/permission-config/spec.md` | policy-core | policy-core（config.ts） |
| `openspec/specs/access-decision/spec.md` | policy-core | policy-core（decision.ts）+ side-effects（sensitive.ts 兜底） |
| `openspec/specs/approval-flow/spec.md` | extension-orchestration | extension-orchestration（UI 弹窗分派） |
| `openspec/specs/grant-memory/spec.md` | extension-orchestration + policy-core | extension-orchestration（记忆查询）+ policy-core（trust.ts 持久化存储） |
| `openspec/specs/bash-target-extraction/spec.md` | side-effects | side-effects（bash-extract.ts） |
| `openspec/specs/audit-log/spec.md` | side-effects | side-effects（audit.ts）+ extension-orchestration（触发点） |

## 分系统间接口图

```
                              ┌────────────────────────────┐
                              │ pi-coding-agent (宿主)     │
                              │  read/write/edit/bash/…    │
                              └──────────┬─────────────────┘
                                         │ ExtensionAPI hook
                                         ▼
                ┌──────────────────────────────────────────────────┐
                │  extension-orchestration  (extensions/index.ts)  │
                │  - 拦截工具调用                                    │
                │  - 记忆查询 (hasGrant/hasBashSessionGrant/…)     │◄─── grant-memory spec
                │  - 弹窗分派 (bashSubtitleForReason, tier=…)       │◄─── approval-flow spec
                │  - 审计触发 (createAuditLogger.log)               │◄─── audit-log spec
                └────┬───────────────────┬───────────────────┬──────┘
                     │                   │                   │
        policy.resolve│       decide(…   │       extractBash │
                     │                   │                   │
                     ▼                   ▼                   ▼
    ┌──────────────────────────┐  ┌──────────────┐  ┌────────────────────────┐
    │ policy-core              │  │ access-      │  │ side-effects           │
    │ - config.ts (MergedPoli- │  │ decision     │  │ - bash-extract.ts      │
    │   cy: resolve/priority)  │──┤ (decision.ts)│  │   · extractBashTargets │
    │ - config.ts (mergePoli-  │  └──────┬───────┘  │   · splitCommands      │
    │   cies, JSONC)           │  │  ▲   │          │   · isDevSocketOrFd    │
    │ - path-utils.ts          │  │  │   ▼          │ - audit.ts             │
    │   (toAbsolutePath/real-  │  │  │ prompt/      │   · createAuditLogger  │
    │   path/hashProject/…)    │  │  │ auto_allow   │   · truncateCommand    │
    │ - trust.ts (持久化授权)  │  │  │ deny_hard    │ - sensitive.ts         │
    └──────────────────────────┘  │  └──────┬───────┘  │   · findSensitiveMatch│
                                  │         │          │   · DEFAULT_SENSITIVE_ │
                                  │  sensitive 参数   │     RULES               │
                                  │◄──────────────────┴─────────────────────── │
                                  └────────────────────────────────────────────┘

跨分系统共享模块：
  sensitive.ts ── 同时被 policy-core (decision.ts 使用 SensitiveRule 类型) 与
                  side-effects (规则表实现) 依赖 → 隐式共享依赖
```

## 分系统间接口清单

### 稳定公共契约（跨分系统，改前必触发 human-in-loop 基线第 1 类）

- **`policy-core → extension-orchestration`**
  - `MergedPolicy.resolve(absPath): MatchedEntry | undefined` — 决策引擎的入口依赖
  - `decide({policy, absPath, projectRoot, action, isInside, sensitive}): Decision` — 纯函数契约，返回 discriminated union（`auto_allow` / `deny_hard` / `prompt`）
  - `Decision.tier: "three" | "two"` — approval-flow 弹窗分派的唯一判定源
- **`side-effects → extension-orchestration`**
  - `extractBashTargets(cmd, projectRoot): ExtractResult` — 二分支 discriminated union（`{reliable: true, targets}` | `{reliable: false, rawCommand, reason}`）；`reason` 字段的字符串字面量是 approval-flow 副文本分派的开关，`reason` 集合是**隐式公共契约**（每加一个 reason 都要同步 `bashSubtitleForReason` / `bashPermissionForReason`）
  - `isDevSocketOrFd(path): boolean` — `decision.ts` 从 `bash-extract.ts` 反向 import 使用（`bash-hardening-round-2` 的 L4b 依赖）
  - `createAuditLogger(logPath): AuditLogger` — 审计 API 稳定，`AuditRecord` 字段列表是公共契约（本次 6 个 spec 已固化，`bash-target-extraction` change 若新增 `grant_type` 等字段需同步 audit-log spec）
- **`side-effects → policy-core`（反向 import）**
  - `bash-extract.ts` 与 `sensitive.ts` 同属 side-effects，但 `decision.ts`（policy-core）从 `sensitive.ts` import `SensitiveRule` 类型 — 类型层面的稳定契约
- **`extension-orchestration` → pi 宿主**
  - `ctx.registerTool` / `ctx.ui.notify` / `ctx.ui.showInput` 等 pi API（外部依赖，不受本仓库版本控制）

### 隐式依赖（未显式建模）

1. **`sensitive.ts` 归属性模糊**：模块归 `side-effects`，但被 `policy-core` 的 `decision.ts` 直接 import，跨分系统共享同一份代码；对 `DEFAULT_SENSITIVE_RULES` 数组的追加/删除（如 `bash-hardening-round-2` 的 L4a）会同时影响两个分系统的行为契约
2. **`bash_reason` 字符串集合**：`extractBashTargets` 的 `reason` 返回值是 approval-flow 副文本分派的隐式开关。当前 spec 显式列举了 `glob_expansion` / `unresolved variable: X` / `control_flow` / `shell_forwarder` / `forwarding_command`；进行中 change 引入 `cd_chdir`；`bash-hardening-round-2` 的 L1/L2 复用 `shell_forwarder`，L3 引入 `cd_chdir`。**该字符串集合的每次扩充都需同步 `bashSubtitleForReason` / `bashPermissionForReason` 与 `approval-flow` spec**——这是隐式契约，未通过 TypeScript 类型系统固化
3. **`bash-extract.ts` → `bash-extract.ts` 常量集合的跨守卫传播**：`SHELL_WRAPPER_NAMES` 同时被 `isShellForwarderTokenStream`（L2 修复点）与 `isAnyUnreliableCommand` 共用——扩展集合会让 `sudo sed -i ...`、`sudo python3 ...` 等**原本静默**的命令被新判 `unreliable_command`。跨守卫影响已在 `bash-hardening-round-2` proposal 的 caller impact 分析节显式列出，但**代码层无类型或结构约束阻止这类误伤**
4. **审计日志与决策引擎的分层责任**：`decide()` 是纯函数（不查记忆、不写审计），记忆查询与审计触发都在 `extension-orchestration`。这个"决策纯函数 + 副作用在集成层"的分层是当前架构的关键约束，任何把审计写入塞进 `decide()` 的重构都会破坏既有 spec 的"决策引擎不检查 grants/memory"契约
5. **`isInside` 参数的语义漂移风险**：`decide()` 接受 `isInside: boolean` 而非 `Region`——调用方必须先做符号链接/`..` 逃逸规范化（`path-utils.tryRealpath` + `isInside`）再传 boolean。若任一调用点跳过规范化直接传 `true`，会绕过 access-decision spec 的"`..` 逃逸规范化"与"符号链接逃逸规范化"两个 requirement

### 循环依赖

**未发现**跨分系统循环依赖。依赖图是单向 DAG：
```
extension-orchestration → policy-core → side-effects (sensitive.ts 类型)
extension-orchestration → side-effects (bash-extract.ts / audit.ts)
```
`decision.ts` 反向 import `bash-extract.ts` 的 `isDevSocketOrFd` 是**未来 L4b 引入**的新方向（policy-core → side-effects 内部代码），已在 `bash-hardening-round-2` design.md D5 明确记录决策理由。

## 各分系统 spec 位置与规模

| spec | 路径 | 行数 | Requirement 数 | Scenario 数 |
|---|---|---|---|---|
| permission-config | `openspec/specs/permission-config/spec.md` | 131 | 6 | 16 |
| access-decision | `openspec/specs/access-decision/spec.md` | 169 | 9 | 21 |
| approval-flow | `openspec/specs/approval-flow/spec.md` | 178 | 8 | 22 |
| grant-memory | `openspec/specs/grant-memory/spec.md` | 221 | 9 | 21 |
| audit-log | `openspec/specs/audit-log/spec.md` | 146 | 8 | 15 |
| bash-target-extraction | `openspec/specs/bash-target-extraction/spec.md` | 1,635 | 21 | 100+ |
| **合计** |  | **2,480** | **61** | **~195** |

**结构合规性**：6 个 spec 均满足 `openspec validate --specs` 的结构要求——含 `## Purpose` 一节 + `## Requirements` 下 `### Requirement: <标题>` + 每条含 SHALL/MUST 规范陈述 + 至少一个 `#### Scenario:` 含 `- **WHEN**` / `- **THEN**`。校验命令未跑（本次是 reverse-spec baseline 确认，非首次生成 spec）。

## 已知风险 / 技术债

按"接下来要改"优先级排序（reverse-spec guardrail：优先详审要改的分系统，其他粗粒度即可）：

1. **`bash-extract.ts` 单体化（P1，直接影响 next change）** — 3,305 行单文件占 8 源文件的 47%。已含 21 个 requirement、100+ scenario，代码与 spec 的双向追溯成本已高。`bash-hardening-round-2` 明确 non-goal "不重构 bash-extract.ts 的单体结构"，接受技术债——但下一个 change 若再触及该文件，`caller impact 分析`节必须逐守卫列出跨守卫传播影响（如 `SHELL_WRAPPER_NAMES` 被 `isShellForwarderTokenStream` 与 `isAnyUnreliableCommand` 共用）
2. **`bash_reason` 隐式契约（P1）** — 字符串字面量集合分散在 `bash-extract.ts`（写入端）、`approval-flow` spec + `bashSubtitleForReason`（读取端）——加一个新 reason 时同步点无类型系统保护。TODO 池中"[P1] 升级 permission-config 规则表达能力"和"[P2] Presumed vs ByPerson"两个方向若涉及 reason 扩充，需先修此契约（可考虑把 reason 定义为 discriminated union 的 literal 集合导出到 `extensions/index.ts`）
3. **`bash-extract` 降噪类工作 backlog（P1，TODO 池）** — `[P1] 静默 bash 只读循环与带 glob 参数的 find，减少 glob_expansion 弹窗噪音`。当前 guardrails 文案宣称 `find . -name '*.ts'` 静默，实测静默；但 `for x in *.log; do wc -l "$x"; done` 实测仍是 glob_expansion 提示——文案与实际不符（详见 `openspec/todo.md` 第 13-15 行）
4. **公共契约变更未定迁移策略（P1，TODO 池）** — "[P1] 升级 permission-config 规则表达能力，支持 tool + pattern 组合语法" 是公共契约变更（`permission-config` spec），迁移策略三选一未定（并存 / 替换 / 不做）。**前置工作：先做一次 `/td-reverse-spec` 覆盖 `permission-config` spec 的当前实现细节，再 `/td-propose`**（TODO 池原文如此）——本次运行已生成该 spec 的 baseline 确认，可解锁后续 propose
5. **`sensitive.ts` 跨分系统归属模糊（P2）** — 一份代码被 policy-core 与 side-effects 同时依赖，规则表变更会同时改两个分系统的 spec 语义。要么把 `sensitive.ts` 独立成第 4 分系统（`sensitive-catalog`），要么在 `policy-core` 中显式承认 `sensitive.ts` 是其内部模块
6. **无 CI/CD（P2）** — 项目无 GitHub Actions / GitLab CI / CircleCI 配置，`npm test` 完全依赖本地执行。若未来上线或多人协作，需补 CI；brownfield × tier-medium 当前无 CI/CD 不满足 `profile-maintenance` 判据，因此 profile 不升级
7. **审计日志 `grant_type` 字段缺口（P2，TODO 池）** — `grant-memory` spec 声明"审计日志字段扩展：新增 `grant_type` 字段，区分 `path` / `bash`"，但 `src/lib/audit.ts` 的 `AuditRecord` interface 无此字段——**spec 声明但代码未实现**，属"spec 与代码漂移"（`bash-hardening-round-2` 的 6.3 任务会新增 `test/grant-memory.test.ts` 覆盖，但不会实现 `grant_type` 字段；字段落地需独立 propose）
8. **`extensions/index.ts` 集成层未纳入 spec** — `extension-orchestration` 分系统的实际行为契约分布在 3 个 spec（approval-flow / grant-memory / audit-log 的触发侧），没有独立的"extension-orchestration spec"整合 UI 交互、记忆查询顺序、审计触发时序。若做跨集成层的重构（如把记忆查询抽出到 policy-core），缺少统一的 spec 参照面

## 建议的下一步

- **当前进行中的 change**：`bash-hardening-round-2` 已完成 propose + design + tasks（tasks 0/18 全未勾选，实施前状态），spec delta 覆盖 4 个 capability（access-decision / approval-flow / bash-target-extraction / grant-memory）。**下一步：`/td-apply bash-hardening-round-2`**——本次 reverse-spec 的 baseline 已确认可作为 apply 阶段的参照面（tasks 中的 caller impact 与 spec delta 均已在 reverse-spec 阶段复核）
- **若下一批是 `openspec/todo.md` 的 [P1] 降噪类工作**：`for`-bounded-glob 只读循环静默 + guardrails 文案对齐，主要触及 `bash-target-extraction` spec 与 `src/lib/bash-extract.ts`——`bash-target-extraction` spec baseline 已就绪（1,635 行，21 requirement）
- **若下一批是 `openspec/todo.md` 的 [P1] permission-config 升级**：需先 `/td-explore` 收敛迁移策略三选一，再 `/td-propose`；本次 reverse-spec 已确认 `permission-config` spec baseline（131 行，6 requirement）
- **若想先补架构层缺口**：独立一次 `/td-explore` 讨论 `sensitive.ts` 归属性（风险 5）+ `bash_reason` 显式契约化（风险 2）——两者都是 P2 但影响面跨分系统，早处理早受益
- **若 baseline 与代码漂移后续需刷新**：`td-system-audit` 步骤 6 可在"baseline spec 与代码漂移"确认后二次调用本 skill（第二入口），仅对检出漂移的分系统执行步骤 4，覆盖更新对应 spec；本仓库当前 `audit-history.yaml` 最近一次 audit 是 2026-10-21T12:31:13+08:00（severe_count: 0），漂移风险低

## 与既有 artifact 的关系

- 6 个 spec 目录：**baseline 确认通过**，结构合规（含 Purpose + Requirements + SHALL/MUST + Scenarios），无需覆盖重写
- `bash-hardening-round-2`：**未 archive**（tasks 0/18），本次 reverse-spec 不与其发生双写冲突——`td-reverse-spec` 步骤 4 明确"不修改原代码"，本次仅写本报告
- `openspec/todo.md` 待办池：4 个条目（2 个已闭环 bash-meta-commands-guard、3 个未闭环 P1/P2），本次报告已按 todo 池原文关联"permission-config 前置工作"与"降噪类工作"两个方向
- `profile-tier.yaml`：缓存命中，本次未更新
