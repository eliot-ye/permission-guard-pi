# Change: Audit auto-allow record completeness (D1/D2)

## Metadata
- **Status**: proposal
- **Change Type**: behavior (audit completeness)
- **Spec Driven**: yes
- **Source**: reverse-spec 2026-10-27 检出漂移 D1/D2；用户拍板 j4（D1/D2 改代码）

## Why

reverse-spec（2026-10-27）检出 audit-log 分系统漂移：

- **D1（严重）**：`audit-log` Req 1 要求"所有决策必须记录（唯一例外：项目内未配置非敏感常规读写）"。但代码只在 **1 处** 记录 `auto_allow`（bash grant 命中，index.ts:652）。文件工具 auto_allow（config 声明 read_only read / read_write inner / allow 规则 / grant 命中 / 项目外 read / tmp default）在 `decision.kind === "auto_allow"` 时直接 `return undefined`（index.ts:825），无 audit.log。可靠 bash auto_allow 同样 `continue`（index.ts:768），无 audit.log。
- **D2（中）**：`audit-log` Req 8 要求 `hard_deny → authorization === "presumed"`。文件工具 hard_deny 有该字段（index.ts:817），但可靠 bash hard_deny（index.ts:749-762）**无** `authorization`。

spec（audit-log Req 1 "所有决策必须记录" + Req 8 授权来源标注）从 initiate 起就是原始契约，从未有意放宽。代码未完整实现（欠账）。`permission-model.md:20` 明确"审计日志全记录"设计意图。

## What Changes

- **D1**：文件工具 + 可靠 bash 的 auto_allow，除 `in_project_default_allowed`（项目内未配置非敏感常规读写——唯一 spec 例外）外，补 `audit.log({ event: "auto_allow", ... })`，透传决策对象的 `authorization` / `grant_source`（audit-log spec "auto_allow 从决策对象透传"）。
- **D2**：可靠 bash hard_deny 补 `authorization: "presumed"`（与文件工具 hard_deny 对齐）。

## Impact

- **Callers**：`extensions/index.ts` handleFileTool + handleBash（新增 audit.log 调用）。
- **Audit 记录量**：增加——config 声明 / allow 规则 / grant 命中 / 项目外 read / tmp 的 auto_allow 现在会被记录。这是 spec 要求，修复欠账。
- **向后兼容**：audit.log 的 `authorization` / `grant_source` 是既有可选字段（B2/B5 已加），无 schema 变化。

## Caller impact analysis

- `extensions/index.ts` handleFileTool：auto_allow 非例外时补 `audit.log`。
- `extensions/index.ts` handleBash：可靠 bash auto_allow 非例外时补命令级 `audit.log`（once per call）；hard_deny 补 `authorization: "presumed"`。
- 无公共 API 变化。

## Risk

- **低**。新增的 auto_allow 审计是 spec 明确要求的记录行为，不改变决策结果（auto_allow 仍返回 undefined，仅多写一条日志）。
- 日志量略增，但 auto_allow 本身是"已授权/已声明"的常规路径，记录是审计完整性要求。

## Verification

- RED：SYS-B2a（D2 bash hard_deny authorization）、SYS-B2b（D1 config 声明 auto_allow 审计）、SYS-B2c（D1 可靠 bash auto_allow 审计）——先失败后通过。
- Full suite：704/704 pass。
- typecheck：0 new errors。

## System Engineering Assessment

- **Subsystem**：side-effects（audit）+ extension-orchestration（audit.log 调用点）。
- **Tier**：medium（audit 完整性是 side-effects 核心；调用点在 extension-orchestration）。
- **Impact scope**：行为补全（修复 spec 欠账），无 schema 变化，向后兼容。
- **预期行为模型**：
  1. 文件工具 config 声明 auto_allow → audit `event: auto_allow` + grant_source 透传
  2. 可靠 bash auto_allow → 命令级 audit（once per call）
  3. 项目内未配置非敏感常规（in_project_default_allowed）→ 仍不记录（例外保留）
  4. 可靠 bash hard_deny → audit 含 `authorization: "presumed"`

## 实际系统工程影响 vs 预期

（td-archive 步骤 3 强制复盘。对照 proposal 的"系统工程影响评估"节。本复盘为 2026-10-27 system-audit project（18:37）a1 后补写——原归档时缺此节。）

- **实际影响的分系统**：`side-effects`（audit）+ `extension-orchestration`（extensions/index.ts handleFileTool + handleBash 的 audit.log 调用点）——与预期一致
- **实际整体性能变化**：零性能影响——与预期一致（auto_allow 审计为一次布尔判断 + 追加 JSONL 行，常数级；decision.reasonCode 已有，无新计算）
- **实际是局部优化还是全局协调**：局部优化（补齐 audit 记录欠账）——与预期一致
- **局部优化的实际全局影响**：新增 auto_allow 审计记录使 audit-log spec Req 1"所有决策必须记录"得到满足——无决策结果变化（仍 return undefined），仅多写日志行——与预期一致
- **模型验证**：
  1. **文件工具 config 声明 auto_allow → audit** ✅ 已验证——SYS-B2b（`/etc/hosts: read_only` read → `event: auto_allow` + `grant_source: config_declaration`）
  2. **可靠 bash auto_allow → 命令级 audit** ✅ 已验证——SYS-B2c（`cat /etc/hosts` → `event: auto_allow`，tool: bash）
  3. **例外保留（in_project_default_allowed 不记录）** ✅ 已验证——既有测试（项目内未配置常规读写无审计记录）保持 GREEN
  4. **可靠 bash hard_deny → authorization: presumed** ✅ 已验证——SYS-B2a（`cat /etc/passwd` unread → `authorization: presumed`）
  - **预期行为模型已验证**（4/4）

- **预期之外的副作用**：无。全量 704/704（一次 AL7 偶发 flaky——已知 HEAD 基线竞态 `al4_af7_flaky_tests_existing`，非本 change 引入；重跑 704/0）。
