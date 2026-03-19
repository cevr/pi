# Modes

AUTO / SPEC / execution flow for pi.

## High-level flow

### AUTO

Normal working mode.

- if work is executable now, AUTO produces an executable task list
- task lists are part of AUTO mode; there is no separate task-review state
- once AUTO has a task list, execution starts immediately
- if deeper design is needed first, AUTO escalates to SPEC

### SPEC

Read-only exploration and spec writing.

- SPEC drafts the spec only
- SPEC does not generate executable task lists
- when the draft is ready, the agent calls `modes_spec_ready`

### Spec review

After `modes_spec_ready`, modes pauses for user review.

- approve → return to AUTO, then AUTO extracts the task list from the approved spec
- reject/edit → return to SPEC and revise

### EXECUTING

Sequential step execution.

- run current step
- call `modes_step_done`
- run gate, then call `modes_gate_result`
- run counsel, then call `modes_counsel_result`
- continue until complete, then return to AUTO

## Transcript visibility

Modes emits both user-visible milestones and hidden control/context messages.

### Visible history entries

These should appear in the transcript because they are meaningful phase boundaries or user-review artifacts:

- `modes-transition:spec` — AUTO escalated into SPEC, including the spec goal
- `modes-review:spec` — full drafted spec for approval
- `modes-plan:task-list` — generated executable task list
- `modes-execution:start` — execution kickoff / resume message
- `modes-execution:complete` — execution completion summary

### Hidden control/context entries

These should stay hidden because they are machine steering or context injection, not user-facing artifacts:

- `modes-context:auto`
- `modes-context:spec`
- `modes-context:executing`
- `modes-context:auto-task-list`
- `modes-execution:gate`
- `modes-execution:gate-fix`
- `modes-execution:counsel`
- `modes-execution:counsel-fix`
- `modes-execution:next-step`

Rule of thumb:

- if an entry explains a real workflow transition the user may want to review later, keep it visible
- if an entry only steers the agent/runtime, keep it hidden

Non-goal:

- this naming discipline is for workflow/control transcript entries
- the internal persisted machine snapshot still uses the plain custom type `modes`
- handoff may copy that `modes` snapshot into the child session, but that is persistence state, not a handoff transcript milestone

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

- `Auto` restores the task list and resumes execution
- `Spec` restores as pending task-list state
- legacy `AwaitingChoice` sessions hydrate into `Executing`

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
