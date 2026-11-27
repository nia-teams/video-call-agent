import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Check release candidates in the worktree, including untracked, non-ignored files.
// This is a source snapshot check, not an audit of Git history or ignored local data.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root, maxBuffer: 16 * 1024 * 1024,
}).toString().split('\0').filter(Boolean));
const forbidden = /(?:^|\/)(?:experiments|instrumentation|python_client|\.runtime(?:-signing)?|\.local-private|[^/]+\.driver)\/|\.(?:apk|dex|desc|ipa|p12|pfx|keystore|jks|pem|key|wav|pcm|mp4)$/i;
const removedPaths = /^(?:agent\/|app\/(?:doubao|device|api\/(?:doubao|device))\/|lib\/doubao\/|tests\/doubao\/|scripts\/import-doubao-env\.ts$)/i;
const internal = /baichuan|bc[-_]?medical|offline[-_]workspace|we[c]omnodeaudio|local\.[w]ecom|wework-video|\bexperiments\//i;
const removedAvatar = /Live2D[ ._-]*Cubism[ ._-]*(?:Motion[ ._-]*Sync[ ._-]*)?Core|csmMotionSync_|live2d\.com\/eula\/live2d-proprietary/i;
const avatarFile = /(?:live2d|cubism|motionsync)|\.moc3$/i;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/;
const removedIntegration = /(?:lib|app)\/doubao|@volcengine\/rtc|frida-(?:compile|java-bridge)/;
const issues = [];
for (const name of files) {
  let info;
  const full = path.join(root, name);
  try { info = lstatSync(full); } catch (error) {
    if (error.code === 'ENOENT') continue; // Tracked file removed from the worktree.
    throw error;
  }
  if (!info.isFile()) { issues.push(`${name}: unsupported file type`); continue; }
  if (forbidden.test(name) || removedPaths.test(name) || (/(^|\/)\.env($|\.)/.test(name) && !/\.example$/.test(name))) issues.push(`${name}: private or removed artifact`);
  if (internal.test(name)) issues.push(`${name}: internal or legacy name`);
  if ((name.startsWith('media/avatar-assets/') && avatarFile.test(name)) || /\.moc3$/i.test(name)) issues.push(`${name}: removed proprietary avatar asset`);
  if (name === 'scripts/check-public-source.mjs') continue; // The denylist itself.
  if (info.size > 4 * 1024 * 1024) { issues.push(`${name}: exceeds the source check size limit`); continue; }
  const bytes = readFileSync(full);
  // Detect strong runtime signatures in renamed binaries as well as source, but
  // allow prose explaining the library's removal without shipping it.
  if (removedAvatar.test(bytes.toString('latin1'))) issues.push(`${name}: removed proprietary avatar runtime`);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  if (secret.test(text)) issues.push(`${name}: possible credential (value redacted)`);
  if (internal.test(text)) issues.push(`${name}: internal fingerprint (value redacted)`);
  if (/\.(?:tsx?|[cm]?js|json)$/.test(name) && removedIntegration.test(text)) issues.push(`${name}: removed integration reference`);
}
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log('Public source checks passed (current files only; history not scanned).');
