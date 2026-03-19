# AGENTS.md

Repo-local notes for `~/Developer/personal/dotfiles/pi`.

## Navigation

```text
What are you doing?
├─ Editing pi extensions only                → §1 Repo Shape
├─ Touching extension runtime APIs           → §2 Local Runtime Fork
├─ Relinking the local `pi` binary           → §3 Global Install Gotchas
├─ Verifying handoff / session switching     → §4 Verification
└─ Something looks inconsistent or broken    → §5 Gotchas
```

## Topic Index

| Topic                        | Section                     | When to Read                                       |
| ---------------------------- | --------------------------- | -------------------------------------------------- |
| Custom extensions vs runtime | `§1 Repo Shape`             | Starting work in this repo                         |
| Local runtime fork           | `§2 Local Runtime Fork`     | API/runtime bugs, session control, handoff crashes |
| Bun global link weirdness    | `§3 Global Install Gotchas` | `pi` missing, relinking, global install drift      |
| Verification commands        | `§4 Verification`           | Before handoff, after runtime changes              |
| Modes task-list scope        | `§5 Modes Task-List Scope`  | Working on modes persistence / restore behavior    |
| Common pitfalls              | `§6 Gotchas`                | If behavior or git state smells wrong              |

## 1. Repo Shape

What lives here vs what belongs in the fork.

### When to Use

- Working in `packages/extensions/*`
- Changing custom tools, slash commands, prompts, or extension behavior
- Building/testing the custom extension bundle

### Quick Reference

| Area              | Path                                                    | When to Read                    |
| ----------------- | ------------------------------------------------------- | ------------------------------- |
| Custom extensions | `~/Developer/personal/dotfiles/pi/packages/extensions/` | Most feature work               |
| Core helpers      | `~/Developer/personal/dotfiles/pi/packages/core/`       | Shared utilities                |
| Build entry       | `~/Developer/personal/dotfiles/pi/package.json`         | Build/test scripts              |
| Runtime fork      | `~/Developer/personal/pi-mono`                          | Upstream runtime or API changes |

### Commands

| Task             | Command                                                  |
| ---------------- | -------------------------------------------------------- |
| Build extensions | `bun run build`                                          |
| Test all         | `bun test`                                               |
| Test one file    | `bun test "packages/extensions/handoff/machine.test.ts"` |
| Full gate        | `bun run gate`                                           |

### Gotchas

- If the change needs a new runtime API surface, this repo is the wrong place.
- Do not patch over missing runtime behavior in extension code unless it is clearly temporary and documented.

## 2. Local Runtime Fork

Why the fork exists and when to leave this repo for runtime work.

### When to Use

- Extension code needs runtime APIs not exposed upstream yet
- Anything involving `ExtensionContext`, session switching, or runtime internals
- Handoff/counsel/runtime bugs that reproduce in the CLI, not just this repo

### Quick Reference

| Item            | Value                             |
| --------------- | --------------------------------- |
| Fork repo       | `~/Developer/personal/pi-mono`    |
| Remote          | `git@github.com:cevr/pi-mono.git` |
| Upstream source | `badlogic/pi-mono`                |
| Linked package  | `@mariozechner/pi-coding-agent`   |

### Patterns / Examples

- `dotfiles/pi` = custom extension logic
- `pi-mono` = runtime surfaces, extension context APIs, mode wiring

BAD:

- leave a permanent extension-side workaround for a missing runtime API
- add repo-specific hacks to the fork for custom extension behavior

GOOD:

- patch the runtime surface once in `pi-mono`
- remove the workaround in `dotfiles/pi`
- keep the fork diff minimal and upstreamable

### Why this fork exists

- `handoff` needed `ctx.newSession()` from normal `ExtensionContext`
- upstream exposed `newSession()` only on `ExtensionCommandContext`
- auto-triggered handoff paths use plain `ExtensionContext`
- result was a runtime crash: `ctx.newSession is not a function`

