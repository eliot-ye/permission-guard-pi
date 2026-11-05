# 全局权限审核：发现与风险清单

> 审核日期：2026-11-05
> 审核对象：permission-guard-pi（pi-coding-agent 的权限门控扩展）
> 审核方式：源码逐层阅读 + 决策引擎/配置/敏感/信任/审计/路径工具独立分析 + 集成层深挖 + bash 提取子系统深挖 + 实测 20+ 条边界命令 + 运行 809 个单元测试与 55 个安全探针
> 结论：**整体设计扎实、自洽、可维护**；发现若干**结构级安全盲区**，其中 3 个值得优先关注（详见风险分级）。

---

## 一、项目作用（一句话）

permission-guard-pi 是给 AI 编程代理（pi-coding-agent）装的一道**权限门禁**：每次 `read` / `write` / `edit` / `bash` 工具调用先过一道闸，由系统决定 **静默放行（auto_allow）/ 弹窗确认（prompt）/ 硬拒绝（deny_hard）**。它**不是沙箱**（不真正阻止进程访问文件），而是"弹窗确认型"门控。

约 9000 行 TypeScript，四层：
- **配置层**（`config.ts` / `sensitive.ts`）——你声明的规则
- **决策层**（`decision.ts`，纯函数引擎，核心）
- **bash 提取层**（`bash-extract/`，约 5400 行，最重）——静态解析 bash 命令
- **集成层**（`extensions/index.ts`，1284 行）——接 pi、弹窗、授权记忆、审计

---

## 二、权限逻辑全景（决策树）

一次调用（如 AI 想 `read` 某个文件）的完整决策链：

```
调用进来
  ├─ ① 配置声明 unread？────────► 是 → deny_hard（硬拒，最高优先，永不询问）
  ├─ ② 授权记忆命中？────────────► 是 → auto_allow（你曾"总是允许"，直接放）
  ├─ ③ 配置声明了路径？
  │      read_write+项目内 → auto_allow（静默）
  │      read_write+项目外 → prompt（弹窗）
  │      read_only         → 读静默；写/删弹窗
  │      跨源冲突(含unread) → prompt（强制，防配置打架）
  ├─ ④ 没配置，查敏感兜底？
  │      hard级(不可逆私钥)+项目外 → prompt(two档,不可持久化)
  │      hard级+项目内 / soft级     → prompt(three档,可持久化)
  ├─ ⑤ 默认临时目录 /tmp/**？──► auto_allow
  ├─ ⑥ 项目内 未配置非敏感 ──► auto_allow（核心工作流静默）
  └─ ⑦ 项目外 未配置
         read → auto_allow（外部读一般不拦）
         write/delete → prompt（外部写默认要问）
```

**顺序关键**：`unread`（策略硬拒）→ 授权记忆 → `decide()`（纯函数）。**授权记忆不能覆盖 `unread` 硬拒**。

**两个无法被配置绕过的硬底线**：
- **敏感文件永远弹窗**（SSH 私钥、`.env`、凭证、`/etc/shadow`）
- **网络外带写入永远弹窗**（`/dev/tcp`、`/dev/udp`，强制两档、不可持久化）

---

## 三、三个判断轴

| 轴 | 取值 | 逻辑 |
|---|---|---|
| **区域** | `project_inner`（项目内）/ `project_outer`（项目外） | 项目内默认静默；项目外写入默认弹窗 |
| **敏感度** | `hard` / `soft` / 非敏感 | 见下表 |
| **配置声明** | `read_write` / `read_only` / `unread` | 显式规则，优先于敏感兜底 |

**敏感路径白名单**（`sensitive.ts`，7 条规则）：
- **hard**（不可逆凭证，泄露无法吊销）：SSH 私钥、`.pem/.key` 私钥、`.env`、`.aws/.kube/.docker` 凭证、`/etc/shadow`、`/etc/sudoers`、cron 配置
- **soft**（可吊销，泄露可重生成）：SSH 公钥（`known_hosts`/`authorized_keys`）、通用凭证配置（`config.json`/`auth.yaml`/`settings.yml`）

> 白名单模型——只有列出的才算敏感。`/etc/passwd`、`/etc/hosts` 等**公开**配置不算（避免噪音弹窗）。

---

## 四、配置优先级 & 冲突

三份配置文件，**优先级 local > project > global**：

