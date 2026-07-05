/**
 * The capability-catalog scanner (BE-8) — the four DoD fixture-tree cases
 * (precedence, walk-up, malformed-YAML survival, unknown-key preservation)
 * plus plugins (install×enablement×scope), OpenCode API-first + file fallback,
 * and the workflow static-parse. Everything drives the in-memory fixture fs —
 * the real account dirs are NEVER touched (rule 3).
 */

import { describe, expect, it } from 'vitest';

import { createMemoryCatalogFs, type CatalogFixtureTree } from './fs.js';
import {
  scanCatalog,
  type OpencodeCapability,
  type OpencodeCatalogSource,
} from './scanner.js';
import { scanResultToSnapshot } from './wire.js';

const skill = (name: string, extra = ''): string =>
  ['---', `name: ${name}`, `description: the ${name} skill`, extra, '---', `# ${name}`].join('\n');

const agent = (name: string): string =>
  ['---', `name: ${name}`, 'description: an agent', 'model: sonnet', '---', 'You are…'].join('\n');

async function scan(tree: CatalogFixtureTree, opts?: Parameters<typeof scanCatalog>[0] extends infer T ? Partial<T> : never) {
  const fs = createMemoryCatalogFs(tree);
  return scanCatalog({
    fs,
    accounts: [{ account: 'MAX_A', configDir: '/cfg/max_a' }],
    nowMs: () => 1_700_000_000_000,
    ...opts,
  } as Parameters<typeof scanCatalog>[0]);
}

