/**
 * The narrow filesystem port the catalog scanner reads through (BE-8).
 *
 * THE POINT OF THIS PORT (rule 3 / [X2]): the scanner NEVER touches the real
 * `~/.claude` / `~/.config/opencode` account dirs in tests. The catalog test
 * suites drive an in-memory FIXTURE TREE ({@link createMemoryCatalogFs}); the
 * composition root binds the real node:fs adapter ({@link createNodeCatalogFs})
 * ONLY at runtime. This mirrors the kernel's env-injection discipline: the
 * account config dirs are inputs, never hard-wired paths.
 *
 * The port is read-only by construction — there is no write method, so the
 * scanner physically cannot mutate a native store (the [X4] fs-audit rule).
 */

/** One directory entry the scanner needs to classify. */
export interface CatalogDirent {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  /** Symlink target resolution (§1.1 "symlinked skill dirs are followed"). */
  readonly isSymbolicLink: boolean;
}

/**
 * Read-only fs surface. Every method is total: a missing path answers the
 * empty/undefined case, never throws (the scanner treats absence as "surface
 * not present", the common case for a fresh account dir — §1.8 ground truth).
 */
export interface CatalogFs {
  /** File contents as UTF-8, or undefined when the path is absent/not a file. */
  readFile(path: string): string | undefined;
  /** Directory entries, or [] when the path is absent/not a directory. */
  readDir(path: string): readonly CatalogDirent[];
  /** True iff the path exists (file or dir). */
  exists(path: string): boolean;
  /** True iff the path exists and is a directory. */
  isDir(path: string): boolean;
}

// ---------------------------------------------------------------------------
// In-memory fixture fs (tests) — a flat path → content map
// ---------------------------------------------------------------------------

/**
 * A fixture tree: absolute POSIX paths → file contents. Directories are
 * INFERRED from the file paths (any prefix ending in `/` is a directory), so a
 * test just declares the files it wants scanned. Trailing-slash keys with an
 * empty value declare an empty directory explicitly.
 */
export type CatalogFixtureTree = Readonly<Record<string, string>>;

export function createMemoryCatalogFs(tree: CatalogFixtureTree): CatalogFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const registerDirsOf = (path: string): void => {
    // Every ancestor of `path` is a directory.
    let idx = path.indexOf('/', 1);
    while (idx !== -1) {
      dirs.add(path.slice(0, idx));
      idx = path.indexOf('/', idx + 1);
    }
  };

  for (const [rawPath, content] of Object.entries(tree)) {
    if (rawPath.endsWith('/')) {
      const dir = rawPath.slice(0, -1);
      dirs.add(dir);
      registerDirsOf(dir);
      continue;
    }
    files.set(rawPath, content);
    registerDirsOf(rawPath);
  }
  // The root is always a directory.
  dirs.add('');

  const childrenOf = (dir: string): CatalogDirent[] => {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const names = new Set<string>();
    const collect = (path: string): void => {
      if (!path.startsWith(prefix)) return;
      const rest = path.slice(prefix.length);
      if (rest.length === 0) return;
      const slash = rest.indexOf('/');
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    };
    for (const f of files.keys()) collect(f);
    for (const d of dirs) collect(d);

    return [...names].sort().map((name) => {
      const full = `${prefix}${name}`;
      const isFile = files.has(full);
      const isDirectory = dirs.has(full);
      return { name, isDirectory, isFile, isSymbolicLink: false };
    });
  };

  return {
    readFile: (path) => files.get(path),
    readDir: (path) => (dirs.has(path) ? childrenOf(path) : []),
    exists: (path) => files.has(path) || dirs.has(path),
    isDir: (path) => dirs.has(path),
  };
}

// ---------------------------------------------------------------------------
// Real node:fs adapter (runtime only — never used in tests)
// ---------------------------------------------------------------------------

export interface NodeCatalogFsDeps {
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
  readonly readdirSync: (
    path: string,
    options: { withFileTypes: true },
  ) => readonly {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }[];
  readonly statSync: (path: string) => { isDirectory(): boolean } | undefined;
  readonly existsSync: (path: string) => boolean;
}

/**
 * Bind the read-only port to node:fs (the composition root passes the actual
 * `node:fs` sync functions). Every method swallows ENOENT/EACCES into the
 * empty case — the scanner treats an unreadable account dir as an absent
 * surface, never a scan-aborting throw.
 */
export function createNodeCatalogFs(deps: NodeCatalogFsDeps): CatalogFs {
  return {
    readFile: (path) => {
      try {
        return deps.readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    readDir: (path) => {
      try {
        return deps.readdirSync(path, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink(),
        }));
      } catch {
        return [];
      }
    },
    exists: (path) => {
      try {
        return deps.existsSync(path);
      } catch {
        return false;
      }
    },
    isDir: (path) => {
      try {
        return deps.statSync(path)?.isDirectory() ?? false;
      } catch {
        return false;
      }
    },
  };
}
