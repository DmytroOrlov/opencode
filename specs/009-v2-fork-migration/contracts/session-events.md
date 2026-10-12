# V2 session telemetry and compaction events

This contract has two deliberately different lifetimes: generation telemetry is ephemeral and attempt-owned; compaction publication is durable and session-owned. Both use V2 Session event delivery, but telemetry is never part of the durable transcript.

## Ephemeral `session.telemetry`

Add an ephemeral event to `packages/schema/src/session-event.ts`, using the existing ephemeral Session event pattern (for example, `UsageUpdated`). The event carries:

- `sessionID`, `assistantMessageID`, and a unique `attemptID` for one physical LLM stream;
- a lifecycle phase sufficient for the app to replace/reset the display and discard/finish an attempt;
- zero or more finite measurements, each with a metric identity/meaning, value/unit, source (`provider-native` or `estimated`), and any required approximation indicator.

`packages/core/src/session/runner/step.ts::SessionStep.attempt` owns attempt attribution, accepted-value state, source arbitration, publication, cancellation, and observer cleanup. AI adapters observe provider protocol only and carry no session identity; Core joins their observations to the active attempt. Core captures the effective endpoint and `route.auth` from `SessionModelRequest.Prepared` after request hooks. Credentials remain Redacted and neither the event nor diagnostics may contain secrets. The Core attempt accepts an observation synchronously before asynchronous event publication, so stale async publication cannot become authority for a replacement attempt.

Typed `mlxTelemetry` and `splashTelemetry` settings belong to `Config.Provider.Settings`. Resolve them through `packages/core/src/model-resolver.ts`, then remove them through `Provider.CORE_KEYS` and `packages/core/src/aisdk.ts::prepareOptions` before provider/SDK dispatch. MLX observations take precedence over Splash for equivalent native metrics. Terminal-rate observations remain provisional until Core validates them. Splash stays opt-in and must not mutate inference options or implicitly set `return_progress`.

Event acceptance rules:

- Missing, malformed, non-finite, aggregate-only, or semantically unsuitable measurements are omitted, not encoded as zero.
- Native data supersedes an estimate only if authoritative for the same metric meaning and current attempt. Source arrival order alone is not authority.
- The app session reducer ignores an event whose attempt ID is not the currently displayed owner for that session/message. Assistant message ID alone does not distinguish a retry.
- Provider-specific Splash collection is explicit opt-in and observes the selected request; MLX behavior remains compatible. No additional inference request or polling path is introduced, and Splash opt-in does not change `return_progress` or other inference options.
- Event, parsing, provider watcher, and cleanup failure is observational and cannot alter inference outcome. All watcher/listener/timer resources end with the physical attempt.
- The event is not stored in the durable event log, projected into conversation history, or used as a dependency for generation success.

## Durable compaction candidate and `session.compaction.published`

### Facts and identity

- Each newly started compaction has a stable candidate identity established durably before successful summary content can be considered new-format.
- The candidate identity binds the session, compaction request/input identity, and exact summary content/message identity. The implementation may reuse an existing stable input or message ID only if uniqueness and binding are proved by projector validation; otherwise add a dedicated typed ID.
- Reflect the identity and publication status as typed optional fields in `SessionMessage.Compaction` and its existing JSON projection. Old rows with both candidate identity and publication metadata absent remain legacy. A candidate ID without accepted publication remains explicitly new-format and non-authoritative. The current `SessionMessageTable.data` JSON representation does not require a new SQL table; add a migration only if implementation evidence shows the existing projection cannot represent the invariant safely.
- Existing `Started`, `Ended`, and `Failed` facts continue to describe preparation/completion/failure. `Ended` means “content generation completed,” not “history publication committed.”
- Add one durable publication decision bound to the exact candidate and summary pair. It cannot name another candidate, switch summary, or publish across sessions.

### Acceptance and projection

- Publish only after the exact candidate has completed and reader-equivalent validation confirms nonempty usable summary content. A full summary without a retained tail is valid.
- Validate pair ownership, status, duplicate/contradictory publication, deletion/cancellation state, and all references in the same transaction that appends the event and applies its projection. A rejected mutation leaves durable event ordering and projected state unchanged.
- `SessionHistory` selects the latest accepted published pair. Preparing, failed, abandoned, or complete-but-unpublished candidates cannot hide or replace the prior published history.
- The compaction candidate is not an ordinary user message, assistant response, or tool result. Session response selection and `SessionInbox` pending-work visibility remain independently projected and tested.
- Existing orphan `running` compactions continue to settle as failed when the V2 runner encounters them. Do not add optional startup reconciliation from FR-024.

### Legacy, delete, replay, and fork

- Legacy means both explicit new-format candidate identity and publication metadata are absent. Legacy full/tailed/chained summaries and failure/unfinished outcomes preserve established V2 behavior.
- If either new-format marker exists without a valid pair/publication, the record is new-format and remains non-authoritative; it cannot be interpreted as legacy for convenience.
- Existing deletion/cancellation evidence permanently prevents that candidate identity from becoming authoritative. Late completion, duplicate/additional parts, retyping, replay, restart, or an event whose projection has no matching live candidate cannot recreate it.
- Fork projection remaps every reference in a published pair to fork-owned records. Partial/unmappable pairs are not published in the fork. No source-session message/part reference may leak into fork history.

## Verification obligations

Use deterministic event sequences and reader APIs. For each crash/rejection boundary, assert (a) authoritative model-visible history, (b) pending inbox rows, and (c) selected response separately. Cover publication transaction rollback, deletion followed by stale mutations, restart/replay, full and tail summaries, strict legacy reads, and fork reference ownership. A plausible final transcript alone is insufficient.
