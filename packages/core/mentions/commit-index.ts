import { Effect, Layer, Option, Ref, ServiceMap } from "effect";
import { GitClient, type GitError, type GitLogEntry } from "@cvr/pi-git-client";
import type { ResolvedCommitMention } from "./types";

export interface CommitIndex {
  root: string;
  commits: ResolvedCommitMention[];
}

export type CommitLookupResult =
  | { status: "resolved"; commit: ResolvedCommitMention }
  | { status: "ambiguous"; matches: ResolvedCommitMention[] }
  | { status: "not_found" };

function toResolvedCommitMention(entry: GitLogEntry): ResolvedCommitMention {
  return {
    sha: entry.sha.toLowerCase(),
    shortSha: entry.sha.slice(0, 12).toLowerCase(),
    committedAt: entry.committedAt,
    subject: entry.subject,
  };
}

export function createCommitIndex(
  root: string,
  commits: ReadonlyArray<ResolvedCommitMention>,
): CommitIndex {
  return { root, commits: [...commits] };
}

export function parseCommitLog(stdout: string): ResolvedCommitMention[] {
  const commits: ResolvedCommitMention[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [sha = "", committedAt = "", ...subjectParts] = line.split("\t");
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
    commits.push({
      sha: sha.toLowerCase(),
      shortSha: sha.slice(0, 12).toLowerCase(),
      committedAt,
      subject: subjectParts.join("\t"),
    });
  }

  return commits;
}

export function lookupCommitByPrefix(prefix: string, index: CommitIndex): CommitLookupResult {
  const normalized = prefix.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized)) return { status: "not_found" };

  const matches = index.commits.filter((commit) => commit.sha.startsWith(normalized));
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length === 1) return { status: "resolved", commit: matches[0]! };
  return { status: "ambiguous", matches };
}

export class CommitIndexService extends ServiceMap.Service<
  CommitIndexService,
  {
    readonly resolveGitRoot: (cwd: string) => Effect.Effect<string | null, GitError>;
    readonly getIndex: (cwd: string) => Effect.Effect<CommitIndex | null, GitError>;
  }
>()("@cvr/pi-mentions/commit-index/CommitIndexService") {
  static layer = Layer.effect(
    CommitIndexService,
    Effect.gen(function* () {
      const git = yield* GitClient;
      const cache = yield* Ref.make(new Map<string, CommitIndex>());

      const resolveGitRoot = (cwd: string) =>
        git.root(cwd).pipe(Effect.map((root) => Option.getOrUndefined(root) ?? null));

      const getIndexForRoot = (root: string) =>
        Ref.get(cache).pipe(
          Effect.flatMap((cached) => {
            const existing = cached.get(root);
            if (existing) return Effect.succeed(existing);

            return git.log(root, { all: true }).pipe(
              Effect.map((entries) =>
                createCommitIndex(
                  root,
                  entries.map((entry) => toResolvedCommitMention(entry)),
                ),
              ),
              Effect.tap((index) =>
                Ref.update(cache, (current) => new Map(current).set(root, index)),
              ),
            );
          }),
        );

      return {
        resolveGitRoot,
        getIndex: (cwd: string) =>
          resolveGitRoot(cwd).pipe(
            Effect.flatMap((root) => (root ? getIndexForRoot(root) : Effect.succeed(null))),
          ),
      };
    }),
  );

  static layerTest = (indexes: Map<string, CommitIndex | null>) =>
    Layer.succeed(CommitIndexService, {
      resolveGitRoot: (cwd: string) => Effect.succeed(indexes.get(cwd)?.root ?? null),
      getIndex: (cwd: string) => Effect.succeed(indexes.get(cwd) ?? null),
    });
}
