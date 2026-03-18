/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Schema, ServiceMap } from "effect";

const SECRET_PATTERNS = [/^\.env$/, /^\.env\..+$/];
const SECRET_EXCEPTIONS = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * normalizes the path shorthands our local tools already accept.
 *
 * this keeps the path contract in one place so file-aware tools do not drift on
 * `@` prefix stripping or `~` expansion.
 */
export function expandPath(filePath: string): string {
  const stripped = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (stripped === "~") return os.homedir();
  if (stripped.startsWith("~/")) return os.homedir() + stripped.slice(1);
  return stripped;
}

export function resolveToAbsolute(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

/**
 * preserves the read tool's existing mac-friendly fallback order.
 *
 * callers already rely on this being tolerant of unicode normalization drift and
 * Finder-style narrow no-break spaces in timestamped names.
 */
export function resolveWithVariantsUsing(
  filePath: string,
  cwd: string,
  exists: (candidate: string) => boolean,
): string {
  const resolved = resolveToAbsolute(filePath, cwd);
  if (exists(resolved)) return resolved;

  const amPm = resolved.replace(/ (AM|PM)\./g, `\u202F$1.`);
  if (amPm !== resolved && exists(amPm)) return amPm;

  const nfd = resolved.normalize("NFD");
  if (nfd !== resolved && exists(nfd)) return nfd;

  return resolved;
}

export function resolveWithVariants(filePath: string, cwd: string): string {
  return resolveWithVariantsUsing(filePath, cwd, (candidate) => fs.existsSync(candidate));
}

export interface ParsedScopedPathArgs {
  targetPaths: string[];
  userPrompt: string;
  invalidPaths: string[];
}

export function parseScopedPathArgs(rawArgs: string, cwd: string): ParsedScopedPathArgs {
  const promptTokens: string[] = [];
  const invalidPaths: string[] = [];
  const targetPaths = new Set<string>();

  for (const token of tokenizeArgs(rawArgs)) {
    const explicitPath = token.startsWith("@");
    const value = explicitPath ? token.slice(1) : token;

    if (!value) {
      if (explicitPath) invalidPaths.push(token);
      continue;
    }

    const resolved = resolveWithVariants(value, cwd);
    if (fs.existsSync(resolved)) {
      targetPaths.add(path.normalize(resolved));
      continue;
    }

    if (explicitPath) {
      invalidPaths.push(token);
      continue;
    }

    promptTokens.push(token);
  }

  return {
    targetPaths: Array.from(targetPaths),
    userPrompt: promptTokens.join(" ").trim(),
    invalidPaths,
  };
}

export function toWorkspaceDisplayPath(filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative;
}

export function isSecretFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (SECRET_EXCEPTIONS.has(basename)) return false;
  return SECRET_PATTERNS.some((p) => p.test(basename));
}

/**
 * keeps directory formatting out of individual tools so `read` and `ls` render
 * the same entries and truncation notices.
 */
function headTailList(items: string[], maxItems: number): string[] {
  if (items.length <= maxItems) return items;
  const half = Math.floor(maxItems / 2);
  return [
    ...items.slice(0, half),
    "",
    `... [${items.length - half * 2} more entries] ...`,
    "",
    ...items.slice(-half),
  ];
}

export function listDirectory(dirPath: string, maxEntries: number): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err: any) {
    throw new Error(`cannot list directory: ${err.message}`);
  }

  const names = entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => a.localeCompare(b));

  return headTailList(names, maxEntries).join("\n");
}

function tokenizeArgs(rawArgs: string): string[] {
  const matches = rawArgs.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? [];
  return matches.map(unquoteToken).filter((token) => token.length > 0);
}

function unquoteToken(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1).replace(/\\([\\'" ])/g, "$1");
  }
  return token.replace(/\\([\\'" ])/g, "$1");
}

export interface WalkDirOptions {
  filter?(entry: fs.Dirent, absolutePath: string): boolean;
  stopWhen?(entry: fs.Dirent, absolutePath: string): boolean;
}

/**
 * tiny recursive walker for local package internals.
 *
 * this is intentionally literal: no hidden ignore rules, no async layer, no
 * glob language. callers keep ownership of filtering and early-stop policy.
 */
export function walkDirSync(rootDir: string, options: WalkDirOptions = {}): string[] {
  const matches: string[] = [];

  const walk = (dir: string): boolean => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);

      if (options.stopWhen?.(entry, absolutePath)) {
        matches.push(absolutePath);
        return true;
      }

      if (options.filter?.(entry, absolutePath)) {
        matches.push(absolutePath);
      }

      if (entry.isDirectory() && walk(absolutePath)) {
        return true;
      }
    }

    return false;
  };

  walk(rootDir);
  return matches;
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class FsError extends Schema.TaggedErrorClass<FsError>()("FsError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class FsService extends ServiceMap.Service<
  FsService,
  {
    /** list directory entries, truncated to maxEntries. */
    readonly listDirectory: (dirPath: string, maxEntries: number) => Effect.Effect<string, FsError>;

    /** recursively walk a directory with filter/stopWhen callbacks. */
    readonly walkDirSync: (
      rootDir: string,
      options?: WalkDirOptions,
    ) => Effect.Effect<string[], FsError>;

    /** resolve a file path with mac-friendly fallback variants. */
    readonly resolveWithVariants: (filePath: string, cwd: string) => Effect.Effect<string, FsError>;
  }
>()("@cvr/pi-fs/index/FsService") {
  static layer = Layer.succeed(FsService, {
    listDirectory: (dirPath, maxEntries) =>
      Effect.try({
        try: () => listDirectory(dirPath, maxEntries),
        catch: (cause) =>
          new FsError({
            message: cause instanceof Error ? cause.message : String(cause),
            path: dirPath,
          }),
      }),

    walkDirSync: (rootDir, options) =>
      Effect.try({
        try: () => walkDirSync(rootDir, options),
        catch: (cause) =>
          new FsError({
            message: cause instanceof Error ? cause.message : String(cause),
            path: rootDir,
          }),
      }),

    resolveWithVariants: (filePath, cwd) =>
      Effect.try({
        try: () => resolveWithVariants(filePath, cwd),
        catch: (cause) =>
          new FsError({
            message: cause instanceof Error ? cause.message : String(cause),
            path: filePath,
          }),
      }),
  });

  static layerTest = (files: Map<string, string | string[]>) =>
    Layer.succeed(FsService, {
      listDirectory: (dirPath) => {
        const value = files.get(dirPath);
        return typeof value === "string"
          ? Effect.succeed(value)
          : Effect.fail(new FsError({ message: `no mock for ${dirPath}`, path: dirPath }));
      },
      walkDirSync: (rootDir) => {
        const value = files.get(rootDir);
        return Array.isArray(value)
          ? Effect.succeed(value)
          : Effect.fail(new FsError({ message: `no mock for ${rootDir}`, path: rootDir }));
      },
      resolveWithVariants: (filePath) => Effect.succeed(filePath),
    });
}

// inline tests live here so the helper seam can move without depending on the
// read tool package for coverage.
