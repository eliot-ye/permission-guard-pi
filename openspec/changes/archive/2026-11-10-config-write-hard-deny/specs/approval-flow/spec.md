# approval-flow Specification

## REMOVED Requirements

### Requirement: 配置写弹窗副文本分派

**Reason**：config-write-hard-deny change 把 `permission.json` 写/delete 从 `prompt tier=two` 升级为 `deny_hard`——deny_hard 不弹窗，配置写副文本（"权限配置写操作不可持久化，如需长期允许请直接编辑 permission.json"）失效。

**Migration**：配置写现走 deny_hard 路径（`{ block: true }` + 红色警告通知，非弹窗）。原副文本码 `subtitle_config_write_not_persistable` 随本 change 移除（`reason-codes.ts` + `i18n.ts`）。用户若需修改权限配置，直接手工编辑 `permission.json`（agent 经工具调用写配置一律被硬拒，见 access-decision「配置写保护」）。