| 层级 | 路径 | 用途 |
|---|---|---|
| global | `~/.pi/agent/permission.json` | 全局默认 |
| project | `<项目>/.pi/permission.json` | 项目规则（可提交 git）|
| local | `<项目>/.pi/local/permission.json` | 本机覆盖（**不**提交 git）|

- **跨源冲突**：global 说 `unread`、project 说 `read_write` → **强制弹窗**让你拍板。
- **通配覆盖提醒**：配 `{"~/.ssh/**": "read_write"}` 时启动给警告"覆盖了敏感路径，建议收窄"。

---

## 五、bash 命令静态解析

AI 跑 bash 时，系统先**静态解析**，提取要读/写的文件：

```
bash 命令 → 解析 → reliable（可靠，精确提取目标）/ unreliable（不可靠，整体弹窗）
```

**不可靠触发条件**（15 类 reason）：
1. `find_write_flag`——`find -delete/-exec/-ok` 等写 flag
2. `command_substitution`——`$(...)` 内命令非只读
3. `backtick_substitution`——反引号
4/5. `process_substitution_(input/output)`——`<(...)` / `>(...)`
6. `heredoc`——非引号定界 `<<`
7. `subshell`——顶层 `(...)`
8. `glob_expansion`——非引号 glob 且非 bounded-safe
9. `control_flow`——while/for/if/case 等（豁免：字面迭代 for + 只读体）
10. `cd_chdir`——复合命令含 `cd`
11. `shell_forwarder`——`bash -c`/`source`/脚本路径
12. `unreliable_command`——`python3 -c`/`node -e`/`sed -i`/`scp`/`ssh`/`kubectl exec` 等
13. `unresolved variable: X`——`$VAR`（仅 `$HOME`/`$PWD` 可展开）
14. `arithmetic`——`$((...))`
15. `forwarding_command`——xargs/parallel/pforeach 下游或上游不安全

**静默白名单**（`silent.ts`，命令名+子命令+形态三维匹配）：`git status/log/diff`、`npm test`、`cargo check`、`tsc --noEmit` 等。

**bash 授权记忆**：选"总是允许本命令"存**原始命令**。匹配是**词法空白折叠**（`git  status`==`git status`），**不做语法级等价**（`bash -c "git status"` ≠ `git status`）。另有 **keypoints 双轨**：等价类 = 相同访问集 + 相同动作。

---

## 六、授权记忆 & 审计

**授权记忆（`trusted.json`）**：
- **双通道**：会话级（内存，重启清空）+ 持久化（磁盘，跨会话）
- **项目隔离**：键含 `projectHash` = sha256(项目路径).slice(0,12)
- **文件权限**：`0600` 文件 / `0700` 目录，原子写（temp+rename）
- **吊销**：无程序化 API，手动编辑 `trusted.json`

**审计日志（JSONL 追加）**：
- 每次决策一行：`event / tool / path / command / region / declaration / authorization / grant_source / ts`
- **`authorization` 区分**：`by_person`（真人拍板）vs `presumed`（系统规则）
- `reason` **永远英文**（跨版本稳定，方便 grep/脚本）
- 串行写入、失败**永不阻塞**决策（fire-and-forget）

---

## 七、验证结果

- **核心单元测试：809/809 全部通过**
- **安全探针：55/55 全部通过**（专门测拦截绕过 payload）
- 系统集成测试中访问 `~/.ssh`、`~/` 的用例因当前沙箱 `EPERM` 无法运行（环境限制，非代码问题）

---

## 八、设计权衡（已知边界，非缺陷）

| 边界 | 说明 |
|---|---|
| 不做完整 shell 解析 | 复杂语法一律"不可靠"弹窗，不做语义展开 |
| 不做解释器代码分析 | `python3 -c "..."` 无法穿透，只能整体弹窗 |
| 不做运行时变量解析 | `$MYSECRETS` 无法静态确定 |
| 不做沙箱 | 是"弹窗确认"非"访问阻止" |
| 敏感路径是白名单 | 未列出的敏感文件需你显式配置 |

---

## 九、⚠️ 发现的风险（按严重度分级）

> 以下均经**实测复现**（非仅静态推断）。前 3 个为**结构级安全盲区**，建议优先评估是否修复。

### 🔴 极高：盲区 A —— 管道第 2+ stage 的命令完全逃过命令名守卫

**根因**：`scanFindWriteFlags`、`isAnyUnreliableCommand` 只检查每个 fragment（按 `;`/`&&`/`||`/`&`/`\n` 拆分）的**首命令**，**不遍历管道 stage**。管道下游的命令（第 2+ stage）不可见。

