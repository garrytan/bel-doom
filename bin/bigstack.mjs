// Bel recursion runs on the JS stack. Node's default (~1 MB) allows ~2,000
// nested Bel calls; re-exec with a 7.8 MB stack (~18,000) when not already set.
import { spawnSync } from 'node:child_process';

if (!process.execArgv.some((a) => a.startsWith('--stack-size'))) {
  const r = spawnSync(process.execPath, ['--stack-size=7800', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}
