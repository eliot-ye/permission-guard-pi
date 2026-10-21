# Tasks

## Key Chain (Critical Path)

关键链：`1.1 → 2.1 → 2.2 → 3.1 → 3.2 → 4.1`（TDD RED-GREEN-REFACTOR + 集成验证）。
- 1.1（RED 写测试）是必需起点
- 2.1/2.2（GREEN 扩 splitCommands + 重构 isBoundedGlobSafe）是主实施
- 3.1/3.2（回归测试 + 用户触发场景验证）是集成验证
- 4.1（全量测试 + openspec validate）是最终关口

**Project buffer**：tier-medium → 35%（见 `field-assessment/references/strength-matrix.md` 表 1）。关键链估时约 5 tasks × 中位 30 min = 150 min；buffer 约 52 min 留到最后集成阶段。

## 1. TDD RED：新增测试用例

- [x] 1.1 编写 8 条新增测试（BMG60-BMG67）到 `test/bash-extract.test.ts` 末尾，验证命令为 `node --experimental-strip-types --test test/bash-extract.test.ts 2>&1 | grep -E "BMG6[0-9]"`
  - 验证证据：RED phase 运行输出中 BMG60-64 FAIL（5 条正向 case 期望 reliable 但得到 unreliable: glob_expansion）；BMG65-67 PASS（3 条反向 case 已正确）
  - 文件：`test/bash-extract.test.ts`
  - 风险：low（纯测试添加，无代码改动）
  - 验证：命令输出中 BMG60-BMG67 均为 failing；既有的 250+ 测试仍全部通过
  - 分系统影响：side-effects（bash-extract 测试面）
  - 依赖：无
  - 新增测试清单（对应 proposal 的 scenario→test 覆盖账本）：
    - BMG60: `semicolon_separated_echo_then_bounded_glob_is_safe`（`echo hi; wc -l src/*.ts`）
    - BMG61: `ampersand_separated_echo_then_bounded_glob_is_safe`（`sleep 5 & wc -l src/*.ts`）
    - BMG62: `newline_separated_echo_then_bounded_glob_is_safe`（`echo hi\nwc -l src/*.ts`，`\n` 为实际换行）
    - BMG63: `logical_and_separated_echo_then_bounded_glob_is_safe`（`echo hi && wc -l src/*.ts`）
    - BMG64: `logical_or_separated_echo_then_bounded_glob_is_safe`（`false || wc -l src/*.ts`）
    - BMG65: `semicolon_separated_write_glob_still_unreliable`（`echo hi; rm -f /tmp/*.log`）
    - BMG66: `ampersand_greater_redirect_not_split_as_background`（`echo hi &> /tmp/log`）
    - BMG67: `fd_dup_not_split_as_background`（`cmd 2>&1`）

## 2. TDD GREEN：实现代码

- [x] 2.1 扩展 `splitCommands` 支持 `&` 与 `\n` 分隔符（含 fd-dup 例外）
  - 验证证据：BMG61 (ampersand) 与 BMG62 (newline) PASS；BMG66 (`&>`) 与 BMG67 (fd-dup) PASS；全量回归 124/124 通过
  - 文件：`src/lib/bash-extract.ts`（`splitCommands` 函数，位于 `:499-557` 附近）
  - 风险：medium（既有函数扩展，被 `extractBashTargets` 主流程共享，改动会影响所有命令拆分）
  - 验证：
    - BMG60 (semicolon) 与 BMG61 (ampersand) 与 BMG62 (newline) 测试通过
    - BMG66 (ampersand redirect) 与 BMG67 (fd-dup) 测试通过——保护 fd-redirect 语义不被误拆
    - 现有 BMG24-BM32 (fd-redirect 组) 与 BTP1-BTP22 (pipeline 组) 与 BT1-BT12 (基础组) 全部继续通过
    - 完整命令 `node --experimental-strip-types --test test/bash-extract.test.ts 2>&1 | tail -5` 显示全部通过
  - 分系统影响：side-effects（bash-extract 主改动）
  - 依赖：1.1
  - 实现要点（对应 design.md D2/D3）：
    - `&` 判定顺序：先 `&&` 分支，然后 `next === ">"` 守卫（`&>`），`prev` 是 `0-9` 守卫（`N>&N`/`N>&-`），最后作为命令分隔符
    - `\n` 直接作为命令分隔符；引号内的 `\n` 天然被 quote 状态机跳过
    - 引号 / 反斜杠状态机保持现有实现

