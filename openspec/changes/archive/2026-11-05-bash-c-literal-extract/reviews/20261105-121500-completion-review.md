# Code Review：bash-c-literal-extract change 级收尾

**reviewed-by**: subagent（独立隔离，只读，authoring context 之外）
**深度**：tier-medium / 风险 medium → Spec compliance + Code quality + Code consistency 全查，Security 查红线
**实跑验证**：reviewer 实跑 `npm run typecheck`（通过）+ `npm test`（942 绿；唯一 fail 为 AL7 已知 flaky，与本 change 无关）

## Spec compliance
- D1 纯字面量护栏：OK（shell-forwarder.ts:1106-1120，精确落实拦截集 + 两点澄清）
- D2 递归 + 深度上限 1 层：OK（entry.ts:41 depth 守卫 + :52 depth+1 递归）
- D3 0 目标强制回退：OK（entry.ts:54；BMG10 dash 分支 + literal_shell_c_zero_target_falls_back 双覆盖）
- D4 集成点：OK（entry.ts:111-120，守卫链顺序未变）
- Spec Scenario 逐条：OK——8 ADDED + 8 MODIFIED 全部有对应实现与测试路径
- **核心安全性质「≤ 直接执行」：OK，未见反例**——有目标时内层提取与直接执行同一函数同一套守卫，目标集合恒等；「丢外层 stage 目标」安全洞被 entry.ts:43-46 外层单 stage 限制防住（test:5025/5033 实证复合/管道外层回退）；0 目标/内层不可靠/嵌套 -c 三路全回退（更严）

## Security（红线）
- 递归无新绕过面：OK（extractShellCArg 脚本路径/source/stdin 一律不展开；$ 字符级强充分条件）
- 敏感文件/网络外带硬底线：OK（/dev/tcp 经内层 extractRedirects 提取 write 目标，决策层 L4b 拦，cross-system Boundary 4 验证）
- depth 外部超大值：OK（公共签名 depth=0 默认，唯一非默认来自内部 depth+1，守卫兜底）

## Code quality
- 命名/DRY：OK（复用 SHELL_WRAPPER_NAMES/SHELL_NAMES/skipWrapperTokens/CONTROL_FLOW_KEYWORDS，未另起一套）
- 递归终止：OK（三重终止：depth + 非 -c 形态 + 护栏不过）
- 测试边界：OK 且超出计划（brace/嵌套-c/嵌套引号拼接/0目标/复合内层 + 外层复合/管道回退 + 未引号 -c 首 token）
- 轻微（非缺陷，安全方向）：`cat in`（`in` 是控制流关键字）会保守回退——合法文件名误判方向是回退弹窗，非放行

## Code consistency
- OK——纯函数模式、谓词导出自 shell-forwarder.ts、编排留 entry.ts、JSDoc 风格与既有 scanCdChdir/shouldTrackCdCwd 一致、守卫链只做命中处插入

## Issues（review 后处理）
1. **[warning]** 缺"目标集合恒等"专门回归测试 → **已修复**：补 `literal_shell_c_targets_equivalent_to_direct_execution` 参数化测试（5 组命令断言 wrapped targets ≡ direct targets，含 /dev/tcp case），固化"≤ 直接执行"为契约
2. **[nit]** `]` 不在拦截 regex 与 design 文字"`* ? [ { }`"不一致 → **已修复（修措辞）**：design D1 补说明——`]` 单独非 glob 活跃字符（字符类需 `[` 开启已被拦），拦 `]` 只会误伤合法文件名 `foo]bar` 无安全收益

## Verdict
APPROVED
reviewed-by: subagent
（无 critical；1 warning + 1 nit 均已在 review 后修复；可以进入归档）
