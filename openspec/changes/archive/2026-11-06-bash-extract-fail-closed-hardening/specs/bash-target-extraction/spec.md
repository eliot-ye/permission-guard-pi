## ADDED Requirements

### Requirement: 目标提取不可靠降级（fail-closed）

当目标提取逻辑无法自证「已完整提取全部文件目标且语义分类正确」时，提取结果 MUST 降级为不可靠（`{ reliable: false, rawCommand, reason }`），交由决策层弹窗，MUST NOT 返回「可靠 + 不完整或语义错误的目标」。

判定为不可靠的形态至少包括：

1. 只读豁免形态校验失败——命令名在只读白名单内，但实际形态含写/删除副作用（如 `find` 携带 `-delete` / `-exec ... ;` / 写重定向），此时 MUST NOT 以「命令名只读」为由返回只读目标；
2. 重定向目标存在于复合/嵌套结构（管道 stage、命令转发、控制流体、带引号目标）但提取逻辑无法可靠解析该目标时；
3. 任何「目标提取成功但语义分类存疑」的命令形态。

此降级与既有「0 目标回退弹窗」兜底同构：豁免与放行 MUST 在判定为可靠之后短路，不可跳过可靠性判定本身。

#### Scenario: 只读命令名携带写 flag 经管道降级

- **WHEN** bash 命令为 `echo hi | find /outside/victim -delete`
- **THEN** 提取结果降级为不可靠（不返回 `{ reliable: true, targets: [read /outside/victim] }`）

#### Scenario: 真正只读命令保持可靠免弹

- **WHEN** bash 命令为 `find /etc | sort | head -5`（`find` 无写 flag）
- **THEN** 提取结果为 `{ reliable: true }`，包含读 target `/etc`

#### Scenario: 可靠性判定优先于豁免短路

- **WHEN** 一条命令同时命中只读白名单与某写副作用形态
- **THEN** MUST 先因写副作用形态判不可靠，豁免不生效（白名单在可靠性判定之后短路）

### Requirement: 管道每个 stage 独立执行写 flag 守卫

对含管道的命令，写 flag 守卫（如 `find -delete` / `-exec` 写形态判定）MUST 对**每个 stage 独立执行**，MUST NOT 只检查管道前首命令或首个非只读 stage。任一 stage 命中写 flag 守卫时，整条命令 MUST 降级为不可靠。

#### Scenario: 写 flag 位于非首 stage

- **WHEN** bash 命令为 `echo hi | find /outside/victim -delete`
- **THEN** 写 flag 守卫在 `find` 所在 stage 命中，整条命令降级为不可靠（即使守卫在首命令 `echo` 处未命中）

#### Scenario: 全只读 stage 保持可靠

- **WHEN** bash 命令为 `cat /a | grep x | sort`
- **THEN** 各 stage 均无写 flag，提取结果保持 `{ reliable: true }`

### Requirement: 命令转发命令的外层重定向目标提取

对命令转发形态（`bash -c "<script>"` 及同类），当该命令携带**外层**写重定向时，系统 MUST 在提取转发体内部目标之外，**同时提取外层重定向目标**。缺失外层重定向目标（只返回转发体内目标）属目标提取不完整，MUST 按不可靠降级处理。

#### Scenario: 转发体只读但外层写重定向到项目外

- **WHEN** bash 命令为 `bash -c "cat /tmp/input.txt" > /outside/output`
- **THEN** 提取结果 MUST 包含外层写 target `/outside/output`（MUST NOT 只返回 `read /tmp/input.txt` 而漏掉写目标）

#### Scenario: 转发体只读且无外层重定向

- **WHEN** bash 命令为 `bash -c "cat /tmp/input.txt"`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /tmp/input.txt] }`（无外层写目标时行为不变）

### Requirement: 控制流体内的变量赋值前缀命令守卫

在控制流结构（`for` / `while` / `until` 循环体）内，形如 `VAR=value command args` 的**变量赋值前缀命令**，其 `command` 部分 MUST 仍被识别为待守卫命令——赋值前缀 MUST NOT 使后续命令逃逸写/删除守卫与目标提取。当无法确定赋值前缀后的命令目标时，MUST 按不可靠降级处理。

#### Scenario: 循环体内赋值前缀携带删除命令

- **WHEN** bash 命令为 `for f in a; do x=5 rm /outside/victim; done`
- **THEN** 提取结果 MUST 提取到删除 target `/outside/victim` 或降级为不可靠（MUST NOT 返回 `{ reliable: true, targets: [] }` 静默放行）

#### Scenario: 循环体内普通命令不受影响

- **WHEN** bash 命令为 `for f in a b; do cat $f; done`（赋值豁免范围内、无写形态）
- **THEN** 提取结果保持既有只读豁免行为（不因本 requirement 引入新弹窗）

### Requirement: 带引号重定向目标提取

写重定向（`>` / `>>` / `2>` 等）的目标以引号包裹时（如 `> "/outside/output"`），系统 MUST 剥离引号后提取该目标为写 target。引号包裹 MUST NOT 导致重定向目标被漏提。

引号未闭合时（如 `> "/outside/output`），系统 MUST 保守降级为不可靠，MUST NOT 因无法解析目标而静默放行。该降级信号 MUST 同步作用于依赖重定向检测的既有豁免判定（如 sed 只读豁免的条件 4「无写重定向」）——引号未闭合的写重定向 MUST 使该豁免不成立，MUST NOT 因目标无法解析而误判为「无写重定向」。

#### Scenario: 双引号包裹的写重定向目标

- **WHEN** bash 命令为 `echo hi > "/outside/output"`
- **THEN** 提取结果 MUST 包含写 target `/outside/output`（MUST NOT 返回 `{ reliable: true, targets: [] }`）

#### Scenario: 单引号包裹的写重定向目标

- **WHEN** bash 命令为 `echo hi > '/outside/output'`
- **THEN** 提取结果 MUST 包含写 target `/outside/output`

#### Scenario: 未闭合引号的写重定向保守降级

- **WHEN** bash 命令为 `echo hi > "/outside/output`（双引号未闭合）
- **THEN** 提取结果降级为不可靠（MUST NOT 返回 `{ reliable: true, targets: [] }` 静默放行）

#### Scenario: sed 只读豁免遇未闭合引号写重定向不成立

- **WHEN** bash 命令为 `sed -n 's/a/b/' f > "/outside/o`（sed 脚本本身只读，但外层写重定向目标未闭合引号）
- **THEN** sed 只读豁免不成立（写重定向未被可靠排除），提取结果降级为不可靠（MUST NOT 误判为「无写重定向」而豁免放行）
