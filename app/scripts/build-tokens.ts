/**
 * FE-1 token build (run: `pnpm -F aibender-app build:tokens`, executes via tsx).
 *
 * tokens.ts ──► app/src/chrome/theme/tokens.css          (--ig-* custom props)
 *          └──► app/src/chrome/theme/tailwind.theme.css  (Tailwind 4 @theme)
 *
 * Both outputs are committed; theme.spec.ts fails if they drift from tokens.ts.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTailwindTheme, renderTokensCss } from '../src/chrome/theme/generate.ts';

const themeDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'chrome', 'theme');

const targets: ReadonlyArray<[file: string, render: () => string]> = [
  ['tokens.css', renderTokensCss],
  ['tailwind.theme.css', renderTailwindTheme],
];

for (const [file, render] of targets) {
  const path = join(themeDir, file);
  writeFileSync(path, render(), 'utf8');
  console.log(`wrote ${path}`);
}
