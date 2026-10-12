# Feature 009 Data Model

This model identifies state ownership and transitions needed by the migration. It does not mandate a new database table for every entity. Existing V2 records remain the source of truth unless the contract below calls for a new durable fact.

## Existing and added state

| Concept | Owner / lifetime | Durable? | Migration rule |
|---|---|---:|---|
| Verified CA mode | CLI process bootstrap; passed as trusted process-local startup state to ServerInfo | No | `bundled` or `system` only after effective trust verification. Missing/legacy server field is `unknown` to clients. Never derive it from endpoint or binary name. |
| Primary model selection | App V2 model selection and session/workspace persistence | Existing | Keep current owner, acknowledgement, and session promotion behavior. |
| Fallback selection | Global `Config.Info`/config document as `ConfigModel.Selection`; client may hold a pending local intent during update | Yes, committed config | `model` plus variant follows `ConfigModel.Selection`. Omitted patch property means unchanged; explicit `null` clears. Do not persist a second pair in session state. |
| Fallback runtime intent | Process-global config coordination service; revisioned candidate associated with update operation | No separate durable record | Accepted intent is visible to recovery before save finishes. A save failure is not a committed success. A later process loads only the persisted config. A failed writer may clear only its own still-current revision. |
| Generation admission lease | Process-global Core admission service; owned by one execution chain or protected config operation | No | Shared across distinct runtime graphs. Wait is interruptible. Lease transfers only to the operation that acquired it and is released exactly once on terminal completion/cancel/failure. It is separate from SessionStore's recovery claim. |
| Recovery decision | Session runner, evaluated after retry delay and immediately before a new dispatch | No | Retry schedule carries timing/reason only. Decision re-reads current fallback intent and validates primary/fallback eligibility, attempt limits, variants, and tool outcome. Dispatch snapshots model/variant for that physical attempt. |
| Tool outcome | Step/tool execution state | Existing session records where settled; transient while executing | Replay-safe/no side effect may restart; settled tool result continues without re-executing; executing with unknown outcome is not replayable. User cancellation is terminal. |
| Physical generation attempt | `SessionStep.attempt` | No | Has a unique attempt ID even when assistant message ID is reused. Owns its LLM stream and all telemetry resources/events. A retry, fallback, continuation, or new request gets the appropriate fresh attempt identity. |
| Telemetry measurement | Attempt-local collector then ephemeral V2 session event | No | Value includes metric meaning, source/provenance, and attempt ID; no fabricated zero. Stale IDs cannot mutate current presentation. Collection failure is observational. |
| Compaction candidate | Session-owned durable events and typed `SessionMessage` JSON projection | Yes | New candidate is distinct from generated content and publication. Preparing/failed/unpublished state never replaces the last published model-visible view. Legacy records retain strict legacy interpretation. No new SQL table is presumed. |
| Compaction publication decision | New durable Session event bound to exact candidate and summary IDs, reflected in typed message JSON projection | Yes | Only one validated decision makes the exact pair authoritative. Transactional projection rejects invalid, deleted, duplicate, or cross-session pair references. |
| Pending work | Existing `SessionInbox` row until delivery/cancellation | Yes | Remains independent from compaction history and model-visible transcript selection. A compaction operation cannot consume/hide pending work merely by being excluded from model input. |
| Fork-owned references | V2 `SessionFork` boundary and copied session rows | Yes | Any new candidate/publication references copied into a fork resolve to fork-owned IDs; unmappable/partial pair remains non-authoritative. |

## State transitions

### TLS bootstrap

```text
unselected
  ├─ no explicit option ─> select bundled
  ├─ valid explicit bundled/system ─> selected mode
  └─ missing/unknown/conflicting explicit option ─> fail before command graph/network

selected mode
  ├─ effective trust matches and verification enabled ─> verified process state
  └─ trust differs, verification disabled, or cannot be proven ─> fail closed

verified process state ─> children inherit the same controlled mode ─> ServerInfo may report it
```

ServerInfo reports only the verified process state. An older server that omits the field remains usable; its CA mode is unknown.

### Fallback update and protected config commit

```text
committed fallback C
  └─ accept update revision R with candidate F ─> runtime intent (R, F)
       ├─ generation recovery reads R before dispatch ─> choose eligible F or current primary
       ├─ writer waits for generation lease drain, persists atomically ─> committed fallback F
       │    └─ refresh config graphs; mark R committed
       └─ persistence fails ─> report failure; preserve active accepted intent while applicable;
                              clear only if R is still the current failed revision
```

A process restart reconstructs fallback from committed config, not an uncommitted intent. A dispatched attempt retains its model/variant snapshot even if a newer intent arrives. The shared admission lease coordinates use versus protected replacement; it does not provide clustered or exactly-once execution.

### Admission lease and cancellation

```text
waiting (interruptible) ── acquire ──> owned by execution/config operation
       │                                  │
       └─ cancel ─> settled, no lease      ├─ success/failure/cancel ─> release once
                                          └─ shutdown policy follows V2 process lifecycle
```

The regression test must cover a real subagent operation parked at the V2 admission boundary. Cancellation while waiting cannot wait forever, create a phantom lease, or prevent the next queued operation. Cancelling a joined waiter does not cancel the existing owner.

### Compaction candidate and publication

```text
legacy record ─> strict legacy reader rules (no implicit rewrite)

new candidate:
preparing ── exact successful summary ──> complete/unpublished
    │                                         │
    ├─ failure/cancel/delete ─> terminal      ├─ validate reader-visible content + exact references
    │                                         │
    └─ replay/restart remains non-authoritative └─ durable publish event + projection transaction
                                                   ├─ accepted ─> published exact pair
                                                   └─ rejected ─> no event/projection partial state
```

Before accepted publication, history reads the prior published projection. After publication, it reads the exact complete pair. Deletion/cancellation tombstones the identity so later completion, duplicate parts, replay, restart, or retyping cannot restore authority. Fork projection remaps all published-pair references to destination-owned records. Inbox rows are enumerated and asserted independently at each boundary.

### Telemetry attempt lifecycle

```text
attempt created (ID)
  ├─ normalized stream/native source observations ─> validate metric semantics and provenance
  ├─ new attempt starts / attempt aborts ─> close old watchers, reject late updates
  └─ terminal stream ─> publish current attempt state, release all resources
```

The event is ephemeral. Attempt ID, not session ID or assistant message ID alone, is the authority for updates. Native and estimated measurements have a stable source and semantic meaning; invalid, missing, aggregate-only, or non-finite values are absent. Telemetry exceptions do not change inference result.

## Persistence and migration constraints

- Do not add a new telemetry table or a second durable transcript. Existing session event delivery and app reducer are the event path.
- Keep generation leases and runtime intent in process memory. They are coordination state, not recovery claims or persisted config success.
- Fallback is persisted with the existing global config document and is exposed through existing `Config.Info`/`Config.Patch`; commit semantics are defined in `contracts/fallback-config.md`.
- Compaction publication is the only planned new durable session decision. Add typed optional facts to `SessionMessage` JSON and durable `SessionEvent` schemas as needed; event and projection validation must share the existing bus transaction boundary. No new SQL table is required by the current model.
- Preserve current legacy compaction data and read outcomes. No bulk migration or implicit legacy rewrite is part of this feature.
