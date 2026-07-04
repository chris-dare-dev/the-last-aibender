// SPIKE-D finding 1 (docs/spikes/spike-d-pty-supervision.md, BE-2 carry-over):
// node-pty 1.1.0 ships darwin prebuilds whose `spawn-helper` binary loses its
// executable bit when installed by pnpm (mode -rw-r--r-- in the store).
// Without +x every pty.spawn() fails with the opaque
// `Error: posix_spawnp failed.`. This postinstall guard restores it; the
// runtime belt is ensureSpawnHelperExecutable() in
// core/src/kernel/pty/ptyBackend.ts. Mirrors the spike's proven fix
// (spikes/pty-supervision/scripts/fix-spawn-helper.mjs).
import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let packageDir;
try {
  packageDir = dirname(require.resolve('node-pty/package.json'));
} catch {
  console.log('[fix-spawn-helper] node-pty not installed yet; skipping');
  process.exit(0);
}
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(packageDir, 'prebuilds', arch, 'spawn-helper');
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
