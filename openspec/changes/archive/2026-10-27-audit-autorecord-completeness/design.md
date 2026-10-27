# Design: Audit auto-allow record completeness (D1/D2)

## D1: auto_allow 例外判定

audit-log spec Req 1 的唯一例外是"项目内未配置非敏感常规读写"。在 Decision 对象上，这精确对应 `reasonCode === "in_project_default_allowed"`（decision.ts:305——region project_inner + declaration unconfigured + grant_source default）。其余 auto_allow 的 reasonCode 均非此值，应记录。

## D2: 文件工具 auto_allow 记录

handleFileTool 的 auto_allow 分支（index.ts:838）——补：

```ts
if (decision.reasonCode !== "in_project_default_allowed") {
  state.audit.log({
    event: "auto_allow",
    tool: event.toolName,
    path: expandedInput,
    command: null,
    region: decision.region,
    declaration: decision.declaration,
    permission: null,
    toolCallId: event.toolCallId,
    authorization: decision.authorization,   // 透传
    grant_source: decision.grant_source,     // 透传
    note: decision.reason,
  });
}
```

## D3: 可靠 bash auto_allow 记录

handleBash 的可靠 per-target 循环（index.ts:768）——补命令级记录（once per call，避免多 target 重复）：

- 用 `autoAllowLogged` 标志，任一 target 非例外 auto_allow 时记录一次。
- 命令级记录：`path: null` + `command`（与 bash grant 命中先例一致）。
- 例外（`in_project_default_allowed`）不记录。

## D4: bash hard_deny 授权来源

可靠 bash hard_deny（index.ts:749）——补 `authorization: "presumed"`，`grant_source` 省略（hard_deny 非授权事件，与文件工具 hard_deny 一致）。

## 向后兼容

- `authorization` / `grant_source` 是既有可选字段（B2/B5 引入），无 schema 变化。
- 旧日志行无这些字段，消费者按 undefined 回退（audit-log spec "既有日志无字段向后兼容"）。
- 新增 auto_allow 审计只增记录，不改变决策结果（仍 return undefined / continue）。

## Test strategy

- **SYS-B2a**（D4）：可靠 bash unread target hard_deny → authorization: presumed。
- **SYS-B2b**（D2）：config 声明 read_only read → auto_allow audit + grant_source config_declaration。
- **SYS-B2c**（D3）：可靠 bash config 声明 target → 命令级 auto_allow audit。
- 既有 SYS-B1/B2/B4（bash grant bypassed）不回归——已确认 704/704。
