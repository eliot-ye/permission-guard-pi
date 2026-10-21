## ADDED Requirements

### Requirement: 命令替换内只读命令豁免

当 bash 命令中的命令替换 `$(...)` 满足以下**全部**条件时，MUST NOT 触发 `command_substitution` 不可靠标记，让命令走正常提取流程：

1. **顶层命令属于豁免白名单**：`$(...)` 内展开后的顶层命令名属于 `SUBSTITUTION_READONLY_CMDS` 集合（`basename` / `dirname` / `echo` / `printf` / `pwd` / `test`）——这些命令只执行路径字符串变换、标准输出打印、当前目录输出或条件查询，无任意文件读写、无网络访问、无子命令执行副作用。**注意**：`realpath`（即使 `-m` 形式）与 bash 的 `[` test builtin 别名**不在**白名单内——前者涉及文件系统遍历，后者的语法检查成本高、收益低。
2. **嵌套替换递归判定**：`$(basename $(dirname $f))` 这类嵌套形式中，外层 `$(basename ...)` 通过条件 1 后，其参数 `$(dirname $f)` 是嵌套命令替换，MUST 递归地对最内层命令替换运行相同的条件 1/2 判定。嵌套深度超过 3 层 MUST NOT 豁免（触发 `command_substitution`），避免恶意构造。
3. **顶层无副作用构造**：`$(...)` 顶层命令的**参数部分**（不含被递归判定的嵌套 `$(...)`）MUST NOT 包含以下任一 shell 层副作用构造：
   - 未加引号的 glob 元字符（`*` / `?` / `[`）——与"有界 glob 免不可靠标记"一致，无界 glob 不豁免
   - heredoc 定界符 `<<`
   - 反引号 `` `...` ``（命令替换的旧形式）
   - 未加引号的形式化命令替换 `$(...)`（未被递归判定接受为嵌套豁免）
   - 输出重定向 `>` / `>>` / `2>` 等（会写入任意文件，绕过 `command_substitution` 门禁）
   - 管道 `|`（引入额外命令执行，extractor 无法穿透边界判定）
   - 后台分隔符 `&` 与逻辑与 `&&`（引入额外命令执行）
   - 命令分隔符 `;`（引入额外命令执行）
4. **用户变量在参数中允许**：白名单命令的参数中可以出现引号内的用户变量（如 `basename "$f"`）——变量的实际值不影响命令的静态只读性判定。这类命令里的用户变量**仍会**在 `findUnresolvedVariable`（"变量展开与展开失败"requirement）判定中被识别为未解析用户变量，走兜底弹窗——**本豁免不覆盖用户变量判定**，豁免判定与用户变量判定是**独立且顺序执行**的两步。

**边界与理由**：命令替换的豁免判定是**保守白名单准入**——白名单外的形式（`$(cat ...)`、`$(grep ...)`、`$(rm -rf ...)`）一律保持原 `command_substitution` 判定不变。豁免的存在不改变默认行为，只让"用户眼中显然安全"的常见 shell 惯用法（`$(basename ...)`、`$(dirname ...)`）不再被误判为噪音弹窗。

**顺序与交互**：
- 本豁免在 `scanUnreliable` 的字符扫描循环内判定，位置在同循环内其他 unreliable 检测（backtick / heredoc / subshell / glob）的**同一次遍历**中——即豁免掉一个 `$(...)` 后，扫描继续向后，其他位置的 unreliable 模式仍会被检测。
- 豁免判定通过之后，整条命令仍要经过 `scanControlFlow` / `isShellForwarder` / `isAnyUnreliableCommand` / `findUnresolvedVariable` 等**后续所有守卫**——豁免仅关闭 `command_substitution` 这一条理由，不短路任何其他守卫。
- 与"有界 glob 免不可靠标记"requirement 一致：豁免判定失败立即回退原判定，不影响其他 guardrail 层。

#### Scenario: `$(basename ...)` 在 read-only for 循环内自动放行

- **WHEN** bash 命令为 `for f in openspec/changes/archive/*/proposal.md; do echo "=== $(basename $f) ==="; head -20 "$f"; done`
- **THEN** 提取结果为 `{ reliable: true }`——`$(basename $f)` 的顶层命令 `basename` 在白名单内，参数 `"$f"` 是引号内字面量，无副作用构造，豁免条件 1-4 全部满足；不触发 `command_substitution`，命令按正常提取流程判 reliable

