import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';

const tempParent = fs.realpathSync(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(tempParent, 'dsh-purge-ui-'));
const savedEnv = Object.fromEntries(['DSH_HOME', 'TMP', 'TEMP'].map(key => [key, process.env[key]]));
const home = path.join(fixture, 'home');
fs.mkdirSync(home);
process.env.DSH_HOME = home;
process.env.TMP = fixture;
process.env.TEMP = fixture;
const core = await import('../lib/core.js');
const { installWebServer } = await import('../lib/index.js');
const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const target = fs.realpathSync(fixture);
  assert.equal(path.dirname(target), tempParent);
  assert.ok(path.basename(target).startsWith('dsh-purge-ui-'));
  fs.rmSync(target, { recursive: true, force: true });
});

// Keep assertion diagnostics short even when a regression returns the bundled prompt.
function sameText(actual, expected, message) {
  const digest = text => createHash('sha256').update(String(text)).digest('hex');
  assert.equal(digest(actual), digest(expected), message);
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)];
}

// Render the real bundled components with persistent hooks and a mocked HTTP boundary.
// No transformed component source, real network, host installation, or restart is used.
function promptUi({ content = '', defaultContent = 'Bundled fixture', restoreFails = false } = {}) {
  let bundle;
  let current;
  let section;
  let tree;
  let serverContent = content;
  const instances = new Map();
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  const schedule = (fn, delay) => {
    const id = ++nextTimer;
    timers.set(id, { fn, delay });
    return id;
  };
  const cancel = id => timers.delete(id);
  const hook = create => {
    const index = current.cursor++;
    if (!(index in current.cells)) current.cells[index] = create();
    return current.cells[index];
  };
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    Component: class {}, Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const cell = hook(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
    },
    useRef: initial => hook(() => ({ current: initial })),
    useCallback(fn, deps) {
      const cell = hook(() => ({}));
      if (!sameDeps(cell.deps, deps)) Object.assign(cell, { value: fn, deps });
      return cell.value;
    },
    useMemo(fn, deps) {
      const cell = hook(() => ({}));
      if (!sameDeps(cell.deps, deps)) Object.assign(cell, { value: fn(), deps });
      return cell.value;
    },
    useEffect(fn, deps) {
      const cell = hook(() => ({}));
      if (!sameDeps(cell.deps, deps)) {
        cell.deps = deps;
        current.effects.push(fn);
      }
    },
  };
  function render(component, props = {}, runEffects = false) {
    let instance = instances.get(component);
    if (!instance) instances.set(component, instance = { cells: [], cursor: 0, effects: [] });
    current = instance;
    instance.cursor = 0;
    instance.effects = [];
    const result = component(props);
    for (const node of nodes(result)) {
      if (node.type === 'textarea' && node.props.ref) node.props.ref.current = { value: node.props.value };
    }
    if (runEffects) for (const effect of instance.effects) effect();
    return result;
  }
  const window = {
    innerWidth: 1280, innerHeight: 900,
    location: { href: 'http://localhost:43120/chat', origin: 'http://localhost:43120' },
    localStorage: { getItem: () => null, setItem: () => {} },
    alert: () => { throw Error('unexpected prompt rejection'); },
    setTimeout: schedule, clearTimeout: cancel,
    setInterval: schedule, clearInterval: cancel,
    __ModuleLoader__: { load: value => { bundle = value; } },
  };
  async function fetch(url, init = {}) {
    const route = new URL(url, window.location.origin).pathname;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ route, method, body });
    let status = 200;
    let result;
    if (route === '/dsh-purge/status') result = { ok: true, patches_total: 0, patches_applied: 0, patch_status: {} };
    else if (route === '/dsh-purge/update') result = { ok: true, versions: [] };
    else if (route === '/dsh-purge/override') {
      if (method === 'POST') {
        if (body.action === 'restore' && restoreFails) status = 500;
        else serverContent = body.action === 'restore' ? defaultContent : body.content;
      }
      result = status === 200 ? { ok: true, content: serverContent, defaultContent } : { ok: false, error: 'fixture write failed' };
    } else if (route === '/dsh-purge/apply') {
      if (Object.hasOwn(body, 'content')) serverContent = body.content;
      result = { ok: true, complete: true, override_content: serverContent, defaultContent };
    } else throw Error('unexpected request: ' + method + ' ' + route);
    return { ok: status === 200, status, text: async () => JSON.stringify(result), json: async () => result };
  }
  vm.runInNewContext(clientSource, {
    window, URL, console, AbortController, fetch,
    setTimeout: schedule, clearTimeout: cancel, setInterval: schedule, clearInterval: cancel,
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
    slots: { inject: (_slot, fn) => fn(), register: (spec, component) => entries.set(spec.id, component) },
  });
  const overlay = entries.get('dsh-purge-dock')();
  const dock = nodes(overlay).find(node => node.type?.name === 'PurgeDock');
  const settings = nodes(render(dock.type)).find(node => node.type?.name === 'SettingsRoot');
  assert.ok(settings, 'dock exposes settings');
  section = nodes(render(settings.type, settings.props)).find(node => node.type?.name === 'PurgifySection').type;
  tree = render(section, {}, true);
  return {
    requests,
    async settle() {
      // The component launches several independent promise chains; drain and render them.
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
        tree = render(section, {}, true);
      }
    },
    text: () => nodes(tree).find(node => node.type === 'textarea').props.value,
    disabled() {
      tree = render(section, {}, true);
      return nodes(tree).find(node => node.type === 'textarea').props.disabled;
    },
    edit(value) {
      const area = nodes(tree).find(node => node.type === 'textarea');
      assert.equal(Boolean(area.props.disabled), false, 'editor is enabled');
      area.props.ref.current.value = value;
      area.props.onChange({ target: { value } });
      tree = render(section, {}, true);
    },
    click(label) {
      const button = nodes(tree).find(node => node.children.includes(label) && typeof node.props.onClick === 'function');
      assert.ok(button, 'button exists: ' + label);
      assert.equal(Boolean(button.props.disabled), false, 'button enabled: ' + label);
      button.props.onClick();
    },
    poll() {
      const timer = [...timers.values()].find(item => item.delay === 5000);
      assert.ok(timer, 'scheduled prompt refresh exists');
      timer.fn();
    },
  };
}

