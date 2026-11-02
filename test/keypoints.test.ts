//
// TDD RED: bash grant keypoints (bash-grant-keypoints change).
// Covers the keypoint derivation safety-equivalence rules:
//   - Safe-equivalence (same access set + same action) → same keypoints
//   - Non-equivalence (different access set/action) → different keypoints
//   - find internal-match flag values vs shell-glob positionals
//   - cd landing tracking & $VAR downgrade, ~ / relative normal resolution
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { bashCommandKeypoints } from "../src/lib/bash-extract/keypoints.ts";

const ROOT = "/Users/eliot/my/permission-guard-pi";

// -------- K1: safe-equivalence → same keypoints (免弹) --------

test("K1: 纯读 flag 值变化命中同一关键点 (head -50 vs -60)", () => {
  const a = bashCommandKeypoints(`cd ${ROOT} && find openspec -type f | head -50`, ROOT);
  const b = bashCommandKeypoints(`cd ${ROOT} && find openspec -type f | head -60`, ROOT);
  assert.equal(a, b);
});

test("K1b: -type f vs -type d 命中同一关键点", () => {
  const a = bashCommandKeypoints(`cd ${ROOT} && find openspec -type f`, ROOT);
  const b = bashCommandKeypoints(`cd ${ROOT} && find openspec -type d`, ROOT);
  assert.equal(a, b);
});

test("K1c: -type f vs -name '*.ts' 命中同一关键点", () => {
  const a = bashCommandKeypoints(`cd ${ROOT} && find openspec -type f`, ROOT);
  const b = bashCommandKeypoints(`cd ${ROOT} && find openspec -name '*.ts'`, ROOT);
  assert.equal(a, b);
});

test("K1d: 增删 fd 重定向命中同一关键点", () => {
  const a = bashCommandKeypoints(`cd ${ROOT} && cat openspec/.td-state/profile-tier.yaml 2>/dev/null`, ROOT);
  const b = bashCommandKeypoints(`cd ${ROOT} && cat openspec/.td-state/profile-tier.yaml`, ROOT);
  assert.equal(a, b);
});

test("K1e: echo 文本变化写同文件命中同一关键点", () => {
  const a = bashCommandKeypoints(`cd /tmp && echo hello > /tmp/x`, ROOT);
  const b = bashCommandKeypoints(`cd /tmp && echo world > /tmp/x`, ROOT);
  assert.equal(a, b);
});

// -------- K2: non-equivalence → different keypoints (保守弹窗) --------

test("K2: 不同路径不命中同一关键点 (find src vs test)", () => {
  const a = bashCommandKeypoints(`cd ${ROOT} && find src -type f`, ROOT);
  const b = bashCommandKeypoints(`cd ${ROOT} && find test -type f`, ROOT);
  assert.notEqual(a, b);
});

test("K2b: cd 落点不同不命中 (cd /a vs /b, ls 无参数)", () => {
  const a = bashCommandKeypoints(`cd /a && ls`, ROOT);
  const b = bashCommandKeypoints(`cd /b && ls`, ROOT);
  assert.notEqual(a, b);
});

test("K2c: shell glob 位置参数保留 (cat *.ts vs *.go)", () => {
  const a = bashCommandKeypoints(`cd ${ROOT} && cat src/*.ts`, ROOT);
  const b = bashCommandKeypoints(`cd ${ROOT} && cat src/*.go`, ROOT);
  assert.notEqual(a, b);
});

test("K2d: 写重定向目标保留 (cat a.txt vs cat a.txt > /tmp/out)", () => {
  const a = bashCommandKeypoints(`cd ${ROOT} && cat a.txt`, ROOT);
  const b = bashCommandKeypoints(`cd ${ROOT} && cat a.txt > /tmp/out.txt`, ROOT);
  assert.notEqual(a, b);
});

test("K2e: 写 flag 变化不命中 (rm -r vs rm -rf)", () => {
  const a = bashCommandKeypoints(`rm -r /tmp/x`, ROOT);
  const b = bashCommandKeypoints(`rm -rf /tmp/x`, ROOT);
  assert.notEqual(a, b);
});

// -------- K3: syntax-level semantic drift NOT equivalent --------

test("K3: bash -c 与直接命令不判等价", () => {
  const a = bashCommandKeypoints(`bash -c "git status"`, ROOT);
  const b = bashCommandKeypoints(`git status`, ROOT);
  assert.notEqual(a, b);
});

test("K3b: cd 漂移与直接命令不判等价", () => {
  const a = bashCommandKeypoints(`cd /tmp && git status`, ROOT);
  const b = bashCommandKeypoints(`git status`, ROOT);
  assert.notEqual(a, b);
});

// -------- K4: cd landing tracking / downgrade --------

test("K4: cd $HOME 降级为 cd-var", () => {
  const a = bashCommandKeypoints(`cd $HOME && cat x.yaml`, ROOT);
  const b = bashCommandKeypoints(`cd $HOME && cat x.yaml`, ROOT);
  assert.equal(a, b);
  assert.ok(a.includes("cd-var:$HOME"), `expected cd-var:$HOME in "${a}"`);
});

test("K4b: cd ~ 正常解析为绝对落点（非降级）", () => {
  const a = bashCommandKeypoints(`cd ~ && cat x.yaml`, ROOT);
  // ~ expands to home dir; keypoint should be cd:<abs>, NOT cd-var:~
  assert.ok(!a.includes("cd-var:~"), `expected no cd-var:~ in "${a}"`);
});

