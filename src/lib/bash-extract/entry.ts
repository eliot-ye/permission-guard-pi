// Bash extraction: main entry point (extractBashTargets).
// Orchestrates: find-write → scan → control-flow → shell-forwarder → per-stage extract.
// Pure module — no IO / no side effects.

import { expandSafeVariables, extractRedirects, findUnresolvedVariable, splitCommands, splitPipelines, tokenize } from "./parse.ts";
import type { ExtractAction, ExtractResult } from "./parse.ts";
import { scanControlFlow, scanFindWriteFlags } from "./control-flow.ts";
import { scanUnreliable } from "./scan.ts";
import { FORWARDING_COMMANDS, isForwarderStageSafe, isShellForwarder, scanCdChdir, shouldTrackCdCwd } from "./shell-forwarder.ts";
import { toAbsolutePath } from "../path-utils.ts";
import { GIT_BLOB_OK_SUBCOMMANDS, NPM_RUN_OK_SCRIPTS, SILENT_ALLOW_ALL, SILENT_COMMANDS, isAnyUnreliableCommand, isSilentCommand, isSilentGo, isSilentNpx, isSilentTsc, looksLikeGitBlobToken, looksLikeRepoRelativePath } from "./silent.ts";
import { COMMAND_TABLE } from "./extractors.ts";

export function extractBashTargets(rawCommand: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): ExtractResult {
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
    return { reliable: false, rawCommand, reason: "shell_forwarder" };
  }

  // 4. Unreliable-command guard (bash-stage-b-security-fixes D2): commands
  // like sed/python3/node/scp/ssh that can execute arbitrary code or read
  // arbitrary files are unconditionally unreliable. Runs AFTER shell_forwarder
  // so `bash -c 'sed -i …'` correctly reports shell_forwarder (the outer
  // shell, not the inner interpreter, is what we can't parse).
  if (isAnyUnreliableCommand(rawCommand)) {
    // Change C: `npx --no-install <pkg>` is a static-safe form — even
    // though `npx` is in UNRELIABLE_COMMANDS, this specific form has
    // no network access (npm CLI's `--no-install` guarantees local-
    // package-only execution). Skip the UNRELIABLE_COMMANDS rejection
    // for npx iff isSilentNpx passes.
    if (!(SILENT_COMMANDS["npx"] && isSilentNpx(tokenize(rawCommand).slice(1)))) {
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

      // Redirects.
      extractRedirects(trimmed, targets, resolveBase);

      // Command-specific extractor or SILENT_COMMANDS.
      const tokens = tokenize(trimmed);
      if (tokens.length === 0) continue;
      const cmdName = tokens[0].split("/").pop()!;
      // COMMAND_TABLE takes precedence over SILENT_COMMANDS.
      const extractor = COMMAND_TABLE[cmdName];
      if (extractor) {
        extractor(tokens, targets, resolveBase);
      } else if (isSilentCommand(cmdName, tokens.slice(1))) {
        // Silent: 0 target, no unreliable flag.
      }
      // Otherwise: unknown command, 0 target (D6).
    }
  }

  return { reliable: true, targets };
}
