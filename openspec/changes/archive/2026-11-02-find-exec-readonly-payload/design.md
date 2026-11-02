# Design: find-exec-readonly-payload

## Context

现状（`src/lib/bash-extract/readonly.ts:46`）`isFindReadOnly` 用**黑名单**判定：`find` 参数中只要出现 `-delete`/`-exec`/`-execdir`/`-ok`/`-okdir` 任一即判写，不看载荷。实测确认（2026-11-02）：`find . -name '*.ts' -exec cat {} \;` 被判 `{ reliable: false, reason: "find_write_flag" }`——即使载荷 `cat` 是本项目已知只读命令（`READ_ONLY_COMMANDS`）。

调用链：`extractBashTargets` step 0（`entry.ts:27`）→ `scanFindWriteFlags`（`control-flow.ts:9`）→ `isFindReadOnly`。所有调用方都经同一 `isFindReadOnly`，单一事实源，改动一处全链受益。动机见 proposal.md「Why」，不重复。

## Goals / Non-Goals

**Goals:**
- `-exec`/`-execdir` 后的载荷命令名 ∈ `READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS` 时，该 flag 不再判写。
- 保持 `isFindReadOnly` 签名不变（`(tokens: string[]) => boolean`），所有既有 caller 兼容。
- 写载荷（`rm`/`mv`/`chmod`）、未知载荷（`sh`/`bash`/`xargs`/`eval`）、`{}` 直接执行、无命令、`+` 终止交互变体、`-delete`/`-ok`/`-okdir` 全部维持判写（fail-closed）。

**Non-Goals:**
- 不做完整 shell 解析（项目 Non-Goal：`find` 载荷内的 `>` 重定向、管道、命令替换**不**静态分析——这些形态的载荷命令名不在只读集合，整条命令判写）。
- 不改 `-delete`/`-ok`/`-okdir` 判定（始终判写/交互）。
- 不新增载荷命令集合（复用既有 `READ_ONLY_COMMANDS`/`HARMLESS_BUILTINS` 单一事实源）。
- 不新增载荷内路径的提取逻辑——现有 `findExtract = readExtract`（`extractors.ts:266`）对载荷内的**绝对路径**（如 `-exec cat /etc/passwd \;` 的 `/etc/passwd`）仍会提取为 read target 并经敏感/权限管线检查（属既有保守行为，proposal「Impact」已声明「载荷内真实路径仍会被提取并经敏感/权限管线检查」）；本 change 只改 `isFindReadOnly` 的判写逻辑，不改 `findExtract`。

## Decisions

### D1: 载荷命令名 = `-exec`/`-execdir` 之后的第一个 token

tokenize 实测确认（2026-11-02）各形态的切分：

| 命令 | tokens（find 之后） | 载荷命令名 |
|---|---|---|
| `-exec cat {} \;` | `["src/","-name","*.tmp","-exec","cat","{}","\\;"]` | `cat` |
| `-execdir rm {} \;` | `[..., "-execdir","rm","{}","\\;"]` | `rm` |
| `-exec cat {} +` | `[..., "-exec","cat","{}","+"]` | `cat` |
| `-exec sh -c "rm $1" _ {} \;` | `[..., "-exec","sh","-c","rm \\$1","_","{}","\\;"]` | `sh` |
| `-exec {} \;` | `[..., "-exec","{}","\\;"]` | 无（首个是 `{}`） |

载荷命令名就是 `-exec`/`-execdir` 索引 `i` 的下一个 token `tokens[i+1]`。终止符 `\;`/`+` 是独立 token，无需特殊处理——若 `tokens[i+1]` 是终止符则载荷缺失，判写。

**备选方案**：扫描到终止符 `;`/`+` 的整个载荷区间再取首个命令 token。弃——区间扫描需额外处理 `\;` 与 `+` 的 token 形态差异，且本 change 只需要命令名判定，区间扫描不增加安全收益（载荷内后续 token 属于该命令的参数，不属于 find 的路径参数）。

### D2: 只读载荷判定集合 = `READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS`

- `READ_ONLY_COMMANDS`（`readonly.ts:9`）：`cat`/`head`/`tail`/`wc`/`grep`/`ls`/`tree`/`stat`/`du`/`df`/`file`/`less`/`more` + git 只读子命令。
- `HARMLESS_BUILTINS`（`silent.ts:915`）：`echo`/`printf`/`true`/`false`/`pwd`/`cd`/`test`/`[`/`:`/`sleep`/`export`/`set`/`unset`/`type`/`which`/`hash`/`seq`/`basename`/`dirname`。

两个集合都是既有单一事实源，本 change 不新建平行集合。`cat`/`wc`/`grep`/`head`/`tail`/`ls` 等读命令与 `echo`/`basename` 等无害内置在集合内 → 判读；`rm`/`mv`/`cp`/`chmod`/`sh`/`bash`/`awk`/`sed`/`xargs`/`eval`/`tar` 不在集合 → 判写。

