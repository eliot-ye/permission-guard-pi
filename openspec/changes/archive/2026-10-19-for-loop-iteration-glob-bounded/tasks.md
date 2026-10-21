# Tasks

## 1. TDD RED：新增测试用例

- [x] 1.1 编写 9 条新增测试（BMG88-BMG96）到 `test/bash-extract.test.ts` 末尾
  - 风险：low（纯测试添加）
  - 验证：BMG88-96 全部通过
  - 依赖：无

## 2. TDD GREEN：实现代码

- [x] 2.1 新增 `isForLoopIterationGlobExempt` 辅助函数 + 修改 `scanUnreliable` 的 glob 处理分支
  - 文件：`src/lib/bash-extract.ts`（`scanUnreliable` 函数 + 新增 `isForLoopIterationGlobExempt` 辅助函数）
  - 风险：medium（for-loop 结构解析 + glob 位置定位，错误会导致误判）
  - 根因：`splitCommands` 在 `;` 处拆分，`isBoundedGlobSafe` 看不到完整 for-loop 结构，必须在 `scanUnreliable`（看到完整 cmd）层面处理
  - 验证：BMG88-96 全部通过；既有 BMG60-87 无回归
  - 依赖：1.1

- [x] 2.2 新增 `isGlobForLoopExempt` + `parseGlobForLoop` 辅助函数 + 修改 `scanControlFlow` 签名
  - 文件：`src/lib/bash-extract.ts`（`scanControlFlow` 函数 + 新增 `isGlobForLoopExempt` + `parseGlobForLoop` 辅助函数 + `extractBashTargets` 调用点）
  - 风险：medium（scanControlFlow 签名变更，需要更新调用点）
  - 说明：`scanUnreliable` 修复后，for-loop 命令通过了 glob 检查但被 `scanControlFlow` 拦截（`isLiteralForLoop` 要求迭代集为字面量，glob 被拒）。需要额外的 glob-iteration 豁免路径。
  - 验证：BMG88-96 全部通过；control_flow 不再误触发
  - 依赖：2.1

## 3. 集成验证

- [x] 3.1 全量测试回归：`node --experimental-strip-types --test test/*.test.ts` 全部通过
  - 验证：pass 321, fail 0
  - 依赖：2.2

- [x] 3.2 用户会话原始命令现场验证
  - 验证：`for d in openspec/specs/*/; do echo "=== $d ==="; ls "$d"; done` → reliable
  - 依赖：2.2

- [x] 3.3 `openspec validate for-loop-iteration-glob-bounded --type change --json` 通过
  - 验证：valid: true
  - 依赖：3.1

- [x] 3.4 security-probe 回归：`node --experimental-strip-types test/security-probe.mjs` 全部通过
  - 验证：12 passed, 0 failed
  - 依赖：2.2