#### Scenario: 嵌套 basename+dirname 自动放行

- **WHEN** bash 命令为 `for f in openspec/**/*.md; do echo "=== $(basename $(dirname $f)) ==="; head -20 "$f"; done`
- **THEN** 提取结果为 `{ reliable: true }`——外层 `$(basename $(dirname $f))` 的顶层命令 `basename` 在白名单内（条件 1），参数 `$(dirname $f)` 是嵌套命令替换（条件 3），递归判定 `$(dirname $f)` 通过（`dirname` 也在白名单内），豁免成立

#### Scenario: 白名单外命令替换仍判不可靠

- **WHEN** bash 命令为 `echo "$(cat /etc/passwd)"`
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——`cat` 不在 `SUBSTITUTION_READONLY_CMDS` 内，条件 1 不满足，豁免失败回退原判定

#### Scenario: `realpath`（含 `-m`）暂不豁免

- **WHEN** bash 命令为 `echo "$(realpath -m openspec/specs/foo.md)"`
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——`realpath` 不在 `SUBSTITUTION_READONLY_CMDS` 白名单内（即使 `-m` 形式涉及路径参数与文件系统遍历，本 change 暂不纳入白名单，待二次评估）；豁免失败回退原判定

#### Scenario: 白名单命令含未加引号 glob 参数仍判不可靠

- **WHEN** bash 命令为 `echo "$(basename /etc/*.txt)"`
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——虽然 `basename` 在白名单内（条件 1），但参数 `*.txt` 是未加引号的 glob 元字符，违反条件 3，豁免失败回退原判定

#### Scenario: 嵌套深度超过 3 层判不可靠

- **WHEN** bash 命令为 `echo "$(basename $(dirname $(pwd $(pwd))))"`
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——嵌套深度达到 3 层，第 4 层触发嵌套深度上限，豁免失败回退原判定（条件 3 违反）

#### Scenario: 白名单命令参数中嵌套替换含写操作仍判不可靠

- **WHEN** bash 命令为 `echo "$(basename $(rm -rf /tmp/x))"`
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——外层 `basename` 通过条件 1，但嵌套 `$(rm -rf /tmp/x)` 递归判定时 `rm` 不在白名单内，条件 3 递归失败，豁免失败回退原判定

#### Scenario: 白名单命令参数含用户变量仍豁免但走变量判定

- **WHEN** bash 命令为 `echo "path: $(basename $MY_FILE)"`，`MY_FILE` 未展开
- **THEN** 提取结果为 `{ reliable: false }`——`basename` 通过豁免条件 1-4（参数 `"$MY_FILE"` 是引号内字面变量引用，豁免判定不检查变量值），但 `findUnresolvedVariable` 在后续步骤检测到未展开用户变量 `MY_FILE`，命令仍判 `unreliable, unresolved variable: MY_FILE`——豁免与用户变量判定是独立的两个步骤

#### Scenario: 白名单命令 + 后续命令含真实写操作仍提取 write target

- **WHEN** bash 命令为 `echo "$(basename $f)" && rm -rf /tmp/scratch`
- **THEN** 提取结果为 `{ reliable: true, targets: [delete /tmp/scratch] }`——`$(basename $f)` 豁免通过，命令不判 `command_substitution`；但 `&&` 后的 `rm -rf /tmp/scratch` 由正常的 `rm` 提取器（`COMMAND_TABLE.rm`）提取为 delete target，命令仍判 reliable（`scanControlFlow` 等其他守卫不触发）。这演示了"豁免仅关闭 command_substitution 单条理由，不短路任何其他守卫"的规则

#### Scenario: `$(dirname ...)` 单独出现自动放行

- **WHEN** bash 命令为 `head -20 "$(dirname openspec/specs/bash-target-extraction/spec.md)/spec.md"`
- **THEN** 提取结果为 `{ reliable: true }`——`$(dirname ...)` 参数是纯字面量路径，无副作用构造，豁免成立

#### Scenario: `$(pwd)` 自动放行

- **WHEN** bash 命令为 `echo "cwd: $(pwd)"`
- **THEN** 提取结果为 `{ reliable: true }`——`pwd` 在白名单内，无参数，豁免成立
