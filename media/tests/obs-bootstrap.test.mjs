import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeOBSWebSocket } from '../obs-bootstrap.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'obs-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, configFile: path.join(directory, 'config.json'), isRunning: async () => false, port: 4455, password: 'synthetic-env-password' };
}
test('first launch configures authenticated OBS from the supplied env settings', async t => {
  const options = await fixture(t);
  assert.equal(await initializeOBSWebSocket(options), true);
  const config = JSON.parse(await readFile(options.configFile));
  assert.equal(config.server_enabled, true); assert.equal(config.auth_required, true);
  assert.equal(config.server_port, 4455); assert.equal(config.server_password, options.password);
  assert.equal((await stat(options.configFile)).mode & 0o777, 0o600);
  assert.equal(await initializeOBSWebSocket(options), false);
});
test('env port and password replace old OBS settings with a backup and preserve other preferences', async t => {
  const options = await fixture(t);
  const previous = { server_enabled: false, server_password: 'existing-password', server_port: 4456, alerts: true };
  await writeFile(options.configFile, JSON.stringify(previous));
  await initializeOBSWebSocket(options);
  const config = JSON.parse(await readFile(options.configFile));
  assert.equal(config.server_password, options.password); assert.equal(config.server_port, options.port); assert.equal(config.alerts, true);
  const backup = (await readdir(options.directory)).find(name => name.includes('before-wecom'));
  assert.deepEqual(JSON.parse(await readFile(path.join(options.directory, backup))), previous);
});
test('running OBS with incomplete settings is not modified behind its back', async t => {
  const options = await fixture(t);
  await assert.rejects(initializeOBSWebSocket({ ...options, isRunning: async () => true }), /退出 OBS/);
  assert.deepEqual(await readdir(options.directory), []);
});
test('malformed configuration is preserved for manual repair', async t => {
  const options = await fixture(t); await writeFile(options.configFile, '{broken');
  await assert.rejects(initializeOBSWebSocket(options), /未覆盖/);
  assert.equal(await readFile(options.configFile, 'utf8'), '{broken');
});

test('missing configured credentials cannot generate or persist an alternative password', async t => {
  const options = await fixture(t);
  await assert.rejects(initializeOBSWebSocket({ ...options, password: '' }), /\.env/);
  assert.deepEqual(await readdir(options.directory), []);
});