**实测**（均被判 `reliable:true`）：
```
cat /etc/passwd | python3 -c "import os; os.remove('/etc/x')"   → 只提取读 /etc/passwd，实际删 /etc/x
echo hi | find . -delete                                        → 0 target，实际删除当前目录树
cat x | sed -i s/a/b/ file                                      → 0 target，实际写文件
```

**影响**：任意代码执行级绕过。`python3 -c` 在管道下游执行任意代码，`find -delete` 在管道下游删文件，但系统都当作"可靠只读"放行。

**修复方向**：让步骤 0/4 的守卫也遍历 `splitPipelines` 的每个 stage，而不只检查 fragment 首命令。

### 🔴 高：盲区 B —— 未知命令 fail-open 到 0-target reliable

**根因**：任何不在 `COMMAND_TABLE ∪ SILENT_COMMANDS ∪ UNRELIABLE_COMMANDS` 的命令 → `reliable:true, targets:[]`（entry.ts:348，silent.ts:42 自认这是"留给未来的已知边界"）。

**实测**：
```
vim /etc/passwd      → reliable:true, targets:[] → 读、写都不提取，直接放行
gcc -o /tmp/x main.c → reliable:true, targets:[] → 写 /tmp/x 静默放行
mount /dev/sda /mnt  → reliable:true, targets:[]
```

**影响**：覆盖面最大的盲区。只要命令名没列入三张表，就完全放行。

**修复方向**：把未知命令从 fail-open 改为 fail-closed（判 unreliable 弹窗），或扩充分类表。

### 🟠 中高：盲区 C —— 复合命令包裹绕过静默形态严格校验

**根因**：4b 的静默形态校验**只对「1 fragment + 1 stage」的简单调用生效**（entry.ts:126-130）。复合命令被委派给逐 fragment 循环，循环只跑较弱的 `isSilentCommand`，不命中时落到 0-target reliable（而非 unreliable_command）。

**实测**：
```
git log /etc/passwd              → reliable:false, reason:unreliable_command（独立，正确拦截）
echo hi && git log /etc/passwd   → reliable:true, targets:[]（复合包裹后漏检）
```

**影响**：同一命令在独立/复合两种形态下判定不一致，复合形态漏检。

### 🟠 中高：盲区 D —— git 只读子命令表过粗

**根因**：`GIT_READONLY_SUBCOMMANDS` 含 branch/tag/config，但 4b 循环把 `-d`/`-D`/`--unset` 当普通 flag 消费值，从不检查子命令是否有破坏性 flag。

**实测**：
```
git branch -d foo    → reliable:true, targets:[]（删除分支，写 .git）
git tag -d v1        → reliable:true, targets:[]（删除 tag）
git config --unset user.email → reliable:true, targets:[]（改写 config）
git clean -fd        → 正确 unreliable_command（clean 不在只读子命令集）
```

**影响**：只做"子命令名"级判读，未做 flag 级判读。

### 🟠 中：盲区 E —— for 循环体重定向变量绕过

**根因**：`isForBodyReadOnly` 把 `echo` 归入 `HARMLESS_BUILTINS` 直接放行，不检查其写重定向目标是否绑定循环变量。豁免后提取循环对 `> "$f"` 这类引号变量目标 `looksLikePath`=false，无法提取 → 0 target。

**实测**：
```
for f in /etc/passwd /etc/shadow; do echo hi > "$f"; done → reliable:true, targets:[]
```
实际运行会覆写 `/etc/passwd`、`/etc/shadow`。

### 🟡 中：风险 1 —— 不可靠 bash 命令可持久化授权，且能绕过敏感/unread 硬底线

**根因**：`bash -c "cat ~/.ssh/id_rsa"` 这类命令无法静态提取目标（字符串内嵌路径，见下）→ 走 tier=three **可持久化**弹窗 → 一旦"总是允许本命令"永久放行。C5 兜底只扫裸路径 token，**引号内路径不生效**（design.md:361 自认）。

**为何字符串内嵌路径提取不到**：tokenizer 把 `"cat ~/.ssh/id_rsa"` 整个当成一个 token（parse.ts:378-414），不是独立路径 token；且设计者**故意**不往字符串内部解析（Q5 决策：不扩展，因内部可能带引号嵌套、转义、变量替换，静态分析不可靠）。

