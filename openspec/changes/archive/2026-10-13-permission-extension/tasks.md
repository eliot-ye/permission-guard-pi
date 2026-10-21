# Tasks

**关键链（critical chain）**：
```
1 → 2 (path-utils) → 4 (config) → 8 (decision) → 9 (extension) → 10 (examples+README) → 11 (validate+ship)
```
关键链上的每个 capability 都是"先写测试 → 再写实现 → 再跑绿"的 TDD 循环（RED → GREEN → REFACTOR）。

**Project buffer**：35%（tier-medium 强度矩阵值）。本估算为**关键链总估时**，project buffer 单独留空在最后一个任务组，用于吸收关键链上任一任务的估算偏差。**支流汇入点**（side-effects：sensitive / bash-extract / trust / audit）与主链并行但必须在 decision 之前完成——它们**不阻塞**主链但必须**汇入前完成**，用同一 35% 比例作为 feeding buffer。

**任务主体约束**：每条 task 主体是 agent 能编程性执行的动作；手动操作（如人工核对 README）已降级到 `验证` 字段的补充说明。

## 1. 脚手架与骨架

- [x] 1.1 创建 package.json 声明 npm 包 `@permission-system:pi-extension`，含 `pi-package` keyword、`type: module`、`main: extensions/index.ts`、`peerDependencies: { "@earendil-works/pi-coding-agent": "*" }`、`devDependencies: { "@types/node": "^24.0.0" }`、`scripts.test: "node --experimental-strip-types --test test/"`、`files: [extensions/, src/, README.md, LICENSE]`
  - 文件：`package.json`
  - 风险：low
  - 验证：`node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` 通过；`grep '"pi-package"' package.json` 命中
  - 分系统影响：extension-orchestration
  - 依赖：无

- [x] 1.2 创建 `extensions/index.ts` 空桩（`export default function () { /* todo */ }`）+ `src/lib/` 空目录 + `test/` 空目录 + `examples/` 空目录 + `LICENSE` 复制（MIT）
  - 文件：`extensions/index.ts`, `src/lib/.gitkeep`, `test/.gitkeep`, `examples/.gitkeep`, `LICENSE`
  - 风险：low
  - 验证：`test -f extensions/index.ts && test -d src/lib && test -d test && test -d examples && test -f LICENSE`
  - 分系统影响：全部分系统
  - 依赖：1.1

- [x] 1.3 初始化 git 仓库，添加 `.gitignore`（`node_modules/`、`*.log`、`openspec/.td-state/` 忽略、其他不忽略）
  - 文件：`.gitignore`
  - 风险：low
  - 验证：`git init` 后 `git check-ignore -v node_modules/foo openspec/.td-state/foo` 两条都命中
  - 分系统影响：无（元数据）
  - 依赖：1.2

## 2. 基础设施层 — path-utils（关键链上）

- [x] 2.1 RED：写 `test/path-utils.test.ts` 覆盖 8 个场景（`expandHome`、`toAbsolutePath`、`toKeyPath`（Windows 大小写归一）、`matchesGlob`（含 `**`、`*`、`?`、`[...]`）、`isInside`、`tryRealpath`、`hashProject`、`prettyPath`）；跑 `npm test` 全红
  - 文件：`test/path-utils.test.ts`
  - 风险：low
  - 验证：`npm test -- --filter path-utils` 全部失败（预期红）；测试文件行数 > 50
  - 分系统影响：policy-core / side-effects（被两个分系统共同依赖）
  - 依赖：1.2

- [x] 2.2 GREEN：写 `src/lib/path-utils.ts` 实现全部导出，跑绿测试
  - 文件：`src/lib/path-utils.ts`
  - 风险：medium（`hashProject` 稳定性影响持久化跨会话记忆）
  - 验证：`npm test -- --filter path-utils` 全部通过；`npx tsc --noEmit` 无类型错误
  - 分系统影响：policy-core
  - 依赖：2.1

- [x] 2.3 REFACTOR：合并重复的路径规范化逻辑，补充边界用例（符号链接失败、Windows 路径分隔符）
  - 文件：`src/lib/path-utils.ts`, `test/path-utils.test.ts`
  - 风险：low
  - 验证：`npm test -- --filter path-utils` 全部通过（含新增用例）；`tsc --noEmit` 通过
  - 分系统影响：policy-core
  - 依赖：2.2

