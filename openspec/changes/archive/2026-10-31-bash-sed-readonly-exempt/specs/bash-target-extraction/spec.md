## ADDED Requirements

### Requirement: sed 只读豁免

`sed` 属于 `UNRELIABLE_COMMANDS`（命令名精确匹配即判 `unreliable_command`）。系统 MUST 在满足以下**全部**条件时，MUST NOT 判 `unreliable_command`，改为按 sed 只读形态处理（读目标提取见"支持的文件读取命令"requirement 的 sed 子项）：

1. 无任何以 `-i` 开头的短 flag（`-i`、`-i.bak`、`-in` 等备份后缀/选项簇）且无任何短 option cluster 含 `i` 字符（`-ni`、`-si` 等——cluster 每字母独立 flag，含 `i` 即含原地改写语义）且无 `--in-place` 或 `--in-place=...` 长 flag——不原地改写文件（GNU sed `-i[SUFFIX]` 备份后缀语义，`-i.bak` 也是原地改写）。**判定不误伤**：合法只读短 flag（`-n`/`-e`/`-f`/`-s`/`-z`/`-E`/`-r`/`-l`/`-u`/`-b`）主体均不含 `i`，仅 `-i` 及其变体命中
2. 无任何以 `-f` 开头的短 flag（`-f`、`-fxxx`）且无任何短 option cluster 含 `f` 字符（`-nf`、`-ef` 等——含 `f` 即含脚本文件语义）且无 `--file` 或 `--file=...` 长 flag——脚本从文件读取，内容静态不可确定（可含 `r /etc/shadow`/`w /etc/passwd`/`e cmd` 任意命令），MUST 判不豁免（与 awk/perl 脚本内嵌命令同类，见"非目标"）。**判定不误伤**：合法只读短 flag 主体均不含 `f`，仅 `-f` 及其变体命中
3. 每个 sed 脚本（所有 `-e` / `--expression` 值（含 `--expression=...` 内联形式）+ 首个非 flag 位置参数（若存在，即无 `-e`/`-f` 时的单脚本））都**移除分隔符定界形式后**不含以下任一 sed 命令字符——读文件命令 `r` / `R`、写文件命令 `w` / `W`、执行命令 `e` / `E`。**分隔符定界形式的判定**：先移除全部"只读分隔符定界"形式——替换式 `s/RE/REP/`、transliteration `y/src/dst/`、正则地址 `/RE/`（三者 RE/REP/src/dst 内未转义 `/` 为定界符；**内含转义 `\/` 时**：该 `\/` 是字面量 `/`，正确识别定界并移除——实测 `s/a\/b/c/` 判安全（纯只读替换）；**定界不完整**（如 `s/a\/b` 缺第二个未转义 `/`）时保守判不豁免——宁保守弹窗不误放行），对剩余"命令位置"文本检测 `r`/`R`/`w`/`W`/`e`/`E` 任一字符——任一命中即不豁免。**替换式 flag 位置**（`s/RE/REP/e`、`s/RE/REP/w FILE`、`s/RE/REP/W FILE`）的 `e`/`w`/`W` 是命令 flag（执行 / 写文件），MUST 判不豁免——替换式前缀移除**不含** flag 之后的文本（`s/RE/REP/e` 移除 `s/RE/REP/` 后剩余 `e` 仍是命令位置字符，命中）。**判定不误伤**：常见只读 sed（`sed -n '335,345p' file`、`sed 's/foo/bar/' file`、`sed -n '/error/p' file`、`sed 'y/abc/rwx/' file`、`sed -n 's/a\/b/c/' file`（转义 `/` 替换））经分隔符定界形式移除后，剩余命令位置文本不含 `r`/`R`/`w`/`W`/`e`/`E`，正确判安全；真实危险命令（`1,5r /etc/shadow`、`1,5w /etc/passwd`、`e ls`、`s/foo/bar/e`）的命令位置字符在移除后仍残留，正确判危险
4. 无写重定向（`>` / `>>` / `2>` / `2>>` 等写文件重定向）
5. 无命令替换（`$()` / 反引号）——沿用"复杂语法导致不可靠"requirement 的引号感知规则

不满足任一条件时，MUST 保持 `unreliable_command`（读任意文件 / 写 / 执行形态保留弹窗）。

**非目标**：`awk` / `perl` / `python` 等脚本解释器的只读形式 MUST NOT 适用本豁免——其脚本可内嵌 `system()` / `open()`，访问目标静态不可确定，维持 `unreliable_command`。

**判定位置**：sed 只读豁免判定 MUST 在 `isAnyUnreliableCommand` 的 sed 命中之后、判 `unreliable_command` 之前执行——sed 命中且满足豁免条件时不再判 unreliable，落到正常提取流程。

**引号感知**：sed 脚本与文件位置参数的判定 MUST 遵循既有引号感知规则——单引号 `'...'` 内字符为字面量（`r`/`w`/`e` 等在单引号内是字面字符，不触发命令字符判定）；双引号 `"..."` 内的 `$()` 仍触发命令替换（bash 双引号语义）。

#### Scenario: sed 只读形态（-n）放行