describe('scanCatalog — skills/commands/agents (positive)', () => {
  it('scans user-scope skills, commands, and recursive agents', async () => {
    const result = await scan({
      '/cfg/max_a/skills/deploy/SKILL.md': skill('deploy'),
      '/cfg/max_a/commands/triage.md': ['---', 'description: triage', '---', 'body'].join('\n'),
      '/cfg/max_a/agents/reviewers/security.md': agent('security-reviewer'),
    });
    const names = result.entries.map((e) => e.name).sort();
    expect(names).toEqual(['deploy', 'security-reviewer', 'triage']);
    const deploy = result.entries.find((e) => e.name === 'deploy');
    expect(deploy?.kind).toBe('skill');
    expect(deploy?.scope).toBe('user');
    expect(deploy?.slash).toBe('/deploy');
    expect(deploy?.accounts).toEqual(['MAX_A']);
    expect(deploy?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Agent identity comes from frontmatter `name`, not the filename.
    expect(result.entries.some((e) => e.name === 'security-reviewer' && e.kind === 'agent')).toBe(
      true,
    );
  });

  it('projects to a valid catalog-snapshot without leaking frontmatter', async () => {
    const result = await scan({
      '/cfg/max_a/skills/deploy/SKILL.md': skill('deploy', 'type: runbook'),
    });
    const snapshot = scanResultToSnapshot(result);
    expect(snapshot.kind).toBe('catalog-snapshot');
    expect(snapshot.entries).toHaveLength(1);
    const entry = snapshot.entries[0]!;
    // The wire entry carries names/paths/labels only — no frontmatter, no user keys.
    expect(entry).not.toHaveProperty('frontmatter');
    expect(entry).not.toHaveProperty('type');
    expect(Object.keys(entry)).not.toContain('degraded');
  });
});

describe('scanCatalog — PRECEDENCE (DoD)', () => {
  it('enterprise beats user beats project on a name collision', async () => {
    const result = await scan(
      {
        '/managed/skills/deploy/SKILL.md': skill('deploy'),
        '/cfg/max_a/skills/deploy/SKILL.md': skill('deploy'),
        '/ws/.claude/skills/deploy/SKILL.md': skill('deploy'),
      },
      {
        accounts: [{ account: 'MAX_A', configDir: '/cfg/max_a', managedDir: '/managed' }],
        workspace: '/ws',
        repoRoot: '/ws',
      },
    );
    const deploy = result.entries.filter((e) => e.name === 'deploy');
    expect(deploy).toHaveLength(1);
    expect(deploy[0]!.scope).toBe('enterprise'); // enterprise wins
    // The user + project copies are SHADOWED, not lost.
    expect(result.shadowed.filter((e) => e.name === 'deploy').map((e) => e.scope).sort()).toEqual([
      'project',
      'user',
    ]);
  });

  it('a skill beats a command of the same name', async () => {
    const result = await scan({
      '/cfg/max_a/skills/deploy/SKILL.md': skill('deploy'),
      '/cfg/max_a/commands/deploy.md': ['---', 'description: cmd', '---', 'b'].join('\n'),
    });
    const deploy = result.entries.filter((e) => e.name === 'deploy');
    expect(deploy).toHaveLength(1);
    expect(deploy[0]!.kind).toBe('skill'); // skill wins over command
  });
});

describe('scanCatalog — WALK-UP (DoD)', () => {
  it('loads project skills from cwd AND every parent up to the repo root', async () => {
    const result = await scan(
      {
        '/repo/.claude/skills/root-skill/SKILL.md': skill('root-skill'),
        '/repo/apps/web/.claude/skills/web-skill/SKILL.md': skill('web-skill'),
      },
      { workspace: '/repo/apps/web', repoRoot: '/repo' },
    );
    const names = result.entries.map((e) => e.name).sort();
    expect(names).toContain('root-skill'); // from a parent .claude/
    expect(names).toContain('web-skill'); // from the cwd .claude/
  });

  it('nearest .claude wins on a duplicate name during walk-up', async () => {
    const result = await scan(
      {
        '/repo/.claude/skills/deploy/SKILL.md': skill('deploy'),
        '/repo/apps/web/.claude/skills/deploy/SKILL.md': skill('deploy'),
      },
      { workspace: '/repo/apps/web', repoRoot: '/repo' },
    );
    const deploy = result.entries.filter((e) => e.name === 'deploy');
    expect(deploy).toHaveLength(1);
    // Nearest (cwd) source path wins — the deeper .claude.
    expect(deploy[0]!.sourcePath).toBe('/repo/apps/web/.claude/skills/deploy/SKILL.md');
  });

  it('stops at the repo root — a .claude above the ceiling is not scanned', async () => {
    const result = await scan(
      {
        '/above/.claude/skills/outside/SKILL.md': skill('outside'),
        '/above/repo/.claude/skills/inside/SKILL.md': skill('inside'),
      },
      { workspace: '/above/repo', repoRoot: '/above/repo' },
    );
    const names = result.entries.map((e) => e.name);
    expect(names).toContain('inside');
    expect(names).not.toContain('outside');
  });
});

describe('scanCatalog — MALFORMED-YAML SURVIVAL (DoD)', () => {
  it('surfaces a malformed skill as a degraded row, never a crash', async () => {
    const result = await scan({
      '/cfg/max_a/skills/broken/SKILL.md': ['---', 'this: is: not: valid', 'garbage line', '---', 'body'].join(
        '\n',
      ),
      '/cfg/max_a/skills/good/SKILL.md': skill('good'),
    });
    // Both entries appear — the malformed one falls back to its dir name.
    const broken = result.entries.find((e) => e.name === 'broken');
    expect(broken).toBeDefined();
    expect(broken?.degraded?.reason).toBeTruthy();
    expect(broken?.slash).toBe('/broken'); // still invocable by filename
    expect(result.entries.some((e) => e.name === 'good')).toBe(true);
  });
});

describe('scanCatalog — UNKNOWN-KEY PRESERVATION (DoD)', () => {
  it('preserves unknown frontmatter keys scanner-side', async () => {
    const result = await scan({
      '/cfg/max_a/skills/deploy/SKILL.md': ['---', 'name: deploy', 'description: d', 'status: active', 'tags: [ops, prod]', '---', 'b'].join(
        '\n',
      ),
    });
    const deploy = result.entries.find((e) => e.name === 'deploy');
    expect(deploy?.frontmatter?.['status']).toBe('active');
    expect(deploy?.frontmatter?.['tags']).toEqual(['ops', 'prod']);
  });
});

describe('scanCatalog — plugins (install × enablement × scope)', () => {
  const installed = JSON.stringify({
    version: 2,
    plugins: {
      'my-plugin@market': [{ scope: 'user', installPath: '/plug/my-plugin/1.0.0', version: '1.0.0' }],
      'off-plugin@market': [{ scope: 'user', installPath: '/plug/off-plugin/1.0.0' }],
    },
  });

  it('scans an ENABLED plugin and namespaces its capabilities', async () => {
    const result = await scan({
      '/cfg/max_a/plugins/installed_plugins.json': installed,
      '/cfg/max_a/settings.json': JSON.stringify({ enabledPlugins: ['my-plugin@market'] }),
      '/plug/my-plugin/1.0.0/skills/review/SKILL.md': skill('review'),
      '/plug/my-plugin/1.0.0/agents/sec.md': agent('sec'),
      '/plug/off-plugin/1.0.0/skills/nope/SKILL.md': skill('nope'),
    });
    const names = result.entries.map((e) => e.name);
    expect(names).toContain('my-plugin:review'); // namespaced skill
    expect(names).toContain('my-plugin:sec'); // namespaced agent
    // A DISABLED plugin contributes nothing.
    expect(names).not.toContain('nope');
    expect(names.some((n) => n.includes('off-plugin'))).toBe(false);
  });
});

describe('scanCatalog — OpenCode API-first + file fallback', () => {
  it('uses the serve API when present (source of truth)', async () => {
    const source: OpencodeCatalogSource = {
      list: async (): Promise<readonly OpencodeCapability[]> => [
        { name: 'build', kind: 'oc-agent', scope: 'opencode-global' },
        { name: 'deploy', kind: 'oc-command', scope: 'opencode-project' },
      ],
    };
    const result = await scan(
      { '/ws/.opencode/agents/ignored.md': agent('ignored') },
      { workspace: '/ws', opencode: source, opencodeGlobalDir: '/oc' },
    );
    const oc = result.entries.filter((e) => e.backendFamily === 'opencode');
    expect(oc.map((e) => e.name).sort()).toEqual(['build', 'deploy']);
    // API-first: the file `.opencode/agents/ignored.md` is NOT scanned.
    expect(result.entries.some((e) => e.name === 'ignored')).toBe(false);
  });

  it('falls back to file scan when the serve API answers undefined (serve down)', async () => {
    const downSource: OpencodeCatalogSource = { list: async () => undefined };
    const result = await scan(
      { '/ws/.opencode/agents/reviewer.md': agent('reviewer') },
      { workspace: '/ws', opencode: downSource },
    );
    const reviewer = result.entries.find((e) => e.name === 'reviewer');
    expect(reviewer?.kind).toBe('oc-agent');
    expect(reviewer?.backendFamily).toBe('opencode');
    expect(reviewer?.scope).toBe('opencode-project');
  });
});

describe('scanCatalog — workflow scripts (STATIC meta only)', () => {
  it('lists a saved workflow from its meta export without executing it', async () => {
    const script = [
      "export const meta = { name: 'audit-routes', description: 'Audit routes', phases: [{ title: 'Implement' }] }",
      "const x = await agent('do work')", // body — never executed
      'return x',
    ].join('\n');
    const result = await scan({ '/cfg/max_a/workflows/audit.js': script });
    const wf = result.entries.find((e) => e.kind === 'workflow');
    expect(wf?.name).toBe('audit-routes');
    expect(wf?.slash).toBe('/audit-routes');
    expect(wf?.degraded).toBeUndefined();
  });

  it('degrades a workflow with no recoverable meta (filename name)', async () => {
    const result = await scan({ '/cfg/max_a/workflows/mystery.js': 'const x = 1; return x' });
    const wf = result.entries.find((e) => e.kind === 'workflow');
    expect(wf?.name).toBe('mystery'); // filename fallback
    expect(wf?.degraded?.reason).toBeTruthy();
  });
});

describe('scanCatalog — account dimension', () => {
  it('records which accounts a user-scope entry resolves for', async () => {
    const fs = createMemoryCatalogFs({
      '/cfg/max_a/skills/a/SKILL.md': skill('a'),
      '/cfg/ent/skills/b/SKILL.md': skill('b'),
    });
    const result = await scanCatalog({
      fs,
      accounts: [
        { account: 'MAX_A', configDir: '/cfg/max_a' },
        { account: 'ENT', configDir: '/cfg/ent' },
      ],
      nowMs: () => 1,
    });
    expect(result.entries.find((e) => e.name === 'a')?.accounts).toEqual(['MAX_A']);
    expect(result.entries.find((e) => e.name === 'b')?.accounts).toEqual(['ENT']);
  });
});
