/**
 * Architectural test (plan §9.2 BE-2 NEGATIVE row): "semantic parsing of PTY
 * bytes is absent BY CONSTRUCTION — no parser imports in pty/".
 *
 * Blueprint §4.1: the PTY carries pixels only; semantics flow from the SDK
 * stream, hooks, OTel, and JSONL tailing — never from terminal bytes. This
 * suite pins that as a source-level property of every PRODUCTION module in
 * core/src/kernel/pty/ (test files and the testing/ doubles excluded — they
 * synthesize pixels, which is the other direction):
 *
 *   1. no imports of transcript/JSONL parsing machinery (transcriptTail,
 *      readline, @aibender/testkit generators);
 *   2. no byte→string decoding of OUTPUT data (TextDecoder, StringDecoder,
 *      Buffer#toString on output paths) — the ONLY sanctioned string
 *      conversion is the INPUT-side transport encode in ptyBackend.ts
 *      (client UTF-8 keystrokes → node-pty's string-only write());
 *   3. no regex-over-output scraping (the OSC/CSI-pattern trap).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PTY_DIR = dirname(fileURLToPath(import.meta.url));

/** Production sources only: no *.spec.ts, no testing/ doubles. */
function productionSources(): { name: string; text: string }[] {
  return readdirSync(PTY_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => ({ name, text: readFileSync(join(PTY_DIR, name), 'utf8') }));
}

describe('pty/ architectural invariants', () => {
  const sources = productionSources();

  it('covers the expected production modules', () => {
    expect(sources.map((source) => source.name).sort()).toEqual([
      'flowControl.ts',
      'gatewayPort.ts',
      'index.ts',
      'ptyBackend.ts',
      'ptyHost.ts',
    ]);
  });

  it('imports no transcript/JSONL parsing machinery', () => {
    for (const source of sources) {
      expect(source.text, source.name).not.toMatch(/from\s+'.*transcriptTail/);
      expect(source.text, source.name).not.toMatch(/from\s+'node:readline/);
      expect(source.text, source.name).not.toMatch(/from\s+'@aibender\/testkit/);
      expect(source.text, source.name).not.toMatch(/JSON\.parse/);
    }
  });

  it('never decodes PTY OUTPUT bytes to strings', () => {
    for (const source of sources) {
      expect(source.text, source.name).not.toMatch(/StringDecoder/);
      if (source.name === 'ptyBackend.ts') {
        // The sanctioned exceptions, INPUT/adapter-side only:
        //  - write(): client UTF-8 keystroke bytes → node-pty's string write
        //  - onData string→bytes ENCODE (TextEncoder) for backends configured
        //    without encoding:null — bytes never become strings host-side.
        const outputDecodes = source.text.match(/TextDecoder/g) ?? [];
        expect(outputDecodes, source.name).toHaveLength(0);
        continue;
      }
      expect(source.text, source.name).not.toMatch(/TextDecoder/);
      expect(source.text, source.name).not.toMatch(/\.toString\(\s*'(utf|latin|ascii|binary)/);
      expect(source.text, source.name).not.toMatch(/String\.fromCharCode/);
    }
  });

  it('runs no regexes over output byte content', () => {
    // Heuristic with teeth: production pty/ modules define no regex literals
    // at all except the error-message-free ones TypeScript needs — currently
    // ZERO. If a future change needs one, it must not target PTY output; move
    // the logic out of pty/ or amend this pin with review.
    for (const source of sources) {
      const withoutComments = source.text
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');
      expect(withoutComments, source.name).not.toMatch(/\.match\(|\.exec\(|new RegExp\(/);
    }
  });

  it('pty/ never imports the SDK or node-pty outside the backend seam', () => {
    for (const source of sources) {
      if (source.name !== 'ptyBackend.ts') {
        expect(source.text, source.name).not.toMatch(/from\s+'node-pty'|require\(\s*'node-pty'/);
      }
      expect(source.text, source.name).not.toMatch(/@anthropic-ai\/claude-agent-sdk/);
    }
  });
});
