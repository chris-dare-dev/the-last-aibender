// SPIKE FINDING (feeds BE-2): node-pty 1.1.0 ships darwin prebuilds whose
// `spawn-helper` binary loses its executable bit when installed by pnpm
// (mode -rw-r--r-- in the store). Without +x every pty.spawn() fails with
// the opaque `Error: posix_spawnp failed.`. The prod kernel package must
// carry the same guard (or an install-time doctor check).
import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let pkgDir;
try {
  pkgDir = dirname(require.resolve('node-pty/package.json'));
} catch {
  console.log('[fix-spawn-helper] node-pty not installed yet; skipping');
  process.exit(0);
}
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(pkgDir, 'prebuilds', arch, 'spawn-helper');
  try {
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0) {
      chmodSync(helper, mode | 0o755);
      console.log(`[fix-spawn-helper] +x applied: ${helper}`);
    }
  } catch {
    /* arch not present — fine */
  }
}
