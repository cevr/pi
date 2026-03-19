# Modes

AUTO / SPEC / execution flow for pi.

## Task-list scope

`scope` answers one question:

**where does the executable task list live, and how far should it follow you?**

Configured via:

```json
{
  "@cvr/pi-modes": {
    "taskListScope": "session"
  }
}
```

Valid values:

### `"memory"`

Task list lives only in memory for the current running process.

Use when you want:
- no disk persistence
- clean ephemeral sessions
- zero carry-over after restart

Behavior:
- restarting pi loses the task list
- switching sessions does not share task lists
- safest / least sticky

### `"session"` (default)

Task list is stored per pi session.

Use when you want:
- task list recovery after restart
- one task list per session
- no accidental sharing between separate sessions

Behavior:
- task list survives restart for the same session
- another session gets a different task-list file
- good default for normal work

### `"project"`

Task list is stored once per project/worktree.

Use when you want:
- one shared task list for the repo
- recovery across different sessions in the same project
- to resume the same plan even from a new session

Behavior:
- task list survives restart
- task list is shared by sessions in the same `cwd`
- most persistent / most sticky

## Storage locations

Given `cwd=/repo`:

- `memory` → no file
- `session` → `/repo/.pi/modes/tasks-<sessionId>.json`
- `project` → `/repo/.pi/modes/tasks.json`

## Restore behavior

On `session_start`, modes first restores its machine state from session entries.

Then it checks the task-list store.

If stored task-list data exists and the current machine state does **not** already have a task list:
- `Auto` restores into `AwaitingChoice`
- `Spec` restores as pending task-list state

This means store-backed task lists fill gaps, but do not override stronger session-state data.

## Current persistence behavior

Modes persists the executable task list when it changes meaningfully:
- task list created
- execution starts
- counsel approves and advances to the next step

Modes clears the stored task list when execution completes.

## Choosing a scope

Use:
- `memory` for throwaway work
- `session` for normal work
- `project` when you explicitly want shared project-wide plan continuity

If you are unsure, keep `session`.
