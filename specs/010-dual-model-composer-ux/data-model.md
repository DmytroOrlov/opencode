# Data model: the model pair

No new storage, schema, or record shape. This file records what already exists, the one rule that changes, and the derived display states the UI needs.

## Owners and fields

| Slot | Owner | Durable record | Scope | Lifetime |
|---|---|---|---|---|
| Primary model + variant | `LocalProvider` (`packages/app/src/providers/models/selection.tsx`) → workspace machine state (`selection-machine.ts`) | Existing per-workspace persisted `Selection` (`agent`, `choice`, `choices[agent]`), plus the existing per-model variant preference store in `packages/app/src/providers/models/models.tsx` (`variant.get/set`) | One session (`params.id`) or one draft, in one workspace (`ScopedKey.from(scope, pathKey(directory))`) | Released with the composer/session view (`acquireWorkspace().retain()`) |
| Fallback model + variant | `createFallbackModelSelection()` (`:759`) → `fallbackUpdateState` (`fallback-update.ts`) | Existing server config field `fallback: { providerID, model, variant }` \| `null` written by `PATCH /api/experimental/config`, read back by `loadGlobalConfigQuery` | Global (per server/scope) — shown by every composer | Client override lives only in `fallbackUpdateState.optimistic` (revision-tagged) and is cleared on confirm or failure |
| Effective recovery fallback | `packages/core/src/session/runner/llm.ts` `chooseFallback` + `packages/core/src/config/fallback.ts` `resolve()` | Same config field; `undefined` → `LEGACY_MODEL_FALLBACK` | Per generation attempt | Per attempt (`pendingFallback`, `attemptedFallbacks`) |

Three separate records stay separate: the session's choice, the per-model variant preference, and the global `fallback` field. The pair feature adds none of them. A fourth record is already touched by model writes and is listed here because the exchange must not corrupt it:

| Field | Owner | Durable record | Scope |
|---|---|---|---|
| Model visibility (`show`/`hide`) | `packages/app/src/providers/models/models.tsx` (`visible()` `:128`, `setVisibility()` `:142`) | persisted `store.user[]` entries in the same workspace document | per catalog model, per workspace document |

Durability failure is owned one layer below each slot: the primary's value reaches disk through `persist.write` → `setSaved` → a scheduled save (`persistSaveDelay = 100`, `persist.ts:13`) and a failed save leaves the store dirty and retried (`persist-machine.ts:108-112`); the fallback's value reaches the server through the config `PATCH` chain (`fallbackUpdateState`). Both signals are per record **document/server**, not per action, which is why the exchange's compensation is one attempt and one report rather than a durable guarantee, and why the record signal is read as an *admissible observation* (the owner's `write.failed` payload plus a monotonic failure id that only sequences observations) rather than a boolean: it may be attributed to the exchange that is claiming only when its payload carries the pair that exchange wrote for this session, no successful save of that document has landed since the write, and the phase still holds the attempt — never from id ordering alone, and never as proof of which edit failed.

## Identity rule (the single changed rule)

`identity(model) = providerID + modelID`, **variant ignored**, applied by:

- `swapModelPair` / pair math in `packages/app/src/session/composer/selection.ts` (already ignores variant, carrying variants separately);
- `packages/core/src/session/runner/llm.ts:277` `modelKey` — the only code change to core: `${ref.providerID}/${ref.id}`;
- the composer's collision check for the inactive fallback state;
- picker dedup when the opposite slot's model is `include`d.

Consequences stated for review: two variants of one model are one model (so a variant-only fallback is not a recovery, FR-031), and the same `modelID` under two providers is two models (so an exchange is possible between them). The app cannot import `ConfigFallback` from core (browser-unavailable; see the comment at `selection.tsx:743`), so the rule and the legacy default exist on both sides and are pinned by paired tests instead of a shared module — recorded as a known limitation, not a new abstraction.

## Derived presentation states for the fallback slot

Computed from the two owners; never stored, never a second source of truth. `off` and `inactive` must be visually and semantically distinct (FR-015/013/029/030).

| State | Predicate | Chip content | Picker | Written by |
|---|---|---|---|---|
| `model` | `enabled()` and identity(`fallback.key()`) ≠ identity(`primary.key()`) | the fallback model's name (+ chevron) | offers the model (a hidden or default model is still listed, FR-024) | a fallback-picker choice or an exchange |
| `off` | `raw() === null` (explicit "None") | `ui.sessionTurn.status.fallback.none` → "None" | "None" row is the current selection | `fallback.set(undefined)` → `save(null)` (existing) |
| `inactive` | `enabled()` and identities are equal (chosen, inherited, hidden, or the shipped default) | `ui.sessionTurn.status.fallback.sameModel` → "Same model" | its configured model is still offered, so picking a different model resolves the collision | **nothing** — reaching this state must not write, clear, or rewrite the config field (FR-029) |
| `pending` | catalog not loaded (`loading()`) | no fallback control at all (`<Show when={!props.loading}>`, existing) | not reachable | — |

`inactive` reverts to `model` automatically when the primary stops colliding, because the predicate is recomputed (FR-030). Its recorded variant stays in the config record untouched.

