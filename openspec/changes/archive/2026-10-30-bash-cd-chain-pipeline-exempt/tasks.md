# Tasks: bash-cd-chain-pipeline-exempt

## 关键链与 buffer

- **关键链**：T2（RED 测试）→ T3（条件 3 实现）→ T4（全量回归 + 断言核对）。T1（i18n 文案）与 T2/T3 无依赖，可并行，但 T5（文档一致性核对）依赖 T4。
- **Project buffer**：35%（tier-medium）。关键链估时 3.0h → project buffer ≈ 1.1h。
- Feeding buffer：T1 支流 0.5h × 35% ≈ 0.2h，汇入点 T5。

## Tasks

- [x] **T1**：更新 `cd_chdir` i18n 文案（支流，0.5h）
  - 主体：修改 `src/lib/i18n.ts` 的 `cd_chdir` 条目（英文 :66、中文 :172），把「无 ;/||/&/管道」的 D2a 边界描述改为「管道各 stage 通过路径安全检查时自动放行」，中英文语义对齐。
  - 验证：`npx tsx -e 'import {BASH_REASON_MESSAGES_EN} ...'`（或对应导出）确认两处文案包含新边界描述；`git diff` 确认仅改动这两处字符串。✅（EN_BUNDLE/ZH_BUNDLE.cd_chdir 含「pipeline stages」/「管道各 stage」，无旧边界表述；git diff 仅改 i18n.ts 两行）

- [x] **T2**: RED——新增 cd 链 + 管道测试断言（关键链，1.0h）
  - 主体：在 `test/bash-extract.test.ts` 新增 8 个用例（先写测试、先跑失败）：
    1. `cd <abs> && npm test 2>&1 | tail -25` → `{reliable:true, targets:[]}`（动机案例）
    2. `cd /tmp/x && cat a.txt | sort` → `{reliable:true, targets:[read /tmp/x/a.txt]}`（跟踪 cwd 解析）
    3. `cd /etc && sort sub | wc -l` → `{reliable:false, reason:"cd_chdir"}`（裸词反例）
    4. `cd /tmp/x && wc -l . | head -5` → `{reliable:false, reason:"cd_chdir"}`（cwd 锚点反例）
    5. `cd /tmp/x && ls *.md | wc -l` → `{reliable:false, reason:"cd_chdir"}`（glob 反例）
    6. `cd /etc && cat /etc/passwd | xargs rm` → `{reliable:false, reason:"forwarding_command"}`（转发器兜底）
    7. `cd /tmp/x | cat && grep pattern file.txt` → `{reliable:false, reason:"cd_chdir"}`（cd 片段自身含管道）
    8. `cd /etc && git log | git rm file.txt` → `{reliable:false, reason:"cd_chdir"}`（git 写子命令位于管道非首 stage）
  - 验证：`node --experimental-strip-types --test test/bash-extract.test.ts`——新用例 RED（1/2/6 通过失败暴露现状，其余确认现行为基线），既有用例不受影响。✅（T2 RED：CDC-PIPE-01/02/06 失败暴露差距，03/04/05/07/08 基线确认）

- [x] **T3**: 实现——`analyzeCd` 条件 3 逐 stage 化（关键链，1.5h）
  - 主体：修改 `src/lib/bash-extract/shell-forwarder.ts` 的 `analyzeCd`：
    1. cd 片段自身 `splitPipelines` 结果恰为 1 stage 的检查独立保留（不满足 → 维持 `cd_chdir`）；
    2. 删除条件 3 对下游片段的「`splitPipelines` 结果恰好 1 stage」整体拒绝；
    3. 把 `downstreamFragments` 改为 `downstreamStages`（每片段 `splitPipelines` 拆 stage 后展平），条件 4~11 的**遍历单元**从片段换为 stage——条件 7/10/11 的首命令判定改为对每个 stage 重新 `tokenize(stage)[0]`（review warning：只删条件 3 而漏改遍历会让条件 11 只看首 stage，`cd /etc && git log | xargs git rm` 类命令漏拦 git 写子命令），检查逻辑本体不改；
    4. 更新条件 3 处的注释块（理由：管道 stage 继承 cd 后 cwd，语义与下游片段一致；转发器由既有守卫兜底）。
  - 验证：`node --experimental-strip-types --test test/bash-extract.test.ts`——T2 全部用例转 GREEN。✅（CDC-PIPE-01~08 全绿；实施中发现 parse.ts splitCommands 对 `2>&1` 误拆的既有 bug，经 `isAmpBackgroundSeparator` 修复）

- [x] **T4**: 全量回归 + 探针断言核对（关键链，0.5h）
  - 主体：跑全量测试与安全探针；逐一核对 reason 变化的既有断言（预期：部分 `cd 链 + 管道` 命令从 `cd_chdir` 变 `reliable` 或 `forwarding_command`），按 design D2 的预期行为变化更新非测试断言文件（`test/security-probe.mjs` / `test/cross-system-boundary.mjs` 等）。
  - 验证：`node --experimental-strip-types --test test/` 全量绿 + `node test/security-probe.mjs`、`node test/cross-system-boundary.mjs` 通过（或断言按预期行为变化更新后通过）。✅（全量 794/794、security-probe 55/55、cross-system-boundary 6/6、symlink-grant 探针通过；更新 BTP-audit-102 / BMG-CD-pipeline-reject 两处预期行为变化断言）

- [x] **T5**: 收尾核对（汇入点，0.3h）
  - 主体：核对 `README.md` / `docs/security/permission-model.md`（若存在）中对 cd 链豁免「无管道」边界的描述并同步修正；确认无残留「无管道」表述。
  - 验证：`grep -rn "无管道\|no pipeline" README.md docs/ src/lib/i18n.ts` 无过期表述（或命中处均为本 change 修正后的新语义）。✅（README/docs 无残留；shell-forwarder.ts:788-789 的「无管道」为放宽理由新语义注释）

## 已知边界（非本 change 范围）

- 条件 4~11 的 `FILE_ARG_COMMANDS` 清单完备性为「持续清点非穷尽」（前序 change 声明），本 change 不扩展清单。
- `analyzeCd` 逐 stage 化后，跨 stage 组合语义（bash 管道仅数据流、无共享路径语义）理论上无新增 cwd 依赖；如未来引入进程替换类语法，需重新评估。

## 估时汇总

关键链 T2→T3→T4 = 3.0h，project buffer 35% ≈ 1.1h；支流 T1 0.5h（feeding buffer 0.2h）；T5 0.3h。
