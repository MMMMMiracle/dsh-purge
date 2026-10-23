import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { installPreset, removeLegacyAnchorGate } from '../lib/redteam/index.js';
import { readPresetDefinition } from '../lib/redteam/preset-composition.js';
import { apply as applyDrillHttp } from '../lib/redteam/ui.js';

test('existing presets lose only the retired plugin gate and migrate idempotently', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-purge-preset-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = scratch;
  try {
    const dir = join(scratch, '.agent-presets', 'redteam');
    mkdirSync(dir, { recursive: true });
    const before = '- id: user-persona\n  name: custom-persona\n  config:\n    text: keep my prompt\n';
    const gate = '- id: anchor-gate\n  name: ./anchor-gate.mjs\n  config:\n    bootstrapMaxTokens: 8192\n';
    const after = '- id: redteam-tools\n  name: dsh-purge/redteam/tools\n';
    writeFileSync(join(dir, 'agent.cordis.yml'), before + gate + after);
    assert.equal(installPreset().action, 'repaired');
    const result = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8');
    assert.ok(result.includes(before));
    assert.ok(result.includes(after));
    assert.doesNotMatch(result, /anchor-gate/);
    assert.equal(installPreset().action, 'kept');
    assert.equal(readFileSync(join(dir, 'agent.cordis.yml'), 'utf8'), result);
    const custom = '- id: anchor-gate\n  name: my-own-plugin\n';
    assert.equal(removeLegacyAnchorGate(custom).text, custom);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('fresh presets parse and keep host output settings without the retired gate', () => {
  const dir = fileURLToPath(new URL('../presets/redteam/', import.meta.url));
  const definition = readPresetDefinition('redteam', dir);
  assert.ok(definition.plugins.length > 0);
  assert.equal(definition.plugins.some(row => row.id === 'anchor-gate'), false);
});

test('environment settings do not register a turn gate; HTTP method and origin validation remain', async () => {
  const hooks = [];
  let route;
  applyDrillHttp({
    redteam: {},
    on: (...args) => { hooks.push(args); return () => {}; },
    effect: fn => fn(),
    webServer: { register: spec => { route = spec; return () => {}; } },
  });
  assert.equal(hooks.length, 0);
  assert.equal(route.path, '/redteam/api');
  for (const [request, status] of [
    [{ method: 'GET' }, 405],
    [{ method: 'POST', socket: { remoteAddress: '192.0.2.10' }, headers: { host: 'localhost:43120', origin: 'https://unrelated.example' } }, 403],
  ]) {
    const response = { writeHead(code) { this.status = code; }, end(body) { this.body = body; } };
    await route.handler(request, response);
    assert.equal(response.status, status);
  }
});

test('first-time Drill navigation opens the panel and full view without authorization requests', () => {
  let bundle;
  const requests = [];
  const windows = [];
  const react = {
    Component: class {}, Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {}, useCallback: fn => fn, useRef: value => ({ current: value }),
    useMemo: fn => fn(),
  };
  const window = {
    innerWidth: 1280, innerHeight: 900,
    location: { href: 'http://localhost:43120/chat', origin: 'http://localhost:43120' },
    localStorage: { getItem: () => null, setItem: () => {} },
    open: (...args) => windows.push(args),
    __ModuleLoader__: { load: value => { bundle = value; } },
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window, URL, console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: (...args) => { requests.push(args); throw Error('unexpected network request'); },
  });
  const plugin = bundle.factory(name => {
    if (name === 'react') return react;
    if (name === 'react-dom') return {};
    throw Error('unexpected module: ' + name);
  });
  const entries = new Map();
  plugin.apply({
    effect: fn => fn(),
    locale: { register: () => {}, bind: () => key => key },
    slots: { inject: (_slot, fn) => fn(), register: (spec, render) => entries.set(spec.id, render) },
  });
  const overlay = entries.get('dsh-purge-dock')();
  const dock = overlay.children.find(item => item.type.name === 'PurgeDock').type;
  function nodes(tree) {
    if (!tree || typeof tree !== 'object') return [];
    return [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)];
  }
  const drillTab = nodes(dock()).find(node => node.props.role === 'tab' && node.children.includes('dock.drill'));
  assert.ok(drillTab);
  drillTab.props.onClick();
  const opened = nodes(dock());
  assert.ok(opened.some(node => node.props.embedded === true));
  assert.equal(opened.some(node => node.props.role === 'dialog'), false);
  const full = opened.find(node => node.children.includes('dock.full'));
  assert.ok(full);
  full.props.onClick();
  assert.equal(windows[0][0], 'http://localhost:43120/chat#redteam-full');
  assert.equal(requests.length, 0);
});


test('legacy gate removal preserves adjacent comments, CRLF, and unrelated final entries', () => {
  const heading = '# my plugin configuration\r\n';
  const gate = '- id: anchor-gate\r\n  name: "./anchor-gate.mjs"\r\n  config:\r\n    maxPromptChars: 14000\r\n';
  const following = '# keep this explanation\r\n- name: custom\r\n  config: {}\r\n';
  assert.equal(removeLegacyAnchorGate(heading + gate + following).text, heading + following);
  assert.equal(removeLegacyAnchorGate(heading + gate).text, heading);
});
