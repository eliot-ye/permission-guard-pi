# Tasks

**关键链（critical chain）**：
```
1.1 (RED) → 2.1 (scanControlFlow) → 2.2 (isShellForwarder) → 2.3 (主流程整合) → 2.4 (GREEN) → 3.1 (收尾) → 4.1-4.4 ($? 白名单扩展)
```

**Project buffer**：35%（tier-medium）。关键链共 10 个任务，总估时约 3-4 小时。project buffer 独立留空，用于吸收：控制流 token 识别边界（关键字子串 vs 独立 token）、shell 转发器 token 组合识别边界（`-c` vs `-xc` vs `--`）、shell 内置变量白名单边界（哪些特殊参数无路径影响）的调试时间。

**任务主体约束**：所有 task 主体是 agent 能编程性执行的动作（写测试、写实现、跑命令、改文件）。

**TDD 顺序**：先写测试再写实现。1.1 是 RED，2.4 是 GREEN。

> **Scope 扩展日志（4.1-4.4）**：开发中捕获到 `findUnresolvedVariable` 把 `$?` 误判为 `unresolved variable: special:?` 导致 `git status --short && ...; echo "cached_exit=$?"` 类命令走 tier=two 弹窗。经用户确认纳入本 change（而非建 todo 或新建 change），追加 4.1-4.4 四项任务。

## 1. RED：写测试（先跑红）

- [x] 1.1 写 `test/bash-extract.test.ts` 新增 12 个测试（BMG1-BMG12）
  - 文件：`test/bash-extract.test.ts`
  - 风险：low（纯测试代码）
  - 验证：`npm test -- --filter bash-extract 2>&1 | tail -30` 显示 12 个新增测试全部失败（RED 阶段预期）；既有 100+ 测试继续通过
  - 分系统影响：side-effects（bash-extract）
  - 依赖：无
  - 覆盖场景：BMG1-BMG5（控制流 5 关键字）、BMG6-BMG12（引号感知 + shell 转发器 + 反例）
  - 注意：BMG7 (`bash -c "rm -rf /"`) 是本 change 最关键的回归测试——上一 change 落地时该命令静默放行，本 change 落地后必须判不可靠

## 2. GREEN：bash-extract 实现

- [x] 2.1 实现 `scanControlFlow(cmd: string): boolean`——quote-aware 控制流关键字扫描
  - 文件：`src/lib/bash-extract.ts`
  - 风险：medium（token 边界识别 + quote-aware 状态机）
  - 验证：手工构造 6 个样本手测函数返回值：
    - `while read x; do cat $x; done` → true
    - `for f in *.log; do cat $f; done` → true
    - `if [ -f foo ]; then cat foo; fi` → true
    - `echo "while"` → false（引号内不触发）
    - `echo 'for'` → false（单引号内不触发）
    - `cat /tmp/if.txt` → false（token 子串不触发）
    - `echo hi` → false（无关键字）
  - 分系统影响：side-effects（bash-extract）
  - 依赖：1.1
  - 参考设计：`design.md` D1/D2/D3/D4/D8
  - 关键实现点：
    - 字符级扫描，维护 `quote: null | "'" | '"'` 与 `escaped: boolean` 状态（与 `scanUnreliable` 状态机一致）
    - 单引号/双引号内所有字符视为字面量，不检测关键字
    - 反斜杠转义在外层引号外有效
    - 关键字 token 检测：前后必须为空白、`;`、`&`、`|`、`(`、`)` 或字符串边界
    - 关键字集合：`while`、`for`、`until`、`if`、`then`、`else`、`elif`、`fi`、`case`、`in`、`esac`、`do`、`done`

- [x] 2.2 实现 `isShellForwarder(cmd: string): boolean`——shell 转发器检测
  - 文件：`src/lib/bash-extract.ts`
  - 风险：low（token 层判断，逻辑简单）
  - 验证：手工构造 6 个样本手测：
    - `bash -c "..."` → true
    - `sh -c "..."` → true
    - `zsh -c "..."` → true
    - `bash /tmp/x.sh` → false（无 -c）
    - `bash --version` → false（无 -c）
    - `env bash -c "..."` → true（env 后接 bash -c）
    - `env KEY=VAL bash -c "..."` → true（跳过 KEY=VAL）
    - `which bash` → false（bash 是参数）
  - 分系统影响：side-effects（bash-extract）
  - 依赖：无（与 2.1 并行）
  - 参考设计：`design.md` D5
  - 关键实现点：
    - 取 splitPipelines 拆出的第一个 stage 的 token 序列
    - 第一个 token 是命令名；若是 SHELL_NAMES 成员，检查后续 token 中是否有 `-c`（独立 token）或以 `-` 开头（单 `-`，不匹配 `--`）且包含 `c` 字符（如 `-xc`、`-lc`、`-xec`；bash 选项簇的 `c` 是独立标志）
    - 若是 `env` 或 `command`，跳过 `KEY=VALUE` 形式参数（不匹配 `-c`），继续检查后续
    - 嵌套 env：`env env bash -c "..."` 也支持（递归或迭代跳过）

- [x] 2.3 整合主流程：`extractBashTargets` 中新增两个守卫调用
  - 文件：`src/lib/bash-extract.ts`
  - 风险：low（仅插入两个 if 判断）
  - 验证：手工跑 extractBashTargets 验证 12 个场景全部符合预期
  - 分系统影响：side-effects（bash-extract）
  - 依赖：2.1, 2.2
  - 参考设计：`design.md` D1/D2/D6/D7
  - 关键实现点：
    - 调用顺序：`scanUnreliable` → `findUnresolvedVariable` → **`scanControlFlow`** → **`isShellForwarder`** → `expandSafeVariables` → `splitCommands` + `splitPipelines` + `FORWARDING_COMMANDS` → `SILENT_COMMANDS`
    - 控制流命中 → `return { reliable: false, rawCommand: cmd, reason: "control_flow" }`
    - shell 转发器命中 → `return { reliable: false, rawCommand: cmd, reason: "shell_forwarder" }`

