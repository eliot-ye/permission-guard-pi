## ADDED Requirements

### Requirement: Bash grant 关键点等价

系统的 bash 命令 grant 键派生（`command_hash`）SHALL 从「整条命令 hash」改为「命令关键点 hash」——只保留决定「访问哪个文件、什么动作」的 token，忽略安全无关 token，使同一访问集 + 同一动作的命令命中同一 grant。

**键派生**：`command_hash = sha256(bashCommandKeypoints(rawCommand, projectRoot))`。

**关键点 token 分类**（token 级，窄边界）：

- **保留**：命令名（`CMD:<basename>`）、路径引用（`PATH:<绝对化>`，按追踪 cwd）、写重定向目标（`WRITE:<绝对化>`）、写/不确定 flag（`FLAG:<名>` + `FLAGVAL:<值>`）、shell glob 位置参数（`GLOB:<原始>`，非 find 匹配 flag）、其余裸词（`WORD:<原始>`，保守）、cd 落点（`cd:<绝对化>`；仅 `$VAR` 不可静态解析时降级为 `cd-var:<原始>`）。
- **忽略**：纯读 flag（名+值连跳，有限白名单）、fd 重定向（`2>&1` `N>&-` `2>/dev/null`）、文本命令参数（echo/printf/true/false/pwd…）、纯文本 token。

**等价边界**：

- 关键点等价是「词法 whitespace 等价」的**超集**——`git  status`（双空格）与 `git status` 仍命中同一 grant（既有等价保留）。
- 关键点等价**不包含语法级语义漂移**：`bash -c "git status"` ≢ `git status`（shell-forwarder 漂移）、`cd /tmp && git status` ≢ `git status`（cwd 漂移）——MUST NOT 判等价（与 security-boundary-docs Non-Goal「不做完整 shell 解析」对齐）。

**安全等价判据**：等价类 = 同一访问集 + 同一动作。忽略的 token MUST NOT 改变访问集与动作；保留的 token 决定「访问哪个文件、什么动作」。关键点不同 ⇒ 至少一个安全维度不同 ⇒ 保守弹窗。

**双轨兼容**：既有 `commandHash`（整条命令 hash）grant 保持精确匹配，授权范围不自动扩大；新 `keypointsHash` grant 用关键点匹配。查询时 `关键点命中 || 整条命中`。

#### Scenario: 纯读 flag 值变化命中同一 grant

- **GIVEN** 用户已授权 `cd /proj && find openspec -type f | head -50`（持久）
- **WHEN** 随后命令为 `cd /proj && find openspec -type d | head -60`（纯读 flag 值变化，访问集与动作不变）
- **THEN** 命中同一 grant（关键点忽略 `-type`/`-d`/`-50`/`-60` 值），auto_allow 不再弹窗

#### Scenario: 增删 fd 重定向命中同一 grant

- **GIVEN** 用户已授权 `cd /proj && cat openspec/.td-state/profile-tier.yaml 2>/dev/null`（持久）
- **WHEN** 随后命令为 `cd /proj && cat openspec/.td-state/profile-tier.yaml`（去掉 `2>/dev/null`，fd 重定向不改变安全性质）
- **THEN** 命中同一 grant，auto_allow 不再弹窗

#### Scenario: 不同路径不命中（保守弹窗）

- **GIVEN** 用户已授权 `cd /proj && find src -type f`（持久）
- **WHEN** 随后命令为 `cd /proj && find test -type f`（路径不同，访问集不同）
- **THEN** 不命中，走 tier=three 弹窗

#### Scenario: cd 落点不同不命中

- **GIVEN** 用户已授权 `cd /a && ls`（持久）
- **WHEN** 随后命令为 `cd /b && ls`（cd 落点不同，`ls` 无位置参数时访问集由 cwd 决定）
- **THEN** 不命中（cd 落点绝对化入键），走 tier=three 弹窗

#### Scenario: shell glob 位置参数保留（不误放行）

