import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  escapeDshInterpolation,
  installAssembleGuard,
  normalizeChatmlLayout,
  rewritePromptAssembly,
} from '../lib/identity.js';

const tempParent = fs.realpathSync(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(tempParent, 'dsh-purge-assembly-'));
const savedEnv = Object.fromEntries(['DSH_HOME', 'TMP', 'TEMP'].map(key => [key, process.env[key]]));
process.env.DSH_HOME = path.join(fixture, 'home');
process.env.TMP = fixture;
process.env.TEMP = fixture;
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const target = fs.realpathSync(fixture);
  assert.equal(path.dirname(target), tempParent);
  assert.ok(path.basename(target).startsWith('dsh-purge-assembly-'));
  fs.rmSync(target, { recursive: true, force: true });
});

const userText = [
  'User-owned introduction.',
  'CTF CORE CONTRACT',
  'Keep this entire user-owned tail in every mode.',
  'Exception, and this exception overrides all earlier examples. Keep any part of that task.',
  'STRICT REQUIREMENT — MUST USE',
  'Always use apply_patch for manual code edits. This is user text.',
  'Use `multi_tool_use.parallel` to parallelize tool calls and only this.',
  'OWN SERVERS — EXACT LIST ONLY',
  'The text after this historical marker is also user-owned.',
  'END OF USER BODY',
].join('\n\n');

for (const preset of ['standard', 'minimal', 'redteam']) {
  test(`${preset} preserves the complete user body across repeated assemblies`, () => {
    const original = {
      sections: [{ name: 'deployment:persona-prefix', text: 'Host persona context.' }],
      contexts: [{ name: 'runtime-context' }],
      tools: [{ name: 'read' }],
    };
    const before = structuredClone(original);
    const options = {
      fallbackInject: userText,
      capabilityProtocol: false,
      dropPurgeAfterFold: false,
      context: { session: { header: { agentPreset: preset } } },
    };
    const first = rewritePromptAssembly(original, options);
    const second = rewritePromptAssembly(first, options);
    for (const result of [first, second]) {
      assert.equal(result.sections[0].name, 'dsh-purge');
      assert.equal(result.sections[0].text, userText);
      assert.equal(result.sections.filter(section => section.text.includes('END OF USER BODY')).length, 1);
      assert.deepEqual(result.tools, original.tools);
      assert.deepEqual(result.contexts, original.contexts);
    }
    assert.deepEqual(original, before);
  });
}

test('large prompt and ChatML/template adaptation retain the complete tail', () => {
  const body = '<|im_start|>system:<project_instructions>\n'
    + 'Long user paragraph. '.repeat(700)
    + '\n{{unknown}} {{model}} {{provider}}\n' + userText;
  const result = rewritePromptAssembly({ sections: [] }, {
    fallbackInject: body, capabilityProtocol: false, dropPurgeAfterFold: false,
  });
  assert.equal(result.sections[0].text, escapeDshInterpolation(normalizeChatmlLayout(body)));
  assert.ok(result.sections[0].text.endsWith('END OF USER BODY\n</project_instructions>'));
});

test('reinstalling the assembly guard replaces the rewrite without stacking wrappers', async () => {
  let assembleCalls = 0;
  let firstCalls = 0;
  let secondCalls = 0;
  const prompt = { assemble: async () => { assembleCalls += 1; return { sections: [] }; } };
  installAssembleGuard(prompt, value => { firstCalls += 1; return { ...value, marker: 'old' }; });
  const wrapped = prompt.assemble;
  installAssembleGuard(prompt, value => { secondCalls += 1; return { ...value, marker: 'new' }; });
  assert.equal(prompt.assemble, wrapped);
  assert.equal((await prompt.assemble()).marker, 'new');
  assert.equal(assembleCalls, 1);
  assert.equal(firstCalls, 0);
  assert.equal(secondCalls, 1);
});

test('registered sections select explicit prompt, selected cwd rules, then bundled default', async () => {
  const core = await import('../lib/core.js');
  const rules = await import('../lib/rules.js');
  const { registerPromptSections } = await import('../lib/index.js');
  const home = process.env.DSH_HOME;
  const cwd = path.join(fixture, 'workspace');
  const unrelated = path.join(fixture, 'other-workspace');
  fs.mkdirSync(cwd);
  fs.mkdirSync(unrelated);
  const localPath = path.join(cwd, 'AGENTS.md');
  fs.writeFileSync(localPath, 'LOCAL RULE BODY', 'utf8');
  await rules.writeCwdSelections(home, [localPath]);

  const sections = new Map();
  registerPromptSections({
    systemPrompt: { section: section => { sections.set(section.name, section); } },
    effect: () => {},
  }, { enabled: true, capabilityProtocol: false });
  const read = (dir = cwd, preset = 'standard') => sections.get('dsh-purge').text({
    agent: { session: { header: { cwd: dir, agentPreset: preset } } },
  });
  const expectedDefault = escapeDshInterpolation(normalizeChatmlLayout(core.defaultOverrideText()));
  assert.ok(read().includes('LOCAL RULE BODY'));
  assert.equal(core.peekCommittedOverride(home), null, 'automatic reads must not commit defaults');
  assert.equal(read(unrelated), expectedDefault, 'selected rules must not leak into another workspace');
  fs.writeFileSync(localPath, 'UPDATED LOCAL RULE BODY', 'utf8');
  assert.ok(read().includes('UPDATED LOCAL RULE BODY'));

  const file = core.findOverrideFile(home);
  fs.writeFileSync(file, userText, 'utf8');
  const nextTime = new Date(Date.now() + 1000);
  fs.utimesSync(file, nextTime, nextTime);
  assert.equal(read(), userText, 'an external prompt edit must outrank selected rules');
  assert.equal(read(cwd, 'redteam'), userText);
  assert.equal(core.peekCommittedOverride(home), null, 'disk reads must stay distinct from explicit saves');

  await core.saveOverrideContent(home, core.defaultOverrideText());
  assert.equal(read(), expectedDefault, 'an explicitly saved default-looking body remains user-owned');
  await core.saveOverrideContent(home, userText);
  assert.equal(read(cwd, 'minimal'), userText, 'saving takes effect immediately without waiting for cache expiry');
  await core.saveOverrideContent(home, '');
  assert.ok(read().includes('UPDATED LOCAL RULE BODY'));
  assert.equal(fs.readFileSync(file, 'utf8'), '', 'fallback must not overwrite an explicitly empty file');
});