- [x] 2.4 跑 `npm test`（不 filter），确认 bash-extract 相关全部绿；若有回归意外，回 2.3 修
  - 文件：无（测试执行）
  - 风险：low
  - 验证：`npm test 2>&1 | tail -10` 显示 0 fail；`npm test -- --filter bash-extract 2>&1 | grep -E "pass|fail"` 显示 pass 全部绿
  - 分系统影响：无
  - 依赖：2.3

## 3. 收尾

- [x] 3.1 更新 `BASH_GUARDRAILS` 文案（`extensions/index.ts` 顶部）：新增控制流 + shell 转发器的说明
  - 文件：`extensions/index.ts`
  - 风险：low
  - 验证：手工审阅 guardrail 文案（约 3 行新增）；确保文案准确描述新行为
  - 分系统影响：extension-orchestration（guardrail 文案）
  - 依赖：2.4
  - 关键实现点：
    - 保留既有"avoid `xargs`/`parallel` in pipelines"、"avoid command substitution / unquoted glob"文案
    - 新增："avoid control flow keywords (`while`/`for`/`if`/`case` etc.) and shell forwarders (`bash -c`/`sh -c`) — command flow cannot be statically analyzed"

- [x] 3.2 全量跑测试 + TypeScript 类型检查
  - 文件：无
  - 风险：low
  - 验证：`npm test 2>&1 | tail -5` 显示 0 fail；`./node_modules/.bin/tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --strict --allowImportingTsExtensions src/lib/*.ts extensions/index.ts` 通过（无 TS2367 新错误）
  - 分系统影响：无
  - 依赖：3.1

- [x] 3.3 `openspec validate bash-meta-commands-guard --type change --json` 通过
  - 文件：无
  - 风险：low
  - 验证：`openspec validate bash-meta-commands-guard --type change` 输出 valid
  - 分系统影响：无
  - 依赖：3.2

- [x] 3.4 更新 `README.md`：加入控制流 + shell 转发器说明
  - 文件：`README.md`
  - 风险：low
  - 验证：手工审阅（约 5 行新增）
  - 分系统影响：无
  - 依赖：3.2

## 4. `$?` 类白名单扩展（scope 扩展，开发中捕获）

- [x] 4.1 实现 `INERT_SPECIAL_PARAMS` 白名单，修改 `findUnresolvedVariable`
  - 文件：`src/lib/bash-extract.ts`
  - 风险：low（在 2.4 GREEN 后的定向修改，仅影响 `special:*` 分支）
  - 验证：手工跑 extractBashTargets 验证 `$?` / `$!` / `$#` / `$$` 均放行、`$@` / `$0` / `$1` / `$-` 仍判不可靠
  - 分系统影响：side-effects（bash-extract）
  - 依赖：2.4
  - 关键实现点：
    - 新增 `INERT_SPECIAL_PARAMS = new Set(["?", "!", "#", "$"])`——四类无路径影响的 shell 内置变量
    - `findUnresolvedVariable` 的 `special` 分支改为：`m = /^\$([@*\-?!#0-9$])/.exec(rest)`；命中 `INERT_SPECIAL_PARAMS` 时 `continue` 继续扫描，其他仍 return
    - 删除未被引用的死代码 `SPECIAL_PARAMS` 常量
    - `reason` 字段无需新增枚举值（`$?` 类不再产生 reason，其他 special 仍输出 `unresolved variable: special:*`）

- [x] 4.2 新增 BMG15-BMG23 九个测试覆盖白名单与反例
  - 文件：`test/bash-extract.test.ts`
  - 风险：low（纯测试代码）
  - 验证：`npm test 2>&1 | tail -5` 显示 0 fail（总 208 pass）
  - 分系统影响：无
  - 依赖：4.1
  - 覆盖场景：BMG15 `$?` / BMG16 git status 真实场景 / BMG17 `$!` / BMG18 `$#` / BMG19 `$$` / BMG20 `$@` 反例 / BMG21 `$0` `$1` 反例 / BMG22 `$-` 反例 / BMG23 `$?` 单引号内字面

- [x] 4.3 更新 proposal.md / spec delta 反映白名单 requirement
  - 文件：`openspec/changes/bash-meta-commands-guard/proposal.md`、`openspec/changes/bash-meta-commands-guard/specs/bash-target-extraction/spec.md`
  - 风险：low（文档）
  - 验证：手工审阅 + `openspec validate bash-meta-commands-guard --type change` 通过
  - 分系统影响：无
  - 依赖：4.2
  - 内容：What Changes / Capabilities / Impact / 系统工程影响评估 / 预期行为模型 / scenario→test 账本 新增 `$?` 白名单条目；spec delta 新增"Shell 内置变量白名单"Requirement 及 7 个场景

- [x] 4.4 回归验证（TS 检查 + 全量测试 + openspec validate）
  - 文件：无
  - 风险：low
  - 验证：`npm test` 208 pass 0 fail；`tsc --noEmit ... --strict` 通过；`openspec validate bash-meta-commands-guard --type change` 输出 valid
  - 分系统影响：无
  - 依赖：4.3
