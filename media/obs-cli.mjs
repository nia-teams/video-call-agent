import { obsStatus, prepareOBS } from './obs.mjs';
import { loadEnv } from '../env.mjs';
try {
  loadEnv({ requireOBS: true });
  const mode = process.argv[2] || 'status';
  if (!['status', 'prepare', 'source'].includes(mode)) throw new Error('用法：obs-cli.mjs [status | prepare | source]');
  const result = mode === 'status' ? await obsStatus() : await prepareOBS({ configureSource: mode === 'source' });
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