- **GIVEN** 用户已授权 `cd /proj && cat src/*.ts`（持久）
- **WHEN** 随后命令为 `cd /proj && cat src/*.go`（shell glob 决定访问集，`*.ts` vs `*.go` 不同）
- **THEN** 不命中（`GLOB` token 保留），走 tier=three 弹窗

#### Scenario: 写重定向目标保留

- **GIVEN** 用户已授权 `cd /proj && cat a.txt`（持久）
- **WHEN** 随后命令为 `cd /proj && cat a.txt > /tmp/out.txt`（写重定向目标不同，动作不同）
- **THEN** 不命中（`WRITE:/tmp/out.txt` 保留），走 tier=three 弹窗

#### Scenario: 写 flag 变化不命中

- **GIVEN** 用户已授权 `rm -r /tmp/x`（持久）
- **WHEN** 随后命令为 `rm -rf /tmp/x`（写 flag `-r` vs `-rf`，动作强度不同）
- **THEN** 不命中（`FLAG:r` vs `FLAG:rf` 保留），走 tier=three 弹窗

#### Scenario: 语法级语义漂移不判等价

- **GIVEN** 用户已授权 `git status`（持久）
- **WHEN** 随后命令为 `bash -c "git status"` 或 `cd /tmp && git status`
- **THEN** 不命中（shell-forwarder / cwd 漂移属语义漂移，MUST NOT 判等价），走 tier=three 弹窗

#### Scenario: 词法 whitespace 等价保留

- **GIVEN** 用户已授权 `git status`（持久）
- **WHEN** 随后命令为 `git  status`（双空格）
- **THEN** 命中同一 grant（关键点等价是 whitespace 等价的超集），auto_allow 不再弹窗

#### Scenario: 双轨兼容旧整条 grant 精确匹配

- **GIVEN** 用户已授权 `cd /proj && find openspec -type f | head -50`（持久，仅含 `commandHash` 整条字段）
- **WHEN** 随后命令为 `cd /proj && find openspec -type f | head -60`（纯读 flag 值变化，但旧 grant 无双轨关键点）
- **THEN** 不命中旧 `commandHash`（整条精确匹配，授权范围不自动扩大），走 tier=three 弹窗——用户重授权后获得关键点免弹

#### Scenario: cd 变量落点降级

- **GIVEN** 用户已授权 `cd $HOME && cat x.yaml`（持久，cd 落点 `$HOME` 不可静态解析）
- **WHEN** 随后命令为 `cd $HOME && cat x.yaml`（相同 `cd-var:$HOME`）
- **THEN** 命中同一 grant（降级为 `cd-var:<原始>`，不更新追踪 cwd），auto_allow 不再弹窗

#### Scenario: cd 家目录/相对落点正常解析

- **GIVEN** 用户已授权 `cd ~ && cat x.yaml`（持久，`~` 展开家目录，可静态解析）
- **WHEN** 随后命令为 `cd ~ && cat x.yaml`（相同 `cd:<家目录绝对路径>`）
- **THEN** 命中同一 grant（`~` 按家目录解析为 `cd:<绝对化>`，非降级），auto_allow 不再弹窗

- **GIVEN** 用户已授权 `cd src && cat x.yaml`（持久，相对落点按追踪 cwd 解析，可静态解析）
- **WHEN** 随后命令为 `cd src && cat x.yaml`（相同 `cd:<追踪cwd/src绝对路径>`）
- **THEN** 命中同一 grant（相对落点按追踪 cwd 解析为 `cd:<绝对化>`，非降级），auto_allow 不再弹窗

#### Scenario: 关键点不同保守弹窗不误放行

- **GIVEN** 用户已授权 `cd /proj && find openspec -name '*.ts' | head -50`（持久，`-name '*.ts'` 是 find 内部匹配连跳）
- **WHEN** 随后命令为 `cd /proj && cat openspec/*.ts`（`openspec/*.ts` 是 shell glob 展开，决定访问集）
- **THEN** 不命中（`cat` 的 glob 保留 vs `find` 的匹配 flag 连跳，语义不同），走 tier=three 弹窗
