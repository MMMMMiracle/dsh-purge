import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/redteam/index.js';

const persona = '- id: user-persona\n  name: custom-persona\n  config:\n    text: preserve my entire user-authored persona\n';
const anchor = '- id: anchor-gate\n  name: ./anchor-gate.mjs\n  config:\n    bootstrapMaxTokens: 8192\n';

async function withPreset(text, run, force = false) {
  const tempParent = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(tempParent, 'dsh-purge-apply-preset-'));
  const previousHome = process.env.DSH_HOME;
  const previousRefresh = process.env.REDTEAM_PRESET_REFRESH;
  process.env.DSH_HOME = scratch;
  if (force) process.env.REDTEAM_PRESET_REFRESH = '1';
  else delete process.env.REDTEAM_PRESET_REFRESH;
  const dir = path.join(scratch, '.agent-presets', 'redteam');
  fs.mkdirSync(dir, { recursive: true });
  const presetFile = path.join(dir, 'agent.cordis.yml');
  fs.writeFileSync(presetFile, text);
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: User preset\ndescription: User description\n');
  const declarations = [];
  const cleanups = [];
  const registry = {
    register: async definition => { declarations.push(definition); return () => {}; },
    list: async () => [{ id: 'redteam' }],
  };
  const ctx = {
    agentPresets: registry,
    get: name => name === 'agentPresets' ? registry : undefined,
    effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    provide: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  try {
    const boot = async () => { apply(ctx); await new Promise(resolve => setImmediate(resolve)); };
    await boot();
    assert.equal(declarations.length, 1, 'the real apply entry must declare the preserved preset');
    await run({ presetFile, declarations, boot });
  } finally {
    for (const cleanup of cleanups) cleanup();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousRefresh === undefined) delete process.env.REDTEAM_PRESET_REFRESH;
    else process.env.REDTEAM_PRESET_REFRESH = previousRefresh;
    const resolved = fs.realpathSync(scratch);
    assert.equal(path.dirname(resolved), tempParent);
    assert.ok(path.basename(resolved).startsWith('dsh-purge-apply-preset-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test('real startup preserves a custom preset without workflow-ptc while removing the retired gate', async () => {
  const tail = '# user comment after the gate\n- id: custom-tool\n  name: my-custom-tool\n';
  await withPreset(persona + anchor + tail, async ({ presetFile, declarations, boot }) => {
    const migrated = fs.readFileSync(presetFile, 'utf8');
    assert.equal(migrated, persona + tail);
    assert.equal(declarations[0].name, 'User preset');
    assert.equal(declarations[0].plugins[0].config.text, 'preserve my entire user-authored persona');
    await boot();
    assert.equal(fs.readFileSync(presetFile, 'utf8'), migrated);
  });
});

test('legacy workflow provider repair preserves persona and unrelated tools on real startup', async () => {
  const workflows = [
    '- id: delegation', '  name: cordis:group', '  group: true', '  isolate:', '    workflowEngine: true', '  config:',
    '    - id: workflow-worker-thread', "      name: '@deepseek-ai/dsh-workflow-worker-thread'", '      config:', '        provider: spawn',
    '    - id: tool-workflow', "      name: '@deepseek-ai/dsh-tool-workflow'",
    '    - id: user-tool', '      name: custom-user-tool', '',
  ].join('\n');
  await withPreset(persona + workflows, async ({ presetFile, declarations, boot }) => {
    const migrated = fs.readFileSync(presetFile, 'utf8');
    assert.ok(migrated.startsWith(persona));
    const group = declarations[0].plugins.find(row => row.id === 'delegation');
    assert.equal(group.config.find(row => row.id === 'workflow-worker-thread').disabled, true);
    assert.equal(group.config.find(row => row.id === 'workflow-ptc').config.provider, 'spawn');
    assert.equal(group.config.find(row => row.id === 'user-tool').name, 'custom-user-tool');
    await boot();
    assert.equal(fs.readFileSync(presetFile, 'utf8'), migrated);
  });
});

test('only explicit preset refresh replaces the user composition', async () => {
  await withPreset(persona, async ({ presetFile, declarations }) => {
    assert.equal(declarations[0].plugins.some(row => row.id === 'user-persona'), false);
    assert.ok(declarations[0].plugins.some(row => row.id === 'redteam-tools'));
    assert.doesNotMatch(fs.readFileSync(presetFile, 'utf8'), /preserve my entire user-authored persona/);
  }, true);
});