- [x] 2.2 重构 `isBoundedGlobSafe` 为外层 fragment loop + 内层 stage loop
  - 验证证据：BMG60 (semicolon) 与 BMG63 (logical AND) 与 BMG64 (logical OR) PASS；BMG65 (写 glob 负例) PASS；既有 BMG48-BMG53 isBoundedGlobSafe 单元测试继续通过
  - 文件：`src/lib/bash-extract.ts`（`isBoundedGlobSafe` 函数，位于 `:92-175` 附近）
  - 风险：medium（导出函数重构，但签名不变；仅 `scanUnreliable` 内部与单元测试消费）
  - 验证：
    - BMG60-BMG67 全部通过
    - BMG65（写命令 glob 负例）通过——重构不改变"写命令 + glob 仍判不可靠"语义
    - 现有 BMG48-BMG51（isBoundedGlobSafe 单元测试）继续通过（签名不变、单片段输入行为不变）
    - 完整命令 `node --experimental-strip-types --test test/bash-extract.test.ts 2>&1 | tail -5` 显示全部通过
  - 分系统影响：side-effects（bash-extract 主改动）
  - 依赖：2.1
  - 实现要点（对应 design.md D3）：
    - 外层 `const fragments = splitCommands(cmd)`
    - 内层逻辑（`splitPipelines` + stage loop + token scan）完全保持原样，只是作为 `for (const fragment of fragments)` 循环体
    - 函数签名 `isBoundedGlobSafe(cmd: string, projectRoot: string): boolean` 不变

## 3. 集成验证

- [x] 3.1 全量测试回归：`node --experimental-strip-types --test test/*.test.ts` 全部通过
  - 验证证据：240 tests, 240 pass, 0 fail（既有 232 + 新增 8）
  - 文件：无（只运行测试）
  - 风险：low
  - 验证：命令输出末尾显示 `# fail 0` 且 `# pass` 数 ≥ 260（既有 250+ + 新增 8）
  - 分系统影响：全部（跨分系统回归验证）
  - 依赖：2.2

- [x] 3.2 用户会话原始触发命令现场验证
  - 验证证据：原始动机命令 `wc -l src/lib/*.ts ...` → R 3t（reliable）；用户触发 `echo hi; wc -l src/*.ts` → R 1t；audit-02:53:52 → R 3t（修复）；audit-03:49:51 → R 1t（reliable）；audit-04:54:54 → R 3t（修复）
  - 文件：无（现场验证）
  - 风险：low
  - 验证：
    - 使用一个 TypeScript 临时脚本调用 `extractBashTargets` 传入本 change 的动机命令（`echo '--- src/lib ---'; ls -la src src/lib extensions test 2>/dev/null; wc -l src/*.ts src/lib/*.ts extensions/*.ts 2>/dev/null; wc -l test/*.test.ts extensions/*.test.ts 2>/dev/null | tail -30`）
    - 期望输出：`{ reliable: true, targets: [...] }`，targets 全部为项目内 read 目标
    - 完成后删除临时脚本
  - 分系统影响：side-effects（bash-extract 端到端）
  - 依赖：2.2

## 4. 定稿与归档准备

- [x] 4.1 `openspec validate bounded-glob-compound-separators --type change --json` 通过
  - 验证证据：valid: true, issues: []
  - 文件：无（只运行 validate）
  - 风险：low
  - 验证：命令 JSON 输出中 `valid: true`（或等价字段）；`issues` 为空数组
  - 分系统影响：无（工具命令）
  - 依赖：3.1
  - 补充说明：如果 `openspec validate --strict` 报 specs delta 中 "MODIFIED Requirements" 未包含完整更新内容的警告，需回到 specs delta 补齐 requirement 全文（本 change 的 delta 已按"full updated content"格式写好，预期通过）

## 关键链与 buffer 说明

- 关键链总估时：1.1（15 min）+ 2.1（30 min）+ 2.2（30 min）+ 3.1（10 min）+ 3.2（10 min）+ 4.1（5 min）= **100 min**
- Project buffer（35%）：35 min，主要在 3.1/3.2 阶段（回归 + 现场验证）——如出现测试回归或用户触发场景仍失败，用 buffer 排查
- Feeding buffer：无支流汇入，不适用

## 非关键路径

无——本 change 关键链即全部任务序列，无并行支流。

## 完成定义

全部 7 个 tasks 完成 + 4.1 openspec validate 通过 + 所有测试绿 → 可 `/td-apply` 结束并 `/td-archive`。
