## Scenario→Test 覆盖账本

**tier 分层**：`tier-medium`，强制。本 change 共 35 个 scenario（bash-target-extraction 16 + access-decision 16 + approval-flow 2 + grant-memory 1），其中 32 个映射到具名测试，3 个为 N/A + 等价机械校验。

**测试文件路径核验**（账本产出前已逐一确认）：
- `test/security-probe.mjs`（**存在**，20 行既有 payload + 本 change 追加）
- `test/sensitive.test.ts`（**存在**，8 个既有 test）
- `test/decision.test.ts`（**存在**，15+ 个既有 test）
- `test/bash-extract.test.ts`（**存在**，覆盖 `extractBashTargets` 行为）
- `test/sys-integration.test.ts`（**存在**，既有 SYS1–SYS8 集成用例）
- `test/approval-flow.test.ts`（**本 change 新增**，见 tasks.md 6.3——覆盖 `bashSubtitleForReason` 的 `cd_chdir` 分支）
- `test/grant-memory.test.ts`（**本 change 新增**，见 tasks.md 6.3——覆盖 `bashPermissionForReason` 的 `cd_chdir` 授权映射）

**状态说明**：全部 scenario 当前为 🔴 red（测试尚未实现），tasks.md 的关键链 0.1 / 0.2 负责建立 RED 基线，1.2 / 2.2 / 3.3 / 4.2 / 5.2 / 6.1 / 6.2 / 6.3 负责转 GREEN。3 个 N/A scenario 附 grep 机械校验，见下方 approval-flow delta / grant-memory delta 两节。

### bash-target-extraction delta（16 scenario）

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| shell 转发器的长参数前缀判不可靠 | bash --posix -c 判不可靠 | test/security-probe.mjs | SH-L1-01 `bash_posix_c` | 🔴 |
| shell 转发器的长参数前缀判不可靠 | sh --norc -c 判不可靠 | test/security-probe.mjs | SH-L1-02 `sh_norc_c` | 🔴 |
| shell 转发器的长参数前缀判不可靠 | bash --version 不触发 shell 转发器 | test/security-probe.mjs | SH-L1-03 `bash_version_silent` | 🔴 |
| shell 转发器的长参数前缀判不可靠 | bash --rcfile 后接 -c 判不可靠 | test/security-probe.mjs | SH-L1-04 `bash_rcfile_then_c` | 🔴 |
| shell 外层包装器判不可靠 | sudo bash -c 判不可靠 | test/security-probe.mjs | SH-L2-01 `sudo_bash_c` | 🔴 |
| shell 外层包装器判不可靠 | nohup bash /tmp/x.sh 判不可靠 | test/security-probe.mjs | SH-L2-02 `nohup_bash_script` | 🔴 |
| shell 外层包装器判不可靠 | timeout 5 bash -c 判不可靠 | test/security-probe.mjs | SH-L2-03 `timeout_5_bash_c` | 🔴 |
| shell 外层包装器判不可靠 | watch bash -c 判不可靠 | test/security-probe.mjs | SH-L2-04 `watch_bash_c` | 🔴 |
| shell 外层包装器判不可靠 | nice -n 10 bash -c 判不可靠 | test/security-probe.mjs | SH-L2-05 `nice_n10_bash_c` | 🔴 |
| shell 外层包装器判不可靠 | sudo env bash -c 判不可靠 | test/security-probe.mjs | SH-L2-06 `sudo_env_bash_c` | 🔴 |
| cd cwd 变更判不可靠 | cd 后接写入命令判不可靠 | test/security-probe.mjs | SH-L3-01 `cd_etc_then_rm_rf_dot` | 🔴 |
| cd cwd 变更判不可靠 | cd 后接读取命令判不可靠 | test/security-probe.mjs | SH-L3-02 `cd_etc_then_ls` | 🔴 |
| cd cwd 变更判不可靠 | 单命令 cd 不触发 | test/security-probe.mjs | SH-L3-03 `cd_etc_alone_silent` | 🔴 |
| cd cwd 变更判不可靠 | cd 在管道片段中判不可靠 | test/security-probe.mjs | SH-L3-04 `cd_src_then_cat_pipe_sort` | 🔴 |
| cd cwd 变更判不可靠 | cd 在后续片段中判不可靠 | test/security-probe.mjs | SH-L3-05 `echo_hi_semicolon_cd_tmp_then_rm` | 🔴 |
| cd cwd 变更判不可靠 | cd 后接写入目标触发 tier=two 提示 | test/decision.test.ts | AD-CD-01 `bash_cd_chdir_reason_yields_tier_two_prompt` | 🔴 |

