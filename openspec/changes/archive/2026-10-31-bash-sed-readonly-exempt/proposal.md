## Why

`sed` 在 `UNRELIABLE_COMMANDS`（脚本解释器类），命令名精确匹配即判整条命令 `unreliable_command`，**无论参数形态如何**。这导致 `sed -n '335,345p' test/decision.test.ts` 这类纯只读的 sed 形态（无 `-i`、脚本无 `r`/`R`/`w`/`W`/`e`/`E` 命令、无写重定向、无命令替换）也被弹窗拦截——实际访问目标（文件位置参数）完全可静态确定，不该走兜底弹窗。真实案例：一条全只读诊断命令因含 `sed -n` 段被误弹 `unreliable_command`（隔离实验证伪了"裸词目录/重定向 token"等其他归因，根因确为 sed 整类判不可靠）。

2026-10-20 `bash-stage-b-security-fixes` 设计文档预留了此方向：`sed` 判 unreliable 的理由是"`sed -i` 可写任意文件"，但只读形态的访问目标是静态可确定的。本 change 给"确定只读的 sed 形态"开豁免，同时保留读任意文件 / 写 / 执行形态的弹窗。

## What Changes

- **新增**：`sed` 只读窄形态豁免——无 `-i` 开头的短 flag 及含 `i` 的短 option cluster（`-i.bak`/`-ni` 等）且无 `--in-place`、无 `-f` 开头的短 flag 及含 `f` 的短 option cluster（`-nf` 等）且无 `--file`、每个脚本（所有 `-e` 值 + 首个非 flag 位置参数）移除替换式前缀后无 `r`/`R` 读文件命令、无 `w`/`W` 写文件命令、无 `e`/`E` 执行命令、无写重定向（`>`/`>>`/`2>` 等）、无命令替换（`$()`/反引号）时，按 read target 提取文件位置参数放行；其余 sed 形式保持 `unreliable_command`。
- **新增**：`sed` 读提取器——位置参数（含 `-n` 脚本后的文件参数，排除全部 `-e`/`-f` 脚本值）作为 read target 提取，走正常决策（与 cat/head/tail 同通道）。
- **保留不变**：`sed -i`/`-i.bak`/`--in-place`、`sed -f script.txt`、`sed -e '1,5p' -e 'r /etc/shadow'`（多 `-e` 第二脚本 r）、`sed '1,5w /etc/passwd'`、`sed '1r /etc/shadow'`、`sed 'e ls'`、`sed 's/foo/bar/e'`（替换式 flag e 执行）、`sed 's/foo/bar/w /etc/passwd'`（替换式 flag w 写文件）、任何读任意文件/写/执行形态 → 仍 `unreliable_command`（安全非目标）。
- **明确非目标**：`awk`/`perl`/`python` 等脚本解释器的只读形式**不纳入**豁免——脚本可内嵌 `system()`/`open()`，访问目标静态不可确定。

## Capabilities

### New Capabilities

（无新增能力——本 change 只修改既有 bash-target-extraction 行为契约。）

### Modified Capabilities

- `bash-target-extraction`: 本 change 对既有 capability 做两处 spec 级行为变更：
  - **ADDED** "sed 只读豁免" requirement——定义 sed 只读形态豁免判据（无 `-i` 前缀/含 `i` cluster/`--in-place`、无 `-f` 前缀/含 `f` cluster/`--file`、所有脚本移除替换式前缀后无 `r`/`R`/`w`/`W`/`e`/`E` 命令字符、无写重定向、无命令替换）与读任意文件/写/执行形态保留弹窗；明确 awk/perl/python 只读形式为**非目标**。
  - **MODIFIED** "支持的文件读取命令" requirement——读目标列表加入 `sed`（只读形态，文件位置参数作为 read target）。
  - 注：主 spec 无既有 `UNRELIABLE_COMMANDS`/`sed` requirement（2026-10-20 archive 的"不可执行命令守卫"delta 未并入主 spec，属独立 archive 缺口，不在本 change 范围内修复），故 sed 判不可靠的既有行为契约需以 ADDED requirement 形式补入本 change 的 delta。

## Impact

