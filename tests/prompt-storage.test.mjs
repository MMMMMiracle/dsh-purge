import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-prompt-test-"));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = path.join(root, "home");
const core = await import("../lib/core.js");
const rules = await import("../lib/rules.js");
const bundled = core.defaultOverrideText();
const repo = fileURLToPath(new URL("..", import.meta.url));

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
});

function home() {
  return fs.mkdtempSync(path.join(root, "case-"));
}

function disk(dir) {
  return fs.readFileSync(core.findOverrideFile(dir), "utf8");
}

// Compare exact bytes without dumping the full bundled prompt on failure.
function assertTextEqual(actual, expected) {
  const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
  assert.equal(Buffer.byteLength(actual), Buffer.byteLength(expected), "text byte length");
  assert.equal(digest(actual), digest(expected), "text SHA-256");
}

test("first boot seeds the existing published prompt once", () => {
  const dir = home();
  assert.ok(bundled.trim());
  assert.equal(core.seedPromptInjectAtBoot(dir).action, "seed_default");
  assertTextEqual(disk(dir), bundled);
  assert.equal(core.seedPromptInjectAtBoot(dir).action, "current");
  assert.equal(rules.resolveInjectText(dir).source, "default");
});

test("a proven old default refreshes, but an unproven hash does not", async () => {
  for (const customized of [false, true, undefined]) {
    const dir = home();
    const old = "Previously shipped default fixture";
    fs.writeFileSync(core.findOverrideFile(dir), old);
    await core.writeOverrideState(dir, { customized, hash: core.hashOverride(old), seedHash: core.hashOverride(old) });
    core.syncPromptInjectOnDiskSync(dir);
    assertTextEqual(disk(dir), customized === false ? bundled : old);
  }
});

test("edits retaining all legacy persona markers survive boot, install and Apply", async () => {
  const dir = home();
  const custom = "<|im_start|>system:\n<project_instructions>\nLittle Code Sauce\nUser-edited fixture.\n</project_instructions>";
  core.seedPromptInjectAtBoot(dir);
  fs.writeFileSync(core.findOverrideFile(dir), custom);
  assert.equal(core.syncPromptInjectOnDiskSync(dir).reason, "user_custom");
  assert.equal(await core.installOverride(dir), "exists");
  assert.equal(disk(dir), custom);
  await core.commitOverrideOnApply(dir, custom);
  core.clearCommittedOverride(dir); // 模拟进程重启，仅剩磁盘和状态。
  core.syncPromptInjectOnDiskSync(dir);
  assert.equal(disk(dir), custom);
  assert.equal(rules.resolveInjectText(dir).text, custom);
  assert.equal(rules.resolveInjectText(dir).source, "prompt");
});

test("explicit saves own the text even when empty or equal to the bundled default", async () => {
  for (const content of ["", bundled, "A user-owned prompt"]) {
    const dir = home();
    await core.saveOverrideContent(dir, content);
    core.clearCommittedOverride(dir);
    assert.equal(core.syncPromptInjectOnDiskSync(dir).reason, "user_custom");
    assert.equal(await core.installOverride(dir), "exists");
    assertTextEqual(disk(dir), content);
    assert.equal(rules.resolveInjectText(dir).source, "prompt");
    assertTextEqual(rules.resolveInjectText(dir).text, core.normalizeOverride(content));
    const ui = await core.readOverrideForUi(dir);
    assertTextEqual(ui.content, content.replace(/\r\n/g, "\n"));
    assert.equal(ui.empty, !content.trim());
  }
});

test("Apply keeps an explicitly submitted draft instead of resurrecting disk text", async () => {
  const dir = home();
  await core.saveOverrideContent(dir, "Older saved text");
  await core.commitOverrideOnApply(dir, "");
  assert.equal(disk(dir), "");
  assert.equal(rules.resolveInjectText(dir).text, "");
  core.hangOperatorPrompt("Stale in-memory prompt");
  assert.equal(rules.ensureOperatorBody(dir), "");
});

test("committed text wins until explicit restore clears it", async () => {
  const dir = home();
  await core.saveOverrideContent(dir, "Committed text");
  fs.writeFileSync(core.findOverrideFile(dir), "Later disk text");
  assert.equal(rules.resolveInjectText(dir).text, "Committed text");
  core.syncPromptInjectOnDiskSync(dir);
  assert.equal(disk(dir), "Later disk text");
  await core.installOverride(dir, true);
  assert.equal(core.peekCommittedOverride(dir), null);
  assertTextEqual(disk(dir), bundled);
  assert.equal(rules.resolveInjectText(dir).source, "default");
});

