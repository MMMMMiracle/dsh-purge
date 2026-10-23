import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-purge-update-source-'));
const previousDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = scratch;
const { archiveZipUrl, archiveTarballUrl, remotePackageUrls, gitResetTo } = await import('../lib/update.js');
const { handleUpdateOp: handleDrillUpdateOp } = await import('../lib/redteam/ui.js');
after(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  assert.equal(dirname(resolve(scratch)), resolve(tmpdir()));
  assert.ok(basename(scratch).startsWith('dsh-purge-update-source-'));
  rmSync(scratch, { recursive: true, force: true });
});

const repository = 'MMMMMiracle/dsh-purge';
const gitUrl = `https://github.com/${repository}.git`;
const commit = '5a9b8e14856138814a2139a0105481e1dcdaece4';

test('branch, tag, and pinned-commit archives all stay on this fork', () => {
  for (const [ref, suffix] of [
    ['master', 'refs/heads/master'],
    ['beta', 'refs/heads/beta'],
    ['v1.1.74', 'refs/tags/v1.1.74'],
    [commit, commit],
  ]) {
    assert.equal(archiveZipUrl(ref), `https://codeload.github.com/${repository}/zip/${suffix}`);
    assert.equal(archiveTarballUrl(ref), `https://codeload.github.com/${repository}/tar.gz/${suffix}`);
  }
});

test('every metadata retry uses the selected fork revision', () => {
  for (const [sha, ref] of [['', 'master'], ['', 'beta'], [commit, 'master']]) {
    const selected = sha || ref;
    const urls = remotePackageUrls(sha, ref);
    assert.ok(urls.length >= 3);
    for (const raw of urls) {
      const url = new URL(raw);
      assert.equal(url.protocol, 'https:');
      if (url.hostname === 'raw.githubusercontent.com') {
        assert.equal(url.pathname, `/${repository}/${selected}/package.json`);
      } else if (url.hostname === 'cdn.jsdelivr.net') {
        assert.equal(url.pathname, `/gh/${repository}@${selected}/package.json`);
      } else {
        assert.equal(url.hostname, 'api.github.com');
        assert.equal(url.pathname, `/repos/${repository}/contents/package.json`);
        assert.equal(url.searchParams.get('ref'), selected);
      }
    }
  }
});

test('Git updates fetch this fork directly and use only its fetched commit', () => {
  for (const ref of ['master', 'beta', 'v1.1.74', commit]) {
    const calls = [];
    gitResetTo(scratch, ref, { force: true, run: (_dir, args) => calls.push(args) });
    assert.deepEqual(calls[0], ['fetch', '--no-tags', gitUrl, ref]);
    assert.equal(calls.at(-1).at(-1), 'FETCH_HEAD');
    assert.ok(calls.every((args) => !args.some((arg) => /^origin(?:\/|$)/.test(arg))));
  }
});

test('failed fork fetch never falls back to an existing local tag or origin', () => {
  const calls = [];
  assert.throws(() => gitResetTo(scratch, 'v1.1.74', {
    force: true,
    run: (_dir, args) => { calls.push(args); throw new Error('fork unavailable'); },
  }), /fork unavailable/);
  assert.deepEqual(calls, [['fetch', '--no-tags', gitUrl, 'v1.1.74']]);
});

test('published metadata installs and reports issues against this fork', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.repository.url, `git+${gitUrl}`);
  assert.equal(pkg.homepage, `https://github.com/${repository}#readme`);
  assert.equal(pkg.bugs.url, `https://github.com/${repository}/issues`);
  assert.equal(pkg.dsh.install.git, gitUrl);
  for (const key of ['zip', 'tarball']) {
    const url = new URL(pkg.dsh.install[key]);
    assert.equal(url.hostname, 'github.com');
    assert.ok(url.pathname.startsWith(`/${repository}/archive/refs/heads/`));
  }
});