**实测**：
```
cat ~/.ssh/id_rsa           → reliable:true, 提取 read ~/.ssh/id_rsa（敏感→两档弹窗）
bash -c "cat ~/.ssh/id_rsa" → reliable:false, reason:shell_forwarder, 0 target（三档可持久化）
```

**影响**：这是唯一能真正绕过敏感硬底线的通道——整条命令粒度授权，一旦持久化，内部藏着的敏感文件被"整体授权"覆盖。

**✅ 缓解状态（bash-c-literal-extract change，2026-11-05）**：本风险**已部分缓解**。对可证明为**纯字面量**的 `-c` 字符串参数（不含 `$`、反引号、控制流、glob/brace、换行，且外层是单 fragment 单 stage），系统现在**递归精确提取目标**：`bash -c "cat ~/.ssh/id_rsa"` 从"三档可持久化弹窗"变为"精确提取 read ~/.ssh/id_rsa → 敏感文件两档弹窗（**不可持久化**）"，堵住纯字面量子集的绕过通道。核心安全性质：精确化后权限判定 **≤ 直接执行该命令**（有目标走与直接执行同路径；0 目标 / 内层不可靠 / 嵌套 `-c` 回退 shell_forwarder 弹窗，更严）。**剩余覆盖边界**：非纯字面量 `-c` 参数（含 `$`/控制流/glob）与复合/管道外层形态仍走 shell_forwarder 弹窗（保守回退，与现状一致）；`trusted.json` 中已持久化的 `bash -c "<纯字面量>"` grant 不自动失效，用户可手动清理。实测：`bash -c "cat ~/.ssh/id_rsa"` → `reliable:true, [read ~/.ssh/id_rsa]`；`bash -c "cat $MYSECRETS"` → 仍 `shell_forwarder` 弹窗。

### 🟡 中：风险 2 —— 门控禁用 = fail-open + 审计静默

**根因**：`/permission off` → `:589 return undefined`，在一切审计之前，零记录、持久跨会话。切换本身也不审计。

**影响**：若被误关/恶意关，既无保护也无痕。

### 🟡 中：风险 3 —— 项目哈希大小写折叠 → 跨项目授权串扰

**根因**：`hashProject` 会 **lowercase**（path-utils.ts:190），POSIX 大小写敏感系统上 `/Proj` 与 `/proj` 同 hash。另 `trusted.json` 多进程共享时**无文件锁**，并发写可能互相覆盖。

### ⚪ 次要（记录备查）
- 会话级授权（allow_session）可绕过 tier=two 的"不可持久化"保护（会话限定，刻意权衡）
- 审计行未记录结构化 `reasonCode`（只能解析自由文本）
- 多 target bash 只记最后 target 的元数据
- `trusted.json` 损坏时**静默清空**授权记忆（安全方向但无 warning）
- `bash -c "cat ~/.ssh/id_rsa"` 在字符串内嵌路径——无法提取，整体弹窗（这是"不做完整 shell 解析"的刻意取舍，非 bug）

---

## 十、总体结论

**这套权限逻辑设计是扎实、自洽、可维护的**：
- 决策引擎是纯函数、可独立测试；三个判断轴（区域×敏感×配置）正交清晰、决策表完整可预测
- fail-safe 倾向明显（宁可多弹窗不误放行）；敏感与网络外带硬底线无法被配置绕过
- 分层合理（配置声明/决策判定/bash 提取/集成接线各司其职）；审计可完整追溯授权来源

**但存在结构级安全盲区**，按优先级：
1. **🔴 管道第 2+ stage 命令逃逸**（任意代码执行级）——盲区 A
2. **🔴 未知命令 fail-open**（覆盖面最宽）——盲区 B
3. **🟠 复合命令包裹绕过 + git 只读表过粗 + for 循环变量重定向**——盲区 C/D/E
4. **🟡 不可靠 bash 可持久化授权绕过敏感底线**——风险 1（唯一能绕过硬底线的通道）

**最重要的边界认知**：这是一个"弹窗确认型"门禁，不是沙箱；bash 静态解析是**白名单模型**，依赖"不可靠→弹窗"兜底而非完整拦截。**最大结构风险集中在 bash 提取层**——它在"窄白名单防漏检"与"宽白名单防误伤"之间权衡，边界缝隙集中在**管道下游**与**未知命令 fail-open** 两处。

**修复优先级建议**：盲区 A（管道 stage 2+ 逃逸）应最先处理——它直接允许任意代码执行绕过门控，且是纯静态逻辑问题，改动集中在 `entry.ts` 的守卫循环，风险可控。
