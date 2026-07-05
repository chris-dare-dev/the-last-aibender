/**
 * THE ONE capability-catalog scanner (BE-8; findings pipeline-workflow-builder
 * §R1, plan §4/BE-8). One scanner, three consumers.
 *
 * SCAN TARGETS (findings §1, exactly):
 *   Claude, per account-config-dir (`CLAUDE_CONFIG_DIR`):
 *     <config>/skills/<name>/SKILL.md      kind `skill`   scope `user`
 *     <config>/commands/**.md              kind `command` scope `user`
 *     <config>/agents/**.md   (recursive)  kind `agent`   scope `user`
 *     <config>/workflows/*.js              kind `workflow` scope `user` (meta-only)
 *     plugins: installed_plugins.json × enabledPlugins × cache trees
 *   Claude, per workspace (walk-up cwd→repo-root + nested subdir discovery):
 *     .claude/{skills,commands,agents,workflows}   scope `project`
 *   OpenCode: API-first (GET /agent + GET /command via an injected source),
 *     file fallback (.opencode/{agents,commands}, ~/.config/opencode/…).
 *
 * ROBUSTNESS (the DoD's four fixture-tree cases):
 *   - PRECEDENCE: enterprise > user > project on a name collision; a skill
 *     beats a command of the same name (§1.1). Shadowed entries are kept
 *     (never silently gone).
 *   - WALK-UP: project skills/agents load from `.claude/` in cwd AND every
 *     parent up to the repo root; nearest wins on a duplicate (§1.1/§1.3).
 *   - MALFORMED-YAML SURVIVAL: a broken frontmatter block → a DEGRADED row
 *     (filename name, no description), never a crashed scan (frontmatter.ts).
 *   - UNKNOWN-KEY PRESERVATION: the full parsed frontmatter (unknown keys
 *     included) rides the scanner-side record (types.ts) — never dropped.
 *
 * The workflow-script surface is parsed STATICALLY (meta regex only) and NEVER
 * executed — enforced by an architectural test (workflowMeta.ts / arch.spec).
 */

import type { AccountLabel } from '@aibender/protocol';
import type { CapabilityKind, CatalogScope } from '@aibender/protocol';

import {
  parseFrontmatter,
  readBoolean,
  readString,
  type Frontmatter,
} from './frontmatter.js';
import type { CatalogFs } from './fs.js';
import { catalogIdOf, contentHashOf } from './hash.js';
import type { CatalogRecord, CatalogScanResult } from './types.js';
import { parseWorkflowMeta } from './workflowMeta.js';

// ---------------------------------------------------------------------------
// OpenCode API-first source (findings §2.4 — the recommended scanner path)
// ---------------------------------------------------------------------------

/** One capability the OpenCode serve API reports (GET /agent | /command). */
export interface OpencodeCapability {
  /** Agent id / command name (post-precedence, resolved by the server). */
  readonly name: string;
  readonly kind: 'oc-agent' | 'oc-command';
  /** The config layer the server resolved it from, when known. */
  readonly scope?: 'opencode-global' | 'opencode-project';
  /** Source file the server reports, when known (else a synthetic api ref). */
  readonly sourcePath?: string;
  readonly description?: string;
}

/**
 * API-first OpenCode discovery (findings §2.4). The composition root binds
 * this to a supervised `opencode serve` (`GET /agent` + `GET /command` via
 * BE-4's client). Absent → the scanner falls back to file parsing. Tests
 * inject a fake source (never a real serve). The method NEVER throws — a serve
 * that is down answers `undefined`, and the scanner file-fallbacks.
 */
export interface OpencodeCatalogSource {
  list(workspace: string | undefined): Promise<readonly OpencodeCapability[] | undefined>;
}

// ---------------------------------------------------------------------------
// Scanner options
// ---------------------------------------------------------------------------