function drillContext(running = false) {
  const profileDir = join(scratch, 'profile');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-purge': 'legacy-install' } }));
  return {
    baseUrl: profileDir,
    redteam: { plugin: { name: 'dsh-purge', version: '1.1.74', homepage: 'https://github.com/YuJunZhiXue/dsh-purge' } },
    get(name) {
      if (name === 'sessions') return { list: () => [{ id: 'parent', header: {} }] };
      if (name === 'subagents') return { listChildren: async () => running ? [{ kind: 'child', activity: 'running', label: 'active task' }] : [] };
    },
  };
}

function drillServices(result = { ok: true, restartAfter: true }) {
  const calls = [];
  const services = {
    updater: {
      async checkUpdate() {
        calls.push('check');
        return {
          ok: true, remoteVersion: '1.1.75', updateTarget: 'master', hasUpdate: true,
          versions: [{ ref: 'master', version: '1.1.75', latest: true }, { ref: 'v1.1.70', version: '1.1.70' }],
        };
      },
      async handleUpdateOp(input) { calls.push(input); return result; },
    },
    restart() { calls.push('restart'); return { restarting: true }; },
  };
  return { calls, services };
}

test('Drill checks use the shared updater and return the actual ref for the client', async () => {
  const { calls, services } = drillServices();
  const result = await handleDrillUpdateOp(drillContext(), { op: 'updateCheck' }, services);
  assert.equal(result.latest, '1.1.75');
  assert.equal(result.updateTarget, 'master');
  assert.equal(result.current, '1.1.74');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.install.source, repository);
  assert.deepEqual(calls, ['check']);
});

test('Drill supports old clients sending versions without inventing a tag or npm spec', async () => {
  for (const [target, ref] of [['1.1.75', 'master'], ['master', 'master'], ['1.1.70', 'v1.1.70']]) {
    const { calls, services } = drillServices();
    const result = await handleDrillUpdateOp(drillContext(), { op: 'updateApply', target }, services);
    assert.equal(result.ok, true);
    assert.equal(result.installed, ref);
    assert.equal(result.restarting, true);
    assert.deepEqual(calls, ['check', { op: 'apply', ref }, 'restart']);
  }
});

test('active executor agents block Drill installation before contacting the update service', async () => {
  const { calls, services } = drillServices();
  const result = await handleDrillUpdateOp(drillContext(true), { op: 'updateApply' }, services);
  assert.equal(result.ok, false);
  assert.match(result.error, /active task/);
  assert.deepEqual(calls, []);
});

test('a failed fork check does not install or try another registry', async () => {
  const { calls, services } = drillServices();
  services.updater.checkUpdate = async () => { calls.push('failed check'); throw new Error('fork unavailable'); };
  const result = await handleDrillUpdateOp(drillContext(), { op: 'updateApply' }, services);
  assert.equal(result.ok, false);
  assert.match(result.error, /fork unavailable/);
  assert.deepEqual(calls, ['failed check']);
});

test('package URLs and unknown version targets cannot select another update source', async () => {
  for (const target of ['https://example.com/plugin.tgz', 'dsh-purge@latest', '9.9.99']) {
    const { calls, services } = drillServices();
    const result = await handleDrillUpdateOp(drillContext(), { op: 'updateApply', target }, services);
    assert.equal(result.ok, false);
    assert.ok(calls.every((call) => call === 'check'));
  }
});

test('Drill preserves full-quit and failed-apply results without scheduling a restart', async () => {
  for (const expected of [
    { ok: true, restartAfter: false, needsFullQuit: true },
    { ok: false, error: 'reapply failed' },
  ]) {
    const { calls, services } = drillServices(expected);
    const result = await handleDrillUpdateOp(drillContext(), { op: 'updateApply' }, services);
    assert.equal(result.ok, expected.ok);
    assert.equal(result.needsFullQuit, expected.needsFullQuit);
    assert.equal(calls.includes('restart'), false);
  }
});

test('Drill reports restart failure without claiming the host is restarting', async () => {
  const { services } = drillServices();
  services.restart = () => { throw new Error('host unavailable'); };
  const result = await handleDrillUpdateOp(drillContext(), { op: 'updateApply' }, services);
  assert.equal(result.ok, true);
  assert.equal(result.restarting, false);
  assert.match(result.restartError, /host unavailable/);
});
