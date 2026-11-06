// Bash extraction: main entry point (extractBashTargets).
// Orchestrates: find-write → scan → control-flow → shell-forwarder → per-stage extract.
// Pure module — no IO / no side effects.

import { expandSafeVariables, extractRedirects, findUnresolvedVariable, splitCommands, splitPipelines, tokenize } from "./parse.ts";
import type { ExtractAction, ExtractResult } from "./parse.ts";
import { scanControlFlow, scanFindWriteFlags } from "./control-flow.ts";
import { scanUnreliable } from "./scan.ts";
import { FORWARDING_COMMANDS, isForwarderStageSafe, isShellForwarder, scanCdChdir, shouldTrackCdCwd, extractShellCArg, isPureLiteralShellArg } from "./shell-forwarder.ts";
import { toAbsolutePath } from "../path-utils.ts";
import { GIT_BLOB_OK_SUBCOMMANDS, NPM_RUN_OK_SCRIPTS, SILENT_ALLOW_ALL, SILENT_COMMANDS, isAnyUnreliableCommand, isSedReadonlyForm, isSilentCommand, isSilentGo, isSilentNpx, isSilentTsc, looksLikeGitBlobToken, looksLikeRepoRelativePath } from "./silent.ts";
import { COMMAND_TABLE, canExtractBareDir, readExtract, readExtractWithBareDir } from "./extractors.ts";

/**
 * bash-c-literal-extract: 尝试对 shell 转发器 `-c` 字符串参数做**纯字面量递归提取**。
 *
 * 安全性质（核心）：精确化后权限判定 **≤ 直接执行该命令**——
 * - 有目标时走与直接执行完全相同的路径决策；
 * - 0 目标 / 内层不可靠 → 返回 undefined（调用方回退 `shell_forwarder` 弹窗，更严）。
 *
 * 深度上限：允许最深 **1 层** `-c` 递归（顶层命令 depth 0 → `-c` 内层 depth 1）。
 * 内层命令若本身仍是 `bash -c ...`，递归进来时 depth ≥ 1 → 直接返回 undefined
 * （回退弹窗），防 `bash -c "bash -c ..."` 无限嵌套。
 *
 * **外层形态限制（防丢目标安全洞）**：仅当外层命令是**单 fragment 单 pipeline
 * stage** 时才递归。复合（`bash -c "..." && rm y`）或管道（`bash -c "..." | head`）
 * 外层形态下，只提取 `-c` 内层目标会**丢掉外层其余 stage 的目标**（如 `rm y` 的
 * 写目标）→ 安全洞。故对非单 stage 外层形态保守回退 `shell_forwarder`（与现状
 * 一致），不精确化。内层命令本身可含复合/管道（递归时由 `extractBashTargets`
 * 的 splitCommands/splitPipelines 正常处理，目标不丢）。
 *
 * 返回 undefined 表示"不可纯字面量精确化"（调用方回退 `shell_forwarder`）。
 */
