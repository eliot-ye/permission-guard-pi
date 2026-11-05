## ADDED Requirements

### Requirement: bash 不可靠判定携带 reason 标注

当 bash 命令的提取结果为不可靠（`reliable: false`）并触发弹窗时，系统写入的审计记录 MUST 携带可选字段 `bash_reason`，其值为 bash 提取器产出的 reason 标注（如 `cd_chdir`、`glob_expansion`、`command_substitution`、`control_flow`、`shell_forwarder`、`forwarding_command`、`find_write_flag`、`heredoc`、`unresolved variable: <var>`、`unreliable_command` 等）。该字段使事后审计能区分"哪一类不可靠判定"——尤其可统计各类不可靠判定的实际占比，用于验证豁免放宽（如 `cd_chdir` 豁免）的弹窗降幅。

`bash_reason` 字段约束：

- **可选、向后兼容**——`bash_reason` 为可选字段。文件工具（`read`/`write`/`edit`）产生的记录 MUST NOT 写该字段（非 bash 提取）。旧日志（无此字段）MUST 仍可正常解析。
- **凡 bash 提取不可靠即写**——当且仅当 `tool` 为 `bash` 且 bash 提取判定为不可靠（`!reliable`）时，MUST 写入 `bash_reason`，值为提取器 reason 原文。此口径统一覆盖所有不可靠 bash 记录路径（弹窗 prompt 路径、grant 命中 auto_allow 路径、hard_deny 路径）——只要该 bash 命令经 `extractBashTargets` 判定为 `!reliable`，其审计记录即写 `bash_reason`，不因决策结果（prompt / auto_allow / deny）不同而遗漏。可靠 bash 命令（`reliable: true`）MUST NOT 写该字段。
- **不影响决策流程**——`bash_reason` 的写入 MUST NOT 改变任何权限判定（auto_allow / prompt / deny_hard），仅是审计观测字段。写入失败 MUST NOT 抛出（与既有审计 fire-and-forget 语义一致）。

#### Scenario: bash 不可靠弹窗记录携带 bash_reason

- **WHEN** 用户执行 bash 命令 `cd /abs && ls; cat rel.txt`（判定 `cd_chdir`，触发弹窗）
- **THEN** 审计日志新增记录含 `tool="bash"`、`bash_reason="cd_chdir"`

#### Scenario: 各类不可靠 reason 均落入 bash_reason

- **WHEN** bash 命令被判 `glob_expansion`（如 `rm -rf /etc/*.log`）并弹窗
- **THEN** 审计记录 `bash_reason="glob_expansion"`

#### Scenario: 可靠 bash 命令不写 bash_reason

- **WHEN** bash 命令 `git status` 判定为可靠（静默放行）
- **THEN** 审计记录 MUST NOT 含 `bash_reason` 字段

#### Scenario: 文件工具记录不写 bash_reason

- **WHEN** 用户执行 write 工具调用
- **THEN** 审计记录 MUST NOT 含 `bash_reason` 字段（该字段仅 bash 不可靠记录携带）

#### Scenario: 旧日志缺 bash_reason 仍可解析

- **WHEN** 审计日志中存在历史记录（无 `bash_reason` 字段）
- **THEN** 该记录仍可正常读取与解析（可选字段，向后兼容）
