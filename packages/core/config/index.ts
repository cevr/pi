/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
/**
 * shared config reader for pi extensions.
 *
 * reads per-extension configuration from pi's settings.json files,
 * keyed by extension namespace (e.g. `"@cvr/pi-librarian"`).
 *
 * merge order: defaults → global (setGlobalSettingsPath() |
 * PI_CVR_CONFIG_PATH | ~/.pi/agent/cvr-pi.json) → project-local
 * (.pi/settings.json). project-local is opt-in via `allowProjectConfig`
 * to prevent malicious repo overrides.
 *
 * sync API only — config bootstrap is synchronous by design (called at
 * extension init for the enabled gate). Effect wrapping adds no value here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// encapsulated config state — no bare module-level mutable variables
// ---------------------------------------------------------------------------

const _state = {
  globalSettingsPath: null as string | null,
  cache: new Map<string, unknown>(),
};

export function setGlobalSettingsPath(p: string): void {
  _state.globalSettingsPath = p;
}

export function clearConfigCache(): void {
  _state.cache.clear();
}

export function resolveGlobalSettingsPath(): string {
  return (
    _state.globalSettingsPath ??
    process.env.PI_CVR_CONFIG_PATH ??
    path.join(os.homedir(), ".pi", "agent", "cvr-pi.json")
  );
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (_state.cache.has(filePath)) {
    return _state.cache.get(filePath) as Record<string, unknown> | null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    _state.cache.set(filePath, parsed);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[@cvr/pi-config] failed to read ${filePath}:`, err);
    }
    _state.cache.set(filePath, null);
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: Record<string, unknown>): T {
  const result = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override)) {
    const baseVal = result[key];
    const overVal = override[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = deepMerge(baseVal, overVal);
    } else {
      result[key] = overVal;
    }
  }
  return result as T;
}

export interface GetExtensionConfigOpts {
  cwd?: string;
  allowProjectConfig?: boolean;
}

export interface ExtensionConfigSchema<T extends Record<string, unknown>> {
  /**
   * validates merged config before it is returned.
   * `getEnabledExtensionConfig()` strips the reserved `enabled` flag first.
   * return false to fall back to defaults.
   */
  validate?: (value: Record<string, unknown>) => value is T;
  /** normalize a validated config before it is returned. */
  normalize?: (value: T) => T;
}

export interface GetExtensionConfigWithSchemaOpts<
  T extends Record<string, unknown>,
> extends GetExtensionConfigOpts {
  schema?: ExtensionConfigSchema<T>;
}

export interface EnabledExtensionConfig<T extends Record<string, unknown>> {
  enabled: boolean;
  config: T;
}

type RawExtensionConfig = Record<string, unknown> & {
  enabled?: unknown;
};

function stripEnabledFlag(value: Record<string, unknown>): Record<string, unknown> {
  const { enabled: _enabled, ...rest } = value as RawExtensionConfig;
  return rest;
}

function applyExtensionSchema<T extends Record<string, unknown>>(
  namespace: string,
  candidate: Record<string, unknown>,
  defaults: T,
  schema?: ExtensionConfigSchema<T>,
): T {
  if (schema?.validate && !schema.validate(candidate)) {
    console.error(`[@cvr/pi-config] invalid config for ${namespace}; falling back to defaults.`);
    return schema.normalize ? schema.normalize(defaults) : defaults;
  }

  const config = candidate as T;
  return schema?.normalize ? schema.normalize(config) : config;
}

export function getExtensionConfig<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  opts?: GetExtensionConfigOpts,
): T {
  let merged = { ...defaults };

  const globalPath = resolveGlobalSettingsPath();
  const globalSettings = readJsonFile(globalPath);
  if (globalSettings && isPlainObject(globalSettings[namespace])) {
    merged = deepMerge(merged, globalSettings[namespace] as Record<string, unknown>);
  }

  if (opts?.allowProjectConfig && opts.cwd) {
    const projectPath = path.join(opts.cwd, ".pi", "settings.json");
    const projectSettings = readJsonFile(projectPath);
    if (projectSettings && isPlainObject(projectSettings[namespace])) {
      merged = deepMerge(merged, projectSettings[namespace] as Record<string, unknown>);
    }
  }

  return merged;
}

export function getExtensionConfigWithSchema<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  opts?: GetExtensionConfigWithSchemaOpts<T>,
): T {
  const merged = getExtensionConfig(namespace, defaults, opts);
  return applyExtensionSchema(namespace, merged, defaults, opts?.schema);
}

export function getEnabledExtensionConfig<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  opts?: GetExtensionConfigWithSchemaOpts<T>,
): EnabledExtensionConfig<T> {
  const merged = getExtensionConfig(namespace, defaults, opts) as RawExtensionConfig;
  const enabled = typeof merged.enabled === "boolean" ? merged.enabled : true;
  const config = applyExtensionSchema(namespace, stripEnabledFlag(merged), defaults, opts?.schema);

  return { enabled, config };
}

/** read a top-level (non-namespaced) key from the global settings file. */
export function getGlobalConfig<T>(key: string): T | undefined {
  const globalPath = resolveGlobalSettingsPath();
  const settings = readJsonFile(globalPath);
  if (!settings || !(key in settings)) return undefined;
  return settings[key] as T;
}

/** directory containing the global settings file (e.g. ~/.pi/agent/). */
export function resolveConfigDir(): string {
  return path.dirname(resolveGlobalSettingsPath());
}
