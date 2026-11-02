# Tasks: find-exec-readonly-payload

> **关键链**：T1（写失败测试）→ T2（改判据）→ T4（全量测试）→ T6（typecheck + 文档同步）。**project buffer 35%**（tier-medium，关键链总估时 ~2.5h → buffer ~0.9h，落在 T4 全量测试上）。

## 1. 测试先行（TDD RED）

- [x] 1.1 在 `test/bash-extract.test.ts` 新增 `find_exec_readonly_payload_cat_reliable`：`extractBashTargets('find src/ -name "*.tmp" -exec cat {} \\;', projectRoot)` 断言 `reliable === true`。验证：RED 确认（改前 `find_write_flag`）
- [x] 1.2 新增 `find_exec_readonly_payload_wc_reliable`：`-exec wc -l {}` 断言 `reliable === true`。验证：RED
- [x] 1.3 新增 `find_execdir_readonly_payload_cat_reliable`：`-execdir cat {}` 断言 `reliable === true`。验证：RED
- [x] 1.4 新增 `find_exec_plus_terminator_readonly_reliable`：`-exec cat {} +` 断言 `reliable === true`。验证：RED
- [x] 1.5 新增 `find_exec_echo_harmless_payload_reliable`：`-exec echo {}` 断言 `reliable === true`。验证：RED
- [x] 1.6 新增 `find_exec_sh_payload_unreliable`：`-exec sh -c 'rm "$1"' _ {}` 断言 `reliable === false && reason === "find_write_flag"`。验证：改前改后均 green（fail-closed 反例）
- [x] 1.7 新增 `find_exec_no_command_payload_unreliable`：`-exec {}` 断言 `reliable === false && reason === "find_write_flag"`。验证：改前改后均 green

## 2. 实现判据（GREEN）

- [x] 2.1 `src/lib/bash-extract/readonly.ts` 内新增 `isReadonlyExecPayload(payloadToken: string): boolean`：payloadToken 为 undefined/空/以 `-` 开头/`{}`/`\;`/`+` → false；否则取 basename（`/bin/cat` → `cat`），返回 `READ_ONLY_COMMANDS.has(name) || HARMLESS_BUILTINS.has(name)`。验证：T1 全部 GREEN + 既有 1312-1344 find 断言保持
- [x] 2.2 修改 `isFindReadOnly`：`-delete`/`-ok`/`-okdir` 保持无条件 `return false`；`-exec`/`-execdir` 改为 `if (!isReadonlyExecPayload(tokens[i + 1])) return false`。验证：T1 全部 GREEN + 既有断言保持
- [x] 2.3 确认 `scanFindWriteFlags`（control-flow.ts）与 `isReadOnlyWithArgs`（readonly.ts:66）无需改动——它们经 `isFindReadOnly` 自动生效。验证：`grep` 确认两处调用仍指向 `isFindReadOnly`，无死代码

## 3. 回归确认

- [x] 3.1 确认既有 find 断言（1312-1344）仍为预期：`isFindReadOnly(["-exec"])` 仍 false（无载荷 fail-closed）、`-exec rm` 仍 false（写载荷）、filter-only 仍 true。验证：跑 `node --test test/bash-extract.test.ts` 该文件全绿（既有 7 个 helper 断言全部保持）
- [x] 3.2 确认反例边界：`find . -exec /bin/cat {} \;`（basename）判 reliable、`find . -exec sort {} \;`（集合外）判 unreliable。验证：临时 node 脚本断言 12/12 OK

## 4. 全量验证

- [x] 4.1 `npm run typecheck` 通过（tsc --noEmit，无新类型错误）。验证：`npm run typecheck` 退出码 0
- [x] 4.2 `npm test` 全量绿（`node --test "test/*.test.ts" "extensions/*.test.ts"`）。验证：退出码 0，908/908 全绿

## 5. 契约与文档同步

- [x] 5.1 `openspec/specs/bash-target-extraction/spec.md` 同步「find 的参数条件性只读判定」——delta spec 已定义新行为，baseline 合并留给 archive（项目既有工作流）。验证：`openspec validate find-exec-readonly-payload --type change` 通过（1/1）
- [x] 5.2 README.md 若声明 find 相关静默示例与实际分类一致（当前 README 未声明 find -exec 载荷，无需改；如改动则同步）。验证：grep README 确认无过时 find 描述
- [x] 5.3 确认 `BASH_GUARDRAILS` 文案（i18n.ts）与实际分类一致——`find_write_flag` 描述「cannot statically enumerate target files」仍适用（写载荷/未知载荷仍判该 reason）。验证：i18n.ts 无需改，grep 确认