function tryExtractLiteralShellC(
  rawCommand: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  depth: number,
): ExtractResult | undefined {
  // 深度上限：内层命令（depth ≥ 1）本身是 `-c` 时不再递归
  if (depth >= 1) return undefined;
  // 外层形态限制：单 fragment 单 stage 才递归（防丢外层其余 stage 目标）
  const fragments = splitCommands(rawCommand);
  if (fragments.length !== 1) return undefined;
  const stages = splitPipelines(fragments[0]);
  if (stages.length !== 1) return undefined;
  const tokens = tokenize(stages[0].trim());
  const cArg = extractShellCArg(tokens);
  if (cArg === undefined) return undefined; // 非 `-c` 形态（脚本路径 / source / stdin 重定向）
  if (!isPureLiteralShellArg(cArg)) return undefined; // 非纯字面量（含 $ / 反引号 / 控制流 / glob / brace / 换行）
  // 递归解析内层字符串（depth+1；内层提取会重跑全套守卫做纵深防御）
  const innerResult = extractBashTargets(cArg, projectRoot, env, depth + 1);
  if (!innerResult.reliable) return undefined; // 内层不可靠 → 回退弹窗
  if (innerResult.targets.length === 0) return undefined; // 0 目标 → 回退弹窗（不更宽松）
  // bash-extract-fail-closed-hardening D3: merge OUTER redirect targets. The
  // inner extraction only sees the `-c` string; an outer redirect such as
  // `bash -c "cat /tmp/input.txt" > /outside/output` was previously dropped
  // (innerResult.targets returned as-is), leaking the outer write.
  // IMPORTANT: only extract redirects OUTSIDE the `-c` argument. The `-c`
  // string is a single token (`tokenize` keeps `cat /a > /b` whole), so any
  // `>`/`>>` BEFORE or INSIDE it belongs to the inner command, NOT the outer.
  // Running extractRedirects on the whole outer command would mis-capture the
  // inner redirect (e.g. `bash -c "cat /a > /b"` would falsely extract `/b` as
  // an outer write). Restrict to tokens AFTER the `-c` argument.
  const cArgIndex = tokens.indexOf(cArg);
  const outerTail = cArgIndex >= 0 ? tokens.slice(cArgIndex + 1).join(" ") : "";
  const mergedTargets = [...innerResult.targets];
  const outerRedirects: Array<{ action: ExtractAction; path: string }> = [];
  if (outerTail && extractRedirects(outerTail, outerRedirects, projectRoot)) {
    return undefined; // outer redirect unresolvable → fail-closed (fall back to prompt)
  }
  for (const t of outerRedirects) {
    if (!mergedTargets.some((m) => m.action === t.action && m.path === t.path)) {
      mergedTargets.push(t);
    }
  }
  return { reliable: true, targets: mergedTargets };
}

