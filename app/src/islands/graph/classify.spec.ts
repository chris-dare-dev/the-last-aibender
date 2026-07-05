/**
 * FE-4 classifier — pure path/relation → kind mapping (blueprint §8 node
 * vocabulary). Positive: each rule lands; negative: relation never downgrades
 * instructions/memory identity; edge: casing + nested basenames.
 */

import { describe, expect, it } from 'vitest';
import { basenameOf, classifyArtifact, upgradeKind } from './classify.ts';

describe('basenameOf', () => {
  it('returns the last segment lower-cased', () => {
    expect(basenameOf('/synthetic/proj/CLAUDE.md')).toBe('claude.md');
    expect(basenameOf('CLAUDE.md')).toBe('claude.md');
    expect(basenameOf('/synthetic/a/b/File.TS')).toBe('file.ts');
  });
});

describe('classifyArtifact', () => {
  it('classifies CLAUDE.md basenames and instructions relations as claude-md', () => {
    expect(classifyArtifact('/synthetic/p/CLAUDE.md', 'read')).toBe('claude-md');
    expect(classifyArtifact('/synthetic/p/claude.local.md', 'read')).toBe('claude-md');
    // InstructionsLoaded covers rules files too — relation wins.
    expect(classifyArtifact('/synthetic/p/rules/style.md', 'instructions')).toBe('claude-md');
  });

  it('classifies MEMORY.md and /memory/ segments as memory', () => {
    expect(classifyArtifact('/synthetic/p/MEMORY.md', 'read')).toBe('memory');
    expect(classifyArtifact('/synthetic/p/memory/notes.md', 'watched')).toBe('memory');
    expect(classifyArtifact('/synthetic/p/Memory/notes.md', 'read')).toBe('memory');
  });

  it('classifies write touches as agent-artifact, the rest as reference', () => {
    expect(classifyArtifact('/synthetic/p/out/report.md', 'write')).toBe('agent-artifact');
    expect(classifyArtifact('/synthetic/p/src/main.ts', 'read')).toBe('reference');
    expect(classifyArtifact('/synthetic/p/src/main.ts', 'watched')).toBe('reference');
  });

  it('instructions/memory identity is stronger than produced-ness', () => {
    // A write to CLAUDE.md stays claude-md; a write under /memory/ stays memory.
    expect(classifyArtifact('/synthetic/p/CLAUDE.md', 'write')).toBe('claude-md');
    expect(classifyArtifact('/synthetic/p/memory/log.md', 'write')).toBe('memory');
  });
});

describe('upgradeKind', () => {
  it('upgrades reference → agent-artifact only', () => {
    expect(upgradeKind('reference', 'agent-artifact')).toBe('agent-artifact');
  });

  it('never re-classifies instructions/memory/session and never downgrades', () => {
    expect(upgradeKind('claude-md', 'agent-artifact')).toBe('claude-md');
    expect(upgradeKind('memory', 'agent-artifact')).toBe('memory');
    expect(upgradeKind('agent-artifact', 'reference')).toBe('agent-artifact');
    expect(upgradeKind('reference', 'memory')).toBe('reference');
    expect(upgradeKind('session', 'reference')).toBe('session');
  });
});