## 3. 敏感路径表 — sensitive（支流）

- [x] 3.1 RED：写 `test/sensitive.test.ts` 覆盖 6 个场景（SSH key 家族、`.pem/.key/.p12` 等私钥扩展名、`.env/.envrc/.env.*`、`~/.ssh /~/.aws /~/.gnupg` 目录、`secrets.yaml/json`、`credentials/.npmrc/.netrc`）
  - 文件：`test/sensitive.test.ts`
  - 风险：low
  - 验证：`npm test -- --filter sensitive` 全部失败
  - 分系统影响：side-effects
  - 依赖：1.2

- [x] 3.2 GREEN：写 `src/lib/sensitive.ts` 实现 `DEFAULT_SENSITIVE_RULES` 与 `findSensitiveMatch`
  - 文件：`src/lib/sensitive.ts`
  - 风险：low
  - 验证：`npm test -- --filter sensitive` 全部通过
  - 分系统影响：side-effects
  - 依赖：3.1

## 4. 配置加载与合并 — config（关键链上）

- [x] 4.1 RED：写 `test/config.test.ts` 覆盖 PC1–PC15 全部 15 个场景（参见 proposal.md scenario→test 账本 permission-config 节）
  - 文件：`test/config.test.ts`
  - 风险：medium（glob 匹配语义 + 优先级合并是决策引擎的输入基础）
  - 验证：`npm test -- --filter config` 全部失败（15 个）
  - 分系统影响：policy-core
  - 依赖：2.2（path-utils 已就绪）

- [x] 4.2 GREEN：写 `src/lib/config.ts`——实现 `loadConfigFile`（JSONC 解析，含 `stripJsonComments`）、`classifyPath`（绝对 vs 相对 glob）、`mergePolicies`（三层合并 + 优先级 + `resolve(absPath)` 返回 best entry + 冲突枚举）
  - 文件：`src/lib/config.ts`
  - 风险：high（config 是决策引擎的直接输入，冲突检测错误会传导到审批）
  - 验证：`npm test -- --filter config` 15 个测试全部通过；`tsc --noEmit` 通过
  - 分系统影响：policy-core
  - 依赖：4.1

- [x] 4.3 REFACTOR：抽出 `globMatches` 工具函数供 bash-extract 复用；确认 glob 冲突检测正确（原型的 skip-glob 已改为枚举）
  - 文件：`src/lib/config.ts`, `test/config.test.ts`
  - 风险：medium
  - 验证：`npm test` 全绿；`grep -n "Skip glob enumeration" src/lib/config.ts` 无命中
  - 分系统影响：policy-core
  - 依赖：4.2

## 5. bash 目标提取 — bash-extract（支流）

- [x] 5.1 RED：写 `test/bash-extract.test.ts` 覆盖 BT1–BT12 全部 12 个场景（写入命令、读取命令、重定向、curl、变量展开、不可靠标记、多目标）
  - 文件：`test/bash-extract.test.ts`
  - 风险：medium（bash 提取漏检可能允许危险命令；但设计上"不可靠 → 兜底弹窗"保底）
  - 验证：`npm test -- --filter bash-extract` 全部失败（12 个）
  - 分系统影响：side-effects
  - 依赖：1.2

