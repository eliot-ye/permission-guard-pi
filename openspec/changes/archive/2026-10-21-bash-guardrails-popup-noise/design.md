## Context

`BASH_GUARDRAILS` 是 `extensions/index.ts` 顶部的常量数组（原 9 条英文 bullet，2729 字符 / 约 682–780 token），通过 `installPromptGuardrails(pi)` 在 `before_agent_start` 事件时以 in-place mutation 的方式注入到 `systemPromptOptions.promptGuidelines`。原稿全部是"陷阱列举 + 尾缀替代建议"的形态——正向引导（prefer read/grep/find）分散在陷阱条尾部，位置靠后、结构不突出。

现有约束：

- **提示词是软引导**：硬规则（`src/lib/bash-extract.ts` 的 `isSilentCommand`、`SILENT_COMMANDS` / `UNRELIABLE_COMMANDS` / `COMMAND_TABLE`、`sensitive.ts`）永远生效；本 change 只影响 LLM 的主动选择倾向，不改变任何决策路径
- **注入机制不变**：`installPromptGuardrails` 的 exact-match dedupe 与 try/catch fail-safe 保持原样；`systemPromptOptions.promptGuidelines` 仍是本扩展与 pi 内核、其他扩展共享的 mutable array，本扩展只 append 不 replace
- **测试断言约束**：`extensions/index.test.ts:779-784` 的 PF1 关键词断言必须继续通过——`/bash/`、`/pipe/`、`/glob/`、`/grep|find/` 四条正则
- **Token 预算**：≤1K token（用户指定，作为 Layer 1/2/3 的总长上限）
- **保守列名**：Layer 2 只点名 `read`/`grep`/`find` 三个 pi 工具短名，不点名 `edit_file`/`write_file`/`glob` 等（避免假设 pi 的工具名与实际不符）
- **范围收敛**：不动 `approval-flow` spec 与所有弹窗副文本；不动 `bash-extract.ts`；不动记忆与审计

## Goals / Non-Goals

**Goals:**

- 显式告诉 LLM"弹窗是噪音"——Layer 1 用一句话给出动机，把"避坑"升级为"主动选静默路径"
- 把正向引导（Layer 2）从陷阱条尾缀提到最前面——LLM 优先命中静默工具
- 每条陷阱（Layer 3）用 `→` 明确接替代方案——不再让 LLM 自己从长句尾推断"该用什么替代"
- 覆盖新增的"敏感系统路径"提醒条（`/etc`、`~/.ssh`、`~/.aws`）——LLM 常见踩坑源，原稿未列
- 保持总长 ≤1K token，让"更清晰"以"不更长"的方式实现（Layer 2 集中式正向清单替代原来 7 条陷阱尾缀的分散式偏好建议，实际字符数比原稿更省）
- PF1 关键词断言全绿；既有测试断言与去重 / fail-safe 语义全部保持

**Non-Goals:**

- **不引入新的分系统**、**不新增公共符号**、**不修改 `installPromptGuardrails` 的函数签名或行为**
- **不改提示词注入机制**：仍走 `systemPromptOptions.promptGuidelines` 的 in-place mutation + exact-match dedupe + try/catch fail-safe
- **不放宽或收紧硬规则**：`src/lib/bash-extract.ts` 的 `isSilentCommand`、`SILENT_COMMANDS` / `UNRELIABLE_COMMANDS` / `COMMAND_TABLE`、`sensitive.ts` 完全不动
- **不改弹窗结构与副文本**：`approval-flow` spec、`bashSubtitleForReason`、`bashPermissionForReason`、tier 两档/三档选项结构、deny_hard 红色通知完全不动
- **不改记忆渠道与授权语义**：`addBashSessionGrant` / `addBashPersistentGrant` / trusted.json 结构 / 审计日志字段完全不动
- **不承诺"LLM 一定不弹窗"**：提示词是软引导，LLM 遵循度取决于模型上下文与训练，本 change 只优化"引导质量"
- **不引入新的 pi 工具名**：Layer 2 只点名 `read`/`grep`/`find` 三个通用短名，不点名 `edit_file`/`write_file`/`glob` 等（d1=B 决策）
- **不新增任何 `BASH_GUARDRAILS` 中的陷阱类别**：Layer 3 的 8 条覆盖与原稿 9 条 bullet 中的 7 条陷阱 1:1 对应，仅新增"敏感系统路径"一条提醒

## Decisions

### D1: 三层结构的顺序（Layer 1 决策层 → Layer 2 静默清单 → Layer 3 陷阱清单）

**决策**：三层从上到下按"决策依据 → 正向选项 → 反面示例"顺序排列，每层用一句话说清"这层在讲什么"作为层间过渡。