**备选方案**：新设 `FIND_EXEC_READONLY_PAYLOADS` 集合。弃——与既有 `READ_ONLY_COMMANDS` 语义重复，产生第二事实源，未来 `READ_ONLY_COMMANDS` 加命令时 find 载荷判定不同步（漂移风险）。复用既有集合保持单一事实源。

### D3: `isFindReadOnly` 签名不变，仅内部改载荷感知

```ts
export function isFindReadOnly(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-delete" || t === "-ok" || t === "-okdir") return false;
    if (t === "-exec" || t === "-execdir") {
      if (!isReadonlyExecPayload(tokens[i + 1])) return false;
    }
  }
  return true;
}
```

`isReadonlyExecPayload(payloadToken)`：payloadToken 为 `undefined`/空/以 `-` 开头/`{}`/`\;`/`+` → false（fail-closed）；否则取 basename（`/bin/cat` → `cat`），判断 ∈ `READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS`。

**语义注解（FIND_WRITE_FLAGS 常量）**：`FIND_WRITE_FLAGS`（`readonly.ts:29`）仍含 `-exec`/`-execdir`，但它不再是无条件写 flag——其语义更新为「`-delete`/`-ok`/`-okdir` 无条件判写；`-exec`/`-execdir` 判写当且仅当载荷判定失败」。常量保留导出以维持既有 13-symbol API 契约（`index.ts:9` 导出面不变），但调用方不能把 `-exec` 当作无条件写 flag。D3 内联 flag 字符串是**有意为之**：`isFindReadOnly` 需要区分「无条件写」（`-delete`/`-ok`/`-okdir`）与「载荷感知写」（`-exec`/`-execdir`）两类语义，`FIND_WRITE_FLAGS` 作为无差别集合无法表达该区分；若改用该集合需额外分支处理，反而弱化单一事实源。实现时新增 `isReadonlyExecPayload` 私有 helper（非导出），不扩大公开符号面。

### D4: 载荷内写重定向仍被外层捕获

`find . -name '*.ts' -exec cat {} \; > /etc/passwd` 这类**载荷外**重定向（`>` 在 find 命令级）由 `extractRedirects`（`parse.ts:444`）在 entry.ts 正常提取阶段捕获为 write target，不受本 change 影响。

**保守边界**：载荷**内**重定向（`-exec sh -c 'echo x > /etc/passwd' {} \;`）——载荷命令名 `sh` 不在只读集合，整条命令判写（fail-closed），不进入提取阶段。载荷是只读命令但嵌重定向的形态（`-exec cat {} > /etc/passwd \;`）——shell 把 `>` 解析为 **find 命令级重定向**（重定向是命令级属性，与 `;` 相对位置无关；`-exec` 的参数区到 `;` 为止，`>` 在参数区内的写法仍按命令级重定向处理），由 `extractRedirects` 捕获为 write target。两种情况均不放行写目标。

## Risks / Trade-offs

- **[风险] 假阴性：集合外"实际只读"命令被误判写**（如 `find . -exec sort {} \;`——`sort` 不在 `READ_ONLY_COMMANDS`）→ 维持 `find_write_flag` 弹窗（fail-closed，用户可手动 allow）。**缓解**：这是保守方向的既有行为，本 change 不扩大；`sort` 等命令加入只读集合属未来独立 change。
- **[风险] 假阳性：集合内命令带写副作用**（如 `find . -exec cat {} \;` 理论上 `cat` 无写，但 `find . -exec wc -l {} \;` 亦无写）→ `READ_ONLY_COMMANDS` 内命令全部是无写副作用的读命令（`cat`/`head`/`tail`/`wc`/`grep`/`ls`/`tree`/`stat`/`du`/`df`/`file`/`less`/`more`），`HARMLESS_BUILTINS` 是无文件写副作用的内置。**缓解**：集合语义本身已保证；`> /etc/passwd` 形式经 D4 被 `extractRedirects` 捕获。
- **[风险] 载荷命令名带路径前缀**（`find . -exec /bin/cat {} \;`）→ 取 basename 判定，`/bin/cat` → `cat` ∈ 集合 → 判读。**缓解**：D3 的 basename 处理。
- **[风险] `-exec` 后跟 flag 的畸形命令**（`find . -exec -name {} \;`，不合法）→ payloadToken 以 `-` 开头 → fail-closed 判写。**缓解**：D3 的 flag 前缀检查。

## Migration Plan

无迁移——纯判定行为调整，无持久化数据、无配置格式、无 API 形状变化。旧配置与 grant 全部兼容（`find -exec cat` 从弹窗变为静默放行，属放宽方向；`trusted.json` 无变化）。

## Open Questions

无。
