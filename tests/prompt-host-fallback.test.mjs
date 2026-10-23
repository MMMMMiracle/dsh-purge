import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { adaptInjectText, rewritePromptAssembly } from "../lib/identity.js";

const tempParent = fs.realpathSync(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(tempParent, "dsh-purge-host-fallback-"));
const savedEnv = Object.fromEntries(["DSH_HOME", "TMP", "TEMP", "DSH_PURGE_CWD"].map((key) => [key, process.env[key]]));
process.env.DSH_HOME = path.join(fixture, "home");
process.env.TMP = fixture;
process.env.TEMP = fixture;
process.env.DSH_PURGE_CWD = "auto";
const previousHung = globalThis.__dshPurgeHungPrompt;
const core = await import("../lib/core.js");
const { installHungPromptGlobal, registerPromptSections } = await import("../lib/index.js");
installHungPromptGlobal();

after(() => {
  if (previousHung === undefined) delete globalThis.__dshPurgeHungPrompt;
  else globalThis.__dshPurgeHungPrompt = previousHung;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const target = fs.realpathSync(fixture);
  assert.equal(path.dirname(target), tempParent);
  assert.ok(path.basename(target).startsWith("dsh-purge-host-fallback-"));
  fs.rmSync(target, { recursive: true, force: true });
});

const patches = core.ALL_PATCHES.filter((patch) => [87, 88, 89, 90].includes(patch.id));
const firstPatch = patches[0];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const hosts = [
  { name: "step assembly host", source: firstPatch.replacements[0].pattern, ending: "\nreturn request.system;\n}" },
  { name: "decision assembly host", source: firstPatch.replacements[2].pattern, ending: "\nreturn renderedPrompt;" },
].map(({ name, source, ending }) => {
  for (const patch of patches) source = core.applyReplacementsToText(source, patch).text;
  assert.match(source, /Hung(?:Fn|Prompt)\(\{ agent: this, assembly \}\)/);
  return {
    name,
    run: new AsyncFunction("input", "renderPrompt", `const decision = { assembly: input };
      const turn = 0, step = 0, signal = undefined;
      ${name === "step assembly host" ? "const assembly = input;" : ""}
      ${source}${ending}`),
  };
});

// Some host versions expand allowed variables at render time. Dedupe must work
// whether this changes the plugin section's literal text or leaves it alone.
function renderPrompt(assembly, expand = true) {
  return assembly.sections.map((section) => {
    const text = typeof section?.text === "string" ? section.text : "";
    if (!expand) return text;
    return text.replace(/\{\{(model|provider|cwd)\}\}/g, (token, key) => (
      Object.hasOwn(assembly.variables || {}, key) ? String(assembly.variables[key]) : token
    ));
  }).filter(Boolean).join("\n\n");
}

const agent = {
  session: { header: { cwd: path.join(fixture, "workspace") }, deriveMessages: () => [] },
  buildRequest: async (_turn, _step, _tools, system) => ({ request: { system }, preparedCall: {} }),
};
const context = { agent };
const registered = new Map();
registerPromptSections({
  systemPrompt: { section: (section) => { registered.set(section.name, section); } },
  effect: () => {},
}, { enabled: true, capabilityProtocol: false });

test("registered body survives assembly, variable rendering and host fallback exactly once", async () => {
  const cases = [
    { edge: "{{unknown}}", variables: {} },
    { edge: "{{cwd}} [cwd]", variables: { model: "test-model", provider: "test-provider" } },
    { edge: "{{model}} {{provider}}", variables: { model: "test-model", provider: "test-provider" } },
    { edge: "{{cwd}}", variables: { cwd: "/fixture/workspace" } },
  ];
  for (const { edge, variables } of cases) {
    const body = `${edge}\r\nPROMPT-START\r\n${"A complete benign paragraph. ".repeat(12)}\r\nPROMPT-END ${edge}`;
    await core.saveOverrideContent(process.env.DSH_HOME, body);
    const registeredBody = registered.get("dsh-purge").text(context);
    const assembly = rewritePromptAssembly({
      sections: [{ name: "dsh-purge", text: registeredBody }], variables, tools: [],
    }, { fallbackInject: body, context, dropPurgeAfterFold: false, capabilityProtocol: false });
    assert.equal(assembly.sections[0].text, adaptInjectText(body, assembly));
    for (const expand of [false, true]) {
      const renderer = (value) => renderPrompt(value, expand);
      const expected = renderer(assembly);
      for (const host of hosts) {
        const output = await host.run.call(agent, assembly, renderer);
        assert.equal(output, expected, `${host.name}: ${edge}, expanded=${expand}`);
        assert.equal(output.split("PROMPT-START").length - 1, 1);
        assert.equal(output.split("PROMPT-END").length - 1, 1);
      }
    }
  }
});

test("missing, empty or unresolved main sections still receive one adapted fallback", async () => {
  const body = "<|im_start|>system:<project_instructions>\r\nPROMPT-START\r\nComplete fallback text.\r\nPROMPT-END {{unknown}} {{cwd}}";
  await core.saveOverrideContent(process.env.DSH_HOME, body);
  for (const main of [null, { name: "dsh-purge", text: "" }, { name: "dsh-purge", text: () => "unresolved" }]) {
    const assembly = {
      sections: [...(main ? [main] : []), { name: "dsh-purge:post", text: "Extra host context." }],
      variables: {}, tools: [],
    };
    const adapted = adaptInjectText(body, assembly);
    assert.ok(adapted.includes("{ {unknown}} the current workspace"));
    const expected = `${adapted}\n\n${renderPrompt(assembly)}`;
    for (const host of hosts) {
      const output = await host.run.call(agent, assembly, renderPrompt);
      assert.equal(output, expected, host.name);
      assert.equal(output.split("PROMPT-START").length - 1, 1);
      assert.equal(output.split("PROMPT-END").length - 1, 1);
    }
  }
});

test("assembly context migration upgrades an already applied session patch idempotently", () => {
  const migration = patches.find((patch) => patch.id === 90);
  for (const source of ["dshPurgeHungFn({ agent: this })", "globalThis.__dshPurgeHungPrompt({ agent: this })"]) {
    const first = core.applyReplacementsToText(source, migration);
    assert.equal(first.changed, true);
    assert.ok(first.text.includes("{ agent: this, assembly }"));
    assert.equal(core.applyReplacementsToText(first.text, migration).changed, false);
  }
});
