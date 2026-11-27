import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { defaults, loadEnv, validateEnv, studioBase } from '../../env.mjs';
import { configuration, DEFAULT_MODEL } from '../qwen-config.mjs';

const execute = promisify(execFile);
const template = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
async function fixture(t, contents = template) {
  const root = await mkdtemp(path.join(tmpdir(), 'wework-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = Object.fromEntries(Object.keys(defaults).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const file = path.join(root, '.env');
  await writeFile(file, contents, { mode: 0o600 });
  return { root, file };
}

test('example documents every supported option and passes without optional services', async t => {
  const { file } = await fixture(t);
  assert.deepEqual(parseEnv(template), defaults);
  assert.deepEqual(loadEnv({ file }), defaults);
});

test('file values and explicit blanks replace inherited process settings', async t => {
  const { file } = await fixture(t, 'PORT=4173\nSTUDIO_AUTO_ANSWER=0\nOPENAI_API_KEY=\n');
  process.env.PORT = '9999'; process.env.OPENAI_API_KEY = 'synthetic-inherited-secret';
  process.env.DASHSCOPE_API_KEY = 'synthetic-old-key';
  const env = loadEnv({ file });
  assert.equal(studioBase(env), 'http://127.0.0.1:4173');
  assert.equal(process.env.STUDIO_AUTO_ANSWER, '0');
  assert.equal(process.env.OPENAI_API_KEY, '');
  assert.equal(process.env.DASHSCOPE_API_KEY, '');
});

test('missing, linked, non-file and oversized configs fail before applying any values', async t => {
  const { root, file } = await fixture(t);
  const link = path.join(root, 'linked.env'); await symlink(file, link);
  const huge = path.join(root, 'huge.env'); await writeFile(huge, 'x'.repeat(65537));
  process.env.PORT = '5555';
  for (const candidate of [path.join(root, 'absent.env'), root, link, huge]) {
    assert.throws(() => loadEnv({ file: candidate }), /无法读取 \.env/);
    assert.equal(process.env.PORT, '5555');
  }
});

test('invalid ports, switches, URLs and incomplete service groups fail with redacted errors', () => {
  const cases = [
    { PORT: '3070junk' }, { PORT: '1023' }, { PORT: '65536' },
    { STUDIO_AUTO_CAPTURE: 'false' }, { STUDIO_AUTO_ANSWER: '' },
    { OPENAI_BASE_URL: 'ftp://example.com' }, { OPENAI_BACKEND_MODEL: '' },
    { OBS_WEBSOCKET_URL: 'ws://example.com:4455', OBS_WEBSOCKET_PASSWORD: 'synthetic-secret' },
    { OBS_WEBSOCKET_URL: 'ws://127.0.0.1:4455' }, { OBS_WEBSOCKET_PASSWORD: 'synthetic-secret' },
    { DASHSCOPE_API_KEY: 'synthetic-secret' },
    { QWEN_REALTIME_MODEL: 'invalid model' }, { QWEN_VOICE: '' },
  ];
  for (const invalid of cases) assert.throws(() => validateEnv({ ...defaults, ...invalid }), error => {
    assert.match(error.message, /\.env 配置检查失败/);
    assert.ok(!error.message.includes('synthetic-secret')); return true;
  });
  assert.throws(() => validateEnv(defaults, { requireOBS: true }), /OBS_WEBSOCKET_PASSWORD/);
});

test('valid Qwen and OBS groups include the optional Qwen instructions', async t => {
  const { file } = await fixture(t, `${template}\nDASHSCOPE_API_KEY=synthetic-key\nQWEN_REALTIME_URL=wss://dashscope.aliyuncs.com/api-ws/v1/realtime\nQWEN_INSTRUCTIONS="第一行\n第二行"\nOBS_WEBSOCKET_URL=ws://127.0.0.1:4456\nOBS_WEBSOCKET_PASSWORD="synthetic#password"\n`);
  const env = loadEnv({ file, requireOBS: true });
  assert.equal(configuration(env).model, DEFAULT_MODEL);
  assert.equal(env.QWEN_INSTRUCTIONS, '第一行\n第二行');
  assert.equal(env.OBS_WEBSOCKET_PASSWORD, 'synthetic#password');
});

test('an omitted file model allows the endpoint model and clears inherited settings', async t => {
  const { file } = await fixture(t, 'DASHSCOPE_API_KEY=synthetic-key\nQWEN_REALTIME_URL=wss://example.com/custom?model=tenant-v2\n');
  process.env.QWEN_REALTIME_MODEL = 'inherited-model';
  assert.equal(configuration(loadEnv({ file })).model, 'tenant-v2');
  assert.equal(process.env.QWEN_REALTIME_MODEL, '');
  await writeFile(file, 'DASHSCOPE_API_KEY=synthetic-key\nQWEN_REALTIME_URL=wss://example.com/custom?model=tenant-v2\nQWEN_REALTIME_MODEL=different-model\n');
  assert.throws(() => loadEnv({ file }), error => /Qwen 配置无效/.test(error.message) && !error.message.includes('synthetic-key'));
});

test('unknown variables cannot inject Node controls or disclose their contents', async t => {
  const { file } = await fixture(t, 'NODE_OPTIONS=synthetic-private-value\n');
  assert.throws(() => loadEnv({ file }), error => {
    assert.match(error.message, /未知配置项/);
    assert.ok(!error.message.includes('synthetic-private-value')); return true;
  });
});

test('dotenv contents are literal data without shell execution or variable expansion', async t => {
  const { root, file } = await fixture(t);
  const marker = path.join(root, 'must-not-exist');
  const literal = `$(touch ${marker}) $HOME`;
  await writeFile(file, `QWEN_INSTRUCTIONS='${literal}'\n`);
  assert.equal(loadEnv({ file }).QWEN_INSTRUCTIONS, literal);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

async function copyLoader(root) {
  await mkdir(path.join(root, 'media'));
  for (const name of ['env.mjs', 'media/qwen-config.mjs']) await copyFile(new URL(`../../${name}`, import.meta.url), path.join(root, name));
}

test('default loader and CLI work independently of cwd and report a missing file without a stack', async t => {
  const { root } = await fixture(t);
  await copyLoader(root);
  const loader = path.join(root, 'env.mjs');
  const { stdout } = await execute(process.execPath, [loader], { cwd: tmpdir() });
  assert.match(stdout, /配置检查通过/);
  await rm(path.join(root, '.env'));
  await assert.rejects(execute(process.execPath, [loader], { cwd: tmpdir() }), error => {
    assert.equal(error.code, 1); assert.match(error.stderr, /\.env/);
    assert.ok(!error.stderr.includes(' at ')); return true;
  });
});

test('Next config replaces legacy env values and preserves unified config across Next resets', async t => {
  const { root } = await fixture(t, 'PORT=4173\nOPENAI_API_KEY=synthetic-file-key\n');
  await copyLoader(root);
  await copyFile(new URL('../../next.config.mjs', import.meta.url), path.join(root, 'next.config.mjs'));
  await mkdir(path.join(root, 'node_modules/@next'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../node_modules/@next/env', import.meta.url)), path.join(root, 'node_modules/@next/env'));
  await writeFile(path.join(root, '.env.local'), 'PORT=9999\nOPENAI_API_KEY=synthetic-old-key\nOPENAI_BACKEND_API_KEY=synthetic-old-backend-key\n');
  const program = `import nextEnv from ${JSON.stringify(pathToFileURL(path.join(root, 'node_modules/@next/env/dist/index.js')).href)};
    import assert from 'node:assert/strict';
    nextEnv.loadEnvConfig(${JSON.stringify(root)}, true, {info(){},error(){}});
    await import(${JSON.stringify(pathToFileURL(path.join(root, 'next.config.mjs')).href)});
    for (let i = 0; i < 2; i++) {
      assert.equal(process.env.PORT, '4173');
      assert.equal(process.env.OPENAI_API_KEY, 'synthetic-file-key');
      assert.equal(process.env.OPENAI_BACKEND_API_KEY || '', '');
      nextEnv.resetEnv();
    }`;
  await execute(process.execPath, ['--input-type=module', '-e', program], { cwd: tmpdir(), env: { ...process.env, PORT: '7777', OPENAI_API_KEY: 'synthetic-shell-key' } });
});

test('Next dev wrapper passes configured port and values to its child before startup', async t => {
  const { root } = await fixture(t, 'PORT=4173\n');
  await copyLoader(root);
  await copyFile(new URL('../../run-next.mjs', import.meta.url), path.join(root, 'run-next.mjs'));
  await mkdir(path.join(root, 'node_modules/next/dist/bin'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/next/dist/bin/next'), 'console.log(JSON.stringify({args:process.argv.slice(2),port:process.env.PORT}));');
  const { stdout } = await execute(process.execPath, [path.join(root, 'run-next.mjs'), 'dev'], { cwd: tmpdir(), env: { ...process.env, PORT: '9999' } });
  assert.deepEqual(JSON.parse(stdout), { args: ['dev', '--hostname', '127.0.0.1', '--port', '4173'], port: '4173' });
});
