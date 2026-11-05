# Scenario→Test 覆盖账本

> tier-medium，applyRequires 含 specs，强制产出。测试名沿用项目惯例（GM/AL/BM 前缀）；apply 阶段实现时若测试名微调，以 tasks.md 的验证项与实际测试名为准，覆盖关系不变。b2 五条（AL-BR）与 b1 七条（BM-CD-MIXED）均已实现转 🟢（见 tasks.md 1.2 / 2.3 验证证据）。

## bash-target-extraction /「cd 链含非 `&&` 分隔符时的只读豁免」

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| cd 链含非 `&&` 分隔符时的只读豁免 | cd 后接只读命令与 `;` 后 cwd 无关片段豁免 | test/bash-extract.test.ts | BM-CD-MIXED-1: cd 绝对 + 只读探查 + `;` 后 cwd 无关片段豁免 | 🟢 |
| cd 链含非 `&&` 分隔符时的只读豁免 | `;` 后片段含 cwd 相对引用仍判不可靠 | test/bash-extract.test.ts | BM-CD-MIXED-2: `;` 后 cat rel.txt 仍判 cd_chdir | 🟢 |
| cd 链含非 `&&` 分隔符时的只读豁免 | `;` 后片段含写命令仍判不可靠 | test/bash-extract.test.ts | BM-CD-MIXED-3: `;` 后 rm -rf sub 仍判 cd_chdir | 🟢 |
| cd 链含非 `&&` 分隔符时的只读豁免 | `;` 后再 cd 相对目标判不可靠（critical 1 反例） | test/bash-extract.test.ts | BM-CD-MIXED-3b: `;` 后 cd rel 仍判 cd_chdir | 🟢 |
| cd 链含非 `&&` 分隔符时的只读豁免 | `;` 后解释器执行判不可靠（豁免成立时 cd 守卫不再命中，落到步骤 4，reason=unreliable_command；critical 3，经二次回写校正） | test/bash-extract.test.ts | BM-CD-MIXED-3c: `;` 后 node -e 判 unreliable_command | 🟢 |
| cd 链含非 `&&` 分隔符时的只读豁免 | `||` 链只读探查豁免 | test/bash-extract.test.ts | BM-CD-MIXED-4: `||` 链 + 2>/dev/null 豁免 | 🟢 |
| cd 链含非 `&&` 分隔符时的只读豁免 | 既有纯 `&&` 链 cd 跟踪豁免不受影响 | test/bash-extract.test.ts | BM-CD-MIXED-5: 纯 `&&` 链豁免行为不变 | 🟢 |

## audit-log /「bash 不可靠判定携带 reason 标注」

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| bash 不可靠判定携带 reason 标注 | bash 不可靠弹窗记录携带 bash_reason | extensions/index.test.ts | AL-BR-1: cd_chdir 弹窗记录含 bash_reason | 🟢 |
| bash 不可靠判定携带 reason 标注 | 各类不可靠 reason 均落入 bash_reason | extensions/index.test.ts | AL-BR-2: glob_expansion reason 落 bash_reason | 🟢 |
| bash 不可靠判定携带 reason 标注 | 可靠 bash 命令不写 bash_reason | extensions/index.test.ts | AL-BR-3: 可靠 bash 记录无 bash_reason | 🟢 |
| bash 不可靠判定携带 reason 标注 | 文件工具记录不写 bash_reason | extensions/index.test.ts | AL-BR-4: write 工具记录无 bash_reason | 🟢 |
| bash 不可靠判定携带 reason 标注 | 旧日志缺 bash_reason 仍可解析 | extensions/index.test.ts | AL-BR-5: 缺 bash_reason 的旧记录可解析 | 🟢 |

## 交叉引用

- b1 的 5 个 scenario 由 tasks.md 2.1（RED 测试）+ 2.2/2.3（实现）覆盖；既有 cd 安全反例（`>&file` critical、`cd /etc && rm -rf .`、`cd /etc && sort data.txt` 等）由 2.4 回归兜底，不进本账本（属既有覆盖，非本 change 新增 scenario）。
- b2 的 5 个 scenario 由 tasks.md 1.2（RED 测试）+ 1.1/1.3 覆盖。
- **apply 阶段账本回写记录**：AL-BR-1..5 测试文件由预判的 `test/audit.test.ts` 修正为 `extensions/index.test.ts`——`bash_reason` 写入点在扩展层（design D3「写入位置：`extensions/index.ts` 的 bash 审计记录构造处」），纯 `createAuditLogger` 单测测不到写入路径；scenario→test 覆盖关系不变（仍 1:1），仅文件落点修正。b2 五条已 RED→GREEN 转 🟢。
- 无 `N/A` 条目——12 个 scenario 均有可执行测试面（bash-extract 为纯函数测试；bash_reason 经 `extensions/index.test.ts` 的 mock pi 全链路 `fireToolCall` → audit 落盘验证）。
- 架构 review 后新增 BM-CD-MIXED-3b（critical 1 反例：`;` 后 cd 相对目标）与 BM-CD-MIXED-3c（critical 3：reason 由守卫决定）——对应 b1 加严作用域修正与 spec 条件 3 措辞修正。
