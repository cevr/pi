/**
 * template variable interpolation for subagent system prompts.
 *
 * variables and their resolution strategies are declarative — defined in
 * cvr-pi.json config or passed at call-time. resolver types: runtime,
 * literal, alias, file, env, dangerously_evaluate_js, dangerously_evaluate_sh.
 *
 * resolution order follows a topological sort of inter-variable references,
 * so {varA} can appear inside another variable's expression.
 */

// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import { execSync } from "node:child_process";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as path from "node:path";
import * as vm from "node:vm";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import { getGlobalConfig, resolveConfigDir } from "@cvr/pi-config";

// ── types ──────────────────────────────────────────────────────────────

export type VariableDefinition = {
  /** built-in runtime var key (cwd, roots, date, os, repo, sessionId, ls, identity, harness, harnessDocsSection) */
  runtime?: string;
  /** static string value */
  literal?: string;
  /** reference another variable by name */
  alias?: string;
  /** read file contents — path relative to resolveConfigDir() */
  file?: string;
  /** read environment variable */
  env?: string;
  /** eval JS expression via new Function("require", ...) */
  dangerously_evaluate_js?: string;
  /** run shell command, capture stdout */
  dangerously_evaluate_sh?: string;
  /** fallback when resolver returns empty. supports {var} refs. */
  default?: string;
  /** drop entire template line if var is empty. default true. */
  dropLineIfEmpty?: boolean;
  /** working directory for dangerously_evaluate_sh. supports {var} refs. */
  cwd?: string;
};

export type PromptVariables = Record<string, VariableDefinition>;

const esmRequire = createRequire(import.meta.url);

// ── defaults ───────────────────────────────────────────────────────────

export const DEFAULT_PROMPT_VARIABLES: PromptVariables = {
  cwd: { runtime: "cwd" },
  roots: { runtime: "roots" },
  wsroot: { alias: "roots" },
  workingDir: { alias: "cwd" },
  date: { runtime: "date" },
  os: { runtime: "os" },
  repo: { runtime: "repo" },
  sessionId: { runtime: "sessionId" },
  ls: { runtime: "ls" },
  identity: { runtime: "identity", default: "Amp" },
  harness: { runtime: "harness", default: "pi" },
  harness_docs_section: { runtime: "harnessDocsSection" },
};

// ── existing exports (preserved) ───────────────────────────────────────

/** walk up from dir looking for .git to find the workspace root. falls back to dir itself. */
export function findGitRoot(dir: string): string {
  let current = path.resolve(dir);
  while (true) {
    try {
      const gitPath = path.join(current, ".git");
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) return current;
    } catch {
      // not found, keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return dir;
    current = parent;
  }
}