- **WHEN** bash 命令为 `sed -n '335,345p' test/decision.test.ts`（无 `-i`、脚本 `335,345p` 不含 r/R/w/W/e/E、无写重定向、无命令替换）
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/test/decision.test.ts] }`

#### Scenario: sed 无 -n 标准输出读放行

- **WHEN** bash 命令为 `sed '1,5p' file.txt`（无 `-n`，标准输出读，无写形态）
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/file.txt] }`

#### Scenario: sed -i 写形态保留弹窗

- **WHEN** bash 命令为 `sed -i 's/a/b/' file.txt`（含 `-i` 原地改写）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: sed 脚本含 w 写命令保留弹窗

- **WHEN** bash 命令为 `sed '1,5w /etc/passwd' file.txt`（脚本含 `w` 写文件命令）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: sed 脚本含 e 执行命令保留弹窗

- **WHEN** bash 命令为 `sed 'e ls' file.txt`（脚本含 `e` 执行命令）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: sed 含命令替换保留弹窗

- **WHEN** bash 命令为 `sed "s/$(date)/x/" file.txt`（脚本含命令替换）
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——命令替换由 scanUnreliable 在 sed 判定之前拦截（entry.ts 步骤 1 先于步骤 4a），故 reason 为 command_substitution；命令替换属于"复杂语法导致不可靠"requirement，sed 豁免条件 5 不满足，维持弹窗

#### Scenario: sed 只读形态 + 管道下游只读放行

- **WHEN** bash 命令为 `sed -n '1,5p' file.txt | grep x`（sed 只读 stage + 下游 grep 只读）
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/file.txt] }`——sed 只读 stage 按 read target 处理，下游 grep 只读，管道按 stage 独立提取

#### Scenario: sed 脚本含 r 读文件命令保留弹窗

- **WHEN** bash 命令为 `sed '1r /etc/shadow' file.txt`（脚本含 `r` 读文件命令——GNU/BSD sed 的 `r FILE` 读取任意路径文件并 append 到输出流）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——`r` 读文件命令读任意路径且目标在脚本内不被位置参数提取，静默放行会读敏感文件，MUST 判不豁免

#### Scenario: sed 脚本含 R 读文件命令保留弹窗

- **WHEN** bash 命令为 `sed '1R /etc/shadow' file.txt`（脚本含 `R` 读文件命令——GNU 扩展，读取一行）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: sed 替换式 flag e 执行保留弹窗

- **WHEN** bash 命令为 `sed 's/foo/bar/e' file.txt`（替换式 flag `e`——替换后执行 REP 作为 shell 命令，GNU 扩展）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——替换式前缀移除后剩余 `e` 是命令 flag（执行），判不豁免

#### Scenario: sed 替换式 flag w 写文件保留弹窗

- **WHEN** bash 命令为 `sed 's/foo/bar/w /etc/passwd' file.txt`（替换式 flag `w`——替换命中写文件，GNU 扩展）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——替换式前缀移除后剩余 `w /etc/passwd` 是命令 flag（写文件），判不豁免

#### Scenario: sed -i 后缀写形态保留弹窗

- **WHEN** bash 命令为 `sed -i.bak 's/a/b/' file.txt`（`-i.bak` 备份后缀形式，GNU sed `-i[SUFFIX]` 原地改写 + 备份）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——`-i.bak` 以 `-i` 开头，条件 1 判不豁免（原地改写 file.txt）

#### Scenario: sed 多 -e 脚本含 r 读文件保留弹窗

- **WHEN** bash 命令为 `sed -e '1,5p' -e 'r /etc/shadow' file.txt`（多个 `-e` 脚本，第二个含 `r` 读文件命令）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——条件 3 检测所有 `-e` 脚本，第二个 `-e` 的参数 `r /etc/shadow` 含 `r`，判不豁免

#### Scenario: sed -f 脚本文件保留弹窗

- **WHEN** bash 命令为 `sed -f script.txt file.txt`（脚本从文件读取，内容静态不可确定）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——条件 2 排除 `-f`/`--file`，脚本文件内容可含任意 sed 命令（r/w/e），判不豁免（与 awk/perl 脚本内嵌命令同类）

#### Scenario: awk 只读形式保持弹窗（非目标）

- **WHEN** bash 命令为 `awk 'NR==1{print}' file.txt`（awk 只读形式）
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——awk 属 UNRELIABLE_COMMANDS，只读形式不适用 sed 豁免

## MODIFIED Requirements

### Requirement: 支持的文件读取命令

系统 SHALL 从以下命令中提取文件目标路径（作为"读目标"）：

- `cat`——读目标
- `head` / `tail`——读目标
- `wc`——读目标
- `grep`——读目标（文件参数）
- `cp` / `mv`（第一参数）——读目标
- `sed`——读目标（只读形态，见"sed 只读豁免"requirement；文件位置参数作为 read target。写/执行形态仍判 `unreliable_command`，不适用本条目）

#### Scenario: `cat` 提取路径

- **WHEN** bash 命令为 `cat /etc/passwd`
- **THEN** 提取读目标 `/etc/passwd`

#### Scenario: `sed` 只读形态提取路径

- **WHEN** bash 命令为 `sed -n '335,345p' test/decision.test.ts`（只读形态）
- **THEN** 提取读目标 `<projectRoot>/test/decision.test.ts`
