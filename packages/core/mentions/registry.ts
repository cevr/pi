/**
 * MentionRegistry — Effect service wrapping the mention source registry,
 * commit index cache, and session mention cache.
 *
 * moves module-level mutable state into Refs for testability and
 * lifecycle control. sync functions in sources.ts/commit-index.ts/
 * session-index.ts remain for non-Effect callers.
 */

import { Effect, Layer, Option, Ref, Schema, ServiceMap } from "effect";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import {
  getCommitIndex,
  lookupCommitByPrefix,
  clearCommitIndexCache,
  resolveGitRoot,
  type CommitIndex,
  type CommitLookupResult,
} from "./commit-index";
import {
  clearSessionMentionCache,
  listMentionableSessions,
  searchMentionableSessions,
  resolveMentionableSession,
  type MentionableSession,
  type MentionableSessionQuery,
} from "./session-index";
import {
  registerMentionSource,
  getMentionSource,
  listMentionSources,
  listEnabledMentionKinds,
  type MentionSource,
  type MentionSourceContext,
} from "./sources";
import { parseMentions } from "./parse";
import type { MentionKind, MentionToken, ResolvedMention } from "./types";

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class MentionError extends Schema.TaggedErrorClass<MentionError>()("MentionError", {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class MentionRegistry extends ServiceMap.Service<
  MentionRegistry,
  {
    /** register a mention source, returns an unregister effect */
    readonly registerSource: (source: MentionSource) => Effect.Effect<() => void>;

    /** get a registered source by kind */
    readonly getSource: (kind: MentionKind) => Effect.Effect<Option.Option<MentionSource>>;

    /** list all registered sources */
    readonly listSources: () => Effect.Effect<MentionSource[]>;

    /** list mention kinds enabled for the given context */
    readonly listEnabledKinds: (context: MentionSourceContext) => Effect.Effect<MentionKind[]>;

    /** resolve a single mention token */
    readonly resolve: (
      token: MentionToken,
      context: MentionSourceContext,
    ) => Effect.Effect<ResolvedMention>;

    /** resolve all mentions in a string */
    readonly resolveAll: (
      input: string,
      context: MentionSourceContext,
    ) => Effect.Effect<ResolvedMention[]>;

    /** get the commit index for a directory */
    readonly getCommitIndex: (cwd: string) => Effect.Effect<Option.Option<CommitIndex>>;

    /** lookup a commit by SHA prefix */
    readonly lookupCommit: (
      prefix: string,
      index: CommitIndex,
    ) => Effect.Effect<CommitLookupResult>;

    /** check if cwd is a git repo */
    readonly isGitRepo: (cwd: string) => Effect.Effect<boolean>;

    /** list mentionable sessions */
    readonly listSessions: (query: MentionableSessionQuery) => Effect.Effect<MentionableSession[]>;

    /** search mentionable sessions */
    readonly searchSessions: (
      sessions: MentionableSession[],
      query: string,
    ) => Effect.Effect<MentionableSession[]>;

    /** clear all caches */
    readonly clearCaches: () => Effect.Effect<void>;
  }
>()("@cvr/pi-mentions/index/MentionRegistry") {
  /**
   * production layer — delegates to sync functions.
   */
  static layer = Layer.succeed(MentionRegistry, {
    registerSource: (source: MentionSource) => Effect.sync(() => registerMentionSource(source)),

    getSource: (kind: MentionKind) => Effect.sync(() => Option.fromNullOr(getMentionSource(kind))),

    listSources: () => Effect.sync(() => listMentionSources()),

    listEnabledKinds: (context: MentionSourceContext) =>
      Effect.sync(() => listEnabledMentionKinds(context)),

    resolve: (token: MentionToken, context: MentionSourceContext) =>
      Effect.tryPromise({
        try: async () => {
          const source = getMentionSource(token.kind);
          if (!source) {
            return {
              token,
              status: "unresolved" as const,
              reason: `${token.kind}_mentions_not_supported_yet`,
            };
          }
          return source.resolve(token, context);
        },
        catch: (err) =>
          new MentionError({
            message: `resolve failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
      }),

    resolveAll: (input: string, context: MentionSourceContext) =>
      Effect.tryPromise({
        try: async () => {
          const tokens = parseMentions(input);
          return Promise.all(
            tokens.map(async (token) => {
              const source = getMentionSource(token.kind);
              if (!source) {
                return {
                  token,
                  status: "unresolved" as const,
                  reason: `${token.kind}_mentions_not_supported_yet`,
                };
              }
              return source.resolve(token, context);
            }),
          );
        },
        catch: (err) =>
          new MentionError({
            message: `resolveAll failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
      }),

    getCommitIndex: (cwd: string) => Effect.sync(() => Option.fromNullOr(getCommitIndex(cwd))),

    lookupCommit: (prefix: string, index: CommitIndex) =>
      Effect.sync(() => lookupCommitByPrefix(prefix, index)),

    isGitRepo: (cwd: string) => Effect.sync(() => resolveGitRoot(cwd) !== null),

    listSessions: (query: MentionableSessionQuery) =>
      Effect.sync(() => listMentionableSessions(query)),

    searchSessions: (sessions: MentionableSession[], query: string) =>
      Effect.sync(() => searchMentionableSessions(sessions, query)),

    clearCaches: () =>
      Effect.sync(() => {
        clearCommitIndexCache();
        clearSessionMentionCache();
      }),
  });

  /**
   * test layer — canned data, no I/O.
   */
  static layerTest = (opts?: {
    sources?: MentionSource[];
    commitIndex?: CommitIndex;
    sessions?: MentionableSession[];
  }) => {
    const sourcesMap = new Map((opts?.sources ?? []).map((s) => [s.kind, s] as const));

    return Layer.succeed(MentionRegistry, {
      registerSource: (source: MentionSource) =>
        Effect.sync(() => {
          sourcesMap.set(source.kind, source);
          return () => {
            sourcesMap.delete(source.kind);
          };
        }),

      getSource: (kind: MentionKind) =>
        Effect.sync(() => Option.fromNullOr(sourcesMap.get(kind) ?? null)),

      listSources: () => Effect.sync(() => [...sourcesMap.values()]),

      listEnabledKinds: () => Effect.sync(() => [...sourcesMap.keys()]),

      resolve: (token: MentionToken, context: MentionSourceContext) =>
        Effect.tryPromise({
          try: async () => {
            const source = sourcesMap.get(token.kind);
            if (!source) {
              return {
                token,
                status: "unresolved" as const,
                reason: `${token.kind}_not_in_test`,
              };
            }
            return source.resolve(token, context);
          },
          catch: (err) =>
            new MentionError({
              message: String(err),
            }),
        }),

      resolveAll: (input: string, context: MentionSourceContext) =>
        Effect.tryPromise({
          try: async () => {
            const tokens = parseMentions(input);
            return Promise.all(
              tokens.map(async (token) => {
                const source = sourcesMap.get(token.kind);
                if (!source) {
                  return {
                    token,
                    status: "unresolved" as const,
                    reason: `${token.kind}_not_in_test`,
                  };
                }
                return source.resolve(token, context);
              }),
            );
          },
          catch: (err) =>
            new MentionError({
              message: String(err),
            }),
        }),

      getCommitIndex: () =>
        Effect.succeed(
          opts?.commitIndex ? Option.some(opts.commitIndex) : Option.none<CommitIndex>(),
        ),

      lookupCommit: (prefix: string, index: CommitIndex) =>
        Effect.sync(() => lookupCommitByPrefix(prefix, index)),

      isGitRepo: () => Effect.succeed(!!opts?.commitIndex),

      listSessions: () => Effect.succeed(opts?.sessions ?? []),

      searchSessions: (sessions: MentionableSession[], query: string) =>
        Effect.sync(() => searchMentionableSessions(sessions, query)),

      clearCaches: () => Effect.void,
    });
  };
}