- **受影响代码**：`src/lib/bash-extract/silent.ts`（`UNRELIABLE_COMMANDS` 判定逻辑或 `isAnyUnreliableCommand`）、`src/lib/bash-extract/entry.ts`（判定流程）、`src/lib/bash-extract/extractors.ts`（`COMMAND_TABLE` 加 sed 读提取器或独立分支）。
- **受影响测试**：`test/bash-extract.test.ts`（新增 sed 只读豁免用例 + 保留写形态用例）。
- **API 契约**：`extractBashTargets` 签名/返回类型不变；`ExtractResult` 结构不变。行为上对既有 sed 命令（全部形态）的返回从"必然 `unreliable_command`"变为"只读形态可放行，写形态仍 `unreliable_command`"——这是**行为变更**，但仅影响 sed 命令类别，不改变任何非 sed 命令的结果。
- **依赖**：无新增依赖。纯函数模块，无 IO/UI。

## 系统工程影响评估

- **影响哪些分系统**：单分系统 `bash-extract`（tier-medium）。不触及 policy-core（decision.ts 只 import `isDevSocketOrFd`，与 sed 判定无关）、extension-orchestration（消费 `extractBashTargets` 结果，但仅依赖 `reliable`/`reason`/`targets` 的既有契约，不因 sed 放行改变契约形状）、side-effects（audit.ts 无涉）。

- **整体性能预期变化**：sed 只读形态从"整条命令被弹窗拦截"变为"按 read target 走正常决策"。对开发工作流，含 sed 只读段的诊断/检查命令不再被弹窗打断——预期可观测行为：`sed -n '335,345p' file` 在项目内文件上不再弹窗、按 read target 决策（项目内默认放行）；`sed -i 's/a/b/' file` 仍弹窗。**可测量**：sed 只读形态的误弹窗率从 100% 降至 0（该形态原必弹窗）；**技术无关**：用户可观察到"含只读 sed 段的命令不再被中断"；**可验证**：`sed -n '335,345p' test/decision.test.ts` → `reliable:true`，`sed -i 's/a/b/' test/x.ts` → `reliable:false`。

- **这是局部优化还是全局协调**：局部优化。只放宽 sed 一种命令的只读形态，不触碰其他 UNRELIABLE 命令类（awk/perl/python 保持弹窗），不改全局判定架构。

- **如果是局部优化，对全局失调的风险**：低（修复后）。风险点是 sed 只读判据**误放行读任意文件/写/执行形态**——若判据未精确排除 `r`/`R` 读文件命令、`w`/`W`/`e`/`E` 命令或 `-i`，`sed '1r /etc/shadow' file` 会被误放行（读敏感文件不被检测）、`sed '1,5w /etc/passwd'` 会被误放行（写文件不被检测）。本 change 的判据必须显式排除这些形态（移除替换式前缀后检测 `r`/`R`/`w`/`W`/`e`/`E` 任一字符），测试必须覆盖读/写/执行形态反例。若判据完备，局部放宽不产生全局失调（其他 UNRELIABLE 类行为不变）。

- **预期行为模型**：
  - **输入** `sed -n '1,5p' file.txt`（项目内）→ **输出** `reliable:true, targets:[read <projectRoot>/file.txt]`；
  - **输入** `sed '1,5p' file.txt`（无 -n，标准输出读）→ **输出** `reliable:true, targets:[read <projectRoot>/file.txt]`；
  - **输入** `sed -e '1,5p' file.txt`（-e 单脚本）→ **输出** `reliable:true, targets:[read <projectRoot>/file.txt]`；
  - **输入** `sed -i 's/a/b/' file.txt` → **输出** `reliable:false, reason:"unreliable_command"`（写形态保留弹窗）；
  - **输入** `sed -i.bak 's/a/b/' file.txt` → **输出** `reliable:false, reason:"unreliable_command"`（`-i.bak` 备份后缀原地改写保留弹窗）；
  - **输入** `sed '1,5w /etc/passwd' file.txt` → **输出** `reliable:false, reason:"unreliable_command"`（`w` 写命令保留弹窗）；
  - **输入** `sed '1r /etc/shadow' file.txt` → **输出** `reliable:false, reason:"unreliable_command"`（`r` 读文件命令保留弹窗——读任意文件且目标不被位置参数提取）；
  - **输入** `sed 'e ls' file.txt` → **输出** `reliable:false, reason:"unreliable_command"`（`e` 执行命令保留弹窗）；
  - **输入** `sed 's/foo/bar/e' file.txt` → **输出** `reliable:false, reason:"unreliable_command"`（替换式 flag `e` 执行保留弹窗）；
  - **输入** `sed 's/foo/bar/w /etc/passwd' file.txt` → **输出** `reliable:false, reason:"unreliable_command"`（替换式 flag `w` 写文件保留弹窗）；
  - **输入** `sed -e '1,5p' -e 'r /etc/shadow' file.txt` → **输出** `reliable:false, reason:"unreliable_command"`（多 `-e` 第二脚本 r 读文件保留弹窗）；
  - **输入** `sed -f script.txt file.txt` → **输出** `reliable:false, reason:"unreliable_command"`（`-f` 脚本文件内容不可确定保留弹窗）；
  - **输入** `sed -n '1,5p' file.txt | grep x`（管道下游只读）→ **输出** `reliable:true`（sed 只读 stage + 只读下游，均按 read target 处理）。
  - **验证**：`test/bash-extract.test.ts` 新增上述用例（TDD RED-GREEN，全部场景见 Scenario→Test 覆盖账本）。