test("an existing empty file is preserved without a state file", async () => {
  const dir = home();
  fs.writeFileSync(core.findOverrideFile(dir), "");
  core.seedPromptInjectAtBoot(dir);
  await core.installOverride(dir);
  assert.equal(disk(dir), "");
  assert.equal((await core.readOverrideForUi(dir)).empty, true);
});

test("activating a rule writes its target without replacing the saved prompt", async () => {
  const dir = home();
  await core.saveOverrideContent(dir, "Saved prompt fixture");
  await rules.saveRule(dir, "project", "Workspace rule fixture", { target: "AGENTS.md" });
  await rules.activateRule(dir, "project");
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "Workspace rule fixture");
  assert.equal(disk(dir), "Saved prompt fixture");
  assert.equal(rules.resolveInjectText(dir).text, "Saved prompt fixture");
});

test("host fallback passes its agent session for both fresh and previously patched hosts", () => {
  const promptPatch = core.ALL_PATCHES.find((patch) => patch.id === 87);
  const contextPatch = core.ALL_PATCHES.find((patch) => patch.id === 89);
  const freshHosts = [promptPatch.replacements[0].pattern, promptPatch.replacements[2].pattern];
  const oldHosts = [
    "const dshPurgeHungFn = globalThis.__dshPurgeHungPrompt; return dshPurgeHungFn();",
    "return globalThis.__dshPurgeHungPrompt();",
  ];
  const previousPrompt = globalThis.__dshPurgeHungPrompt;
  try {
    globalThis.__dshPurgeHungPrompt = ({ agent }) => agent.session.header.cwd;
    for (const source of oldHosts) {
      const migrated = core.applyReplacementsToText(source, contextPatch).text;
      const host = { session: { header: { cwd: "isolated-project" } }, run: new Function(migrated) };
      assert.equal(host.run(), "isolated-project");
      assert.equal(core.applyReplacementsToText(migrated, contextPatch).changed, false);
    }
    for (const source of freshHosts) {
      let migrated = core.applyReplacementsToText(source, promptPatch).text;
      migrated = core.applyReplacementsToText(migrated, contextPatch).text;
      assert.match(migrated, /(?:dshPurgeHungFn|globalThis\.__dshPurgeHungPrompt)\(\{ agent: this \}\)/);
      assert.doesNotMatch(migrated, /(?:dshPurgeHungFn|globalThis\.__dshPurgeHungPrompt)\(\)/);
    }
  } finally {
    if (previousPrompt === undefined) delete globalThis.__dshPurgeHungPrompt;
    else globalThis.__dshPurgeHungPrompt = previousPrompt;
  }
});

test("clean checkout build preserves the released text and ciphertext; changed source rebuilds", () => {
  const dir = home();
  for (const relative of ["scripts/embed-default-prompt.mjs", "lib/default-prompt-source.md", "lib/asset-table.js", "lib/table-read.js", "lib/table-key.js"]) {
    const dest = path.join(dir, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repo, relative), dest);
  }
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  const source = path.join(dir, "lib/default-prompt-source.md");
  const table = path.join(dir, "lib/asset-table.js");
  const before = fs.readFileSync(table, "utf8");
  assertTextEqual(fs.readFileSync(source, "utf8"), bundled);
  execFileSync(process.execPath, [path.join(dir, "scripts/embed-default-prompt.mjs")], { cwd: dir, windowsHide: true });
  assertTextEqual(fs.readFileSync(table, "utf8"), before);
  const revised = "A benign replacement build fixture.\n";
  fs.writeFileSync(source, revised);
  execFileSync(process.execPath, [path.join(dir, "scripts/embed-default-prompt.mjs")], { cwd: dir, windowsHide: true });
  const readerUrl = pathToFileURL(path.join(dir, "lib/table-read.js")).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `import { openSlot } from ${JSON.stringify(readerUrl)}; process.stdout.write(openSlot());`], { cwd: dir, windowsHide: true, encoding: "utf8" });
  assert.equal(output, revised);
});
