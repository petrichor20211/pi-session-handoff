# pi-session-handoff

An Agent-first session handoff extension for [Pi](https://pi.dev).

`handoff` is a continuation message written by the current Agent plus a safe replacement-session switch. The Agent decides **when** to hand off and **what** the next Agent needs. The extension only exposes the context budget, preserves the note, validates the switch boundary, creates the new session, and delivers the note.

There is no separate summarizer call, checkpoint schema, task-manager dependency, or automatic threshold takeover.

## Requirements

This release is tested against and intentionally pinned to:

- `@earendil-works/pi-coding-agent` **0.85.1**
- `@earendil-works/pi-tui` **0.85.1**
- Node.js **22.19+**

The pin matters because the implementation relies on Pi's terminating tool results, replacement-session `withSession` context, and extension-command dispatch behavior.

## Install

From a local checkout:

```bash
pi install /path/to/pi-session-handoff
```

For a one-off test:

```bash
pi -e ./src/index.ts
```

### Migration from an older handoff implementation

Disable the old task-manager `/handoff` registration and automatic threshold takeover before enabling this package. Pi suffixes duplicate extension commands (for example, `/handoff:1` and `/handoff:2`), and two handoff implementations must not compete to replace the active session. Task-manager may continue observing `parentSession` lineage, but this package does not depend on it.

## Agent tool

The extension exposes one side-effecting tool:

```ts
handoff({ message: string })
```

The call must be the only tool call in its assistant message. `message` must be non-empty, but the extension imposes no arbitrary byte budget. The Agent is prompted to keep this task-state portion concise.

Both the `handoff` tool and `/handoff` request ask for a concise, distilled recovery index containing only information necessary to resume work. Omit empty sections, repetition, and filler without sacrificing essential state.

Use these headings in order: **Objective**, **Completed with evidence**, **In progress**, **Next actions**, **Important files**, **Verification**, **Active processes**, and **Active monitors**. The prompt adds no per-heading explanations, numerical length target, or repository-log policy. Repository-specific rules belong in project instructions or server memory.

User messages remain a separate, plugin-generated verbatim archive. No schema or length limit is enforced, no extra summarizer call is made, and session-replacement behavior is unchanged.

Inherited messages are stored as structured ranges into one verbatim archive, rather than by nesting the previous rendered handoff note. Repeated handoffs therefore add only newly received user text instead of recursively duplicating wrappers. Long messages are never truncated or summarized. In the TUI, the continuation card is compact by default: it shows the task state, archive size, and short previews; expanding the output reveals the complete text. The full archive still participates in the replacement Agent's context, so preserving a very long instruction necessarily consumes context—display collapsing does not pretend otherwise.

## User commands

| Command | Behavior |
| --- | --- |
| `/handoff [focus]` | Ask the current Agent to hand off at a useful boundary, optionally preserving a focus. |
| `/handoff status` | Show current estimated context, target, and saved records related to this session. |
| `/handoff target 80k` | Set a persistent advisory token target. Percentages such as `35%` are also accepted. |
| `/handoff --write` | Open a TUI/RPC multiline editor and switch using a note written directly by the user. |

`/handoff [focus]` uses the current Agent's normal response. It does not launch an isolated model call. The request is injected as a provenance-marked custom message, not as a synthetic user chat message, so it cannot contaminate the verbatim user-message archive.

## Context budget

Before every model request, a transient custom context message is appended with:

- current context token estimate or `unknown`;
- active model context window;
- configured advisory target and resolved target tokens;
- estimated remaining tokens to the target.

The snapshot comes from `ctx.getContextUsage()`, not cumulative session usage. It is not persisted in session history. The default target is `35%`. The target never forces a switch; Pi's normal compaction and overflow recovery remain the fallback.

If a continuation session starts at or above the target, the Agent is explicitly told not to hand off again merely to satisfy the configured value.

## Lifecycle and reliability

The Agent tool writes a small local ticket, returns `terminate: true`, and dispatches an opaque internal command. The command waits for Pi to settle, then verifies that:

1. the active session is still the source session;
2. no user message is pending;
3. no new user messages or structural context changes appeared after the accepted handoff boundary; later custom messages (including monitor wake-ups), assistant replies, and tool results are ignored for Agent-authored handoffs, using the accepted note unchanged without carrying over that later work; `/handoff --write` retains strict context checks;
4. the handoff call was the sole tool call in its assistant message.

It then calls `newSession({ parentSession, setup, withSession })`. After replacement, only the fresh `withSession` context is used. The target receives a visible custom note with explicit Agent/user provenance and immediately starts its first response.

The note is explicitly **not** represented as a user chat message or system prompt. Agent-authored notes cannot grant new authorization; directly written `--write` notes are labeled with their real provenance and must not be interpreted beyond their text. High-risk actions still require the user's actual authorization. Versioned range metadata lets later handoffs recover each original user message exactly even when its text contains Markdown headings or delimiter-like content; the earlier v1 note layout is read for migration.

Tickets are stored with Node's local filesystem under:

```text
$PI_CODING_AGENT_DIR/pi-session-handoff/
```

or, by default:

```text
~/.pi/agent/pi-session-handoff/
```

This avoids SSH-routed Agent file tools. Writes use a complete temporary file plus atomic publication/replacement. A ticket is removed only after delivery and a non-error target response settles. Missing, aborted, errored, cancelled, invalidated, or otherwise uncertain records are retained and shown by `/handoff status`; they are not automatically replayed.

## Deliberate boundaries

- `parentSession` and a small origin entry expose continuation lineage; task managers may observe it but are not dependencies.
- Remote cwd/endpoint inheritance remains the SSH extension's responsibility. A note must not claim that an SSH socket or workspace restored successfully.
- PID, log, and monitor details in prose do not migrate timers or background observers.
- The extension does not promise exactly-once execution for external business operations.
- `/handoff --write` requires TUI or an RPC client that implements Pi's extension editor protocol.

See [`docs/DESIGN.md`](docs/DESIGN.md) for invariants and failure semantics.