- **与既有架构/风格的遵循关系**：遵循。sed 只读豁免沿用既有模式——`isAnyUnreliableCommand` 是命令名集合判定（silent.ts），豁免作为该判定的窄化分支（类似 `npx --no-install` 已有窄化豁免：silent.ts `isSilentNpx` 对特定形式放行）；sed 读提取加入 `COMMAND_TABLE` 或复用 `readExtract`（与 cat/head/tail/wc/grep 同通道）。不引入新模式、不改分系统边界、不改错误处理模式。**偏离点：无**。

## caller impact 分析

- **变更点清单**：
  1. **①类 公共符号签名变更**：无。`extractBashTargets`/`isAnyUnreliableCommand` 签名不变，无参数/返回值/异常契约变化。
  2. **②类 Protocol/接口方法变更**：无。不触碰任何抽象接口。
  3. **③类 装配点变更**：无新增装配点。`extractBashTargets` 的消费路径（`extensions/index.ts:622`）不变——它读 `extraction.reliable`/`reason`/`targets`，本次只改变 sed 命令的返回值（从 reliable:false 到可靠 true），不改 `ExtractResult` 结构，消费方无需适配。
  4. **④类 数据流/返回值语义变更**：**有，限 sed 命令类别**。`extractBashTargets` 对 sed 命令的返回值从"必然 `{reliable:false, reason:"unreliable_command"}`"变为"只读形态 `{reliable:true, targets:[read...]}`；写形态仍 `{reliable:false}`"。这是本 change 唯一的变更点，且限定在 sed 类别内。
  - **高危标记**：**无高危（修复后）**。④类变更点限定于 sed 命令，不涉及公共符号/装配点（①③ 类无）。既有 `extractBashTargets` 的全部 caller（`extensions/index.ts:622` 生产 + `test/bash-extract.test.ts` + 3 个 probe `.mjs`）都按 `reliable` 布尔 + `targets` 数组消费，sed 放行只是让 `reliable` 从 false 变 true，所有 caller 的既有分支对 `reliable:true` 路径已有完整处理（正常决策通道），无需适配。**注**：原判据（未排除 `r`/`R`）下"无高危"不成立——`sed '1r /etc/shadow' file` 会静默放行读敏感文件，属高危误放行；修复后判据显式排除 `r`/`R`/`w`/`W`/`e`/`E`，该风险闭合，"无高危"成立（架构 review CRITICAL-1 修复）。
- **已知 caller**（确定已知的高危 caller——无高危，列出全部消费方作完整性说明）：
  - `extensions/index.ts:622`（生产，唯一生产 caller）：`extraction.reliable` 为 true 时走正常决策通道（`if (!extraction.reliable)` 的 else 分支），已处理 read target，**兼容**。
  - `test/bash-extract.test.ts:29`（测试）：直接断言 `extractBashTargets` 返回值，新增用例即可，**兼容**。
  - `test/cross-system-boundary.mjs` / `test/probe-v3-bash-symlink-grant.mjs` / `test/security-probe.mjs`（测试 probe）：消费 `reliable`，**兼容**。

