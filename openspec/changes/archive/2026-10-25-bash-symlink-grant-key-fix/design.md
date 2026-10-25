## Context

见 `proposal.md` - Why。当前实现的 grant 查询与写入端键不自洽：

- **bash 写入端**（`handleBash:657` → `handlePromptDecision`）：prompt 时传 `absPath=resolvedPath`（realpath）存持久 grant——符合 grant-memory spec "记忆键结构" 的 `absPath = realpath 解符号链接` 契约。
- **bash 查询端**（`decideTarget:770` 第一次调用）：用 `target.path`（命令字面路径）查 `hasGrant`——偏离 spec，键不匹配 → 持久 grant 永不命中。
- **文件工具写入端**（`handleFileTool:681` → `handlePromptDecision`）：prompt 时传 `absPath=expandedInput`（`expandHome` 结果，**非 realpath**）——也偏离 spec，但查询端用同一 `expandedInput`，自洽，无 bug。
- **文件工具查询端**：`decideTarget:770`，`absPath=expandedInput`，命中写入端同键。

即：bash 链路"写入用 realpath、查询用字面"不自洽（bug），文件工具链路"写入查询都用字面"自洽（无 bug，但偏离 spec）。两条链路的写入端键形态不同（realpath vs 字面），单键查询必漏一边。

约束：`canonicalPath`（`tryRealpath` 结果）在 `decideTarget:751` 已算出且用于 `isInside`，无新 IO。

## Goals / Non-Goals

**Goals:**
- 让 bash 可靠提取 + 符号链接目标 + 持久 grant 场景下，第二次同命令 auto_allow（免弹）。
- 最小改动：只动 `decideTarget` grant 查询一处，不碰写入端、不改公共契约、不引入 grant 迁移。
- bash 与文件工具两条链路的 grant 查询语义对齐到"双键兜底"。

**Non-Goals:**
- 不统一写入端键形态（不把文件工具写入端从 `expandedInput` 改成 realpath——那会改 audit `path` 字段可读性、使旧 grant 失效、触发迁移，超出本 bug 修复范围）。
- 不改 grant-memory spec（spec 已要求 realpath，实现追上）。
- 不处理 bash 不可靠命令的 grant（那是 `bashKey(projectHash, rawCommand)` 维度，与 path-based grant 无关）。
- 不改 V2（bash 转发器 grant 绕过 unread）——那是已知限制 #3，独立于本 change。

## Decisions

### Decision 1：grant 查询查双键 `absPath || canonicalPath`，而非单键 `canonicalPath`

**选择**：`hasGrant(state, action, absPath) || hasGrant(state, action, canonicalPath)`。

**理由**：写入端两条链路键形态不同——bash 用 `resolvedPath`（realpath，命中 `canonicalPath`），文件工具用 `expandedInput`（字面，命中 `absPath`，其 `canonicalPath` 是 realpath **不**命中写入键）。单查 `canonicalPath` 会漏文件工具的 grant（`expandedInput ≠ canonicalPath` 时 miss），单查 `absPath` 漏 bash 的 grant（V3 本身）。双键兜底是覆盖两端的最小修复。

**替代方案 A（只查 `canonicalPath`）**：更符合 spec 字面（spec 要求 absPath=realpath），但会破坏文件工具链路——文件工具 grant 存的是 `expandedInput`（字面），`canonicalPath`（realpath）查不到，引入新 bug。否决。

**替代方案 B（统一写入端都用 realpath）**：在 `handlePromptDecision` 对文件工具也传 realpath 存 grant。问题：(1) audit `path` 字段当前记 `expandedInput`（用户可读），改 realpath 后 `~/.ssh/id_rsa` 可能显示成 `/Users/x/.ssh/id_rsa`，可读性下降；(2) 既有 trusted.json 的文件工具 grant 键（字面路径）会失效，需迁移；(3) 改动面跨 `handleFileTool` + `handlePromptDecision` + audit，超出 bug 修复范围。否决。

**替代方案 C（在 `handleBash` 内加 grant 预查询）**：在 `handleBash:627` 循环前先查 `hasGrant(target.path) || hasGrant(resolvedPath)`。问题：grant 查询逻辑从 `decideTarget` 内聚位置外移到 `handleBash`，重复 `decideTarget` 已有的 grant 查询 + unread 检查 + decide() 调用链，破坏"`decideTarget` 统一封装 grant 查询 + decision"的既有架构风格。否决。

### Decision 2：在 `decideTarget` 内改，而非 `handleBash` 内改

**选择**：改 `decideTarget:770-787` 的 grant 查询段。

**理由**：`decideTarget` 是 grant 查询 + unread hard-deny + `decide()` 调用的统一封装点（见 L756-799 结构：先 unread、再 grant、再 decide）。bash 与文件工具都经此点。改此处一处，两条链路同时受益/不受影响，符合既有"`decideTarget` 统一封装"架构风格。

### Decision 3：双键查询的 severity 取 max 保持不变

`decideTarget` 的 grant 命中返回 `auto_allow`（severity 1）。bash dual-call（`handleBash:632` target.path + `:634` resolvedPath）取 `severity(altDecision) > severity(decision)` 更严。修复后第一次调用（target.path）若 `hasGrant(canonicalPath)` 命中 → 返回 auto_allow(1)；altDecision（resolvedPath）也命中 → auto_allow(1)；severity 相等，走第一次。无 severity 逻辑变更，只是 grant 命中从 miss→hit。

## Risks / Trade-offs

- **[写入端键形态不统一的技术债] → 显式记录，不本 change 处理**：文件工具写入端用 `expandedInput`（非 realpath）偏离 grant-memory spec，但因查询端自洽而无 bug。本 change 用双键查询兜底覆盖它，但不修写入端。技术债记入 design 供未来 change 评估（若统一写入端需迁移既有 grant）。
- **[canonicalPath 与写入端 realpath 语义一致性] → 已验证一致**：`decideTarget` 内 `canonicalPath = tryRealpath(toAbsolutePath(absPath))`；`handleBash` 内 `resolvedPath = tryRealpath(target.path)`。`decideTarget` 的 `absPath` 参数 = `handleBash:632` 传入的 `target.path`，`toAbsolutePath` 对绝对路径是恒等，故 `canonicalPath === resolvedPath`。双键查询的 `canonicalPath` 键与 bash 写入端 `resolvedPath` 键同源同函数，命中一致。
- **[grant 查询多一次 Set.has 的性能] → 无感**：`hasGrant` 是 `Set.has`（session）或 `Array.some`（persistent），O(1)/O(n)。persistent grants 数量典型 < 100，多一次扫描无感。且 `canonicalPath` 已在 L751 算出，无新 IO。
- **[查询键比写入键"更宽"导致越权] → 不会**：双键查询是"输入路径或其 realpath 任一命中即放行"。realpath 是输入路径的符号链接解析结果，是**同一逻辑文件**的另一种路径形态，不是"更宽"的路径集合。grant 仍按文件粒度（`<projectHash>|<action>|<path>`），不抬开目录或跨文件。

## Migration Plan

无迁移。本 change 是实现层 bug 修复，不动 trusted.json 格式、不动 grant 键结构、不动 spec。既有 trusted.json 的 bash 持久 grant（存 `resolvedPath`）在修复后自动被 `canonicalPath` 键命中，无需重写。

回滚：还原 `decideTarget:770` 单键查询一行即可，无副作用。