/** try to get the git remote origin URL for a directory. */
export function getGitRemoteUrl(dir: string): string {
  try {
    return execSync("git remote get-url origin", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/** extra context from the parent pi session — fields are empty when the API doesn't expose them. */
export interface InterpolateContext {
  sessionId?: string;
  repo?: string;
  /** agent identity name, e.g. "Amp". default: "Amp" */
  identity?: string;
  /** harness name, e.g. "pi" or "amp". determines which docs to load. default: "pi" */
  harness?: string;
  /** pre-loaded harness docs section. if provided, skips file read. */
  harnessDocsSection?: string;
}

// ── runtime var computation ────────────────────────────────────────────

/** compute the built-in runtime variables map from cwd + extra context. */
export function computeRuntimeVars(
  cwd: string,
  extra?: InterpolateContext,
): Record<string, string> {
  const roots = findGitRoot(cwd);
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const repo = extra?.repo ?? getGitRemoteUrl(roots);
  const sessionId = extra?.sessionId ?? "";
  let ls = "";
  try {
    ls = fs
      .readdirSync(roots)
      .map((e) => {
        const full = path.join(roots, e);
        try {
          return fs.statSync(full).isDirectory() ? `${full}/` : full;
        } catch {
          return full;
        }
      })
      .join("\n");
  } catch {
    /* graceful */
  }

  return {
    cwd,
    roots,
    date,
    os: `${os.platform()} (${os.release()}) on ${os.arch()}`,
    repo,
    sessionId,
    ls,
    identity: extra?.identity ?? "",
    harness: extra?.harness ?? "",
    harnessDocsSection: extra?.harnessDocsSection ?? "",
  };
}

// ── internal resolution machinery ──────────────────────────────────────

/** find {varName} patterns in a string that reference known variable names. */
function extractRefs(s: string | undefined, knownVars: Set<string>): string[] {
  if (!s) return [];
  const refs: string[] = [];
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const cap = m[1];
    if (cap !== undefined && knownVars.has(cap)) refs.push(cap);
  }
  return refs;
}

/** collect all variable dependencies for a single definition. */
function getDeps(def: VariableDefinition, knownVars: Set<string>): string[] {
  const deps = new Set<string>();
  // alias is a direct var name reference, not a template
  if (def.alias !== undefined && knownVars.has(def.alias)) deps.add(def.alias);
  for (const ref of extractRefs(def.file, knownVars)) deps.add(ref);
  for (const ref of extractRefs(def.dangerously_evaluate_js, knownVars)) deps.add(ref);
  for (const ref of extractRefs(def.dangerously_evaluate_sh, knownVars)) deps.add(ref);
  for (const ref of extractRefs(def.cwd, knownVars)) deps.add(ref);
  for (const ref of extractRefs(def.default, knownVars)) deps.add(ref);
  return [...deps];
}

/** topological sort of variable definitions. throws on cycles. */
function topoSort(defs: PromptVariables): string[] {
  const names = Object.keys(defs);
  const knownVars = new Set(names);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`cycle detected in prompt variables: ${name}`);
    }
    visiting.add(name);
    const def = defs[name];
    if (def) {
      for (const dep of getDeps(def, knownVars)) {
        visit(dep);
      }
    }
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  }

  for (const name of names) visit(name);
  return order;
}

/** substitute already-resolved vars into a string. */
function subVars(s: string, resolved: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (match, key: string) => {
    const val = resolved[key];
    return val !== undefined ? val : match;
  });
}

/**
 * evaluate a js expression with commonjs `require` available, without using
 * the Function constructor so lint can enforce no-implied-eval.
 */
function executeJsExpression(expr: string): unknown {
  const module = { exports: undefined as unknown };
  const exports = module.exports;
  const source = `module.exports = (${expr});`;

  vm.runInNewContext(source, {
    require: esmRequire,
    module,
    exports,
  });

  return module.exports;
}

