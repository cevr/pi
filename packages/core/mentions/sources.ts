import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { getCommitIndex, resolveGitRoot } from "./commit-index-sync";
import { lookupCommitByPrefix, type CommitIndex } from "./commit-index";
import type { MentionableSession } from "./session-index";
import { type MentionKind, type MentionToken, type ResolvedMention } from "./types";

// ---------------------------------------------------------------------------
// encapsulated state — no bare module-level mutable singletons
// ---------------------------------------------------------------------------

const _state = {
  kindDescriptions: new Map<MentionKind, string>([
    ["commit", "git commit"],
    ["session", "previous pi session"],
    ["handoff", "forked session with resumable context"],
  ]),
  sources: new Map<MentionKind, MentionSource>(),
};

export interface MentionSourceContext {
  cwd: string;
  commitIndex?: CommitIndex | null;
  sessionsDir?: string;
  sessions?: MentionableSession[] | null;
  gitEnabled?: boolean;
}

export interface MentionSource {
  kind: MentionKind;
  description: string;
  isEnabled?(context: MentionSourceContext): boolean;
  getSuggestions(query: string, context: MentionSourceContext): AutocompleteItem[];
  resolve(
    token: MentionToken,
    context: MentionSourceContext,
  ): ResolvedMention | Promise<ResolvedMention>;
}

function isGitEnabled(context: MentionSourceContext): boolean {
  return context.gitEnabled ?? resolveGitRoot(context.cwd) !== null;
}

export function listMentionKinds(): MentionKind[] {
  return [..._state.kindDescriptions.keys()];
}

export function isMentionKind(kind: string): kind is MentionKind {
  return _state.kindDescriptions.has(kind as MentionKind);
}

export function createCommitMentionSource(): MentionSource {
  return {
    kind: "commit",
    description: _state.kindDescriptions.get("commit") ?? "git commit",
    isEnabled: (context) => isGitEnabled(context),
    getSuggestions(query, context) {
      if (!isGitEnabled(context)) return [];
      const index = context.commitIndex ?? getCommitIndex(context.cwd);
      if (!index) return [];

      return index.commits
        .filter((commit) => query.length === 0 || commit.sha.startsWith(query.toLowerCase()))
        .slice(0, 8)
        .map((commit) => ({
          value: `@commit/${commit.shortSha}`,
          label: `@commit/${commit.shortSha}`,
          description: commit.subject,
        }));
    },
    resolve(token, context) {
      const index = context.commitIndex ?? getCommitIndex(context.cwd);
      if (!index) {
        return {
          token,
          status: "unresolved",
          reason: "git_repository_not_found",
        };
      }

      const result = lookupCommitByPrefix(token.value, index);
      if (result.status === "resolved") {
        return {
          token,
          status: "resolved",
          kind: "commit",
          commit: result.commit,
        };
      }

      return {
        token,
        status: "unresolved",
        reason: result.status === "ambiguous" ? "commit_prefix_ambiguous" : "commit_not_found",
      };
    },
  };
}

registerMentionSource(createCommitMentionSource());

export function listMentionSources(): MentionSource[] {
  return listMentionKinds()
    .map((kind) => _state.sources.get(kind))
    .filter((source): source is MentionSource => source !== undefined);
}

export function getMentionSource(kind: MentionKind): MentionSource | null {
  return _state.sources.get(kind) ?? null;
}

export function registerMentionSource(source: MentionSource): () => void {
  _state.kindDescriptions.set(
    source.kind,
    _state.kindDescriptions.get(source.kind) ?? source.description,
  );

  const previous = _state.sources.get(source.kind);
  _state.sources.set(source.kind, source);

  return () => {
    if (_state.sources.get(source.kind) !== source) return;
    if (previous) {
      _state.sources.set(previous.kind, previous);
      return;
    }
    _state.sources.delete(source.kind);
  };
}

export function listEnabledMentionKinds(context: MentionSourceContext): MentionKind[] {
  return listMentionSources()
    .filter((source) => source.isEnabled?.(context) ?? true)
    .map((source) => source.kind);
}

export function getMentionKindDescription(kind: MentionKind): string {
  return getMentionSource(kind)?.description ?? _state.kindDescriptions.get(kind) ?? kind;
}