## The exchange phase (the only new state, and it is not stored anywhere durable)

The two owners keep their own state machines untouched. The coordinator (`createComposerControls`) adds one phase per composer, holding only the values it must be able to put back for the action currently in flight. It lives beside the pair rule in `packages/app/src/session/composer/selection.ts` and is driven from `composer/selection.ts`.

| Phase | Fields | Entered when | Left when |
|---|---|---|---|
| `idle` | — | initial; after an outcome is resolved or dropped | a picker/command selects the model held in the other slot |
| `exchanging` | `attempt` (monotonic token), `restore` = `{ primary: {model, variant}, fallback: {model, variant} }`, `applied` = the pair just written, `half` = which slot the user acted in, plus the pre-write `visible` flags of both targets | refusal checks passed and both writes were issued in one `batch` | an outcome arrives (`record.failed(side)`), any newer write lands (`slot.changed`), identity changes (`target.changed`), or the composer unmounts (`disposed`) |
| `unresolved` | the failed side, and that a report was already made | a compensation attempt itself failed | superseded or disposed (never retried) |

What each phase guarantees and does not:

- `exchanging` means one user action's pair is displayed; it does **not** mean either durable record holds it (FR-019).
- `restore` is read at exchange time and used at most once. A `record.failed` carrying an attempt the phase no longer holds produces no effect at all — that is the stale-compensation rule (FR-018). Consequence, pinned by tests: initial A/B → exchange to B/A → the user selects primary C → the old config write then fails leaves the pair **C/B**, because the primary keeps the newer selection and the fallback half reverts to its own last recorded value; the failed exchange leaves no value behind (never C/A, never A/B).
- `unresolved` is terminal: the failure is reported once through the owners' existing toasts, nothing is retried by the coordinator, and the display stays valid because the `inactive` presentation suppresses a duplicated pair regardless of what the records hold.

## Displayed vs recorded, and what an exchange can promise

- Display is optimistic in both slots: the primary through the machine's `override`/`awaiting-ack` phase, the fallback through `optimistic({ revision, value })` (FR-015).
- Confirmation is per record: a config read clears the fallback override; a server echo moves the primary from `awaiting-ack` to `committed`.
- An exchange is one **displayed** pair (both writes in a single `batch`) and two independent durable writes (FR-019). `batch` coalesces rendering and save scheduling only; it grants no durable atomicity and does not couple the two asynchronous failures. Therefore no scenario may assert that an exchange survives a reload as a pair, and no compensation may claim to undo a config write the server already applied — the fallback half reverts the *client's* view to its last recorded value, and the primary half is re-written with the pre-exchange `ModelChoice`.
- Failure signals are asymmetric, and the data model must say so: the config half reports per write to the caller (`fallbackUpdateState.save(value, failed)`), while the record half reports per save window to the persistence layer only (`write.failed`, `persist-machine.ts:108-112`), surfaced to the coordinator through the added `recordFailure()` **observation** — the owner's `{ attempted, fallback }` payload plus a driver-issued id — because a persistent boolean cannot attribute a per-workspace-document failure to one action: the observation must be **admissible** — its `attempted` payload carries the pair the exchange wrote for this session, no successful save of that document has landed since the write, and the phase still holds the attempt; the id only sequences observations and is never evidence of causation. A missing server acknowledgment is **not** a failure signal and never triggers compensation (corrected FR-017).
- Suppression rules are layered, and no single one is sufficient: fallback — `revision` mismatch drops the result (`fallback-update.ts:44-50`); primary — attempt id in `awaiting-ack` with `commit.cancelled` / `commit.timed-out` (`selection-machine.ts`); **pair** — the exchange phase's own `attempt` token, which is what drops a late `record.failed` from an exchange the user has already superseded (FR-018). Each rule suppresses only its own layer's stale work, so the pair rule cannot be deleted in favour of the other two.
- The `visible` flags captured in the phase are the pair write's only interaction with the persisted per-model visibility map (`store.user[].visibility`): restored inside the same batch, so an exchange never un-hides a model the user hid.

```text
fallback picker row ─▶ createModelSelectorController.select(model, variant?) ─▶ wrapped fallback.set
      │    batch: fallback.set(model) ▶ fallback.variant.set(variant)   # acted slot first, model then its variant
      │           ▶ selection.set(displacedModel) ▶ selection.variant.set(pairVariant)
      │           ▶ restore any flipped visibility
      └── save({providerID, model, variant}) ─▶ PATCH config ─▶ confirm / clear / failed
primary picker row  ─▶ same controller ─▶ wrapped selection.set
      │    batch: selection.set(model) ▶ selection.variant.set(variant?)   # row click passes no variant
      │           ▶ fallback.set(displacedModel, { variant: pairVariant })
      │           ▶ restore any flipped visibility
      └── setSaved ─▶ schedule-save (persistSaveDelay = 100) ─▶ setItem ─▶ ok / write.failed
```

Both arrows are the *same* code path: the wrapped setter decides whether the action is an ordinary change or an exchange, so the pair rule, the variant carry and the visibility restore apply wherever the picker was opened from.

"None" in the fallback picker routes to `fallback.set(undefined)`; the primary picker has no "None" row (unchanged behaviour).