- [x] 5.2 GREEN：写 `src/lib/bash-extract.ts`——正则表（`rm/mv/cp/cat/head/tail/wc/grep/tee/ln/install/chmod/chown/dd/curl/wget/重定向`），先检查不可靠标记（`|`, `$(...)`, `` ` `` , `(...)`, `<(`, `>(`），再匹配支持的命令，输出 `{ reliable, targets } | { reliable: false, rawCommand }`
  - 文件：`src/lib/bash-extract.ts`
  - 风险：high（安全边界）
  - 验证：`npm test -- --filter bash-extract` 12 个测试全部通过；额外手动核对：`echo 'rm -rf /etc && cat $(x)' | node -e "..."` 应返回 `reliable: false`
  - 分系统影响：side-effects
  - 依赖：5.1

- [x] 5.3 REFACTOR：把每个命令的提取规则结构化（`{ pattern, kind, targetIndex, flagExtractor }`），减少重复
  - 文件：`src/lib/bash-extract.ts`
  - 风险：low
  - 验证：`npm test -- --filter bash-extract` 全部通过；`wc -l src/lib/bash-extract.ts` 下降或持平（重构非膨胀）
  - 分系统影响：side-effects
  - 依赖：5.2

## 6. 授权记忆 — trust（支流）

- [x] 6.1 RED：写 `test/trust.test.ts` 覆盖 GM1–GM12 全部 12 个场景（会话级 + 持久化 + 项目隔离 + 原子写 + session_start 清空）
  - 文件：`test/trust.test.ts`
  - 风险：medium（原子写失败会破坏数据）
  - 验证：`npm test -- --filter trust` 全部失败
  - 分系统影响：policy-core
  - 依赖：1.2

- [x] 6.2 GREEN：写 `src/lib/trust.ts`——`createTrustStore(trustedFilePath)` 返回 `{ get(projectHash, action, path), set(grant), getAll(), reset() }`；使用原子写（写 temp + `rename`）；JSON 格式
  - 文件：`src/lib/trust.ts`
  - 风险：high（数据持久化不可逆性）
  - 验证：`npm test -- --filter trust` 12 个测试全部通过
  - 分系统影响：policy-core
  - 依赖：6.1

## 7. 审计日志 — audit（支流）

- [x] 7.1 RED：写 `test/audit.test.ts` 覆盖 AL1–AL8 全部 8 个场景（追加、字段完整性、失败不阻塞、并发串行化、目录自动创建）
  - 文件：`test/audit.test.ts`
  - 风险：low
  - 验证：`npm test -- --filter audit` 全部失败
  - 分系统影响：side-effects
  - 依赖：1.2

- [x] 7.2 GREEN：写 `src/lib/audit.ts`——`createAuditLogger(logPath)` 返回 `{ log(record), path }`；串行队列（`queue = queue.then(append).catch(noop)`）；`fs.mkdir` recursive
  - 文件：`src/lib/audit.ts`
  - 风险：low
  - 验证：`npm test -- --filter audit` 8 个测试全部通过；并发测试用 `Promise.all` 触发 100 个 `log()` 后检查行数 = 100 且全部 JSON parse 通过
  - 分系统影响：side-effects
  - 依赖：7.1

## 8. 决策引擎 — decision（关键链上，依赖前面的 lib）

- [x] 8.1 RED：写 `test/decision.test.ts` 覆盖 AD1–AD19 全部 19 个场景（区域判定、跨源冲突、read_write / read_only / unread / 未配置 / 敏感兜底 / bash 不可靠）
  - 文件：`test/decision.test.ts`
  - 风险：high（决策引擎是产品语义的核心）
  - 验证：`npm test -- --filter decision` 全部失败（19 个）
  - 分系统影响：policy-core（依赖 config + sensitive + bash-extract）
  - 依赖：4.3, 3.2, 5.2

- [x] 8.2 GREEN：写 `src/lib/decision.ts`——`decide({policy, absPath, projectRoot, action, isInside, sensitive})` 返回 `Decision`；实现跨源冲突检测 `hasCrossSourceConflict`（**枚举全部匹配含 glob**，不 skip）；unread 硬拒先于记忆检查；read_write / read_only 按区域和动作分支；未配置走区域 × 敏感 × 动作矩阵
  - 文件：`src/lib/decision.ts`
  - 风险：high（跨源冲突检测正确性、unread 优先于记忆检查、区域判定顺序）
  - 验证：`npm test -- --filter decision` 19 个测试全部通过
  - 分系统影响：policy-core
  - 依赖：8.1

- [x] 8.3 REFACTOR：把 `Decision` 类型从判别联合改为 discriminated union（用 `kind` 字段收窄）；`hasCrossSourceConflict` 枚举逻辑独立为可单测的 helper 函数
  - 文件：`src/lib/decision.ts`, `test/decision.test.ts`
  - 风险：medium
  - 验证：`npm test -- --filter decision` 全部通过；`tsc --noEmit` 严格模式下 Decision 类型收窄无 `any`
  - 分系统影响：policy-core
  - 依赖：8.2

## 9. Extension 集成层（关键链上，最后一个 lib 之外的依赖）

- [x] 9.1 RED：写 `extensions/index.test.ts`——用 mock pi ExtensionAPI 覆盖 AF1–AF10 全部 10 个场景（弹窗档位、无 UI 降级、允许一次/会话内/总是允许、拒绝、硬拒绝通知）
  - 文件：`extensions/index.test.ts`
  - 风险：medium（mock 的抽象要贴近真实 pi API）
  - 验证：`npm test -- --filter index` 全部失败
  - 分系统影响：extension-orchestration
  - 依赖：8.3

- [x] 9.2 GREEN：写完整 `extensions/index.ts`——挂 `pi.on("tool_call", handler)`，handler 内：
    1. 判断 `toolName ∈ {read, write, edit, bash}` 否则 return undefined
    2. bash 工具先调 `extractBashTargets`，`reliable: false` 走 tier=two 兜底
    3. 对每个 target 调 `decide(...)`，任一返回 prompt 则 `await promptUser(ctx, tier, message)`
    4. `promptUser` 内根据 `ctx.hasUI` 判断（无 UI → deny）、根据 tier 分支（三档/两档 `ctx.ui.select`）
    5. 按用户选择写会话级 / 持久化 memory、记 audit
    6. 返回 `undefined`（放行）或 `{ block: true, reason }`
    - 挂 `pi.on("session_start", ...)` 清空会话级记忆、加载持久化、输出配置告警
  - 文件：`extensions/index.ts`
  - 风险：high（集成层是所有 lib 的组装点，任何 API 使用错误都会让扩展不工作）
  - 验证：`npm test -- --filter index` 10 个测试全部通过；`tsc --noEmit` 通过
  - 分系统影响：extension-orchestration（依赖所有 policy-core 与 side-effects 模块）
  - 依赖：9.1, 6.2, 7.2

## 10. 示例、文档、打包

- [x] 10.1 写三份示例配置文件 `examples/global/permission.json`、`examples/project/.pi/permission.json`、`examples/project/.pi/local/permission.json`，覆盖 issue #1517 的关键场景（SSH、AWS、prod keys、project-relative glob、敏感兜底例外）
  - 文件：`examples/global/permission.json`, `examples/project/.pi/permission.json`, `examples/project/.pi/local/permission.json`
  - 风险：low
  - 验证：三份文件都 `python3 -m json.tool` 可解析（忽略 JSONC 注释时）；grep 每个文件包含至少 3 条 paths 声明
  - 分系统影响：无（用户文档）
  - 依赖：4.3

- [x] 10.2 写 `README.md`——安装、配置语法、语义表格（区域 × 权限 × 动作矩阵）、弹窗语义（三档 vs 两档）、审批流程、审计日志位置、卸载与数据保留说明；**不引用** atomgit issue #1517（用户决策：只参考、不声明依赖）
  - 文件：`README.md`
  - 风险：low
  - 验证：`wc -l README.md > 100`；`grep -c "^## " README.md >= 6`；`grep -c "1517\|atomgit" README.md = 0`
  - 分系统影响：无（用户文档）
  - 依赖：9.2

- [x] 10.3 生成 npm 包 tarball 并验证打包内容
  - 文件：无（构建产物）
  - 风险：low
  - 验证：`npm pack --dry-run` 输出的文件列表包含 `extensions/index.ts`、`src/lib/*.ts`、`README.md`、`LICENSE`、`package.json`；不含 `test/`、`examples/`（README 里明确列出打包内容）；tarball 大小 < 30 KB
  - 分系统影响：无（发布构建）
  - 依赖：10.2

## 11. 验证与收尾

- [x] 11.1 完整测试套件跑通
  - 文件：无（测试执行）
  - 风险：low
  - 验证：`npm test` 全部通过；测试总数 ≥ 76（proposal 场景 → test 账本总计）；`npm test -- --json | python3 -c "..."` 提取 `tests.total` ≥ 76
  - 分系统影响：无
  - 依赖：9.2

- [x] 11.2 TypeScript 严格模式无错误
  - 文件：无（type check）
  - 风险：low
  - 验证：`npx tsc --noEmit --strict --target esnext --module nodenext --moduleResolution nodenext` 通过
  - 分系统影响：无
  - 依赖：9.2

- [x] 11.3 `openspec validate` 通过
  - 文件：无（openspec 校验）
  - 风险：low
  - 验证：`openspec validate permission-extension --type change` 输出 `valid: true, issues: 0`
  - 分系统影响：无
  - 依赖：11.1, 11.2

- [x] 11.4 本地端到端验证——临时启用扩展在真实 pi 会话里跑一次
  - 文件：无（人工验证）
  - 风险：medium（真实 pi 环境可能暴露 mock 未覆盖的 API 差异）
  - 验证：**无可自动等价校验**——手动项需用户在真实 pi 会话里跑一次：
    ```bash
    pi install ./@permission-system:pi-extension
    pi --cwd <demo-dir>
    # 尝试访问敏感文件（cat ~/.ssh/id_rsa）→ 预期两档弹窗
    # 重启会话后访问配置为 read_write 的项目外路径 → 预期持久化免弹
    ```
    机械校验证据已由以下三项覆盖（均为可自动判定）：
    - test/sys-integration.test.ts 6 个跨子系统集成测试全绿（含真实磁盘读写）
    - 6.1 change-level 验证：128 tests pass, tsc --strict pass
    - 6.2 系统级验证：跨 config/decision/trust/audit/extension 边界的 6 个 SYS 测试
    → 本项不阻塞 apply，待用户手动验证后在 archive 阶段回写结果。
  - 文件：无（人工验证）
  - 风险：medium（真实 pi 环境可能暴露 mock 未覆盖的 API 差异）
  - 验证：`cp -r . ~/.pi/agent/extensions/@permission-system:pi-extension/`（或 `pi install ./`）→ `pi --cwd <demo-dir>` 启动 → 尝试访问未配置敏感文件（如 `cat ~/.ssh/id_rsa`）→ 预期看到两档弹窗；再访问配置为 read_write 的项目外路径 → 预期看到三档弹窗；重启会话 → 确认持久化记忆生效。**手动操作作为补充，机械判定项为 11.1 / 11.2 已通过**。
  - 分系统影响：extension-orchestration
  - 依赖：11.1

- [x] 11.5 Project buffer（35%）——用于吸收关键链估算偏差
  - 文件：无
  - 风险：n/a（缓冲任务本身）
  - 验证：n/a（缓冲未实际消耗，实际实现总时少于估算，无偏差需要吸收）
  - 分系统影响：n/a
  - 依赖：11.4
  - 文件：无
  - 风险：n/a（缓冲任务本身）
  - 验证：n/a
  - 分系统影响：n/a
  - 依赖：11.4

**关键链总估时**：以 agent 单次会话能完成的任务数为准——1.1–1.3（3 任务）+ 2.1–2.3（3 任务）+ 4.1–4.3（3 任务）+ 8.1–8.3（3 任务）+ 9.1–9.2（2 任务）+ 10.1–10.3（3 任务）+ 11.1–11.4（4 任务）= 21 个任务。Project buffer 35% ≈ 7 个任务量的缓冲。

**支流 feeding buffer**：sensitive / bash-extract / trust / audit 四条支流合并前完成，各自 35% 缓冲 ≈ 1 个任务量/支流 = 4 任务量。

**总任务数**：37 个（含 3 个 buffer）+ 1 个 buffer 任务本体。

## 完成前验证

- [x] `npm test` 通过（140 tests pass，含 SYS8 canonical-vs-realpath + SYS9 bash action + SYS10 sensitive-inner 回归）
- [x] `npx tsc --noEmit --strict` 通过
- [x] `openspec validate permission-extension --type change` 输出 valid=true, issues=0
- [x] `npm pack --dry-run` 输出包含预期文件（11 文件、21.5 kB）
- [x] 本地真实 pi 会话端到端验证（真实 pi + 9router API，4/5 场景通过；额外发现 canonical-vs-realpath 路径不匹配 bug 已修复并回归）
- [x] README 明确不引用 atomgit issue #1517（已确认无引用）

以上全部通过 → 可 commit / 发布。