## Scenario→Test 覆盖账本

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 支持的文件读取命令 | `sed` 只读形态提取路径 | test/bash-extract.test.ts | `BT-SED-1: sed -n 只读提取 read target` | 🟢 |
| sed 只读豁免 | sed 只读形态（-n）放行 | test/bash-extract.test.ts | `BT-SED-2a: sed 只读形态（-n）reliable` | 🟢 |
| sed 只读豁免 | sed 无 -n 标准输出读放行 | test/bash-extract.test.ts | `BT-SED-2b: sed 无 -n 标准输出读 reliable` | 🟢 |
| sed 只读豁免 | sed -i 写形态保留弹窗 | test/bash-extract.test.ts | `BT-SED-3: sed -i 写形态 unreliable` | 🟢 |
| sed 只读豁免 | sed 脚本含 w 写命令保留弹窗 | test/bash-extract.test.ts | `BT-SED-4: sed 脚本含 w 保留弹窗` | 🟢 |
| sed 只读豁免 | sed 脚本含 e 执行命令保留弹窗 | test/bash-extract.test.ts | `BT-SED-5: sed 脚本含 e 保留弹窗` | 🟢 |
| sed 只读豁免 | sed 只读形态 + 管道下游只读放行 | test/bash-extract.test.ts | `BT-SED-6: sed 只读管道链 reliable` | 🟢 |
| sed 只读豁免 | sed 含命令替换保留弹窗 | test/bash-extract.test.ts | `BT-SED-7: sed 含 $() 保留弹窗` | 🟢 |
| sed 只读豁免 | sed 脚本含 r 读文件命令保留弹窗 | test/bash-extract.test.ts | `BT-SED-8: sed 脚本含 r 保留弹窗` | 🟢 |
| sed 只读豁免 | sed 脚本含 R 读文件命令保留弹窗 | test/bash-extract.test.ts | `BT-SED-9: sed 脚本含 R 保留弹窗` | 🟢 |
| sed 只读豁免 | sed 替换式 flag e 执行保留弹窗 | test/bash-extract.test.ts | `BT-SED-10: sed 替换式 flag e 保留弹窗` | 🟢 |
| sed 只读豁免 | sed 替换式 flag w 写文件保留弹窗 | test/bash-extract.test.ts | `BT-SED-11: sed 替换式 flag w 保留弹窗` | 🟢 |
| sed 只读豁免 | sed -i 后缀写形态保留弹窗 | test/bash-extract.test.ts | `BT-SED-14: sed -i 后缀写形态 unreliable` | 🟢 |
| sed 只读豁免 | sed 多 -e 脚本含 r 读文件保留弹窗 | test/bash-extract.test.ts | `BT-SED-15: sed 多 -e 第二脚本 r unreliable` | 🟢 |
| sed 只读豁免 | sed -f 脚本文件保留弹窗 | test/bash-extract.test.ts | `BT-SED-16: sed -f 脚本文件 unreliable` | 🟢 |
| sed 只读豁免 | awk 只读形式保持弹窗（非目标） | test/bash-extract.test.ts | `BT-SED-13: awk 只读形式 unreliable` | 🟢 |

（账本中全部测试为新增 RED 状态。额外测试（非 spec scenario，防 D2/D3 回归）：`BT-SED-12: sed 脚本 a.b 仅提取位置参数`（D2 专项）、`BT-SED-17: 常见只读形态不误伤`（判据文字"判定不误伤"例证：`sed -e '1,5p' file`、`sed -n '/error/p' file`、`sed 'y/abc/rwx/' file`、`sed -e '1,5p' -e 's/a/b/' file`）。change 级收尾 review 后新增回归测试：`BT-SED-18`（管道下游 UNRELIABLE 拒绝，Issue #1）、`BT-SED-19`（`>|`/`2>|` 覆盖写拒绝，Issue #2）、`BT-SED-20`（env/command 包裹只读放行，Issue #4）、`BT-SED-21`（转义 `\/` 定界只读安全 + 写重定向拒绝，Issue #3）。既有 sed 测试无——`UNRELIABLE_COMMANDS` 集合断言 `BT-B16` 只查集合成员，不改动。账本逐行机械校验：测试文件路径 `test/bash-extract.test.ts` 已存在；Scenario 名称与 spec 现文逐字一致——见本 change 的 specs/ 变更文件。）

## 实际系统工程影响 vs 预期

