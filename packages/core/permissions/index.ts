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
// types
// ---------------------------------------------------------------------------

export interface PermissionRule {
  tool: string;
  matches?: { cmd?: string | string[] };
  action: "allow" | "reject";
  message?: string;
}

export interface PermissionVerdict {
  action: "allow" | "reject";
  message?: string;
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class PermissionDenied extends Schema.TaggedErrorClass<PermissionDenied>()(
  "PermissionDenied",
  {
    tool: Schema.String,
    message: Schema.String,
  },
) {}

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
  static layer = (permissionsPath?: string) =>
    Layer.succeed(Permissions, {
      loadRules: () =>
        Effect.sync(() => {
          try {
            const p =
              permissionsPath ?? nodePath.join(os.homedir(), ".pi", "agent", "permissions.json");
            const raw = fs.readFileSync(p, "utf-8");
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed as PermissionRule[];
          } catch {
            return [];
          }
        }),

      evaluate: (toolName: string, params: { cmd?: string }) =>
        Effect.sync(() => {
          try {
            const p =
              permissionsPath ?? nodePath.join(os.homedir(), ".pi", "agent", "permissions.json");
            const raw = fs.readFileSync(p, "utf-8");
            const parsed = JSON.parse(raw);
            const rules: PermissionRule[] = Array.isArray(parsed) ? parsed : [];
            return evaluatePermission(toolName, params, rules);
          } catch {
            return evaluatePermission(toolName, params, []);
          }
        }),
    });

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

export function loadPermissions(): PermissionRule[] {
  try {
    const raw = fs.readFileSync(PERMISSIONS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}