### Files touched by the `newSession` fix

- `~/Developer/personal/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `~/Developer/personal/pi-mono/packages/coding-agent/src/core/extensions/runner.ts`
- `~/Developer/personal/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- `~/Developer/personal/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `~/Developer/personal/pi-mono/packages/coding-agent/test/extensions-runner.test.ts`

### Gotchas

- Type surface changes often require matching test scaffold updates.
- Manual `ExtensionContext` object literals are easy to miss when widening the interface.
- `npm run build` may regenerate unrelated `packages/ai/src/models.generated.ts`; inspect before committing.

## 3. Global Install Gotchas

How to relink the local runtime without trusting Bun more than it deserves.

### When to Use

- Rebuilding or relinking the local runtime
- `pi` suddenly disappears from `$PATH`
- Bun says a package is linked, but reality disagrees

### Quick Reference

| Check               | Expected                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `which pi`          | `/Users/cvr/.bun/bin/pi`                                                                                                                |
| `pi --version`      | prints a version, not an error                                                                                                          |
| global package path | `~/.bun/install/global/node_modules/@mariozechner/pi-coding-agent` is a symlink to `~/Developer/personal/pi-mono/packages/coding-agent` |

### Patterns / Examples

Preferred relink flow:

1. Build fork first: `npm run build` in `~/Developer/personal/pi-mono`
2. Register package: `bun link` in `~/Developer/personal/pi-mono/packages/coding-agent`
3. Try Bun global link if you want
4. Verify with `which pi` and `pi --version`

BAD:

- trust `bun pm ls -g` as the source of truth
- assume Bun global metadata is correct because the command succeeded

GOOD:

- trust the symlink target plus a working `pi` binary
- verify with `which pi` and `pi --version`

Direct symlink fallback:

```bash
ln -s \
  "/Users/cvr/Developer/personal/pi-mono/packages/coding-agent" \
  "/Users/cvr/.bun/install/global/node_modules/@mariozechner/pi-coding-agent"