test("K4c: cd 相对落点按追踪 cwd 解析为绝对（非降级）", () => {
  const a = bashCommandKeypoints(`cd src && cat x.yaml`, ROOT);
  assert.ok(!a.includes("cd-var:src"), `expected no cd-var:src in "${a}"`);
  assert.ok(a.includes(`cd:${ROOT}/src`), `expected cd:${ROOT}/src in "${a}"`);
});

test("K4d: cd /a vs cd /b 关键点不同", () => {
  const a = bashCommandKeypoints(`cd /a && cat x.yaml`, ROOT);
  const b = bashCommandKeypoints(`cd /b && cat x.yaml`, ROOT);
  assert.notEqual(a, b);
});

// -------- K5: find internal-match vs shell-glob distinction --------

test("K5: find -name 匹配值连跳，cat glob 保留（两者不同）", () => {
  const a = bashCommandKeypoints(`cd ${ROOT} && find openspec -name '*.ts' | head -50`, ROOT);
  const b = bashCommandKeypoints(`cd ${ROOT} && cat openspec/*.ts`, ROOT);
  assert.notEqual(a, b);
});

// -------- K6: keypoint structure sanity --------

test("K6: 样本命令关键点含 cd 落点与命令名", () => {
  const kp = bashCommandKeypoints(
    `cd ${ROOT} && echo "===OPENSPEC===" && find openspec -type f | head -50 && ` +
      `echo "===TD-STATE===" && cat openspec/.td-state/profile-tier.yaml 2>/dev/null && ` +
      `echo "===SRC===" && find src -type f && echo "===TEST===" && find test -type f | head -40`,
    ROOT,
  );
  assert.ok(kp.includes(`cd:${ROOT}`), `expected cd:${ROOT} in "${kp}"`);
  assert.ok(kp.includes("CMD:find"), `expected CMD:find in "${kp}"`);
  assert.ok(kp.includes("CMD:cat"), `expected CMD:cat in "${kp}"`);
  // 纯读 flag / fd 重定向 / 文本不进入关键点
  assert.ok(!kp.includes("type"), `expected no 'type' in "${kp}"`);
  assert.ok(!kp.includes("2>/dev/null"), `expected no fd redirect in "${kp}"`);
  assert.ok(!kp.includes("===OPENSPEC==="), `expected no echo text in "${kp}"`);
});

test("K6b: 文本命令参数忽略", () => {
  const a = bashCommandKeypoints(`echo hello`, ROOT);
  const b = bashCommandKeypoints(`echo world`, ROOT);
  assert.equal(a, b);
});

// -------- K7: whitespace normalization preserved (既有等价超集) --------

test("K7: 词法 whitespace 等价保留 (git  status vs git status)", () => {
  const a = bashCommandKeypoints(`git  status`, ROOT);
  const b = bashCommandKeypoints(`git status`, ROOT);
  assert.equal(a, b);
});

// -------- K8-K10: 6.3 收尾 review 修复边界（相对 cd 落点 / test 位置参数 / cd -P） --------

test("K8: 相对 cd 落点按追踪 cwd 解析（cd /a && cd src）", () => {
  const a = bashCommandKeypoints(`cd /a && cd src && cat ./x`, ROOT);
  const b = bashCommandKeypoints(`cd /a && cd ${ROOT}/src && cat ./x`, ROOT);
  // 相对 `cd src` 在 `cd /a` 之后落点是 /a/src（追踪 cwd），而非 ROOT/src
  // （projectRoot）——两命令真实访问不同文件（/a/src/x vs ROOT/src/x），
  // 必须 NOT equivalent（这是 critical 修复的核心：消除误放行）。
  assert.notEqual(a, b, "relative cd resolves against tracked cwd, not projectRoot");
  assert.ok(a.includes(`cd:/a/src`), `expected cd:/a/src in "${a}"`);
  assert.ok(a.includes(`PATH:/a/src/x`), `expected PATH:/a/src/x in "${a}"`);
});

test("K8b: 相对 cd 落点不同不命中（cd src vs cd test）", () => {
  const a = bashCommandKeypoints(`cd /a && cd src && cat ./x`, ROOT);
  const b = bashCommandKeypoints(`cd /a && cd test && cat ./x`, ROOT);
  assert.notEqual(a, b);
});

test("K9: test 位置参数保留（test -e src/*.ts vs src/*.go）", () => {
  const a = bashCommandKeypoints(`cd ${ROOT} && test -e src/*.ts`, ROOT);
  const b = bashCommandKeypoints(`cd ${ROOT} && test -e src/*.go`, ROOT);
  assert.notEqual(a, b, "test glob positional differs → not equivalent");
});

test("K9b: [ 位置参数保留（[ -f a ] vs [ -f b ]）", () => {
  const a = bashCommandKeypoints(`[ -f /tmp/a ]`, ROOT);
  const b = bashCommandKeypoints(`[ -f /tmp/b ]`, ROOT);
  assert.notEqual(a, b, "[ path arg differs → not equivalent");
});

test("K10: cd 带 flag 落点保留（cd -P /a vs cd -P /b）", () => {
  const a = bashCommandKeypoints(`cd -P /a && cat x`, ROOT);
  const b = bashCommandKeypoints(`cd -P /b && cat x`, ROOT);
  assert.notEqual(a, b, "cd -P landing differs → not equivalent");
  assert.ok(a.includes(`cd:/a`), `expected cd:/a in "${a}"`);
});
