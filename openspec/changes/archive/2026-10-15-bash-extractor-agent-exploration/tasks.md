## 1. Bash 提取器逻辑修复

- [x] 1.1 在 `src/lib/bash-extract.ts` 的 `extractRedirects` 中增加对 `/dev/` 前缀路径的跳过 write target 逻辑：重定向目标若以 `/dev/` 开头，则不 push 为 write target
- [x] 1.2 在 `src/lib/bash-extract.ts` 的 `scanUnreliable` 中增加「有界 glob」判断：当未加引号的 glob 前缀完全在 projectRoot 内且命令属于 read-only 命令集合时，不再触发 glob_expansion 标记
- [x] 1.3 验证现有测试无回归：运行 `node --experimental-strip-types --test test/bash-extract.test.ts`，确认 183 既有测试仍全绿

## 2. Grant‑memory：Bash 命令记忆渠道

- [x] 2.1 在 `src/lib/trust.ts` 新增 `addBashSessionGrant(projectHash, rawCommand, permission)` / `hasBashSessionGrant(projectHash, rawCommand)`：key 为 `projectHash|sha256(rawCommand)`，写入 session Grants Set
- [x] 2.2 在 `src/lib/trust.ts` 新增 `addBashPersistentGrant(grant)` / `hasBashPersistentGrant(projectHash, rawCommand)`：同理写入持久化 grants
- [x] 2.3 新增 `clearBashGrants()`：session 结束时清空 session Grants（持久化保持不变）
- [x] 2.4 新增 `Grant` 记录的 `type` 字段（`path` / `bash`），区分 path‑level vs command‑level 授权
- [x] 2.5 编写 trust 单元测试：bash 命令 grant 的 session/persistent 增删查全部通过

## 3. Extension 层：bash 命令 prompt 与 grant 写入

- [x] 3.1 在 `extensions/index.ts` 的 `handleBash` handler 中检测不可靠原因：在 `extraction.reason` 非空时，在 prompt decision 前注入 bash_reason 字段到 decision 对象
- [x] 3.2 在 `handlePromptDecision` 中增加 subtitle 注入：依据 `decision.bash_reason` 动态生成 tier=two 的副文本（glob、device_redirect、control_flow、shell_forwarder、forwarding_command 等细分 case），并在弹窗按钮中提供 "allow for this session" 与 "always allow"（写入 trusted.json）
- [x] 3.3 在 `handlePromptDecision` 中实现 grant 写入："allow for this session" → `state.trust.addBashSessionGrant(...)`；"always allow" → `state.trust.addBashPersistentGrant(...)` + 显示 trusted.json 路径提示
- [x] 3.4 在 `handlePromptDecision` 中实现 "allow once" 路径：仅放行本次调用，不写入任何记忆通道
- [x] 3.5 在弹窗 UI 中显示 trusted.json 绝对路径提示（tier=two 增补：仅当用户选择 "总是允许" 时出现，内容与 tier=three 统一）

## 4. Spec 与测试更新

- [x] 4.1 在 `openspec/specs/bash-target-extraction/spec.md` 添加「有界 glob」与「设备重定向」两条 MODIFIED Requirements（内容已在 change 的 specs 目录自动迁移；archive 时合并）
- [x] 4.2 在 `openspec/specs/grant-memory/spec.md` 添加「Bash 命令记忆渠道」条目（同理）
- [x] 4.3 在 `openspec/specs/approval-flow/spec.md` 添加 bash 命令类 prompt 副文本细分 scenario（同理）
- [x] 4.4 编写 bash-extract 新增测试用例：BMG0*：fd‑redirect 类；BMG1*：有界 glob 类；BMG2*：写命令内 glob 仍触发类
- [x] 4.5 编写 trust 新增测试：bash grant 增删查全通过
- [x] 4.6 在 extensions 集成测试中验证：bash 命令弹窗 tier=two，选择 "allow for this session" auto‑allow 下次同 command，跨 session 仍弹窗

## 5. Verify 全链路

- [x] 5.1 本地开发环境跑一遍所有相关测试：`node --experimental-strip-types --test`（覆盖 bash-extract + trust + extension 集成）
- [x] 5.2 验证开发者频繁使用的命令`2>/dev/null`、`cat file 2>/dev/null`、`ls openspec/changes/archive/*/` 均不再弹 tier=two
- [x] 5.3 验证新增的 session‑grant 流程：任意 tier=two bash prompt，选择 "allow for this session" 后，同一 session 里再次输入完全相同的 rawCommand（包括相同的空格、引号、参数）直接 auto‑allow，不再弹窗；跨 session（重启 pi）仍弹窗