- **实际影响的分系统**：单分系统 `bash-extract`（tier-medium）——与预期一致。未触及 policy-core / extension-orchestration / side-effects（`extensions/index.ts:622` 生产 caller 消费 `reliable`/`reason`/`targets` 既有契约，sed 放行只让 `reliable` 从 false 变 true，无需适配；实测确认兼容）。

- **实际整体性能变化**：与预期一致。sed 只读形态误弹窗率从 100% 降至 0——`sed -n '335,345p' test/decision.test.ts` 实测 `reliable:true, targets:[read <projectRoot>/test/decision.test.ts]`（BT-SED-1），`sed -i 's/a/b/' file` 实测 `reliable:false`（BT-SED-3），含只读 sed 段的诊断/检查命令不再被弹窗打断。**可验证**：BT-SED-1/2a/2b（只读放行）+ BT-SED-3/4/5/8/9/10/11/14/15/16（写/读任意文件/执行形态仍弹窗），全部实测通过。

- **实际是局部优化还是全局协调**：局部优化——与预期一致。只放宽 sed 一种命令的只读形态，awk/perl/python 等其余 UNRELIABLE 命令类保持 `unreliable_command`（BT-SED-13 awk 只读形式实测仍弹窗），未改全局判定架构。

- **局部优化的实际全局影响（主基调第 1 条事后回检）**：低——判据完备性实测闭合。change 级收尾 review 发现并修复了两个真实红线缺陷（均为**预期之外的副作用**，见下）：Issue #1（管道下游 UNRELIABLE 脚本解释器漏检——`sed ... | perl -e 'do q{x}'` 可静默执行任意代码，已修复为逐 pipeline stage 检查）、Issue #2（`>|`/`2>|` 覆盖写重定向漏检——sed 写被误判为 read，已修复为 fragment 层面 `hasNoclobberRedirect` 显式识别）。修复后重审 APPROVED_WITH_CHANGES（安全红线全部通过，无 critical）。其余 UNRELIABLE 命令类行为不变，无全局失调。

- **模型验证（实际行为是否验证预期模型）**：**预期行为模型已验证**。预期模型 13 条输入→输出全部实测通过（BT-SED-1/2a/2b/3/4/5/6/7/8/9/10/11/14/15/16 覆盖）；修复后新增 4 条回归断言（BT-SED-18/19/20/21）确认 Issue #1/#2/#4/#3 修复不破坏模型。模型成立。

- **预期之外的副作用**（后续 `/td-system-audit` 输入）：
  1. **Issue #1（管道下游 UNRELIABLE 漏检）**——初版 `isSedReadonlyForm` 用 `splitCommands`（不切 `|`）只检查 fragment 首命令，`sed ... | perl -e 'do q{x}'` 的 perl 片段不被检查 → 静默执行任意代码。change 级收尾 review 发现，修复为 `splitPipelines` 逐 stage 检查（silent.ts:824-845）+ BT-SED-18。
  2. **Issue #2（`>|`/`2>|` 覆盖写漏检）**——初版条件 4 用 `extractRedirects` 判写重定向，但 `extractRedirects` 对 `>|`/`2>|` 漏检（`>` 分支读到 `|` 即 path 空而跳过），sed 写被误判为 read 放行。review 发现，修复为 fragment 层面 `hasNoclobberRedirect` 显式识别（silent.ts:819,865）+ BT-SED-19。
  3. **提取侧 wrapper 不展开（K1，记录级已知问题）**——判定侧展开 env/command/sudo（silent.ts:833-839）但提取侧 entry.ts:330-334 以 `tokens[0]` 查 `COMMAND_TABLE` 不展开，`env FOO=1 sed -n '1,5p' file.txt` 豁免成立但 `file.txt` 不被收集为 read target。与既有 `env cat` 行为一致（extract 侧不展开 wrapper），read 默认 auto-allow，无安全影响，属审计记录缺口。已记录 tasks.md「已知问题」K1，后续可考虑独立 change 统一 extract 侧 wrapper 展开。

- **scenario→test 覆盖账本状态**：全绿——账本 16 行（15 ADDED scenario + 1 MODIFIED「`sed` 只读形态提取路径」）全部 🟢，无 `N/A` 条目。机械校验：Scenario 名称与 spec 现文逐字一致（无缺无多）。