function stringifyResolvedValue(value: unknown): string {
  if (value == null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return "";
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** resolve a single variable definition to a string value. */
function resolveVariable(
  def: VariableDefinition,
  resolved: Record<string, string>,
  runtimeVars: Record<string, string>,
  configDir?: string,
): string {
  let value = "";

  if (def.runtime !== undefined) {
    value = runtimeVars[def.runtime] ?? "";
  } else if (def.literal !== undefined) {
    value = def.literal;
  } else if (def.alias !== undefined) {
    value = resolved[def.alias] ?? "";
  } else if (def.file !== undefined) {
    const relPath = subVars(def.file, resolved);
    const base = configDir ?? ".";
    const absPath = path.resolve(base, relPath);
    try {
      value = fs.readFileSync(absPath, "utf-8");
    } catch {
      value = "";
    }
  } else if (def.env !== undefined) {
    value = process.env[def.env] ?? "";
  } else if (def.dangerously_evaluate_js !== undefined) {
    const expr = subVars(def.dangerously_evaluate_js, resolved);
    try {
      const result = executeJsExpression(expr);
      value = stringifyResolvedValue(result);
    } catch {
      value = "";
    }
  } else if (def.dangerously_evaluate_sh !== undefined) {
    const cmd = subVars(def.dangerously_evaluate_sh, resolved);
    const shCwd = def.cwd ? subVars(def.cwd, resolved) : undefined;
    try {
      value = execSync(cmd, {
        cwd: shCwd,
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      value = "";
    }
  }

  // apply default if empty
  if (!value && def.default !== undefined) {
    value = subVars(def.default, resolved);
  }

  return value;
}

// ── public API ─────────────────────────────────────────────────────────

/**
 * resolve template variables in agent prompts (e.g. {cwd}, {roots}, {date}).
 *
 * when a value is unavailable and dropLineIfEmpty is true (default),
 * the entire line containing the placeholder is removed rather than
 * leaving an empty label like "Repository: ".
 *
 * merge order: DEFAULT_PROMPT_VARIABLES → global config promptVariables → variables arg.
 */
export function interpolatePromptVars(
  prompt: string,
  cwd: string,
  extra?: InterpolateContext,
  variables?: PromptVariables,
): string {
  // merge variable definitions
  const configVars =
    variables === undefined ? ((getGlobalConfig("promptVariables") as PromptVariables | undefined) ?? {}) : {};
  const merged: PromptVariables = {
    ...DEFAULT_PROMPT_VARIABLES,
    ...configVars,
    ...variables,
  };

  // compute runtime vars
  const runtimeVars = computeRuntimeVars(cwd, extra);
  const configDir = resolveConfigDir();

  // resolve in topological order
  const order = topoSort(merged);
  const resolved: Record<string, string> = {};
  for (const name of order) {
    const def = merged[name];
    if (def) resolved[name] = resolveVariable(def, resolved, runtimeVars, configDir);
  }

  // determine which vars are empty and which are filled, respecting dropLineIfEmpty
  const dropKeys: string[] = [];
  const filled: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    const def = merged[key];
    const drop = def?.dropLineIfEmpty ?? true;
    if (!value && drop) {
      dropKeys.push(key);
    } else {
      filled[key] = value;
    }
  }

  let result = prompt;

  // pass 1: drop entire lines whose var resolved to empty
  if (dropKeys.length > 0) {
    result = result.replace(new RegExp(`^.*\\{(${dropKeys.join("|")})\\}.*\\n?`, "gm"), "");
  }

  // pass 2: substitute all non-empty vars in one pass
  const filledKeys = Object.keys(filled);
  if (filledKeys.length > 0) {
    result = result.replace(
      new RegExp(`\\{(${filledKeys.join("|")})\\}`, "g"),
      (match: string, key: string) => filled[key] ?? match,
    );
  }

  return result;
}

// ── errors ──────────────────────────────────────────────────────────────

export class InterpolateError extends Schema.TaggedErrorClass<InterpolateError>()(
  "InterpolateError",
  { message: Schema.String },
) {}

// ── service ─────────────────────────────────────────────────────────────

export class InterpolateService extends ServiceMap.Service<
  InterpolateService,
  {
    /** resolve template variables in a prompt string. */
    readonly interpolate: (
      prompt: string,
      cwd: string,
      extra?: InterpolateContext,
      variables?: PromptVariables,
    ) => Effect.Effect<string, InterpolateError>;

    /** compute the built-in runtime variables map. */
    readonly runtimeVars: (
      cwd: string,
      extra?: InterpolateContext,
    ) => Effect.Effect<Record<string, string>, InterpolateError>;
  }
>()("@cvr/pi-interpolate/index/InterpolateService") {
  static layer = Layer.succeed(InterpolateService, {
    interpolate: (prompt, cwd, extra, variables) =>
      Effect.try({
        try: () => interpolatePromptVars(prompt, cwd, extra, variables),
        catch: (cause) =>
          new InterpolateError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),

    runtimeVars: (cwd, extra) =>
      Effect.try({
        try: () => computeRuntimeVars(cwd, extra),
        catch: (cause) =>
          new InterpolateError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
  });

  static layerTest = (vars: Record<string, string>) =>
    Layer.succeed(InterpolateService, {
      interpolate: (prompt) => Effect.succeed(prompt),
      runtimeVars: () => Effect.succeed(vars),
    });
}

// ── inline tests ───────────────────────────────────────────────────────