**理由**：
- LLM 阅读提示词是"顺读 → 加权"的过程，最前面出现的类别权重最高——把决策动机（"弹窗是噪音"）与正向选项（静默工具清单）放在最前，让 LLM 优先命中静默路径
- 陷阱（Layer 3）作为"最后防线"——只有 LLM 判断 Layer 2 无法覆盖时才会读到 Layer 3，此时陷阱条本身带 `→` 替代方案，形成"兜底再引导一次"的闭环
- 与原稿的"陷阱罗列 + 尾缀引导"相比，正向选项的**位置权重**提高，但**总长度更省**（正向选项集中化后，陷阱条的尾缀"prefer grep/find" 部分可以精简）

**Alternatives considered:**
- 陷阱优先、正向靠后（原稿结构）：正向引导被稀释，无法达成"减少弹窗"的目标
- 平铺所有条目不分层（无 Layer 1）：LLM 不知道"为什么要少弹窗"，无法形成主动规避动机
- 只写正向清单不写陷阱：LLM 不知道陷阱存在，仍会踩到 forwarder / heredoc / unquoted glob

### D2: Layer 1 用一句话说清"弹窗是噪音"的动机

**决策**：Layer 1 只写一句话，明确包含三个信息点：（1）决策引擎有硬规则会自动放行大多数静态命令；（2）弹窗打断用户；（3）请 minimize prompts。

**理由**：
- LLM 需要理解"为什么要少弹窗"——只是说"这些会弹窗"不够，必须把弹窗的负面性质与用户的价值主张明确挂钩
- 一句话长度约束（≤50 词）保证不占用过多 Layer 1 空间，避免"元说明过长反而分散注意力"的反效果
- 三个信息点的顺序：先说"硬规则自动放行"（消除"LLM 觉得所有命令都要弹窗"的错误直觉）→ 再说"弹窗打断用户"（负面价值主张）→ 最后"minimize prompts"（正向指令）

**Alternatives considered:**
- Layer 1 省略：LLM 没有动机说明，只被动避坑
- Layer 1 写三段详细背景：占 token 太多，稀释主体提示词

### D3: Layer 2 集中式正向清单——只点名 `read`/`grep`/`find` + bash 静默形式

**决策**：Layer 2 用 8 条 bullet，覆盖：（a）非-bash 工具（`read` / `grep` / `find`）；（b）bash 静默形式（git / npm / cargo / tsc / go / rg / jq / head/tail/wc/stat）；（c）项目内只读 glob auto-allowed 边界说明。

**理由**：
- **保守列名**（d1=B 决策）：只点名 pi-coding-agent 文档明确的 `read`/`grep`/`find` 三个短名，不点名 `edit_file`/`write_file`/`glob`——若 pi 实际工具名不匹配，会让 LLM 幻觉出错误工具调用
- **bash 静默形式集中**：把原稿分散在 7 条陷阱尾缀的"prefer grep/find" / "prefer read" 提取出来集中到 Layer 2，既节省 token 又提高位置权重
- **auto-allowed 边界说明**：明确"项目内只读 glob 是自动放行的"，避免 LLM 过度规避（把 `ls openspec/*` 也当成陷阱）

**Alternatives considered:**
- 列出所有 pi 工具（`edit_file`/`write_file`/`glob`）：工具名不确定，可能幻觉；且非本扩展的引导范围（本扩展是 bash 权限控制，不是 pi 工具清单大全）
- 只写 `read`/`grep`/`find` 不写 bash 静默形式：LLM 不知道 `git status` / `npm test` 等是安全的，仍可能过度规避到只用 `read`

### D4: Layer 3 每条陷阱用 `→` 接替代方案

**决策**：Layer 3 的 8 条陷阱每条都以 `→` 明确接一个替代方案。

**理由**：
- 原稿的替代方案散落在陷阱条尾的"prefer grep/find" / "use direct commands" 等短语里，位置不突出，LLM 需要自己从长句里推断"该用什么替代"
- `→` 符号在提示词里形成清晰的"陷阱 → 替代"结构，LLM 阅读时更容易抽取"该用什么"信号
- 与原稿的"陷阱 + 长尾说明"相比，替换为"陷阱 + `→` 短替代"更简洁，实际字符数不增

**Alternatives considered:**
- 保持原稿的长尾说明结构：位置不突出，LLM 抽取替代方案的效率低
- 只列陷阱不写替代：LLM 不知道"不用 X 用什么"，可能换成另一个陷阱

### D5: 敏感系统路径条（Layer 3 最后一条）

**决策**：Layer 3 最后追加一条"Sensitive system paths outside the project"，明确列举 `/etc`、`/usr`、`/System`、`~/.ssh`、`~/.aws` 并说明"usually prompt or hard-deny"。

