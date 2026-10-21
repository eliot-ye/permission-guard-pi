## Why

Bash command target extraction is a security-critical path. Current `scanUnreliable` logic incorrectly treats fd-redirections (`2>/dev/null`, `>/dev/null`) as write targets, causing legitimate read-only commands to trigger tier=two prompts. Additionally, glob-expansion detection treats all unquoted glob patterns as high-risk regardless of context, blocking safe read-only commands (like `ls openspec/changes/archive/*/`) used in AI-assisted exploration.

These misclassifications are not bugs but design limitations (missing `require`-ability for fd to `/dev/null` and "bounded glob" concept). Because they affect capability and impact, we must propose changes to spec and implementation to fix both issues:

1. **fd/device redirect not misinterpreted as write** → `extractRedirects` 里对 `/dev/` 前缀跳过 write target
2. **read-only commands + inner‑project glob auto‑allow** → 在 `scanUnreliable` 中增加"bounded glob"逻辑，缩小不可靠标记范围

### New UX: session‑scoped bash command memory

Current grant-memory does not support "remembering a command". The UX of "allow once / allow for this session" for unreliable bash commands is currently tied to path‑based grants. We need a dedicated bash‑command grant channel so that users can choose "allow for this session" on a bash command and have it auto‑allow subsequent identical command strings within the same session (and optionally store to trusted.json with UI path).

## What Changes

- **New Capability: `bash-target-extraction` – Bounded glob & device redirect fixes**
  - `scanUnreliable` 里增加对"bounded glob"的判断，命中时不再标记 unreliable（属于 read-only 命令）
  - `extractRedirects` 里增加对 `/dev/` 前缀路径的跳过 write target 逻辑
- **Modified Capability: `grant-memory` – Bash command memory channel**
  - 新增 `addBashSessionGrant(projectHash, rawCommand, permission)` + `hasBashSessionGrant(projectHash, rawCommand)`
  - Bash‑command grants use `rawCommand`（sha256）键，标记为 session‑scoped（和 persistent 两种）
  - "allow for this session" 时写入会话级 bash 命令 memory；"总是允许"时写入持久化 trusted.json
- **Modified Capability: `approval-flow` – Bash 命令类 prompt 副文本适配**
  - 精细化 tier=two 的副文本显示：具体是因为 fd 资源 / bounded glob 不能配置导致，不再统一使用"命令无法静态解析，请审阅整条命令；无法通过配置持久化"
  - 新增符合 grant‑memory 中新增的 bash command 类 prompt 的 UI 文案，提供与 path 类提示一致的 UX

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `bash-target-extraction` – Bounded glob and device redirect fixes
- `grant-memory` – Bash command memory channel
- `approval-flow` – Bash 命令类 prompt 副文本文案细化

## Impact

**Modified code**
- `src/lib/bash-extract.ts`：`
  - `scanUnreliable` 新增「bounded glob」逻辑
  - `extractRedirects` 新增对 `/dev/` 前缀路径的跳过 write target 逻辑
- `src/lib/trust.ts`：新增 `addBashSessionGrant`、`hasBashSessionGrant`、`clearBashGrants`，新增 `Grant` 记录字段 `type` 区分 path‑grant vs command‑grant
- `extensions/index.ts`：新增 bash 命令 session‑grant 检查与写入逻辑
- `src/lib/config.ts`、`src/lib/decision.ts` 等（如需调整权限检查流程）

**Added tests**
- bash-extract 测试：
  - BMG0*：`2>/dev/null` 等 fd‑redirect 不触发 write target
  - BMG1*：`>/dev/null`、`2>/dev/null` 等 fd‑redirect 到 `/dev/stderr` 等不触发 write
  - BMG2*：read-only 命令内带「bounded glob」（如 `ls openspec/changes/archive/*/`）不触发 glob_expansion
  - BMG3*：`rm -rf /tmp/*.log` 等前缀出界 glob 仍保持 glob_expansion
- trust 单元测试：新增 bash‑command grant 的 session/persistent 增删查
- extension 集成测试：新增 bash 命令弹出 tier=two 弹窗，"allow for this session" 写入 bash 命令 memory，并 auto‑allow 下次同命令

**User-facing changes**
- Bash 命令（如 `2>/dev/null`、`ls openspec/changes/archive/*/`）不再误触 tier=two，体验更顺畅
- 提供「allow for this session」选项记住 bash 命令，减少重复审批，符合 AI 探索场景需求

**Audit & Docs**
- `reason` 字段新增值「bounded_glob」、「device_redirect」记录；审计日志 tagging 调整
- 文档更新：`approval-flow` spec.md 完善 bash command 类 prompt 副文本
- README/UI 文案补充 bash 命令类 prompt 中「总是允许」选项的 trusted.json 路径提示