### access-decision delta（16 scenario）

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 网络外带写入目标强制 tier=two | /dev/tcp 写入判 tier=two | test/decision.test.ts | AD-DEV-01 `dev_tcp_write_prompts_tier_two` | 🔴 |
| 网络外带写入目标强制 tier=two | /dev/udp 写入判 tier=two | test/decision.test.ts | AD-DEV-02 `dev_udp_write_prompts_tier_two` | 🔴 |
| 网络外带写入目标强制 tier=two | /dev/fd/3 写入判 tier=two | test/decision.test.ts | AD-DEV-03 `dev_fd_numeric_write_prompts_tier_two` | 🔴 |
| 网络外带写入目标强制 tier=two | /dev/tcp 读取不触发 tier=two | test/decision.test.ts | AD-DEV-04 `dev_tcp_read_auto_allows` | 🔴 |
| 网络外带写入目标强制 tier=two | /dev/tcp 写入不能持久化授权 | test/decision.test.ts | AD-DEV-05 `dev_tcp_write_no_persistent_grant_option` | 🔴 |
| 网络外带写入目标强制 tier=two | bash 命令中 dev/tcp 写入目标触发 tier=two | test/sys-integration.test.ts | SYS-DEV-01 `bash_dev_tcp_write_target_yields_tier_two_prompt` | 🔴 |
| 系统机密文件读取判敏感 | /etc/shadow 读取判敏感 | test/sensitive.test.ts | SENS-SYS-01 `system_credential_files_sensitive` | 🔴 |
| 系统机密文件读取判敏感 | /etc/sudoers 读取判敏感 | test/sensitive.test.ts | SENS-SYS-02（合并入 SENS-SYS-01） | 🔴 |
| 系统机密文件读取判敏感 | /etc/master.passwd 读取判敏感 | test/sensitive.test.ts | SENS-SYS-03（合并入 SENS-SYS-01） | 🔴 |
| 系统机密文件读取判敏感 | /etc/crontab 读取判敏感 | test/sensitive.test.ts | SENS-SYS-04（合并入 SENS-SYS-01） | 🔴 |
| 系统机密文件读取判敏感 | /etc/cron.d/ 子文件读取判敏感 | test/sensitive.test.ts | SENS-SYS-05（合并入 SENS-SYS-01） | 🔴 |
| 系统机密文件读取判敏感 | /etc/hosts.allow 读取判敏感 | test/sensitive.test.ts | SENS-SYS-06（合并入 SENS-SYS-01） | 🔴 |
| 系统机密文件读取判敏感 | /etc/passwd 不判敏感 | test/sensitive.test.ts | SENS-SYS-07 `etc_passwd_not_sensitive` | 🔴 |
| 系统机密文件读取判敏感 | /etc/hosts 不判敏感 | test/sensitive.test.ts | SENS-SYS-08（合并入 SENS-SYS-07） | 🔴 |
| 系统机密文件读取判敏感 | 用户配置声明覆盖系统机密文件 | test/decision.test.ts | AD-SYS-01 `declared_config_overrides_system_credential_rule` | 🔴 |
| 系统机密文件读取判敏感 | 项目内敏感文件读取仍判 tier=three | test/decision.test.ts | AD-SYS-02（沿用既有 AD-TESTCASE "未配置项目内敏感文件读弹三档"，本 change 不改变其行为——回归验证） | 🔴 |

**注**：`test/sys-integration.test.ts` 文件存在（既有 SYS1–SYS8 集成用例），新增 SYS-DEV-01 沿用其命名风格。敏感规则表内的 6 个正向 scenario（SENS-SYS-01 到 SENS-SYS-06）可合并到单个 test case（一个 test 内用 `assert.ok` 逐条断言），因为 `test/sensitive.test.ts` 的既有命名风格（如 `sensitive: SSH key files (id_rsa, id_ed25519, ...)`）本身就是"一个 test 覆盖多条断言"。账本逐行映射到 test 名 + 括号内说明"合并入 X"以保留 scenario 粒度可追溯性。

### approval-flow delta（2 scenario）

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| cd cwd 变更命令弹窗副文本 | bash 命令 cd cwd 变更类 prompt 副文本 | test/approval-flow.test.ts（本 change 新增） | AF-CDC-01 `bashSubtitleForReason_cd_chdir_returns_cwd_disclaimer` | 🔴（N/A — 无可执行测试面：`bashSubtitleForReason` 定义在 `extensions/index.ts:193`，当前无任何测试文件覆盖该函数；本 change 通过新增 `test/approval-flow.test.ts` 建立覆盖，见 tasks.md 6.3） |
| cd cwd 变更命令弹窗副文本 | cd cwd 变更类 prompt 与其他 bash 副文本互斥 | test/approval-flow.test.ts（本 change 新增） | AF-CDC-02 `bashSubtitleForReason_cd_chdir_disjoint_from_others` | 🔴（N/A — 同上，附机械校验：`grep -c "case \"cd_chdir\"" extensions/index.ts` 应 ≥ 1；`grep -c "cd 命令" extensions/index.ts` 应 ≥ 1） |

### grant-memory delta（1 scenario）

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| Bash 命令记忆渠道 | cd cwd 变更命令授权为 read_write | test/grant-memory.test.ts（本 change 新增） | GM-CDC-01 `bashPermissionForReason_cd_chdir_maps_to_read_write` | 🔴（N/A — 无可执行测试面：`bashPermissionForReason` 定义在 `extensions/index.ts:159`，当前无任何测试文件覆盖该函数；本 change 通过新增 `test/grant-memory.test.ts` 建立覆盖，见 tasks.md 6.3；附机械校验：`grep -c "cd_chdir" extensions/index.ts` 应 ≥ 2——bashSubtitleForReason 与 bashPermissionForReason 两处 case 分支） |

**archive 复盘 N/A 汇总**（tier-medium 要求）：
- 数量：3 条 N/A 条目（AF-CDC-01、AF-CDC-02、GM-CDC-01）
- 理由：`bashSubtitleForReason` 与 `bashPermissionForReason` 是 `extensions/index.ts` 内的私有函数（未 export，见 `extensions/index.ts:159` / `:193`），当前测试目录（`test/`）无对应覆盖文件。本 change 通过 tasks.md 6.3 新增两个测试文件建立覆盖，同时提供 grep 机械校验作为过渡——在 6.3 完成前，这两处 `cd_chdir` case 分支的存在性由 grep 校验锁定。