**理由**：
- 敏感系统路径是 LLM 常见踩坑源，且**不属于任何一条 bash 陷阱类别**——`cat /etc/passwd` 不是 forwarder、不是 substitution、不是 control-flow，它直接命中 `sensitive.ts` 的默认清单
- 与 spec `approval-flow` 的 `sensitive_default` scenario 副文本一致——弹窗时用户看到"敏感系统路径不能持久化"，提示词里也应该让 LLM 知道这条
- 措辞用"usually prompt **or hard-deny**"——因为 `~/.ssh`/`~/.aws` 等可能是 `deny_hard`（红色通知，不弹窗），提示词需要覆盖两种结局

**Alternatives considered:**
- 省略敏感路径条：LLM 不知道 `/etc`/`~/.ssh` 是敏感源，仍会踩到
- 敏感路径条放 Layer 2 里作为"避免"清单：结构混乱——Layer 2 是正向清单，敏感路径是反面示例
- 敏感路径条放 Layer 1：Layer 1 是元说明，不适合放具体路径

**边界说明**：本条**只作为 LLM 提示**，不改变 `sensitive.ts` 的实际清单或授权判定；`approval-flow` spec 的 `sensitive_default` 副文本 scenario 保持原样。

### D6: 注入机制完全不动

**决策**：`installPromptGuardrails(pi)` 函数、`before_agent_start` handler、`systemPromptOptions.promptGuidelines` in-place mutation、exact-match dedupe、try/catch fail-safe **全部保持原样**，本 change 只替换 `BASH_GUARDRAILS` 常量数组的字面量字符串内容。

**理由**：
- 注入机制是既有 `extension-orchestration` 分系统的稳定契约，改动会影响 `installPromptGuardrails` 的所有 caller（`registerPermissionGate`）与所有依赖 `promptGuidelines` 的其他扩展
- dedupe 与 fail-safe 是既有 `PF1` 测试断言覆盖的行为，任何修改都需要更新测试——本 change 的目标是"改提示词内容"，不是"改注入机制"
- 分层边界（`src/lib/*.ts` 纯函数 vs `extensions/index.ts` 集成层）不变——本 change 不动 `src/lib` 里的任何文件

## Risks / Trade-offs

- **[风险] LLM 遵循度不稳定** → 缓解：Layer 1 显式说"minimize prompts"，Layer 2 集中式正向清单，Layer 3 每条带 `→` 替代方案；即使 LLM 不 100% 遵循，也比原稿的"陷阱罗列 + 尾缀引导"更有引导力
- **[风险] Layer 3 敏感路径条超出"bash 陷阱"名义范围** → 缓解：本条是"提醒 LLM 不要主动碰"，不改变 `sensitive.ts` 的实际清单或授权判定；`approval-flow` spec 的 `sensitive_default` scenario 保持原样；proposal 的"假设"节明确记录此越界
- **[风险] Layer 2 点名的 `read`/`grep`/`find` 与 pi 实际工具名不匹配** → 缓解：保守策略只点三个通用短名（与 README 里既有引用一致）；不点名 `edit_file`/`write_file`/`glob` 等（d1=B 决策）
- **[风险] 提示词变长后 LLM 对其他扩展 `promptGuidelines` 条目的关注权重下降** → 缓解：新稿总长 2397 字符 ≈ 685 token，比原稿 2729 字符 ≈ 780 token 更短；dedupe 保留其他扩展条目；不重复 dispatch
- **[风险] PF1 关键词断言失效** → 缓解：新稿的 Layer 1 提到 `bash`，Layer 3 提到 `pipeline`/`xargs`（匹配 `pipe`），Layer 3 提到 `glob`，Layer 2 提到 `grep` 与 `find`——四条正则全覆盖，测试不改
- **[权衡] Layer 2 正向清单集中化 vs Layer 3 陷阱分散化**：正向清单集中化后，陷阱条尾的"prefer X" 短语可以精简，节省 token；但 LLM 阅读 Layer 3 陷阱时，替代方案的引导强度不如原稿的"陷阱 + 长尾说明"。取舍：集中化更符合"主动选静默路径"的目标，长尾说明更符合"避坑"——本 change 选择前者

## Migration Plan

无部署迁移。本 change 是纯字面量字符串替换：

1. **实现阶段**：`BASH_GUARDRAILS` 数组从 9 条替换为 18 条三层结构；`README.md:233-271` 同步更新；`extensions/index.test.ts` 的 PF1 断言保持不变（新稿关键词覆盖原四条正则）
2. **测试阶段**：`npm test` 全量回归；PF1 测试仍全绿
3. **回退策略**：`git revert` 单个 commit 即可完全回退；运行时数据（trusted.json / logs/）与本 change 无关，无需数据迁移
4. **可观测性**：本 change 是软引导层，无硬指标 SLA；后续会话可人工观察审计日志里 `event=prompt` 的计数变化趋势

## Open Questions

无。所有决策点（改动幅度 a5、范围"只改提示词"、Layer 2 保守列名 d1=B、敏感路径条 d2=A、落池策略"不落池"）均已在 td-explore 阶段由用户明确拍板，无遗留不确定性。