test('settings display an intentionally empty prompt and leave untouched Apply content absent', async () => {
  const ui = promptUi();
  await ui.settle();
  sameText(ui.text(), '', 'empty prompt stays visible');
  ui.click('btn.apply');
  await ui.settle();
  assert.deepEqual(ui.requests.find(row => row.route === '/dsh-purge/apply').body, {});
  sameText(ui.text(), '', 'Apply response and refresh preserve empty text');
});

test('editing a prompt to empty submits the empty string once, then successful Apply clears dirty state', async () => {
  const ui = promptUi({ content: 'Saved fixture' });
  await ui.settle();
  ui.edit('');
  ui.click('btn.apply');
  await ui.settle();
  ui.click('btn.apply');
  await ui.settle();
  assert.deepEqual(ui.requests.filter(row => row.route === '/dsh-purge/apply').map(row => row.body), [{ content: '' }, {}]);
  sameText(ui.text(), '', 'empty edit survives the response');
});

test('background prompt refresh preserves an unsaved draft', async () => {
  const ui = promptUi({ content: 'Saved fixture' });
  await ui.settle();
  ui.edit('Unsaved fixture');
  ui.poll();
  await ui.settle();
  sameText(ui.text(), 'Unsaved fixture', 'poll must not replace user edits');
});

test('restore sends an explicit restore action and resets the next Apply to an absent content field', async () => {
  const ui = promptUi({ content: 'Saved fixture' });
  await ui.settle();
  ui.edit('Unsaved fixture');
  ui.click('btn.restoreInject');
  await ui.settle();
  assert.deepEqual(ui.requests.find(row => row.route === '/dsh-purge/override' && row.method === 'POST').body, { action: 'restore' });
  sameText(ui.text(), 'Bundled fixture', 'restore displays the server result');
  ui.click('btn.apply');
  await ui.settle();
  assert.deepEqual(ui.requests.find(row => row.route === '/dsh-purge/apply').body, {});
});

test('a failed restore preserves the unsaved draft and its next Apply payload', async () => {
  const ui = promptUi({ content: 'Saved fixture', restoreFails: true });
  await ui.settle();
  ui.edit('Unsaved fixture');
  ui.click('btn.restoreInject');
  await ui.settle();
  sameText(ui.text(), 'Unsaved fixture', 'failed restore must not discard the draft');
  ui.click('btn.apply');
  await ui.settle();
  assert.deepEqual(ui.requests.find(row => row.route === '/dsh-purge/apply').body, { content: 'Unsaved fixture' });
});

function overrideRoute() {
  const routes = new Map();
  const host = {
    effect: fn => fn(),
    webServer: { register: spec => { routes.set(spec.path, spec); return () => {}; } },
  };
  installWebServer({ inject: (_deps, fn) => fn(host) }, {});
  const route = routes.get('/dsh-purge/override');
  assert.ok(route);
  return async (method, body) => {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    Object.assign(request, { method, headers: { host: 'localhost:43120', origin: 'http://localhost:43120' } });
    const response = { writeHead(status) { this.status = status; }, end(value) { this.body = value; } };
    await route.handler(request, response);
    assert.equal(response.status, 200, 'override endpoint succeeds');
    const result = JSON.parse(response.body);
    assert.equal(result.ok, true);
    return result;
  };
}

test('real override route saves and reloads explicit empty text while keeping runtime fallback available', async () => {
  const request = overrideRoute();
  await core.saveOverrideContent(home, 'Previous saved fixture');
  const saved = await request('POST', { content: '' });
  sameText(saved.content, '', 'save response keeps empty text');
  sameText(fs.readFileSync(core.findOverrideFile(home), 'utf8'), '', 'disk keeps empty text');
  assert.equal(saved.customized, true);
  assert.equal(saved.needPrompt, false);
  const loaded = await request('GET');
  sameText(loaded.content, '', 'GET must not replace empty text with default');
  assert.equal(loaded.empty, true);
  assert.equal(loaded.customized, true);
});

test('real restore route clears committed user ownership and returns the bundled default', async () => {
  const request = overrideRoute();
  await core.saveOverrideContent(home, 'Committed user fixture');
  const result = await request('POST', { action: 'restore' });
  assert.equal(core.peekCommittedOverride(home), null);
  assert.equal(result.customized, false);
  assert.equal(result.usingDefault, true);
  sameText(result.content, core.defaultOverrideText().replace(/\r\n/g, '\n'), 'restored UI response matches bundled default');
  sameText(fs.readFileSync(core.findOverrideFile(home), 'utf8'), core.defaultOverrideText(), 'restore writes bundled default');
  assert.equal(core.readOverrideStateSync(home).customized, false);
});


test('loading and pending restore prevent concurrent edits that a response could overwrite', async () => {
  const ui = promptUi({ content: 'Saved fixture', restoreFails: true });
  assert.equal(ui.disabled(), true);
  await ui.settle();
  assert.equal(ui.disabled(), false);
  ui.edit('Unsaved fixture');
  ui.click('btn.restoreInject');
  assert.equal(ui.disabled(), true);
  await ui.settle();
  assert.equal(ui.disabled(), false);
  sameText(ui.text(), 'Unsaved fixture', 'a failed request releases the editor with its draft');
});
