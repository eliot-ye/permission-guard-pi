# bash-target-extraction

## ADDED Requirements

### Requirement: 有界 glob 免不可靠标记

当未加引号的 glob 通配符（`*`、`?`、`[`）满足以下全部条件时，MUST NOT 触发"不可靠"标记（即不再因 glob_expansion 走 tier=two 弹窗），而是交给后续正常提取流程按 read/write target 处理：

1. 该 glob 元字符出现在**引号外且未被反斜杠转义**的位置（遵循现有引号感知规则）
2. glob 元字符前的路径前缀（从命令起始到 glob 元字符之前的路径片段）MUST 完全位于 `<projectRoot>` 内部（不含 `../` 越界）
3. glob 所在的 pipeline stage 的首命令（command name）MUST 属于 **read-only 命令集合**：`cat`、`head`、`tail`、`wc`、`grep`、`find`、`ls`、`tree`、`stat`、`du`、`df`、`file`、`less`、`more`、`git log`、`git show`、`git diff`、`git status`、`git ls-files`、`git branch`、`git tag`、`git remote`、`git config`（即：不产生文件系统写入副作用的开发工具命令）

**理由**：这类 glob 的前缀路径已知且在项目内，且命令语义为只读——静态分析无法枚举具体文件列表，但可确定访问范围在项目内只读，不构成安全风险。与管道转发器、控制流关键字（"实际访问集无法静态确定"）本质不同。

**反例（仍触发 glob_expansion）**：
- glob 前缀出界（如 `ls ../other/*`、`cat /tmp/*.log`）
- 命令属于写/删操作（如 `rm -rf /tmp/*.log`、`cp *.txt /dest/`、`mv *.tmp /tmp/`）
- glob 嵌套在写操作的参数中（如 `echo > /tmp/*.log` 的重定向目标）

#### Scenario: 项目内 ls glob 自动放行

- **WHEN** bash 命令为 `ls openspec/changes/archive/*/`，projectRoot 为 `/Users/eliot/my/@permission-system:pi-extension`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-system:pi-extension/openspec/changes/archive/] }`（按前缀目录读处理），不触发 glob_expansion

#### Scenario: 项目内 cat glob 自动放行

- **WHEN** bash 命令为 `cat openspec/specs/*/spec.md`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-system:pi-extension/openspec/specs/] }`，不触发 glob_expansion

#### Scenario: 写命令内的 glob 仍触发 glob_expansion

- **WHEN** bash 命令为 `rm -rf /tmp/build/*.log`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`rm` 不在 read-only 命令集合

#### Scenario: 跨项目边界的 glob 仍触发 glob_expansion

- **WHEN** bash 命令为 `ls ../other-project/*/`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——前缀 `../other-project/` 出界

#### Scenario: git log 带路径 glob 自动放行

- **WHEN** bash 命令为 `git log --oneline openspec/specs/*/spec.md`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-system:pi-extension/openspec/specs/] }`，不触发 glob_expansion

### Requirement: 设备重定向不计入写目标

当重定向操作符（`>`、`>>`、`2>`、`2>>`、`>&`）的目标路径以 `/dev/` 开头时，MUST NOT 将其作为 write target 加入提取结果。这类路径（`/dev/null`、`/dev/zero`、`/dev/stderr`、`/dev/stdout`、`/dev/fd/N` 等）在 shell 用户语境中固定用于"丢弃输出"或"转向标准流"，不构成用户可见的文件系统写入副作用。

**理由**：当前 `extractRedirects` 将所有重定向目标一视同仁 push 为 write target，导致 `cat file 2>/dev/null`、`echo hi >/dev/null` 等常见静默丢弃模式被误判为外层写操作，触发 tier=two 弹窗（"Outside-project non-sensitive write; approval required"）。这类重定向在安全审计语境中属于"无用户可见副作用的操作"，不应计入写目标。

**边界**：仅对 `/dev/` 前缀路径生效。其他特殊文件（如 `/proc/self/fd/1`）不在范围内，保持原有行为。

#### Scenario: stderr 重定向到 /dev/null 不触发写目标

- **WHEN** bash 命令为 `cat /etc/passwd 2>/dev/null`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/passwd] }`，不含 write target

#### Scenario: stdout 重定向到 /dev/null 不触发写目标

- **WHEN** bash 命令为 `echo "hello" >/dev/null`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`，不含 write target

#### Scenario: 混合重定向中仅 /dev/ 目标被过滤

- **WHEN** bash 命令为 `ls /tmp >/dev/null 2>/tmp/error.log`
- **THEN** 提取结果包含 read target `/tmp` 和 write target `/tmp/error.log`，`>/dev/null` 被过滤

#### Scenario: 重定向到 /dev/stderr / /dev/stdout 不触发写目标

- **WHEN** bash 命令为 `echo "error" >&2` 或 `echo "out" >/dev/stdout`
- **THEN** 提取结果不含 write target（`/dev/stderr`、`/dev/stdout` 同为 `/dev/` 前缀）

#### Scenario: 重定向到普通文件仍正常提取

- **WHEN** bash 命令为 `echo "hello" >/tmp/out.txt`
- **THEN** 提取结果为 `{ reliable: true, targets: [write /tmp/out.txt] }`——普通文件不受影响

