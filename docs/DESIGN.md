# Design

## Responsibility split

```text
Agent: decide timing + write concise task state
Extension: preserve source user messages + expose budget + persist + validate + replace session + deliver
```

The user controls the same capability either indirectly (`/handoff [focus]` asks the current Agent) or directly (`/handoff --write`). Both converge on the same ticket and session-replacement implementation.

## Invariants

1. No isolated summary model call is made.
2. The public Agent API is exactly `handoff({ message })`.
3. A handoff tool call is rejected if its assistant message contains any sibling tool call.
4. Empty notes fail before the terminating result is returned; no arbitrary note-size budget is imposed.
5. Every inherited and newly received textual user message on the active source branch is copied into the durable ticket in chronological order.
6. Inherited messages are recovered from structured ranges, not by nesting a rendered continuation note; long messages remain exact and untruncated.
7. Agent requests created by `/handoff` are custom messages, not synthetic user chat messages.
8. A persisted local ticket exists before the tool reports acceptance.
9. Direct-write handoff requires a source path that has already been flushed by an assistant turn.
10. Session replacement only occurs from an extension command context after `waitForIdle()`.
11. Source session identity, queued input, and context boundary are rechecked immediately before replacement. Agent-authored handoffs ignore later custom messages, assistant replies, and tool results, keeping the accepted note unchanged; new user messages and structural context changes still invalidate the boundary. Direct-write handoffs retain strict context checks.
12. Objects bound to the source Pi runtime are never used after a successful replacement.
13. The target note is a custom continuity message with explicit Agent/user provenance, not a user chat message or system instruction.
14. A target path is saved before the continuation turn is triggered.
15. Once a target is recorded, failures recover in that target and never create another target automatically.

## Minimal recovery-note guidance

The tool prompt and `/handoff [focus]` request share the user-supplied writing guidance:

```text
Write handoff.message as a concise, distilled recovery index. Include only information necessary to resume the work; Omit empty sections, repetition, and filler without sacrificing essential state.

Use these headings in order:
Objective:
Completed with evidence:
In progress:
Next actions:
Important files:
Verification:
Active processes:
Active monitors:
```

No per-heading explanations, numerical length targets, repository-log policy, or extra writing paragraphs are appended to this shared guidance. Repository-specific rules remain in project instructions or server memory; the user's server-memory policy references `DEBUGLOG.md` and `CHECKLOG.md`.

The tool's timing and sole-call rules remain separate and unchanged. User messages are still supplied by the existing archive builder without changes to collection, persistence, full-context injection, or compact/expanded rendering. No parser, mandatory checkpoint schema, hard cap, truncation, or extra summary call is added. Direct user-written notes remain unrestricted.

## Normal sequence

```text
assistant emits only handoff({ concise task-state message })
  -> validate non-empty message and sole-call boundary
  -> collect inherited + current source user messages in chronological order
  -> atomically create local ticket
  -> dispatch /_pi-session-handoff-commit <opaque-id>
  -> return "Handoff accepted." + terminate: true
  -> internal command waits for idle
  -> re-read ticket and validate source identity/input boundary
  -> newSession(parentSession = source)
       setup:
         append pi-handoff-origin custom entry
         record target file on ticket
       withSession(new context only):
         send task state + one flat verbatim user-message archive as pi-handoff-note with triggerTurn: true
         inspect the recorded assistant response
         remove ticket only after a non-error run settles
```

## Ticket lifecycle

Tickets contain plain serializable data only. Mechanical statuses are:

- `accepted`: source note is durable; no target is known;
- `target-created`: target is known; do not create another one;
- `invalidated`: source changed or received input before switching;
- `cancelled`: Pi or another extension cancelled target creation.

Successful delivery removes the ticket. Retained records preserve the note for conservative manual recovery. There is intentionally no task objective parser, authorization inference, monitor snapshot, or business workflow state.

## Failure semantics

| Failure | Behavior |
| --- | --- |
| Empty note or ticket write failure | Tool errors, does not terminate, source remains active. |
| Mixed tool batch | Handoff errors; sibling work completes normally; Agent can retry handoff alone. |
| Pending or newly processed user input | Ticket becomes invalidated; no session switch. |
| Custom messages (including monitor wake-ups) and subsequent assistant/tool work after an Agent handoff | Ignore these entries during boundary validation; switch using the accepted note without refreshing or copying the later work. |
| User changed active session | Ticket becomes invalidated; extension never switches the user back. |
| `session_before_switch` cancels | Source remains active; ticket becomes cancelled. |
| Target recorded, continuation run fails | Stay in target; retain ticket and do not create a second target. |
| Process crashes with `accepted` ticket | Report it via status; do not automatically replay. |
| Process crashes with `target-created` ticket | Report source and target via status; recover in target, never replay business work automatically. |

## Long messages and rendering

The target custom message contains the full verbatim archive because exact user wording may carry constraints or authorization that an Agent summary cannot replace. This means an exceptionally long user message necessarily consumes target context; the extension does not silently truncate, summarize, or hide that cost.

To keep persistence linear, v2 note metadata records character ranges into the single rendered archive instead of storing a second copy or recursively embedding prior handoff notes. Later handoffs recover those exact ranges and append only new user messages. A compatibility reader migrates v1 continuation notes.

The TUI message renderer keeps the card collapsed by default, showing concise task state, total message/character counts, and bounded one-line previews. Expanded output shows each complete message under a separate heading. This changes presentation only; it does not change model context or durable text.

`/handoff [focus]` now triggers the Agent with `pi-handoff-request`, a custom message with explicit extension provenance. It is no longer persisted as a fake `role: "user"` message and therefore cannot enter the verbatim archive as though the user typed it.

## Context snapshot

The `context` event appends one non-persisted custom message at the end of each outgoing request. Unknown token estimates remain unknown. Percent targets resolve against the active model's context window. The message describes the target as advisory and discourages handoff loops in continuation sessions whose base context already exceeds it.
