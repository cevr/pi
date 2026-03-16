/**
 * permission evaluation for tool calls.
 *
 * reads rules from ~/.pi/agent/permissions.json. rules are evaluated
 * first-match-wins, matching tool name and params via glob patterns.
 * default action when no rule matches: allow.
 *
 * `Permissions` Effect service for loading rules + evaluating.
 * `evaluatePermission` pure function for direct use.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Effect, Layer, Schema, ServiceMap } from "effect";

// ---------------------------------------------------------------------------
// schemas + types
// ---------------------------------------------------------------------------

const PermissionRuleSchema = Schema.Struct({
  tool: Schema.String,
  matches: Schema.optional(
    Schema.Struct({
      cmd: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    }),
  ),
  action: Schema.Literals(["allow", "reject"]),
  message: Schema.optional(Schema.String),
});

export type PermissionRule = typeof PermissionRuleSchema.Type;

const PermissionRulesFromJson = Schema.fromJsonString(Schema.Array(PermissionRuleSchema));
const _decodeRules = Schema.decodeUnknownEffect(PermissionRulesFromJson);

export interface PermissionVerdict {
  action: "allow" | "reject";
  message?: string;
}

// ---------------------------------------------------------------------------
// pure evaluation (shared by Effect and legacy paths)
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${withWildcards}$`, "i");
}

export function evaluatePermission(
  toolName: string,
  params: { cmd?: string },
  rules: PermissionRule[],
): PermissionVerdict {
  for (const rule of rules) {
    if (!globToRegex(rule.tool).test(toolName)) continue;

    if (rule.matches?.cmd) {
      const patterns = Array.isArray(rule.matches.cmd) ? rule.matches.cmd : [rule.matches.cmd];
      if (!patterns.some((p) => globToRegex(p).test(params.cmd ?? ""))) continue;
    }

    return { action: rule.action, message: rule.message };
  }

  return { action: "allow" };
}

// ---------------------------------------------------------------------------
// shared loader
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}

/** Read + decode permissions from disk. Missing file → []. Malformed/unreadable → FAIL_CLOSED. */
export function decodePermissionsFile(filePath: string): PermissionRule[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (isEnoent(err)) return []; // no file → no rules → allow all
    console.error(
      `[@cvr/pi-permissions] cannot read ${filePath} — rejecting all tool calls until fixed`,
    );
    return FAIL_CLOSED_RULES;
  }
  try {
    return decodeRulesSync(raw);
  } catch {
    console.error(
      `[@cvr/pi-permissions] malformed ${filePath} — rejecting all tool calls until fixed`,
    );
    return FAIL_CLOSED_RULES;
  }
}

/** Rules that reject everything — used when permissions file is malformed or unreadable. */
const FAIL_CLOSED_RULES: PermissionRule[] = [
  {
    tool: "*",
    action: "reject",
    message: "permissions.json is malformed — all tools blocked until fixed",
  },
];

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class Permissions extends ServiceMap.Service<
  Permissions,
  {
    readonly loadRules: () => Effect.Effect<PermissionRule[]>;
    readonly evaluate: (
      toolName: string,
      params: { cmd?: string },
    ) => Effect.Effect<PermissionVerdict>;
  }
>()("@cvr/pi-permissions/index/Permissions") {
  static readonly FAIL_CLOSED = FAIL_CLOSED_RULES;

  static layer = (permissionsPath?: string) => {
    const p = permissionsPath ?? nodePath.join(os.homedir(), ".pi", "agent", "permissions.json");

    return Layer.succeed(Permissions, {
      loadRules: () => Effect.sync(() => decodePermissionsFile(p)),

      evaluate: (toolName: string, params: { cmd?: string }) =>
        Effect.sync(() => evaluatePermission(toolName, params, decodePermissionsFile(p))),
    });
  };

  static layerTest = (rules: PermissionRule[]) =>
    Layer.succeed(Permissions, {
      loadRules: () => Effect.succeed(rules),
      evaluate: (toolName: string, params: { cmd?: string }) =>
        Effect.succeed(evaluatePermission(toolName, params, rules)),
    });
}

// ---------------------------------------------------------------------------
// sync API — for non-Effect callers
// ---------------------------------------------------------------------------

const PERMISSIONS_PATH = nodePath.join(os.homedir(), ".pi", "agent", "permissions.json");

const decodeRulesSync = Schema.decodeUnknownSync(PermissionRulesFromJson);

export function loadPermissions(): PermissionRule[] {
  return decodePermissionsFile(PERMISSIONS_PATH);
}
