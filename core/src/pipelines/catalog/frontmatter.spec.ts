/**
 * The merged-frontmatter parser (BE-8) — the two DoD robustness rules plus the
 * dialect subset. Positive/negative/edge per plan §9.2.
 */

import { describe, expect, it } from 'vitest';

import {
  parseFrontmatter,
  readBoolean,
  readString,
  readStringList,
} from './frontmatter.js';

describe('parseFrontmatter — positive', () => {
  it('parses scalars, quoted strings, and a block list', () => {
    const result = parseFrontmatter(
      [
        '---',
        'name: argocd-debug',
        'description: "Debug an ArgoCD app: sync, status"',
        "argument-hint: '[app]'", // quoted → the literal hint string, not a flow list
        'allowed-tools:',
        '  - Bash',
        '  - Read',
        '---',
        '# Body',
        'do the thing',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readString(result.frontmatter, 'name')).toBe('argocd-debug');
    expect(readString(result.frontmatter, 'description')).toBe('Debug an ArgoCD app: sync, status');
    expect(readString(result.frontmatter, 'argument-hint')).toBe('[app]');
    expect(readStringList(result.frontmatter, 'allowed-tools')).toEqual(['Bash', 'Read']);
    expect(result.body).toBe('# Body\ndo the thing');
  });

  it('parses booleans, flow lists, and integers', () => {
    const result = parseFrontmatter(
      ['---', 'disable-model-invocation: true', 'tags: [a, b, c]', 'steps: 30', '---', 'body'].join(
        '\n',
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readBoolean(result.frontmatter, 'disable-model-invocation')).toBe(true);
    expect(readStringList(result.frontmatter, 'tags')).toEqual(['a', 'b', 'c']);
    expect(result.frontmatter['steps']).toBe(30);
  });

  it('treats the whole document as body when there is no frontmatter fence', () => {
    const result = parseFrontmatter('# Just a body\nno frontmatter here');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('# Just a body\nno frontmatter here');
  });

  it('keeps a dotted version string a string, not a number', () => {
    const result = parseFrontmatter(['---', 'version: 2.1.196', '---', ''].join('\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frontmatter['version']).toBe('2.1.196');
  });
});

describe('parseFrontmatter — UNKNOWN-KEY PRESERVATION (DoD)', () => {
  it('preserves Obsidian-style user keys verbatim alongside known keys', () => {
    const result = parseFrontmatter(
      [
        '---',
        'name: deploy',
        'description: ship it',
        'type: runbook', // non-standard
        'status: active', // non-standard
        'model-class: heavy', // non-standard
        'tags: [ops, prod]', // non-standard
        '---',
        'body',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every unknown key survives — the scanner never drops what it does not know.
    expect(result.frontmatter['type']).toBe('runbook');
    expect(result.frontmatter['status']).toBe('active');
    expect(result.frontmatter['model-class']).toBe('heavy');
    expect(result.frontmatter['tags']).toEqual(['ops', 'prod']);
    // ...and the known keys are still there.
    expect(readString(result.frontmatter, 'name')).toBe('deploy');
    expect(readString(result.frontmatter, 'description')).toBe('ship it');
  });
});

describe('parseFrontmatter — MALFORMED-YAML SURVIVAL (DoD)', () => {
  it('degrades a block with a non-key:value line but recovers the body', () => {
    const result = parseFrontmatter(
      ['---', 'this is not valid yaml at all', '---', '# Body survives'].join('\n'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/key: value/);
    // The body is recovered so `/name` (filename) invocation stays live.
    expect(result.body).toBe('# Body survives');
  });

  it('degrades an unterminated block but recovers the body after the fence', () => {
    const result = parseFrontmatter(['---', 'name: x', 'no closing fence', '# body line'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unterminated/);
    expect(result.body).toContain('# body line');
  });

  it('degrades on unexpected indentation (nested maps unsupported)', () => {
    const result = parseFrontmatter(['---', 'permission:', '  edit: deny', '---', 'b'].join('\n'));
    // `permission:` opens what looks like a block list; the indented
    // `edit: deny` is not a `- item`, so the block is malformed → degraded.
    expect(result.ok).toBe(false);
  });
});