export function extractBashTargets(
  rawCommand: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  // bash-c-literal-extract: 递归深度计数。公共调用方默认 depth=0（顶层命令）；
  // 纯字面量 `-c` 递归时 depth=1（内层命令）。加宽兼容——不影响既有三参数调用。
  depth: number = 0,
): ExtractResult {
  // 0. `find` write flag guard: `find -delete` / `-exec` / `-execdir` /
  // `-ok` / `-okdir` at the leading position of any command fragment is a
  // write operation. Runs FIRST so its reason takes precedence over
  // `glob_expansion` when both are triggered (e.g. `find src/*.ts -delete`).
  // Runs before `scanControlFlow` so isolated `find` in a compound command
  // is caught even if the compound command doesn't itself contain a
  // control-flow keyword. (For-loop bodies are still handled by
  // `scanControlFlow` first, but a literal-iteration `for f in a b; do
  // find "$f" -delete; done` where the body is `find -delete` reaches this
  // guard — but note `scanControlFlow` runs after scanUnreliable so the
  // ordering between the two is: find_write_flag → scanUnreliable →
  // scanControlFlow → shell_forwarder.)
  if (scanFindWriteFlags(rawCommand)) {
    return { reliable: false, rawCommand, reason: "find_write_flag" };
  }

  // 1. Quote-aware scan for constructs that MUST be unreliable. Pass
  // projectRoot so the scanner can apply the bounded-glob allowlist (D6a).
  const reason = scanUnreliable(rawCommand, projectRoot);
  if (reason) {
    return { reliable: false, rawCommand, reason };
  }

  // 2. Control-flow keyword guard: keywords like while/for/if/case make the
  // command's flow non-statically-determinable. Runs BEFORE pipeline splitting
  // AND before variable checks — a control-flow command makes static analysis
  // of variables/filenames moot.
  const cfResult = scanControlFlow(rawCommand, projectRoot);
  if (cfResult.hit) {
    return { reliable: false, rawCommand, reason: "control_flow" };
  }

  // 2b. `cd` chdir guard (bash-hardening-round-2 L3): any compound command
  // whose fragment starts with `cd` cannot have its relative-path targets
  // resolved statically, because `cd` changes the cwd baseline for all
  // downstream fragments. Runs BEFORE `isShellForwarder` so a `cd` command
  // that also contains `bash -c` reports `cd_chdir` (the more specific
  // reason) rather than `shell_forwarder`. A lone `cd /etc` is exempt.
  if (scanCdChdir(rawCommand) === "cd_chdir") {
    return { reliable: false, rawCommand, reason: "cd_chdir" };
  }

  // 3. Shell-forwarder guard: `bash -c "..."` etc. run a command from a string
  // argument, which our tokenizer cannot see through. Runs BEFORE pipeline
  // splitting so `bash -c "cmd" | head` still triggers.
  if (isShellForwarder(rawCommand)) {
    // bash-c-literal-extract: pure-literal `-c` string args are recursively
    // extracted instead of blanket-unreliable. This tightens the decision (no
    // persistable "always allow" grant on the raw command → closes the
    // sensitive-hard-line bypass) while never loosening it (0-target / inner
    // unreliable → fall back to shell_forwarder below).
    const literal = tryExtractLiteralShellC(rawCommand, projectRoot, env, depth);
    if (literal) return literal;
    return { reliable: false, rawCommand, reason: "shell_forwarder" };
  }

  // 4. Unreliable-command guard (bash-stage-b-security-fixes D2): commands
  // like sed/python3/node/scp/ssh that can execute arbitrary code or read
  // arbitrary files are unconditionally unreliable. Runs AFTER shell_forwarder
  // so `bash -c 'sed -i …'` correctly reports shell_forwarder (the outer
  // shell, not the inner interpreter, is what we can't parse).
  if (isAnyUnreliableCommand(rawCommand)) {
    // bash-sed-readonly-exempt: sed 只读窄形态豁免。sed 在 UNRELIABLE_COMMANDS
    // 命令名精确匹配即判 unreliable，但确定只读的窄形态（无 -i/-f、脚本无
    // r/R/w/W/e/E 命令字符、无写重定向）访问目标静态可确定，不该走兜底弹窗。
    // isSedReadonlyForm 内部逐 fragment 判定，返回 true 当且仅当所有 sed
    // 片段都满足只读判据——此时跳过 4a 的 unreliable 拒绝，落到正常提取流程。
    // 写/执行/读任意文件形态（-i/-i.bak/多-e r/-f/s///e/s///w/r /etc/shadow）
    // 判据不满足，保持 unreliable_command。
    if (isSedReadonlyForm(rawCommand)) {
      // 全部 sed 片段豁免成立 → 跳过 4a 拒绝，落到步骤 4b 与逐 stage 提取。
    } else if (!(SILENT_COMMANDS["npx"] && isSilentNpx(tokenize(rawCommand).slice(1)))) {
      return { reliable: false, rawCommand, reason: "unreliable_command" };
    }
    // npx --no-install silent form — proceed to 4b (which will also
    // short-circuit via isSilentNpx and skip the generic loop).
  } else {
    // Non-UNRELIABLE command — proceed normally.
    void 0;
  }

  // Change C: for the `npx --no-install` special form that skipped
  // 4a above, return silently immediately (bypassing 4b's generic
  // check which would otherwise reject any positional). This keeps
  // the 4a/4b interaction simple — 4b's own `npx` short-circuit
  // (isSilentNpx) still runs for other npx forms reached via the
  // isAnyUnreliableCommand=false path, but that path can only be
  // reached if npx is NOT in UNRELIABLE_COMMANDS, which is not the
  // current state. So the practical flow is:
  //   npx <silent-safe form> → 4a bypass → return silently here
  //   npx <other form>       → 4a rejects → UNRELIABLE_COMMAND
  if (isAnyUnreliableCommand(rawCommand) && SILENT_COMMANDS["npx"] && isSilentNpx(tokenize(rawCommand).slice(1))) {
    return { reliable: true, targets: [] };
  }

  // 4b. Silent-command form-check (bash-stage-b-security-fixes D1): if the
  // leading command of a SIMPLE single-command invocation is a SILENT_COMMANDS
  // key but does NOT match the narrowed form (e.g. `git log /etc/passwd`
  // where `log` is allowed but a path follows; `npm run build` where `run`
  // isn't in npm's allow-set), it is not silent. Instead of falling through
  // to fail-open (0-target reliable), flag it as unreliable_command — the
  // command is a dev-tool but invoked in a form that CAN read/write
  // outside the worktree, so the user should see a prompt rather than a
  // silent pass.
  //
  // Only applies to "simple" commands: no compound separators (`&&`, `||`,
  // `;`, `&`, `\n`) and no pipeline (`|`). We use `splitCommands` and
  // `splitPipelines` — the same quote-aware splitting used elsewhere —
  // instead of a naive character scan. This means compound commands like
  // `git status && rm -rf /etc/passwd` are delegated to the per-fragment
  // loop below, not misclassified by 4b's silent-form rule.
  //
  // For `git`, the post-subcommand phase is more permissive than the base
  // `isSilentCommand` rule: git accepts revision references (`HEAD`, `main`,
  // `HEAD~1`) and revision-like bare words after `log`/`diff`/`show`/etc.,
  // and those must not trip the "extra positional" check. We still reject
  // path-like tokens (`/etc/passwd`, `~/x`, `./x`, `../x`, `x.txt`).
  {
    // Fast bail: only simple single-command invocations (one fragment, one stage)
    // enter the silent-form check. Everything else is delegated to the
    // per-fragment pipeline below.
    const cmdFragments = splitCommands(rawCommand);
    if (cmdFragments.length === 1 && splitPipelines(cmdFragments[0]).length === 1) {
      const tks = tokenize(rawCommand);
      if (tks.length > 0) {
        const cmdName = tks[0].split("/").pop()!;
        if (SILENT_COMMANDS[cmdName]) {
          // Change C: `tsc` / `go` / `npx` short-circuit to their
          // dedicated silent-form evaluators to guarantee 4b and
          // isSilentCommand agree. If they return false, this command
          // is UNRELIABLE (the generic loop below would otherwise let
          // e.g. `tsc --outDir /tmp/x`, `go vet ./...`, or
          // `npx --no-install eslint src/**` pass through for various
          // reasons). If they return true, skip the generic loop
          // entirely.
          let skippedGeneric = false;
          if (cmdName === "tsc") {
            if (!isSilentTsc(tks.slice(1))) {
              return { reliable: false, rawCommand, reason: "unreliable_command" };
            }
            skippedGeneric = true;
          } else if (cmdName === "go") {
            if (!isSilentGo(tks.slice(1))) {
              return { reliable: false, rawCommand, reason: "unreliable_command" };
            }
            skippedGeneric = true;
          } else if (cmdName === "npx") {
            if (!isSilentNpx(tks.slice(1))) {
              return { reliable: false, rawCommand, reason: "unreliable_command" };
            }
            skippedGeneric = true;
          }
          if (skippedGeneric) {
            // Command is silent per its dedicated evaluator. Fall
            // through to step 5+ without running the generic loop.
          } else {
          const isAllowAll = SILENT_ALLOW_ALL.has(cmdName);
          const isStrict = !isAllowAll && cmdName !== "git";
          let sawSub: boolean | "__run_form__" | "__run_form_scripted__" = false;
          let seenGitSub: string | null = null;
          let skipNext = false;
          let ok = true;
          for (let i = 1; i < tks.length; i++) {
            const t = tks[i];
            if (skipNext) { skipNext = false; continue; }
            if (t === "--") continue;
            if (t.startsWith("--")) {
              // Long flag. Only consumes a next token if the form is `--flag value`
              // (no `=`) AND the next token is not another flag or `=` assignment.
              if (!t.includes("=")) {
                const next = tks[i + 1];
                if (
                  next !== undefined &&
                  !next.startsWith("-") &&
                  next !== "--" &&
                  !/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)
                ) {
                  skipNext = true;
                }
              }
              continue;
            }
            if (t.startsWith("-")) {
              // Short flag (single dash). May be a value-taking flag
              // (e.g. `-n 10`) or a value-less flag (`-v`).
              if (!t.includes("=")) {
                const next = tks[i + 1];
                if (next !== undefined && !next.startsWith("-") && next !== "--" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) {
                  skipNext = true;
                }
              }
              continue;
            }
            if (!sawSub) {
              // Change B: allow `npm/yarn/pnpm run <script>` form here so
              // that the "second positional" (the script name) can be
              // checked against NPM_RUN_OK_SCRIPTS in the branch below.
              if ((cmdName === "npm" || cmdName === "yarn" || cmdName === "pnpm") && t === "run") {
                sawSub = "__run_form__";
                continue;
              }
              if (isAllowAll) { sawSub = true; continue; }
              if (!SILENT_COMMANDS[cmdName].has(t)) { ok = false; break; }
              if (cmdName === "git") { seenGitSub = t; }
              sawSub = true;
            } else if (sawSub === "__run_form__") {
              // Change B: expect a whitelisted script name after `run`.
              if (NPM_RUN_OK_SCRIPTS.has(t)) {
                sawSub = "__run_form_scripted__";
              } else {
                ok = false;
                break;
              }
            } else {
              // Extra positional after subcommand.
              if (isAllowAll) continue; // allow-all accepts any positional
              if (isStrict) { ok = false; break; }
              // git permissive mode. Under Change B, we allow any positional
              // that matches either the git blob syntax or a repo-relative
              // path. The strict "reject path-like token" rule from
              // pre-Change B is superseded by the more precise rules below.
              // Gated on GIT_BLOB_OK_SUBCOMMANDS so write subcommands
              // (branch/tag/config/ls-files/remote) do NOT get the permissive
              // path — they fall through to strict rejection. This mirrors
              // the same gate in isSilentCommand to keep the two paths in sync.
              if (
                cmdName === "git" &&
                seenGitSub !== null &&
                GIT_BLOB_OK_SUBCOMMANDS.has(seenGitSub)
              ) {
                if (looksLikeGitBlobToken(t) || looksLikeRepoRelativePath(t)) continue;
              }
              ok = false;
              break;
            }
          }
          // Change B: `npm run` without a whitelisted script name is not silent.
          if (sawSub === "__run_form__") { ok = false; }
          if (!ok) {
            return { reliable: false, rawCommand, reason: "unreliable_command" };
          }
          }  // end else (skip generic loop for tsc/go short-circuit)
        }
      }
    }
  }

  // 5. Check for unresolved user variables.
  const unresolved = findUnresolvedVariable(rawCommand, cfResult.loopVars);
  if (unresolved) {
    return { reliable: false, rawCommand, reason: `unresolved variable: ${unresolved}` };
  }

  // 3. Expand safe variables.
  const expanded = expandSafeVariables(rawCommand, env);

  // 4. Split compound commands by ; / && / ||.
  const commands = splitCommands(expanded);

  // 5. For each command fragment, split into pipeline stages and process each.
  const targets: Array<{ action: ExtractAction; path: string }> = [];
  // cd 跟踪豁免（D2c）：当命令为纯 `&&` 链 + 绝对 cd 目标时，维护模拟 cwd，
  // 初始为 projectRoot，每遇到一个 cd 片段（目标绝对）则更新 resolveBase 为
  // 该 cd 目标，后续片段的相对路径按 resolveBase 解析（真实算出 cd 后的落点）。
  // 仅 D2a 成立时跟踪；D2b（全绝对下游）路径与 cwd 无关，无需模拟。
  const trackCd = shouldTrackCdCwd(rawCommand);
  let resolveBase = projectRoot;
  for (const cmd of commands) {
    const stages = splitPipelines(cmd);

    // Check for forwarder in ANY stage (including first stage) BEFORE
    // extraction (D2, D8). Starting at i=0 covers the first stage —
    // a first-stage `xargs rm -rf` is a write operation that the
    // non-first-stage loop would have missed. Each forwarder stage is
    // checked via isForwarderStageSafe, which validates both the current
    // stage's downstream (read-only + statically determinable) and all
    // upstream stages (read-only, or recursively exempt forwarder).
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i].trim();
      const stageTokens = tokenize(stage);
      if (stageTokens.length > 0) {
        const stageCmdName = stageTokens[0].split("/").pop()!;
        if (FORWARDING_COMMANDS.has(stageCmdName)) {
          if (!isForwarderStageSafe(i, stages)) {
            return { reliable: false, rawCommand, reason: "forwarding_command" };
          }
          // Exempt: current stage's downstream and all upstreams are safe.
          // Fall through to normal stage extraction.
        }
      }
    }

    // cd 跟踪：本片段是 cd 片段（首 token basename 为 cd 且目标绝对）时，
    // 更新 resolveBase 为该 cd 目标。cd 片段自身是 cwd 变更者，不参与路径
    // 解析，故其 target 提取不影响结果（cd 是内建，无文件访问）。
    if (trackCd) {
      const trimmed = cmd.trim();
      const tks = tokenize(trimmed);
      if (tks.length > 0) {
        const firstBase = tks[0].split("/").pop()!;
        if (firstBase === "cd" && tks.length > 1 && tks[1]) {
          const target = tks[1];
          // 仅当 cd 目标为显式绝对路径时更新（D2a 条件 2 已保证，这里
          // 复核以防 analyzeCd 与 trackCd 分离）。
          if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) {
            resolveBase = toAbsolutePath(target, projectRoot);
          }
        }
      }
    }

    // Extract targets from each stage.
    for (const stage of stages) {
      const trimmed = stage.trim();
      if (!trimmed) continue;

      // Redirects. bash-extract-fail-closed-hardening D2: `extractRedirects`
      // returns true when it saw an unterminated-quote redirect target that
      // cannot be statically resolved (e.g. `> "/outside/output`). Fail
      // closed — the target might be an outside write, so degrade to
      // unreliable instead of silently dropping the target.
      if (extractRedirects(trimmed, targets, resolveBase)) {
        return { reliable: false, rawCommand, reason: "unterminated_redirect_quote" };
      }

      // Command-specific extractor or SILENT_COMMANDS.
      const tokens = tokenize(trimmed);
      if (tokens.length === 0) continue;
      const cmdName = tokens[0].split("/").pop()!;
      // COMMAND_TABLE takes precedence over SILENT_COMMANDS.
      const extractor = COMMAND_TABLE[cmdName];
      if (extractor) {
        // bareDirOk：cd 跟踪豁免（D2a，trackCd=true）且命令可提取裸词目录
        // （canExtractBareDir）时，传 bareDirOk=true——readExtract 把裸词目录
        // 经 resolveBase 解析为 read target（否则 0-target 静默放行洞）。
        // 按 D4 身份分派：bareDirOk 是 readExtract 函数签名层面的可选参（非
        // Extractor 类型扩展），仅当 extractor === readExtract 时传（readExtract
        // 是唯一需要 bareDirOk 的 extractor，身份分派是刻意权衡）。
        if (trackCd && canExtractBareDir(cmdName) && extractor === readExtract) {
          readExtractWithBareDir(tokens, targets, resolveBase, true);
        } else {
          extractor(tokens, targets, resolveBase);
        }
      } else if (isSilentCommand(cmdName, tokens.slice(1))) {
        // Silent: 0 target, no unreliable flag.
      }
      // Otherwise: unknown command, 0 target (D6).
    }
  }

  return { reliable: true, targets };
}