/** One Claude account config dir the scanner resolves user/plugin scope for. */
export interface AccountConfigDir {
  readonly account: AccountLabel;
  /** Absolute `CLAUDE_CONFIG_DIR` for this account (e.g. `~/.aibender/cfg/max_a`). */
  readonly configDir: string;
  /**
   * `enterprise`-scope managed settings dir for this account, when present
   * (§1.1: enterprise skills/agents win over user). Absent → no enterprise
   * scope for this account.
   */
  readonly managedDir?: string;
}

export interface ScanCatalogOptions {
  readonly fs: CatalogFs;
  /**
   * The Claude accounts to resolve user/enterprise/plugin scope for. The scan
   * result's `accounts` field on a user/plugin entry lists which of these it
   * resolves for (findings §R3: "a skill in MAX_A's config dir doesn't exist
   * for ENT runs").
   */
  readonly accounts: readonly AccountConfigDir[];
  /**
   * The workspace to resolve PROJECT scope for (absolute). Absent → user/
   * global only (the launcher's account-only palette). The scanner walks up
   * from here to `repoRoot` (or the fs root when repoRoot is absent).
   */
  readonly workspace?: string;
  /**
   * Repo root (absolute) — the walk-up ceiling (§1.1 "every parent up to the
   * repository root"). Absent → walk to the filesystem root.
   */
  readonly repoRoot?: string;
  /** API-first OpenCode source (findings §2.4). Absent → file fallback. */
  readonly opencode?: OpencodeCatalogSource;
  /**
   * OpenCode config dirs for the file-fallback path (`~/.config/opencode`
   * global; `<workspace>/.opencode` project). Absent → no OpenCode file scan.
   */
  readonly opencodeGlobalDir?: string;
  /** Epoch-ms clock (tests pin it). */
  readonly nowMs?: () => number;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const SKILL_FILE = 'SKILL.md';

/**
 * Scan every surface for one (workspace, accounts) resolution and return the
 * precedence-resolved palette. Never throws (a broken file is a degraded row).
 */
export async function scanCatalog(options: ScanCatalogOptions): Promise<CatalogScanResult> {
  const { fs } = options;
  const nowMs = options.nowMs ?? Date.now;
  const raw: CatalogRecord[] = [];

  // -- Claude, per account config dir: enterprise + user scope + plugins -----
  for (const account of options.accounts) {
    if (account.managedDir !== undefined) {
      raw.push(...scanClaudeConfigTree(fs, account.managedDir, 'enterprise', account.account));
    }
    raw.push(...scanClaudeConfigTree(fs, account.configDir, 'user', account.account));
    raw.push(...scanPlugins(fs, account.configDir, account.account));
  }

  // -- Claude, per workspace: project scope with walk-up + nested subdirs ----
  if (options.workspace !== undefined) {
    raw.push(...scanProjectTrees(fs, options.workspace, options.repoRoot));
  }

  // -- OpenCode: API-first, file fallback ------------------------------------
  const oc = await scanOpencode(options);
  raw.push(...oc);

  // -- precedence resolution -------------------------------------------------
  const { entries, shadowed } = resolvePrecedence(raw);

  return {
    capturedAt: nowMs(),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    entries,
    shadowed,
  };
}

// ---------------------------------------------------------------------------
// Claude config-dir scan (skills / commands / agents / workflows)
// ---------------------------------------------------------------------------

function scanClaudeConfigTree(
  fs: CatalogFs,
  configDir: string,
  scope: CatalogScope,
  account: AccountLabel,
): CatalogRecord[] {
  const out: CatalogRecord[] = [];
  out.push(...scanSkills(fs, join(configDir, 'skills'), scope, account, undefined, ''));
  out.push(...scanCommands(fs, join(configDir, 'commands'), scope, account, undefined, ''));
  out.push(...scanAgents(fs, join(configDir, 'agents'), scope, account, undefined, ''));
  out.push(...scanWorkflows(fs, join(configDir, 'workflows'), scope, account, undefined));
  return out;
}

/**
 * Skills live one dir deep: `<root>/<skill-name>/SKILL.md`. `namePrefix`
 * carries the monorepo directory-qualified prefix (`apps/web:`) for nested
 * discovery (§1.1). A folder with `.claude-plugin/plugin.json` is a
 * skills-directory plugin (§1.1) — surfaced as a `skill` still (the plugin
 * scan handles the plugin dimension).
 */
function scanSkills(
  fs: CatalogFs,
  skillsRoot: string,
  scope: CatalogScope,
  account: AccountLabel,
  workspace: string | undefined,
  namePrefix: string,
): CatalogRecord[] {
  const out: CatalogRecord[] = [];
  for (const entry of fs.readDir(skillsRoot)) {
    if (!entry.isDirectory) continue;
    const skillDir = join(skillsRoot, entry.name);
    const skillFile = join(skillDir, SKILL_FILE);
    const source = fs.readFile(skillFile);
    if (source === undefined) continue;
    const invocationName = `${namePrefix}${defaultName(entry.name)}`;
    out.push(
      buildRecord(fs, {
        kind: 'skill',
        scope,
        account,
        workspace,
        sourcePath: skillFile,
        source,
        fallbackName: invocationName,
      }),
    );
  }
  return out;
}

/**
 * Commands are FLAT `.md` files; subdirectories NAMESPACE them
 * (`git/commit.md` → `/git:commit`). Recursive.
 */
function scanCommands(
  fs: CatalogFs,
  commandsRoot: string,
  scope: CatalogScope,
  account: AccountLabel,
  workspace: string | undefined,
  namePrefix: string,
): CatalogRecord[] {
  const out: CatalogRecord[] = [];
  for (const entry of fs.readDir(commandsRoot)) {
    const path = join(commandsRoot, entry.name);
    if (entry.isDirectory) {
      out.push(
        ...scanCommands(fs, path, scope, account, workspace, `${namePrefix}${entry.name}:`),
      );
      continue;
    }
    if (!entry.isFile || !entry.name.endsWith('.md')) continue;
    const source = fs.readFile(path);
    if (source === undefined) continue;
    const base = entry.name.slice(0, -'.md'.length);
    out.push(
      buildRecord(fs, {
        kind: 'command',
        scope,
        account,
        workspace,
        sourcePath: path,
        source,
        fallbackName: `${namePrefix}${base}`,
      }),
    );
  }
  return out;
}

/**
 * Agents are `.md` files, scanned RECURSIVELY; subfolders are organizational
 * only — identity is the `name` frontmatter (§1.3). Falls back to the filename
 * on a missing/degraded `name`.
 */
function scanAgents(
  fs: CatalogFs,
  agentsRoot: string,
  scope: CatalogScope,
  account: AccountLabel,
  workspace: string | undefined,
  _subPath: string,
): CatalogRecord[] {
  const out: CatalogRecord[] = [];
  for (const entry of fs.readDir(agentsRoot)) {
    const path = join(agentsRoot, entry.name);
    if (entry.isDirectory) {
      out.push(...scanAgents(fs, path, scope, account, workspace, `${_subPath}${entry.name}/`));
      continue;
    }
    if (!entry.isFile || !entry.name.endsWith('.md')) continue;
    const source = fs.readFile(path);
    if (source === undefined) continue;
    const base = entry.name.slice(0, -'.md'.length);
    out.push(
      buildRecord(fs, {
        kind: 'agent',
        scope,
        account,
        workspace,
        sourcePath: path,
        source,
        fallbackName: base,
        // Agent identity is the frontmatter `name` when present (§1.3).
        nameFromFrontmatterKey: 'name',
      }),
    );
  }
  return out;
}

/**
 * Saved dynamic-workflow scripts (`.js`). STATIC `meta` parse ONLY — the
 * script is NEVER executed (findings §R4 / rule 3, arch-tested). A script with
 * no recoverable `meta` still lists (filename name) as a degraded workflow.
 */
function scanWorkflows(
  fs: CatalogFs,
  workflowsRoot: string,
  scope: CatalogScope,
  account: AccountLabel,
  workspace: string | undefined,
): CatalogRecord[] {
  const out: CatalogRecord[] = [];
  for (const entry of fs.readDir(workflowsRoot)) {
    if (!entry.isFile || !entry.name.endsWith('.js')) continue;
    const path = join(workflowsRoot, entry.name);
    const source = fs.readFile(path);
    if (source === undefined) continue;
    const base = entry.name.slice(0, -'.js'.length);
    const meta = parseWorkflowMeta(source);
    const name = meta.ok && meta.name !== undefined ? meta.name : base;
    out.push({
      capId: catalogIdOf({ kind: 'workflow', scope, name, sourcePath: path, workspace }),
      kind: 'workflow',
      name,
      scope,
      backendFamily: 'claude',
      ...(workspace !== undefined ? { workspace } : {}),
      sourcePath: path,
      contentHash: contentHashOf(source),
      slash: `/${name}`,
      accounts: [account],
      ...(meta.ok
        ? {}
        : { degraded: { reason: meta.reason } }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project (workspace) trees — walk-up + nested discovery
// ---------------------------------------------------------------------------

/**
 * Scan `.claude/{skills,commands,agents,workflows}` at the cwd AND every
 * parent up to `repoRoot` (§1.1 walk-up). NESTED subdir discovery (§1.1) is
 * handled inside `scanSkills` via the directory-qualified name prefix. The
 * account dimension for project entries is left unset (project entries resolve
 * for any account whose cwd matches).
 */
function scanProjectTrees(
  fs: CatalogFs,
  workspace: string,
  repoRoot: string | undefined,
): CatalogRecord[] {
  const out: CatalogRecord[] = [];
  for (const dir of walkUpDirs(workspace, repoRoot)) {
    const dotClaude = join(dir, '.claude');
    if (!fs.isDir(dotClaude)) continue;
    // The name prefix qualifies nested (below-cwd) skill dirs; walk-up dirs
    // above cwd contribute unqualified names (§1.1 "loads from every parent").
    out.push(...scanSkills(fs, join(dotClaude, 'skills'), 'project', firstAccount(), workspace, ''));
    out.push(
      ...scanCommands(fs, join(dotClaude, 'commands'), 'project', firstAccount(), workspace, ''),
    );
    out.push(...scanAgents(fs, join(dotClaude, 'agents'), 'project', firstAccount(), workspace, ''));
    out.push(...scanWorkflows(fs, join(dotClaude, 'workflows'), 'project', firstAccount(), workspace));
  }
  return out;
}

/** Project entries are account-agnostic; a placeholder is not stored on them. */
function firstAccount(): AccountLabel {
  return 'MAX_A';
}

/** cwd, its parent, … up to (and including) repoRoot / the fs root. */
function walkUpDirs(start: string, ceiling: string | undefined): string[] {
  const dirs: string[] = [];
  let current = normalizeDir(start);
  const top = ceiling !== undefined ? normalizeDir(ceiling) : '';
  for (;;) {
    dirs.push(current);
    if (current === top || current === '' || current === '/') break;
    const parent = current.slice(0, current.lastIndexOf('/'));
    if (parent === current) break;
    current = parent === '' ? '/' : parent;
    if (dirs.length > 256) break; // pathological-depth guard
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Plugins — install-state × enablement × scope (§1.4)
// ---------------------------------------------------------------------------

/**
 * Join install state × enablement × scope to answer "what plugin capabilities
 * can this account invoke" (§1.4). Reads:
 *   <config>/plugins/installed_plugins.json  → installed trees
 *   <config>/settings.json enabledPlugins    → which are on
 * Then scans each ENABLED plugin's skills/commands/agents at its install path.
 * A plugin that is installed but not enabled contributes NOTHING (findings
 * §1.4 "the scanner must join install state × enablement × scope").
 */
function scanPlugins(
  fs: CatalogFs,
  configDir: string,
  account: AccountLabel,
): CatalogRecord[] {
  const installedRaw = fs.readFile(join(configDir, 'plugins', 'installed_plugins.json'));
  const settingsRaw = fs.readFile(join(configDir, 'settings.json'));
  if (installedRaw === undefined) return [];

  const installed = safeJson(installedRaw);
  const settings = settingsRaw !== undefined ? safeJson(settingsRaw) : {};
  const enabled = enabledPluginKeys(settings);

  const pluginsObj = isRecord(installed) ? installed['plugins'] : undefined;
  if (!isRecord(pluginsObj)) return [];

  const out: CatalogRecord[] = [];
  for (const [key, entries] of Object.entries(pluginsObj)) {
    // `key` is `<name>@<marketplace>`; enablement keys match it.
    if (!enabled.has(key)) continue;
    if (!Array.isArray(entries)) continue;
    for (const install of entries) {
      if (!isRecord(install)) continue;
      const installPath = install['installPath'];
      if (typeof installPath !== 'string' || installPath.length === 0) continue;
      const pluginName = key.split('@')[0] ?? key;
      // Plugin skills/commands/agents are namespaced `plugin-name:capability`.
      out.push(
        ...scanSkills(fs, join(installPath, 'skills'), 'plugin', account, undefined, `${pluginName}:`),
      );
      out.push(
        ...scanCommands(fs, join(installPath, 'commands'), 'plugin', account, undefined, `${pluginName}:`),
      );
      out.push(...scanPluginAgents(fs, join(installPath, 'agents'), account, pluginName));
    }
  }
  return out;
}

/** Plugin agents get the `plugin-name:agent` scoped id (§1.3). */
function scanPluginAgents(
  fs: CatalogFs,
  agentsRoot: string,
  account: AccountLabel,
  pluginName: string,
): CatalogRecord[] {
  const records = scanAgents(fs, agentsRoot, 'plugin', account, undefined, '');
  return records.map((r) => ({
    ...r,
    name: `${pluginName}:${r.name}`,
    capId: catalogIdOf({
      kind: 'agent',
      scope: 'plugin',
      name: `${pluginName}:${r.name}`,
      sourcePath: r.sourcePath,
    }),
  }));
}

function enabledPluginKeys(settings: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!isRecord(settings)) return keys;
  const enabledPlugins = settings['enabledPlugins'];
  if (Array.isArray(enabledPlugins)) {
    for (const k of enabledPlugins) if (typeof k === 'string') keys.add(k);
  } else if (isRecord(enabledPlugins)) {
    // `{ "name@marketplace": true }` form.
    for (const [k, v] of Object.entries(enabledPlugins)) if (v === true) keys.add(k);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// OpenCode — API-first (findings §2.4) with file fallback
// ---------------------------------------------------------------------------

async function scanOpencode(options: ScanCatalogOptions): Promise<CatalogRecord[]> {
  const { fs } = options;
  // API-FIRST: the serve API resolves precedence/JSONC/npm-plugins for free.
  if (options.opencode !== undefined) {
    const caps = await options.opencode.list(options.workspace);
    if (caps !== undefined) {
      return caps.map((cap) => opencodeApiRecord(cap, options.workspace));
    }
    // undefined → serve down; fall through to file scan.
  }

  // FILE FALLBACK: `.opencode/{agents,commands}` (project) + global config.
  const out: CatalogRecord[] = [];
  const roots: { dir: string; scope: 'opencode-global' | 'opencode-project'; ws?: string }[] = [];
  if (options.opencodeGlobalDir !== undefined) {
    roots.push({ dir: options.opencodeGlobalDir, scope: 'opencode-global' });
  }
  if (options.workspace !== undefined) {
    roots.push({ dir: join(options.workspace, '.opencode'), scope: 'opencode-project', ws: options.workspace });
  }
  for (const root of roots) {
    out.push(...scanOpencodeFiles(fs, join(root.dir, 'agents'), 'oc-agent', root.scope, root.ws));
    // Older installs use singular `agent/` (findings §2.1) — scan both.
    out.push(...scanOpencodeFiles(fs, join(root.dir, 'agent'), 'oc-agent', root.scope, root.ws));
    out.push(...scanOpencodeFiles(fs, join(root.dir, 'commands'), 'oc-command', root.scope, root.ws));
    out.push(...scanOpencodeFiles(fs, join(root.dir, 'command'), 'oc-command', root.scope, root.ws));
  }
  return out;
}

function scanOpencodeFiles(
  fs: CatalogFs,
  root: string,
  kind: 'oc-agent' | 'oc-command',
  scope: 'opencode-global' | 'opencode-project',
  workspace: string | undefined,
): CatalogRecord[] {
  const out: CatalogRecord[] = [];
  for (const entry of fs.readDir(root)) {
    if (!entry.isFile || !entry.name.endsWith('.md')) continue;
    const path = join(root, entry.name);
    const source = fs.readFile(path);
    if (source === undefined) continue;
    const base = entry.name.slice(0, -'.md'.length);
    const record = buildRecord(fs, {
      kind,
      scope,
      account: undefined,
      workspace,
      sourcePath: path,
      source,
      fallbackName: base,
    });
    out.push({ ...record, backendFamily: 'opencode' });
  }
  return out;
}

function opencodeApiRecord(cap: OpencodeCapability, workspace: string | undefined): CatalogRecord {
  const scope: CatalogScope = cap.scope ?? 'opencode-global';
  const sourcePath = cap.sourcePath ?? `opencode-serve://${cap.kind}/${cap.name}`;
  return {
    capId: catalogIdOf({ kind: cap.kind, scope, name: cap.name, sourcePath, workspace }),
    kind: cap.kind,
    name: cap.name,
    scope,
    backendFamily: 'opencode',
    ...(workspace !== undefined ? { workspace } : {}),
    sourcePath,
    // The API path has no file bytes to hash; the server-reported identity is
    // the drift anchor (name@scope). A file path, when present, would be
    // hashed in a later pass; API entries pin on name+scope.
    contentHash: contentHashOf(`${cap.kind}:${scope}:${cap.name}`),
    slash: cap.kind === 'oc-command' ? `/${cap.name}` : `@${cap.name}`,
  };
}

// ---------------------------------------------------------------------------
// Record construction (the merged parser feeds every kind)
// ---------------------------------------------------------------------------

interface BuildRecordInput {
  readonly kind: CapabilityKind;
  readonly scope: CatalogScope;
  readonly account: AccountLabel | undefined;
  readonly workspace: string | undefined;
  readonly sourcePath: string;
  readonly source: string;
  readonly fallbackName: string;
  /** When set, prefer this frontmatter key for the name (agents use `name`). */
  readonly nameFromFrontmatterKey?: string;
}

function buildRecord(_fs: CatalogFs, input: BuildRecordInput): CatalogRecord {
  const parsed = parseFrontmatter(input.source);
  const backendFamily = 'claude';

  if (!parsed.ok) {
    // DEGRADED: filename name, no description — never a crash (the DoD case).
    const name = input.fallbackName;
    return {
      capId: catalogIdOf({
        kind: input.kind,
        scope: input.scope,
        name,
        sourcePath: input.sourcePath,
        workspace: input.workspace,
      }),
      kind: input.kind,
      name,
      scope: input.scope,
      backendFamily,
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
      sourcePath: input.sourcePath,
      contentHash: contentHashOf(input.source),
      ...(slashFor(input.kind, name) !== undefined ? { slash: slashFor(input.kind, name)! } : {}),
      ...(input.account !== undefined ? { accounts: [input.account] } : {}),
      degraded: { reason: parsed.reason },
    };
  }

  const fm: Frontmatter = parsed.frontmatter;
  // The invocation name comes from the frontmatter ONLY when the caller opts
  // in (agents: identity is the `name` field, §1.3). Skills/commands are named
  // by their directory/file (§1.1 — the frontmatter `name` sets the command
  // name only for a plugin-root SKILL.md, which is not this path), so the
  // namespaced fallbackName (`my-plugin:review`) must win for them.
  const nameFromFm =
    input.nameFromFrontmatterKey !== undefined
      ? readString(fm, input.nameFromFrontmatterKey)
      : undefined;
  const name = nameFromFm ?? input.fallbackName;
  const argumentHint = readString(fm, 'argument-hint');
  const disableModelInvocation = readBoolean(fm, 'disable-model-invocation');

  return {
    capId: catalogIdOf({
      kind: input.kind,
      scope: input.scope,
      name,
      sourcePath: input.sourcePath,
      workspace: input.workspace,
    }),
    kind: input.kind,
    name,
    scope: input.scope,
    backendFamily,
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    sourcePath: input.sourcePath,
    contentHash: contentHashOf(input.source),
    ...(slashFor(input.kind, name) !== undefined ? { slash: slashFor(input.kind, name)! } : {}),
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(input.account !== undefined ? { accounts: [input.account] } : {}),
    frontmatter: fm,
  };
}

/** Skills/commands are slash-invocable; agents are `@`-mentioned. */
function slashFor(kind: CapabilityKind, name: string): string | undefined {
  if (kind === 'skill' || kind === 'command') return `/${name}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Precedence resolution (§1.1 enterprise > user > project; skill > command)
// ---------------------------------------------------------------------------

/** Lower number wins (highest precedence). Plugin entries are namespaced so
 *  never collide with non-plugin entries (§1.1). */
const SCOPE_RANK: Readonly<Record<CatalogScope, number>> = {
  enterprise: 0,
  user: 1,
  project: 2,
  plugin: 3,
  'opencode-global': 4,
  'opencode-project': 3, // project OpenCode beats global (§2.1)
};

/** On a same-scope, same-name collision, a skill beats a command (§1.1). */
const KIND_RANK: Readonly<Record<CapabilityKind, number>> = {
  skill: 0,
  agent: 0,
  workflow: 0,
  'oc-agent': 0,
  'oc-command': 0,
  plugin: 0,
  command: 1,
};

function resolvePrecedence(records: readonly CatalogRecord[]): {
  entries: CatalogRecord[];
  shadowed: CatalogRecord[];
} {
  // Collisions are per (backendFamily, invocation name). An agent named
  // `review` and a skill named `review` are DIFFERENT invocation surfaces
  // (`@review` vs `/review`), so we key on kind-family too: slash-invocables
  // (skill/command) collide with each other; agents/workflows/oc-* are their
  // own namespaces.
  const winners = new Map<string, CatalogRecord>();
  const shadowed: CatalogRecord[] = [];

  const collisionKey = (r: CatalogRecord): string => `${namespaceOf(r.kind)} ${r.name}`;

  for (const record of records) {
    const key = collisionKey(record);
    const current = winners.get(key);
    if (current === undefined) {
      winners.set(key, record);
      continue;
    }
    if (rankOf(record) < rankOf(current)) {
      shadowed.push(current);
      winners.set(key, record);
    } else {
      shadowed.push(record);
    }
  }
  return { entries: [...winners.values()], shadowed };
}

/** Which invocation namespace a kind lives in (collisions are within one). */
function namespaceOf(kind: CapabilityKind): string {
  if (kind === 'skill' || kind === 'command') return 'slash';
  if (kind === 'agent') return 'agent';
  if (kind === 'oc-agent') return 'oc-agent';
  if (kind === 'oc-command') return 'oc-command';
  return kind; // workflow, plugin
}

function rankOf(r: CatalogRecord): number {
  // Scope dominates; kind breaks a same-scope tie (skill > command).
  return SCOPE_RANK[r.scope] * 10 + KIND_RANK[r.kind];
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** POSIX join that never doubles slashes; absolute inputs stay absolute. */
function join(base: string, ...parts: string[]): string {
  let out = base.endsWith('/') ? base.slice(0, -1) : base;
  for (const part of parts) {
    const clean = part.startsWith('/') ? part.slice(1) : part;
    out = `${out}/${clean.endsWith('/') ? clean.slice(0, -1) : clean}`;
  }
  return out;
}

function normalizeDir(dir: string): string {
  const trimmed = dir.endsWith('/') && dir.length > 1 ? dir.slice(0, -1) : dir;
  return trimmed;
}

/** Skill/agent folder name → default invocation name (dir name, §1.1). */
function defaultName(dirName: string): string {
  return dirName;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