```

Optional metadata repair in `~/.bun/install/global/package.json`:

```json
{
  "dependencies": {
    "@mariozechner/pi-coding-agent": "link:@mariozechner/pi-coding-agent"
  }
}
```

### Gotchas

- `bun link @mariozechner/pi-coding-agent --global` may fail with `FileNotFound: failed linking dependency/workspace to node_modules`.
- In that failure mode, `~/.bun/bin/pi` may still exist while its target package link is missing or broken.
- If `which pi` fails or `pi` stops launching, inspect both links:
  - `~/.bun/bin/pi`
  - `~/.bun/install/global/node_modules/@mariozechner/pi-coding-agent`
- `bun pm ls -g` may omit the linked package even when `pi` works.
- `bun install` inside `~/.bun/install/global` may still fail on the linked package.

## 4. Verification

What to run before claiming the fork or extension repo is healthy.

### When to Use

- After runtime fork edits
- After handoff/session control changes
- Before saying the local fork is healthy

### Quick Reference

| Area            | Command                                                  |
| --------------- | -------------------------------------------------------- |
| Fork checks     | `npm run check`                                          |
| Fork build      | `npm run build`                                          |
| Handoff test    | `bun test "packages/extensions/handoff/machine.test.ts"` |
| Extension build | `bun run build`                                          |
| Binary sanity   | `which pi` + `pi --version`                              |

### Patterns / Examples

Runtime fork, in `~/Developer/personal/pi-mono`:

```bash
npm run check
npm run build
```

Extension repo, in `~/Developer/personal/dotfiles/pi`:

```bash
bun test "packages/extensions/handoff/machine.test.ts"
bun run build
```

End-to-end sanity:

- `which pi`
- `pi --version`
- manually exercise `/handoff <goal>` if the change touched session switching

### Gotchas

- A successful build is not enough if `pi` no longer resolves from `$PATH`.
- Runtime changes that touch session switching deserve a manual `/handoff` sanity pass.

## 5. Modes Task-List Scope

How modes task-list persistence works and when to use each scope.

### When to Use

- Working in `packages/extensions/modes/*`
- Touching executable task-list persistence or restore behavior
- Debugging why a task list did or did not come back on session start

### Quick Reference

| Config                         | Meaning                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `taskListScope: "memory"`    | no disk persistence; task list dies with the process       |
| `taskListScope: "session"`   | per-session persistence; default                           |
| `taskListScope: "project"`   | shared per-project persistence across sessions in same cwd |

Storage locations for `cwd=/repo`:

- `memory` → no file
- `session` → `/repo/.pi/modes/tasks-<sessionId>.json`
- `project` → `/repo/.pi/modes/tasks.json`

### Patterns / Examples

GOOD:

- `session` for normal work where a session restart should recover the plan
- `project` when you explicitly want the same executable task list across multiple sessions in one repo
- restore store-backed task lists only when session-entry hydration did not already restore stronger mode state

BAD:

- stash task-list serialization queues in the modes extension forever
- let each store call build its own isolated runtime/mutex island
- use `project` scope casually when you do not want cross-session stickiness

### Gotchas

- `scope` means where the executable task list lives and how far it follows you.
- The modes extension config namespace is `@cvr/pi-modes`.
- `taskListScope` currently defaults to `"session"`.
- Runtime caching for `TaskListStore.runtime(...)` is structural, not an optimization nicety — without it, per-call runtimes do not share the same `Mutex` service instance.
- Test cleanup should call `TaskListStore.clearRuntimeCache()` so cached runtimes do not leak between cases.
- Read `packages/extensions/modes/README.md` before changing scope or restore semantics.

## 6. Gotchas

### 6.1 Runtime vs extension bug

If the bug only reproduces inside the actual `pi` process, suspect the fork/runtime boundary first.

### 6.2 Do not paper over runtime API gaps in the extension repo

BAD:

- staging editor state
- fallback-only behavior kept forever
- extension-side type guards around runtime omissions that should be fixed upstream/in fork

GOOD:

- patch runtime surface once
- remove workaround from extension code
- keep extension flow simple

### 6.3 Build noise in the fork

`npm run build` in `pi-mono` may regenerate:

- `~/Developer/personal/pi-mono/packages/ai/src/models.generated.ts`

That file is often unrelated noise. Inspect before committing.

### 6.4 Commit hygiene

- Fork commits: runtime/API only
- `dotfiles/pi` commits: custom extension behavior only
- Do not mix the two unless there is a very good reason

### 6.5 Existing unrelated changes

This repo often has parallel work in flight. Check `git status` before edits. Do not sweep unrelated diffs into a “quick docs” commit.

### 6.6 Signal tools over prose markers

If an extension state machine needs to know that the agent is done, approved, skipped, passed gate, failed gate, or produced structured results, prefer a typed `pi.registerTool(...)` signal over scraping assistant prose.

BAD:

- regexing assistant text for markers like `AUDIT_COMPLETE`, `FINDING_FIXED`, `SESSION_COMPLETE`, `LGTM`
- scraping JSON blocks from assistant prose to drive transitions
- treating narration as the source of truth for control flow

GOOD:

- register a typed signal tool and have the agent call it explicitly
- validate tool usage against current machine state in `execute`
- on `agent_end`, fail closed when the expected tool signal was not called
- for spawned subagents, parse tool calls from the child transcript rather than inventing prose markers

Current prior art:

- `packages/extensions/audit/` — detection, synthesis, fix, gate, counsel, and spawned concern completion all use signal tools
- `packages/extensions/review-loop/` — iteration outcome uses `review_loop_result`
- `packages/extensions/session-closer/` — wrap-up completion uses `session_closer_complete`
- `packages/extensions/modes/` — execution/spec flow uses `modes_*` signal tools; keep it that way and delete legacy prose parsers instead of reviving them
