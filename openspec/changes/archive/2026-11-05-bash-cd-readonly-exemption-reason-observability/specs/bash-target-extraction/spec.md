## ADDED Requirements

### Requirement: cd 链含非 `&&` 分隔符时的只读豁免

当复合命令含 `cd` 片段且分隔符**不全是 `&&`**（含 `;` 或 `||`）时，系统 MUST 判定整条命令为不可靠（`reason` 为 `cd_chdir`）——**除非满足本豁免**。本豁免是既有「cd 跟踪豁免」（要求纯 `&&` 链）与「全绝对下游豁免」之外的**第三条豁免路径**，覆盖"cd 到绝对目录后做只读探查、后续用 `;`/`||` 追加 cwd 无关片段"的常见形态。**非纯 `&&` 的分隔符界定**：`;`、`||`、换行 `\n`、后台 `&` 均视为非纯 `&&`（`&` 复用 `isAmpBackgroundSeparator`，`2>&1`/`N>&N`/`&>` 等 fd 重定向中的 `&` 不算分隔符）——后台 `&` 与 `;`/`||` 同样不保证 cd 成功，按同类加严处理（方向 fail-closed，无静默放行）。

本豁免成立条件（**全部满足**）：

1. **每个 `cd` 片段目标是显式绝对路径**——以 `/` 开头或满足 Windows 盘符 `C:\`，不含 `$VAR`、`~`、未加引号 glob、相对前缀（`./`/`../`）。绝对性判定作用于 `tokenize` 去引号后的 token 形式。**`;` / `||` 之后不得再出现 `cd` 片段**——若 `;`/`||` 后还有 `cd`（尤其相对目标 `cd rel`），其落点依赖前一个 cd 是否成功（成功则相对前一落点、失败则相对原 cwd），不可静态确定，豁免 MUST NOT 成立（回退 `cd_chdir`）。
2. **`;` / `||` 之后的每个片段不含 cwd 相对路径引用**——即该片段**无任何**满足以下之一的路径引用：非绝对且 `looksLikePath` 为 true 的 token（如 `rel.txt`、`dist/`）、非绝对且 `looksLikePath` 为 false 的不可提取裸词（如 `sub`、`sub/`）、cwd 锚点（`.`、`..`、`./`、`../`）、未加引号 glob（`*`、`?`、`[`）、`$PWD`/`$OLDPWD`。片段全为 cwd 无关命令（`echo`、`git log`、全绝对路径命令、纯 stdin 管道如 `| head`/`| wc -l`、`2>/dev/null` 良性重定向）时满足本条件。
3. **无写/执行/解释器/转发/git 写/网络外传形态**——`;` / `||` 之后的片段不含写/删命令（`rm`/`mkdir`/`mv`/`cp`/`tee`/`chmod`/`truncate`/`dd`/`install` 等）、不含解释器执行（`node -e`/`python -c` 等）、不含 shell 转发器（`bash -c`/`sh -c`/`source` 等）、不含 git 写子命令（`rm`/`add`/`commit`/`checkout`/`clean`/`mv`/`reset` 等）、不含网络外传目标（`/dev/tcp/`/`/dev/udp/`/`/dev/fd/[0-9]+`）。**此类形态 MUST 判不可靠，具体 reason 取决于 `entry.ts` 守卫顺序**：本豁免成立时 cd 守卫（步骤 2b `scanCdChdir`）不再命中（d2a=true），故 `;` 段解释器/转发器落到后续守卫——解释器（`node -e`/`python -c`）经步骤 4 `isAnyUnreliableCommand` 产出 **`unreliable_command`**、转发器（`bash -c`）经步骤 3 `isShellForwarder` 产出 **`shell_forwarder`**；而含 cwd 相对引用或写形态的 `;` 片段仍由 cd 守卫拦，产出 `cd_chdir`。本条件的语义是"这类形态不被 cd 只读豁免放行"（fail-closed），不规定 reason 必为某特定值。

**安全论证**：`;` / `||` 下 cd 失败时下游片段仍执行、cwd 不更新——cwd 不可静态确定。但 cwd 不确定**只在下游访问 cwd 相对路径时才有害**。条件 2 保证 `;` / `||` 后片段不含任何 cwd 相对引用，故 cwd 漂移不影响其落点，豁免不产生静默放行。条件 1 保证 `;`/`||` 后不再有 `cd`（避免相对 cd 落点不可确定），顺序模拟 cwd 不会把下游相对路径解析到错误落点。条件 3 排除写/执行/转发/网络形态，这些无论 cwd 是否确定都须弹窗。任一条件不满足 → 回退 `cd_chdir`（fail-closed）。

**与非 `&&` 链的写形态边界**：本豁免**只覆盖只读探查**。`;` 后片段含写命令、解释器执行、转发器、git 写子命令、网络外传目标时，即使其无 cwd 相对引用，也 MUST 维持不可靠（保守拦截），reason 取决于 `entry.ts` 守卫顺序（豁免成立时解释器/转发器由步骤 3/4 拦，产出 `shell_forwarder`/`unreliable_command`；含 cwd 相对引用或写形态时由 cd 守卫拦，产出 `cd_chdir`）。

#### Scenario: cd 后接只读命令与 `;` 后 cwd 无关片段豁免

- **WHEN** bash 命令为 `cd /abs/pkg && grep -rn "x" dist/ | head; echo "---"; git log --oneline -5`
- **THEN** 提取结果为 `{ reliable: true, targets: [read <cd>/dist/...] }`——`;` 后 `echo` 与 `git log` 均 cwd 无关（`git log` 为只读子命令、无 cwd 相对 pathspec），cd 只读豁免成立；`&&` 段 `grep dist/` 经 cwd 跟踪解析为 `<cd>/dist/` read target

#### Scenario: `;` 后片段含 cwd 相对引用仍判不可靠

- **WHEN** bash 命令为 `cd /abs/pkg && ls; cat rel.txt`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`;` 后 `cat rel.txt` 含 cwd 相对引用 `rel.txt`，豁免条件 2 不满足，回退 `cd_chdir`（fail-closed：cd 可能失败 → cwd 不确定 → `rel.txt` 真实落点不定）

#### Scenario: `;` 后片段含写命令仍判不可靠

- **WHEN** bash 命令为 `cd /abs/pkg && ls; rm -rf sub`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`;` 后 `rm -rf sub` 为写命令（`rm` 在 `FILE_ARG_COMMANDS`，`sub` 被检测为 cwd 相对引用 + 条件 3 写形态双重拦截），豁免条件 3 不满足，回退 `cd_chdir`

#### Scenario: `;` 后再 cd 相对目标判不可靠（critical 1 反例）

- **WHEN** bash 命令为 `cd /abs && ls; cd rel && grep x dist/`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——`;` 后出现 `cd rel`（相对目标），其落点依赖前一个 cd 是否成功，不可静态确定；若顺序模拟 cwd 会把 `dist/` 解析到错误落点并 0-target 静默放行。豁免条件 1（`;` 后不得再 cd）不满足，回退 `cd_chdir`

#### Scenario: `;` 后解释器执行判不可靠但 reason 由守卫决定（critical 3）

- **WHEN** bash 命令为 `cd /abs/pkg && ls; node -e "require('fs')"`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——`;` 后 `node -e` 为解释器执行，条件 3 不满足；豁免成立时 cd 守卫（步骤 2b）不再命中，落到步骤 4 `isAnyUnreliableCommand`（`node` 命中 `UNRELIABLE_COMMANDS`）产出 `unreliable_command`（**非 `cd_chdir`**）。语义为"不被 cd 只读豁免放行"（fail-closed 成立：仍判不可靠弹窗）

#### Scenario: `||` 链只读探查豁免

- **WHEN** bash 命令为 `cd /abs/pkg && ls dist/ 2>/dev/null || echo "not found"`
- **THEN** 提取结果为 `{ reliable: true, targets: [read <cd>/dist/] }`——`||` 后 `echo "not found"` 为 cwd 无关，`2>/dev/null` 为良性重定向（`/dev/null` 绝对），豁免成立

#### Scenario: 既有纯 `&&` 链 cd 跟踪豁免不受影响

- **WHEN** bash 命令为 `cd /abs/pkg && ls -la`
- **THEN** 提取结果仍为 `{ reliable: true, targets: [] }`——纯 `&&` 链走既有 cd 跟踪豁免（非本 requirement 范围），行为不变
