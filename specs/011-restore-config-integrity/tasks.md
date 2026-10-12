# Tasks: Restore Config Integrity

**Inputs**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/config-update.md`, `quickstart.md`. Design only; no acceptance is claimed. The three architecture-owned slices below are the only acceptance gates. Story labels trace to the spec; they do not create extra gates. All tasks remain open.

## Phase 1: Setup

Existing workspace and test infrastructure are reused; no initialization task is needed.

## Phase 2: Foundation

- [x] T001 Establish an evidence matrix in `specs/011-restore-config-integrity/tasks.md` during implementation: map the actual V1 negative assertions at `08488fb3a1e274ce00c517dc5106640f3780f50a` in `packages/opencode/test/config/config.test.ts` and `packages/opencode/test/server/global-config-update.test.ts` to V2 owners and demonstrated failure modes, including filesystem failures, two writers, queued admission, interruption and real HTTP abort; record existing V2 assertions to preserve and any untestable boundary as HOLD. Do not use passing-test counts as parity evidence.

## Phase 3: S1 — Atomic config commit and publication [US1] (P1, MVP)

**Goal and scope**: Core Config commits a complete document and separately establishes reader publication. FR-001–004, core FR-005, commit-boundary FR-010, FR-011–013; SC-001 (core portion), SC-003–004; Story 1 scenarios 1–6 and core portion of 7. No prior accepted slice; S2 and S3 are not prerequisites.

- [x] T002 [US1] Test owner `packages/core/test/config/config.test.ts`: add deterministic real-JSONC positive and negative cases for full-document validation, temp-write and rename failure with proven injection reachability, old bytes/mode/readers and temp cleanup, successful retry, preserved comments/format/unrelated fields, omission/null/legacy default, and no-op with zero writes, renames and unnecessary invalidations; retain existing assertions and map T001 failure modes.
- [x] T003 [US1] Production owner `packages/core/src/config.ts`: implement complete candidate validation and sparse JSONC edits against the latest committed document at the protected boundary, true no-op detection, unique same-directory temporary write, mode preservation, atomic replacement and precommit cleanup; follow `data-model.md` Committed document and Commit/publication state constraints.
- [x] T004 [US1] Test owner `packages/core/test/config/config.test.ts`: inject real reload, notification and cleanup boundaries after confirmed rename; prove actual publication state, committed bytes, reader blocking/degradation and reconciliation, publication before release, cancellation and resource release. Verify optional housekeeping diagnostic success and any real mandatory postpublication failure separately; never invent that boundary.
- [x] T005 [US1] Production owner `packages/core/src/config.ts`: implement typed precommit, committed-unpublished and, only for a real mandatory completion failure, committed-published outcomes; ensure protected-reader coherence and reconciliation. Classify notification and cleanup using the narrow verification in `research.md`; optional housekeeping records diagnostics without failing success or stranding required resources or leases.
- [x] T006 [US1] Evidence owner `specs/011-restore-config-integrity/tasks.md`: run and record S1 gate commands, exit status, boundary reachability, positive and negative assertions, publication-state classification, and typed state outcomes, operation classification and coherence handoff for S2 and S3; record exact blockers as HOLD.

**Independent gate**: `bun run --cwd packages/core test test/config/config.test.ts` and `bun run --cwd packages/core typecheck`. PASS only when T002–T005 evidence establishes all listed core boundaries and no stale protected reads; HOLD for unproven injection, old-file mutation before rename, leaked temp, false outcome, rollback, stale read, unenforceable publication boundary, unclassified required operation, or stranded required resource/lease. HTTP and concurrency are not required for this gate. Handoff: typed outcomes, exact publication/reconciliation boundary, test hooks and evidence.

## Phase 4: S2 — Runtime intent, admission and recovery [US2] (P1)

**Goal and scope**: Entry-ordered durable commits coexist with the latest eligible runtime intent despite out-of-order validation. Requires accepted S1; FR-006–010, serialized FR-003/004, FR-011–013; SC-002–004; Story 2 scenarios 1–11.

- [x] T007 [US2] Test owners `packages/core/test/config/fallback-runtime-intent.test.ts` and `packages/core/test/config/config.test.ts`: use barriers for B then C entry with C validating/staging first, late B, invalid/cancelled B, B success/C failure or cancellation exposing committed B, B failure/C success, and C cleanup after D; assert intent freshness, ordered commits, progress and individual failures, including omission, explicit null, invalid selection and restart from disk.
- [x] T008 [US2] Production owners `packages/core/src/config.ts` and `packages/core/src/config/fallback-runtime-intent.ts`: reserve entry order before validation, stage only validated explicit selection/null by entry revision before admission, retire invalid/cancelled reservations and clean only the still-current revision; use S1 commit/publication outcome and `data-model.md` Update reservation and Runtime intent constraints.
- [x] T009 [US2] Test owner `packages/core/test/config/config.test.ts`: prove sparse fallback B and shell C both survive serialized commits and that A → B → A commits B then A instead of discarding C as a stale no-op; assert failing/cancelled updates neither corrupt the last commit nor strand later writers.
- [x] T010 [US2] Production owner `packages/core/src/config.ts`: serialize reservations while applying and comparing each sparse patch against the latest committed document at its own boundary, preserving no-op cleanup and both writer outcomes; follow `data-model.md` Committed document and Update reservation constraints.
- [x] T011 [US2] Test owners `packages/core/test/session-generation-admission.test.ts` and `packages/core/test/effect/app-node-builder.test.ts`: queued writer interruption and subsequent progress, exactly-once release, and cancellation around replacement with no partial commit or stale protected read are PROVEN (positive + decisive negatives, barriers recorded). "Exercise shared leases across runtime graphs" is PROVEN for the production graph shape: `AppNodeBuilder.build` injects ONE admission value and ONE `FallbackRuntimeIntent` owner into the SERVER graph and EVERY location graph of one application build, and `app-node-builder.test.ts` shows a lease held by the SERVER generation owner deferring a LOCATION `Config.update` commit and a LOCATION writer holding its exclusive lease deferring a later SERVER generation, in one build, plus one shared entry-order line across two location graphs of that build (see "S2 correction pass 2" below). Scope, stated not assumed: sharing is per application build — independent builds keep independent leases and independent revision lines, proven by the same file's two boundary controls, so no process-wide claim is made.
- [x] T012 [US2] Production owner `packages/core/src/session/generation-admission.ts` with integration in `packages/core/src/config.ts` and ownership wiring in `packages/core/src/effect/app-node-builder.ts`: retain process-wide shared/exclusive protection, interruptible queued reservations and exactly-once release, and finish or clean forward once replacement crosses the commit boundary; follow `data-model.md` Admission lease constraints. NOTE (corrected): the lease mechanics are proven per instance; the "process-wide" scope behind that wording is realized as ONE admission value and ONE runtime-fallback intent owner per `AppNodeBuilder.build`, injected through the existing `bindings` path into the SERVER graph and every per-location instance graph, which is the shape production compiles (`packages/server/src/routes.ts` compiles one application graph). This is proven, not asserted: cross-graph lease interference in both directions and one shared entry-order line across two location graphs are pinned in `packages/core/test/effect/app-node-builder.test.ts`, and `test/session-generation-admission.test.ts` retains the negative control that two independently compiled graphs are NOT required to share state. Independent application builds stay isolated, so no process-wide (cross-build) claim is made.
- [x] T013 [US2] Test owners `packages/core/test/session-runner.test.ts` and `packages/core/test/session-runner-retry.test.ts`: hold backoff while intent changes and while a committed intent clears, prove a valid latest eligible fallback physically dispatches without an unnecessary primary attempt, and prove already-dispatched model/variant remain fixed; retain decisive same-model and attempted-model guards, retry caps, compaction, attribution and no replay of uncertain tool effects.
- [x] T014 [US2] Production owner `packages/core/src/session/runner/llm.ts`: resolve latest eligible effective intent or committed fallback after backoff immediately before dispatch and freeze model/variant per physical attempt, retaining eligibility, attempt guards, caps, compaction and tool safety; follow `data-model.md` Runtime intent and Attempt snapshot constraints.
- [x] T015 [US2] Evidence owner `specs/011-restore-config-integrity/tasks.md`: run and record S2 gate commands and deterministic B/C/D, out-of-order validation, sparse, cancellation, restart and retry traces with V1 failure-mode mapping; hand S3 the accepted core outcomes, admission/recovery barriers and unresolved blockers.

**Independent gate**: `bun run --cwd packages/core test test/config/config.test.ts test/config/fallback-runtime-intent.test.ts test/session-generation-admission.test.ts test/session-runner.test.ts test/session-runner-retry.test.ts` and `bun run --cwd packages/core typecheck`. PASS only with S1 accepted and all S2 traces and preserved negative assertions passing; HOLD for stale intent/commit, leaked reservation, lack of progress, retargeted attempt, unsafe replay or unproven boundary. HTTP and clients are not prerequisites. Handoff: ordered reservation and intent semantics, actual retry snapshot evidence, and reproducible barriers.

## Phase 5: S3 — HTTP contract and production integration [US1] [US2]

**Goal and scope**: Requires accepted S1 and S2. FR-005, FR-011–014; SC-001–004; Story 1 scenario 7 and integrated Stories 1–2. Sessions may split after T018, but there is exactly one final S3 acceptance gate.

- [x] T016 [US1] Test owners `packages/server/test/config.test.ts` and `packages/server/test/defect-response.test.ts`: prove actual wire and state for 204, precommit, unpublished, generic defect and diagnostic-only housekeeping; where a real mandatory postpublication failure exists, prove its distinct code and published state. Verify each injection boundary, exclusive identities, committed bytes, readers and resource release.
- [x] T017 [US1] Production owners `packages/protocol/src/groups/config.ts`, `packages/protocol/src/errors.ts` and `packages/server/src/handlers/config.ts`: declare a PATCH-specific generic-compatible 500 with literal `CONFIG_COMMITTED_BUT_UNPUBLISHED` and `CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE` variants; map only actual corresponding states, the latter only at a real mandatory boundary. Preserve `_tag`, message, optional ref, ordinary generic errors and 204 including diagnostic-only housekeeping; follow `contracts/config-update.md`.
- [x] T018 [US1] Client owners `packages/client/script/generate.ts`, generated artifacts under `packages/client/`, and if necessary `packages/httpapi-codegen/`; test owners `packages/client/test/promise.test.ts` and `packages/client/test/effect.test.ts`: generate through existing tooling; prove both decoders structurally expose each applicable committed identity at its real boundary, decode ordinary generic 500 and precommit failures without either code, and preserve 204. Record actual before/after Promise rejection and Effect failure types in `specs/011-restore-config-integrity/tasks.md`.
- [x] T019 [US1] Caller production owners `packages/app/src/providers/models/selection.tsx`, its fallback update owner,
  `packages/app/src/runtime/server/sync.tsx`, and `packages/app/src/settings/general/controllers.ts`; test owners
  `packages/app/src/session/composer/selection.test.ts` and `packages/app/src/settings/general/controllers.test.ts`:
  preserve success and failure behavior, composer compensation and stale-failure suppression, and reconcile each
  applicable committed failure truthfully without assuming rollback; preserve settings handling and diagnostic-only 204
  success. CORRECTED IN S3's correction pass (see "S3 correction pass" below): `sync.refreshConfig()` is an AWAITED
  authoritative GET returning `Promise<void>` that throws on an unsuccessful query result, `fallbackUpdateState`'s
  `reconcile` is typed `() => Promise<void>` and releases the optimistic value ONLY on a resolved read (a rejected read or
  an absent callback keeps it visible as unconfirmed, and a newer revision always wins), and the composer suppresses
  compensation for `configNeedsReconciliation` — a committed code OR a `ConfigConfirmationFailure` after 204 — not for
  committed codes alone. All four halves are pinned by new negative scenarios plus a compile-time pin on the callback's
  `Promise<void>`; the 40 prior scenarios and their assertions are unchanged.
- [x] T020 [US2] Integration test owners `packages/server/test/config.test.ts` and the owning core runner/admission tests:
  use deterministic production-path barriers for held generation, ordered updates, retry dispatch and PATCH/client
  outcome, including real HTTP abort and later writer progress; preserve T001 V1 failure modes, immutable dispatch and
  no uncertain tool replay. The "real HTTP abort" half, recorded as a HOLD in the earlier S3 pass, is NOW PROVEN at the
  route boundary by two keepers in the same owner (see "Wire-level abort keepers" below): a `Request.signal` abort
  interrupts the request fiber inside Config's read/queue owner (`{ status: 499, body: "" }`, zero temp writes and zero
  renames for the abandoned writer even after its parked read is released), the next PATCH in the same graph commits so
  the lease and entry position are retired, and a cancellation landing inside the uninterruptible write→commit→publish
  window completes forward with a whole document and no stranded temp. Decisive negative: making the precommit region
  uninterruptible turns the first keeper red. No production change was needed and none was made; core's owning keepers
  still pass.
- [x] T021 [US1] Evidence owner `specs/011-restore-config-integrity/tasks.md`: record S3 command results, generated reproducibility, wire and both-client generic/both-applicable-codes/204 evidence, caller outcomes, integrated trace, intentional type changes and exact blockers. Review all existing V2 assertions and T001 mapping without reducing them.

**Single final gate**: `bun run --cwd packages/server test test/config.test.ts test/defect-response.test.ts`; `bun run --cwd packages/client test test/promise.test.ts test/effect.test.ts`; `bun test packages/app/src/session/composer/selection.test.ts packages/app/src/settings/general/controllers.test.ts`; `bun run --cwd packages/protocol check:generated`; `bun run --cwd packages/client check:generated`; `bun run --cwd packages/protocol typecheck`; `bun run --cwd packages/server typecheck`; `bun run --cwd packages/client typecheck`; `bun run --cwd packages/app typecheck`. If generator source changes, also run its focused tests and typecheck. PASS only with S1 and S2 accepted, all wire, both-client, affected-caller and integrated assertions passing, reproducible artifacts and documented actual types. HOLD for a lost/spurious code, generic 500 decoding failure, false success/rollback, stale protected reads, missing abort evidence, failed integration, unverified real operation classification, or stranded required resource/lease. Handoff: complete evidence matrix and actual client types for feature review.

## Phase 6: Polish and cross-cutting

No separate acceptance slice or speculative refactor. T006, T015 and T021 record the applicable evidence and blockers at their own gates.

## Dependencies, parallel work and strategy

T001 precedes evidence mapping. S1 → S2 → S3 acceptance; implementation tasks within each slice follow their test/production dependencies and gate evidence follows all implementation. S1 is the independently verifiable MVP. S3 protocol/client work (T016–T018) precedes caller/integration work (T019–T020), with one final gate. Within S1, T002 and T004 can be prepared independently; within S2, T007, T009, T011 and T013 cover distinct test owners but coordinate shared files; within S3, server and client test design can proceed in parallel once the contract is agreed. No `[P]` task is asserted independent of incomplete tasks or shared-file conflicts.

## Publication-state decision and verification

The contract now distinguishes precommit failure, committed-unpublished failure, committed-published mandatory completion failure at a real boundary, and diagnostic-only optional housekeeping with 204. The current reload assigns reader state before `Event.Updated`, then requests a deferred reload and releases the lease; ordering alone does not establish each operation's role. T004/T005 must verify the specific subscriber, watch and cleanup boundaries described in `research.md`; an unclassifiable required boundary is HOLD. No later slice is a prerequisite for accepting S1 or S2.

## S1 evidence: T001 matrix and T006 record

Implemented on branch `011-restore-config-integrity`. Only `packages/core/src/config.ts` and
`packages/core/test/config/config.test.ts` changed. The S1 update-lock → staging → exclusive-admission
architecture, `ConfigDiscovery.names` precedence and target-file selection are unchanged.

### Gate commands

| Command | Result |
| --- | --- |
| `bun run --cwd packages/core test test/config/config.test.ts` | `71 pass / 0 fail`, 387 assertions, exit 0 (repeated 3× with identical results) |
| `bun run --cwd packages/core test test/config/` | `307 pass / 0 fail` across 23 config files, exit 0 (regression check for the same owner) |
| `bun run --cwd packages/core typecheck` | `✓ No type errors in 2,018 files across 2 projects`, exit 0 |
| `git diff --check` | clean, exit 0 |

### V1 negative assertion → V2 owner and demonstrated failure mode

V1 injection used a wrapped `FileSystem.FileSystem` node recording `writes`, `renames`, `removes` and
failing selected operations. V2 reproduces it at the same owner: `filesystemInjection()` wraps
`NodeFileSystem.layer` and records `writes`, `renames`, `removes`, `chmods` and `reads` (each read carries
its `failed` flag), failing selected operations. It is wired into the existing graph through
`platformFilesystem.replace(...)` inside `testLayer`, so production `Config.update` → `FSUtil.Service` →
the injected filesystem. Every injected test asserts the intended operation was reached.

| V1 assertion (`packages/opencode/test/config/config.test.ts:443–550`) | V2 test in `packages/core/test/config/config.test.ts` | Demonstrated |
| --- | --- | --- |
| Validation failure: no target mutation, no temp write, no rename | "rejects a candidate whose recognized field is invalid before touching disk" | `{"mcp": 42}` in the complete candidate yields a normalization diagnostic of kind `invalid`; typed `Config.CandidateRejected`, `writes/renames/removes` all 0, bytes and mode `0o600` unchanged, `entries()` deep-equal before/after |
| Malformed or unusable document is rejected before staging | "rejects malformed JSONC and a non-object root without writing" | malformed JSONC → `Config.CandidateRejected` with zero writes; `[1, 2]` root → the sparse edit step itself throws, so a `FileSystemError` precommit failure with zero writes and unchanged bytes |
| Temporary-write failure: original bytes retained, zero renames, temp write and cleanup both observed | "keeps old bytes, mode and readers when the temp write fails, then recovers" | injected `writeFileString` fault; exactly one temp write attempted (basename `.*.tmp`, same directory), zero renames, one `remove` of that temp path, original bytes and mode retained, readers unchanged, retry afterwards commits and publishes |
| Rename failure: original bytes and cached value retained, rename attempted exactly once, temp cleanup observed | "keeps old bytes, mode and readers when the rename fails, then recovers" | injected `rename` fault; `renames === [[temp, target]]` once, `removes === [temp]`, old bytes/mode, `entries()` unchanged, only `opencode.jsonc` left in the directory, retry succeeds |
| Successful atomic update: temp content equals committed target; temp is in target directory; exact temp→target rename; mode preserved; cache reflects new value | "commits the candidate through one same-directory temp file and one exact rename" | one temp write whose recorded content is byte-identical to the saved target, temp in the global directory, exact rename pair, `chmod` recorded on the temp path with the original `0o600`, target mode still `0o600`, `entries()` shows the new fallback, comments/`username`/omitted-`shell` preserved |
| No-op: zero writes, zero renames, no unnecessary cache invalidation | "treats an equal candidate as a no-op with no writes, renames or invalidation" | after a real commit (listener count 1, writes 1), re-issuing the same `shell` + `fallback` leaves writes, renames, removals and the `Event.Updated` listener count unchanged and the file byte-identical |
| Legacy compatibility retained | "keeps legacy unsupported and precedence-conflict diagnostics non-fatal" | `"logLevel"` (kind `unsupported`) and `compaction.reserved`/`compaction.buffer` disagreement (kind `conflict`) still commit; both fields remain in the file |
| Initially absent global directory | "creates the global directory and file when none existed" | `ensureDir` + temp write + rename create `global/opencode.jsonc`; readers see the new values |

### Explicitly deferred, not claimed as S1 parity

| V1 server assertion (`packages/opencode/test/server/global-config-update.test.ts`) | Owning slice |
| --- | --- |
| two concurrent writers, serialized entry-order commits | S2 T007/T009/T010 |
| queued admission and interrupted queued writer, exactly-once release | S2 T011/T012 |
| cancellation around replacement across the admission boundary | S2 T011/T012 (S1 only covers cancellation after the rename, see "releases readers and locks when a writer is cancelled across the rename") |
| real HTTP abort, wire codes and both generated clients | S3 T016–T020 |

Existing V2 assertions preserved: the preexisting persistence test (fallback selection, `shell`, JSONC
comments, unrelated `username`, explicit null, legacy fallback) and all 52 other preexisting tests in
this file pass unchanged. `testLayer` gained one trailing parameter defaulting to `NodeFileSystem.layer`,
so no existing call site changed behavior.

### Reader coherence and no-op coherence (S1 correctness pass)

These three cases close the gaps left by the first pass: a protected read must not succeed with stale
state, a byte-equal PATCH must not report success before coherence, and ordinary `reload` must keep
propagating a notification failure.

| Case | V2 test in `packages/core/test/config/config.test.ts` | Demonstrated |
| --- | --- | --- |
| Stale protected read after a committed-but-unpublished update | "commits but reports unpublished when reader refresh fails, then reconciles forward" | with the reader fault armed, `config.entries()` returns no value: the read exit has `Exit.hasDies === true` carrying the injected `readFileString` `PlatformError`; the retained coherent document is never handed back as a current read, and after the fault clears the next read reconciles to the committed fallback |
| Byte-equal PATCH while the commit is still not visible | "refuses a matching PATCH while the commit is not visible to readers" | fault armed on a *second discovered source* (`project/opencode.jsonc`) through `injection.faults.afterRename`, so it can only land in the reader refresh and never in the precommit read (asserted: zero failed reads of the update target); the equal-candidate path returns `Config.CommittedButUnpublished` instead of success, with `writes`, `renames`, `removes` and the failed-read count all unchanged except the one new refresh attempt, and the file byte-identical; once the source is readable the same PATCH succeeds with still zero writes and renames and readers show the committed fallback |
| Byte-equal PATCH after an external disk change | "repairs readers on a matching PATCH after an external disk change without writing" | disk edited out of band with no watch event, so `entries()` is provably stale (`/bin/zsh`); the matching PATCH writes and renames nothing yet refreshes readers and notifies exactly once (`notified === 1`), then a further matching PATCH is inert (no writes, renames or invalidation) |
| Ordinary reload notification failure | "propagates an aborted notification from an ordinary reload to its caller" | an aborting inline `Bus.listen` listener plus a watcher-driven reload: the reload routine's caller observes the failure exactly once as `failed to reload config` whose logged cause `reasons[0]` is a `Die` defect carrying the injected error message — evidence the failure is no longer discarded inside `reload`. The document was still reloaded (`entries()` shows the new `shell`), so only the completion step failed, and the writer path was untouched (zero writes/renames) |

### State attribution and pending delivery (second S1 correction pass)

| Case | V2 test in `packages/core/test/config/config.test.ts` | Demonstrated |
| --- | --- | --- |
| Matching PATCH after an unrelated external edit, with no commit attributable to this update | "reports the reconciliation failure itself for a matching PATCH after an unrelated edit" | file edited out of band, read fault armed on the second discovered source; the equal-candidate PATCH yields `Exit.isFailure === true` with `Exit.hasDies === true`, `Exit.hasInterrupts === false` and `Option.isNone(Exit.findErrorOption(exit)) === true` — the real `readFileString` defect is surfaced and **no** `Config.*` committed-state identity is invented; zero writes/renames/removes, the external bytes and `0o600` mode intact; while the fault stands the following `entries()` also dies, so neither writer nor reader reports success against a stale document; after the fault clears the read reconciles to `/bin/bash` and the same PATCH then succeeds with still zero writes/renames |
| Aborted announcement on a matching PATCH that committed nothing | "propagates an aborted announcement for a matching PATCH that committed nothing" | after an out-of-band edit, a byte-equal PATCH with an aborting inline `Bus.listen` listener: `Exit.isFailure`/`Exit.hasDies` true, `Exit.hasInterrupts` false and `Option.isNone(Exit.findErrorOption(exit))` true, so the notification failure is propagated and **no** `Config.CommittedWithPostPublicationFailure` (or any committed-state identity) is attributed to this writer; the listener's attempt counter proves the announcement was reached (`attempted === 1`) with delivery incomplete (`notified === 0`); zero writes/renames/removes, external bytes and `0o600` retained; while the delivery stays pending a protected read also dies, and after the listener is removed the reader reconciliation re-delivers exactly once (`notified === 1`, `shell` visible) and a later matching PATCH succeeds with still zero writes/renames. Mutation check: with the `committedByThisCall` guard removed from the postpublication branch this test fails on the empty-error-channel assertion, so it is a real regression guard |
| Mandatory announcement aborted while readers reconcile | "retries a pending announcement on the next protected read instead of losing it" | after a `Config.CommittedButUnpublished` commit (one write, one rename) with the read fault cleared, the first protected read reconciles the document but its announcement aborts: the read dies and the counting listener shows `notified === 0`; a second read still dies with `notified === 0`, proving the delivery stayed pending and was retried rather than dropped when the reader state was cleared; once the listener stops aborting the next read re-delivers exactly once (`notified === 1`) and serves the coherent committed document, and a further read is inert. No additional writes/renames; mode still `0o600` |

### Boundary reachability

Each injected boundary is proven by an assertion on the recorded call, not on a mocked helper: temp
`writeFileString` path/format, `rename` pair `temp → target`, `remove` of the temp path, `chmod` on the
temp path, `stat`-derived mode, `readFileString` faults (armed only after `renames.length > 0`, or armed
through `faults.afterRename` on a *second* discovered source so the fault can only land between commit and
publication), the recorded read attempts with their `failed` flag, inline `Bus.listen` counter and aborting
listener, `remove` fault, the reload routine's error log, and the cancellation gate published from inside
the injected `rename` (so the interrupt is delivered only after the real rename).

### Operation classification by actual state

| Operation | State when it fails | S1 classification |
| --- | --- | --- |
| candidate validation, sparse edit, `ensureDir`, `stat`, temp write, `chmod`, `rename` | rename has not happened | precommit failure: `Config.CandidateRejected` (validation) or `FileSystemError` (edit/filesystem step). Old document remains committed; neither committed-state marker. |
| equal candidate (`updated === text`) with coherent readers | nothing to commit | success with zero writes, renames and reader invalidation (proven inert on the second matching PATCH) |
| equal candidate while a commit by this owner is still unpublished | nothing to commit here; a prior commit by this owner is durable and invisible to readers | the same publication step runs, so the retry keeps the attributable identity `Config.CommittedButUnpublished`; success is not available while protected readers remain stale |
| equal candidate after an unrelated durable edit, with no attributable commit | nothing to commit, readers not coherent | the reconciliation failure itself is surfaced (re-raised cause, error channel empty), **no** committed-state identity is claimed, `readersStale` stays armed, and the following protected read fails too; once disk is readable the read reconciles and a later matching PATCH succeeds with zero writes/renames |
| `refresh()` (discover + load + reconcile + assign `sources`/`configs`) after rename | new bytes durable; protected readers not moved to them | `Config.CommittedButUnpublished`. `load` converts filesystem errors into defects, so the step is observed with `Effect.exit` and any non-interrupt failure classifies; `pendingCommit` is set and stays set until a publication succeeds; the deferred rescan is not used as a substitute for publication |
| protected read (`entries()`) while any fault is armed (`pendingCommit`, `readersStale`, `deliveryPending`) | durable disk state or mandatory delivery outstanding | the read reconciles forward; if that fails it fails with the real cause (re-raised unchanged, so a defect, typed failure or interruption keeps its own identity) after a warning, and `readersStale` is re-armed for the next read. `Interface.entries()`'s success signature is unchanged and no stale document is returned; the in-memory document is retained internally and is served only after a successful reconciliation |
| announcement (`announceUpdate` → `bus.publish(Event.Updated, {})`) aborted inside `update` **with an attributable commit** (`committedByThisCall`, i.e. the rename path or a retry of an existing `pendingCommit`) | new bytes durable **and** coherent in core readers; cross-owner announcement incomplete for this writer | `Config.CommittedWithPostPublicationFailure` — distinguished from a refresh failure by the local `announced` flag, since both surface in one Exit. Coherent readers stay installed; no core-side retry at this boundary (HOLD 4) |
| announcement aborted inside `update` **with nothing attributable to this call** (byte-equal PATCH that only installed an unrelated durable edit) | this writer committed nothing; readers may be coherent while mandatory delivery is incomplete | **no committed-state identity**: the actual notification cause is re-raised unchanged, an error channel stays empty for this outcome, `deliveryPending` is armed so the reader-reconciliation mechanism retries the delivery, and success is not reported for incomplete mandatory delivery |
| announcement aborted **inside `reconcileReaders`** | reader state already coherent; mandatory delivery incomplete | the coherent document is installed, the actual failure surfaces to this reader instead of being discarded, and `deliveryPending` keeps the delivery pending so the next protected read (or a later publication) retries it. This is the deterministic recovery path for the ephemeral event |
| `reload()` announcement failure (watch-, credential-, wellknown- and integration-driven reloads) | reader state already refreshed; announcement incomplete | propagates to the caller unchanged, as before the refactor: each reload routine reports it through `Effect.catchCause` → `logError`. `update` alone re-classifies the same boundary as `CommittedWithPostPublicationFailure`; no second notification subsystem was added |
| `requestReload` (`PubSub.publish` into the 100 ms debounced worker) | protected readers already refreshed; `PubSub.publish` has no error channel (returns `false` when shut down) | advisory follow-up; no failure identity to classify |
| temp cleanup `fs.remove(temp, { force: true })` (`Effect.ensuring`) | after a successful rename the temp path is already consumed, so nothing is stranded | diagnostic log only; success retained (the directory then holds exactly `opencode.jsonc`). Before a rename the same log records `committed: false` while the precommit failure stands |
| `lease.release` (`Effect.ensuring`) and `fallbackIntent.clearIfCurrent` (`Effect.onExit`) | mandatory lifecycle | run on every path, never classified; proven unstranded by a later successful update after each failure identity |

Coherence mechanism: three independent module-local flags, never conflated.
`pendingCommit` marks a durable commit made by this owner that protected readers were not published to;
`readersStale` marks a reconciliation that stalled, so readers may lag durable disk state with no
commit attributable to the current call; `deliveryPending` marks a mandatory `Event.Updated` announcement
that aborted and has not been re-delivered. `Config.entries()` returns the in-memory document only while all
three are clear, and otherwise reconciles forward or fails with the real cause; `Config.update` treats
coherence as a precondition of success on every path, including the byte-equal one, and claims a committed
identity only when the durable document can be attributed to a commit (`committedByThisCall` from the rename
path, or an existing `pendingCommit` on a retry). Cancellation from the first write through publication is
`Effect.uninterruptible`, so a writer interrupted across the rename publishes and cleans forward; a captured
interrupt cause is re-raised unchanged instead of becoming an outcome.

### Typed outcome handoff

Core exports: `Config.CandidateRejectedError` (`_tag: "Config.CandidateRejected"`),
`Config.CommittedButUnpublishedError` (`"Config.CommittedButUnpublished"`),
`Config.CommittedWithPostPublicationFailureError` (`"Config.CommittedWithPostPublicationFailure"`),
and the union `Config.UpdateError`, which is now `Interface.update`'s error type (server
`Effect.orDie` mapping untouched). S3 T017 should map `CommittedButUnpublished` →
`CONFIG_COMMITTED_BUT_UNPUBLISHED` and `CommittedWithPostPublicationFailure` →
`CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE`, and must not map a state core cannot produce: a
reconciliation or announcement failure that no commit can be attributed to stays an uncoded cause (never a
committed-state code), and a protected read that cannot be reconciled surfaces as a defect rather than a wire
identity.
Test hook for later slices: `filesystemInjection()` (records `writes`, `renames`, `removes`, `chmods` and
`reads`, with `faults.read` and `faults.afterRename` arming) plus the trailing `fileSystem` parameter of
`testLayer`.

### HOLD

1. Notification-completion evidence is at the Bus owner with a test-registered inline `listen` listener.
   No core production owner currently registers `bus.listen` for `config.updated`, so S1 proves the
   boundary is reachable and aborts publication delivery, but is not evidence that a production consumer
   hits it. S3 must re-establish this at its own boundary before claiming the second code.
2. A protected read that cannot be reconciled fails with the cause `refresh` produced, and because `Config.load`
   converts filesystem errors into defects (`orDie`) that failure is a **defect**, not a typed error:
   `Interface.entries()` keeps its error-free success signature, so a caller sees an abnormal termination
   rather than a `Config.*` identity. This is deliberate (never serve stale data) but it is a policy change
   for every `entries()` consumer, and S3's server mapping cannot observe it as a wire code. If a typed
   reader identity is required, it needs an `Interface` signature change and is therefore recorded as HOLD
   rather than claimed here.
3. Reload-propagation evidence is a captured error log (`failed to reload config` with the injected
   `Die` defect). The reload entry points have no typed error channel of their own, so the assertion is
   "the caller reports it", not "the caller returns it".
4. Mandatory `Event.Updated` delivery is recoverable on the reader path and on the unattributed writer
   path, both by arming `deliveryPending` so the next protected read retries the delivery without needing
   a document change (proven by both tests). At the **attributed** `update` boundary there is still no
   core-side retry: the aborted announcement is surfaced as `Config.CommittedWithPostPublicationFailure`
   and that writer's delivery is not repeated, because repeating it would emit a second announcement the
   caller cannot distinguish from the first. Guaranteeing idempotent cross-owner delivery would need an
   owner above core, so it stays HOLD; S3 must not imply core retries it.
5. The `ConfigNormalize` "root is not an object" branch is defensive, not reachable through `update`:
   jsonc-parser refuses the sparse edit first (observed `Can not add index to parent of type array`), so
   that document fails as a precommit `FileSystemError` instead. No S1 state classification depends on it.
6. No mandatory post-publication completion operation other than the announcement exists in the current core
   owner; the committed-published identity is exercised only at that boundary.
7. No fsync/power-loss durability guarantee is provided, consistent with `research.md`.
8. S1 acceptance here is reported as implementation plus evidence for independent review; it is not
   self-declared PASS, and S2/S3 work has not started.

## S2 evidence: T007–T015 record

Implemented in the same checkout on top of accepted S1 (all changes uncommitted; the user owns git
operations). Changed: `packages/core/src/config.ts`, `packages/core/src/config/fallback-runtime-intent.ts`,
`packages/core/src/session/runner/llm.ts`, and four test owners. `packages/core/src/session/generation-admission.ts`
is UNCHANGED — T012's retention requirements were already met by S1's implementation; S2 adds the tests that
prove exactly-once release and cancelled queued writers, and rewires the config commit onto that exclusive lease.
The "shared leases across runtime graphs" half of T011 is NOT proven and is recorded as a HOLD with a counterexample
(HOLD item 6): the current graph assembly gives each compiled graph its own admission instance. Changed in this
correction pass: `packages/core/src/session/runner/llm.ts` (`chooseFallback` re-resolution loop), `packages/core/test/
session-runner.test.ts` (instrumented Config read boundary + 3 read-window scenarios) and `packages/core/test/
session-generation-admission.test.ts` (1 boundary counterexample scenario).

### Gate commands

| Command | Result |
| --- | --- |
| `bun run --cwd packages/core test test/config/config.test.ts test/config/fallback-runtime-intent.test.ts test/session-generation-admission.test.ts test/session-runner.test.ts test/session-runner-retry.test.ts` | `370 pass / 0 fail`, 1,923 assertions, exit 0 (repeated with identical results; 80+7+5+271+7 — the +1 admission scenario and +3 session-runner read-window scenarios are the S2 correction additions; all previously recorded assertions still pass) |
| `bun run --cwd packages/core typecheck` | `✓ No type errors in 2,018 files across 2 projects`, exit 0 |
| `git diff --check` | clean, exit 0 |
| Regression: `bun run --cwd packages/core test test/config/` | `321 pass / 0 fail` across 23 config files, exit 0 |
| Context: full `bun run --cwd packages/core test` | `7612 pass / 38 skip / 3 fail` (exit 1) — the 3 failures are `test/tool-shell.test.ts` ×2 ("conditional substitutions respect once/always": spawned `/bin/bash: wait: pid N is not a child of this shell`, exit 127; reproduces standalone) and one `test/shell-scan/bash-syntax.test.ts` case seen only under full-suite spawn load (299/0 standalone). Both files are unmodified and their code paths share nothing with config update, intent, admission or runner recovery. Recorded as pre-existing environment artifacts, not S2 gate members. |

### Architecture delta over S1

- `FallbackRuntimeIntent` gained the entry-position API: `reserve()`, `stageValidated(revision, value)`
  (older revisions are ignored), `awaitPredecessors(revision)` (interruptible, deregisters its waiter on
  interruption), `retire(revision)` (wakes waiters on every exit path) and `clearIfCurrent(revision)`; the legacy
  direct `stage(value)` keeps its signature and RETIRES its position immediately (no durable commit to order).
  State: `{ next, staged: Snapshot, open: Set<number>, waiters }` in a `SynchronizedRef`.
- `Config.update` now: reserve BEFORE validation → (fallback-bearing patches only) pre-admission read+sparse-edit+validate
  against the current disk → `stageValidated` → `awaitPredecessors` (the entry-order commit gate) →
  `admission.acquireExclusive` → RE-read + re-edit + re-validate at this writer's own commit boundary → unchanged
  S1 write/chmod/rename/publish/cleanup → whole-flow `onExit`: `clearIfCurrent` only if this owner staged, then
  `retire`. The former `updateLock` is REMOVED; commit serialization stays with the exclusive admission lease and
  entry order comes from the reservation gate, so C's commit begins only after B has fully retired (committed,
  failed or cancelled) even when C validated and staged first.
- `llm.ts` `chooseFallback` no longer snapshots a request-start `recordedFallback`. The fallback for the attempt
  after a retry's backoff is resolved AFTER backoff and immediately before dispatch, in a re-resolution LOOP: read
  `fallbackIntent.current()` FIRST, and a staged `override.type === "some"` answers the choice with NO committed
  read at all (an explicit `null` therefore disables recovery without touching the committed configuration); only an
  absent override performs the protected read `ConfigFallback.resolve(Config.latest(yield* config.entries(),
  "fallback"))`. AFTER that read the snapshot is re-taken, and if `after.revision !== before.revision` or an override
  appeared meanwhile, the value the suspended read returned is DISCARDED and the choice is re-resolved instead of
  dispatching from an obsolete snapshot. A validated staged value always wins when present; the loop is what keeps
  that true across a read window. Selection stays AFTER the retry backoff (one recovery lifecycle, no second one);
  `choice === null`, `Model.Ref.make`, `context.resolveModel`, the model/variant identity guards, `attemptedFallbacks`
  and current-model checks are unchanged. The primary half of FR-025 (`requestModel`), `currentModel`,
  `attemptedFallbacks`, `pendingFallback` and compaction guards are unchanged. This closes the identifiable read-window
  race; it does NOT claim atomicity against a config change that lands after a physical dispatch has begun.
- Test harness: `filesystemInjection()` gained re-armable single-use barriers `armReadGate(target, wait)`,
  `armWriteGate(wait)`, `armRenameGate(wait)` plus `awaitUntil(effectPredicate)` spin synchronization (fails loudly
  after 2,000 yields; never sleeps), and `faults.write` now accepts a per-path predicate. The graph `testLayer` build
  group lists `FallbackRuntimeIntent.node` and `SessionGenerationAdmission.node`, so tests observe the SAME service
  instances the config layer uses and can hold external leases. All barriers are recorded via the same call counters,
  so boundary reachability is asserted, not assumed. In `session-runner.test.ts` the runner's own Config fixture is
  wrapped by `instrumentConfig(Config.testLayer(...), state.configBarrier)`: the wrapper DELEGATES every operation to
  the same underlying service and is installed in BOTH positions (`Config.node.replace(config)` and the scenario-context
  merge), so the recorded/observed boundary is the service the runner actually reads. `barrier.reads` records the
  committed `fallback` value each `entries()` read saw, and `barrier.hold` (`{ gate, opened }`) parks a read AFTER the
  document read returns and BEFORE the runner decides, with `barrier.parked` counting actual suspensions.

### Traces

| S2 obligation | V2 test | Demonstrated |
| --- | --- | --- |
| Out-of-order validation, entry-ordered commits (FR-006/007) | config: "commits updates in entry order when validation finished out of order" | B parked in its pre-admission read (read gate consumed by its recorded read), C validates and stages `model-c` first: `intent.override === some(model-c)` with `renames===0`, `writes===0` and the file BYTE-IDENTICAL (negative: nothing durable). Releasing B parks it again inside its commit boundary (second armed gate consumed by the fresh re-read): still `writes===0` and intent stays `model-c` (B's late older `stageValidated` returns false, proven as a unit in the intent tests). After release: `writes[0].content` has `model-b`, `writes[1]` has `model-c`, `renames===2`, final bytes carry only `model-c` and the untouched `"username": "kept"`, and both owners' exits cleared only their own revisions (final `override === none`). |
| Staging follows validation; failure/cancellation publishes no intent and strands nobody | config: "publishes no staged intent for a candidate rejected by validation, then commits after the document is fixed"; config: "publishes no staged intent when an update is cancelled during validation, and later writers progress"; intent: "holds a later entry position until the earlier one retires, then releases it" + "…a cancelled waiter stays clean" | Rejected candidate (`"mcp": 42` on disk) → `Config.CandidateRejected`, `override === none`, zero writes/renames, the invalid bytes untouched, and the NEXT update progresses (1 rename, committed, cleared). Cancelled writer: `Fiber.interrupt` at the parked read gate → `Exit.hasInterrupts === true`, `override === none` at the moment of cancellation and after, zero durable ops, the queued shell writer commits and a later fallback update commits (2 renames total). Intent unit: waiter for the later revision shows `Deferred.isDone === false` while the earlier position is open, becomes true exactly on `retire`; an interrupted waiter leaves no leak — a fresh waiter for the same revision stays blocked until the earlier retirement, then releases. |
| Committed B exposed after a newer failure; failed update clears only its own staged revision (FR-011) | config: "clears the staged intent of an update that fails at its temp write, then commits a later update"; config: "exposes the committed fallback after a newer update's commit fails"; config: "orders three overlapping commits so a failed middle exit cannot clear the newest intent" | Per-path write faults: failed temp write → `FileSystemError`, one temp write recorded + one cleanup remove, zero renames, old bytes intact, `override === none` immediately after the failed update. B-then-failing-C leaves the file with only `model-e1`, `renames===1`, intent cleared, `entries()` still shows the committed `model-e1`, and a later shell update commits (coherence retained). Three-way B/C/D with the fault on the SECOND temp (entry order fixes temp order): B succeeds; C fails; immediately after C's exit `staged === model-g3` — C's `clearIfCurrent(C)` cannot erase D; D commits last (`renames===2`, `writes===3`, `removes===3`) leaving only `model-g3`, and D's own exit clears to `none`. |
| Sparse survival and A → B → A at each writer's own boundary (T009/T010) | config: "re-applies a repeated fallback at its own commit boundary so it still commits"; config: "…cancelled during validation…" (mixed shell+fallback) | A1 commits; B parks; A2 (byte-equal against the PRE-ADMISSION document) still commits after B lands: `renames===3` — a stale-snapshot comparison would have skipped the third write — with `writes[1]` carrying `model-b2` and `writes[2]` carrying `model-a1`, final bytes only `model-a1`, entries and intent agree. Shell patch + fallback patch coexist in one document (`"shell": "/bin/zsh"` and `"model": "model-z"` alongside `"username": "kept"`). |
| Restart from disk | config: "starts a second service generation from the committed document with no staged intent" | Graph 1 commits `model-f1`; a SECOND fresh graph over the same directory reads the committed document from disk and `current() === none`, so recovery falls through to the committed value. |
| Admission WITHIN one graph: held generation, cancelled queued writers, exactly-once release (T011/T012) | admission: "a cancelled queued exclusive writer never blocks later readers or writers"; admission: "releasing one lease twice grants a queued writer exactly once"; config: "defers a durable commit while a protected reader holds a shared lease, then admits it" | Interrupted queued exclusive drops its queue entry; a reader and a fresh writer progress after the holder releases. Double release keeps the queued writer withheld (`Deferred.isDone(started) === false` after the double release AND after the first lease's release; admitted only when the LAST shared holder releases — one grant, joined, released). At the real graph boundary an EXTERNAL `acquireShared` lease defers the update's commit while its intent is already staged (`writes===0`, `renames===0`, bytes unchanged — FR-006's staging-before-admission ordering visible through the lease), the commit completes after release, and a later `acquireExclusive` takes the lease immediately (nothing stranded). SCOPE OF THAT PROOF, CORRECTED: the config test obtains Config and Admission from ONE `LayerNode.group([Config.node, Bus.node, FallbackRuntimeIntent.node, SessionGenerationAdmission.node])` build, so it proves sharing INSIDE one compiled graph, not across independently compiled graphs (see the HOLD row below). Cancellation around replacement stays covered by the preserved S1 test "releases readers and locks when a writer is cancelled across the rename" (uninterruptible write→publish window; the commit cleans forward, no partial state, readers coherent). |
| Recovery resolves the LATEST eligible fallback after backoff, dispatch stays frozen, guards intact (T013/T014) | session-runner: "resolves the latest recorded fallback after backoff for a request already waiting in backoff", "uses the latest committed fallback when a staged intent clears during backoff", "disables recovery when the committed fallback turns off during backoff", "prefers the staged runtime intent over the committed document when both change during backoff" | Traces: recorded pair moves mid-backoff → `[model, variantModel]` with `not.toContain(replacementModel)` AND `not.toContain(fallbackModel)` (the stale snapshot can never surface; the primary half is still pinned); request started with fallback OFF then committed value lands and its staged intent clears during backoff → `[model, fallbackModel]` (only FR-008's committed tier can produce this attempt); committed turns explicit null mid-backoff → `[model, model]` with exactly 2 attempt spans (a recorded snapshot would wrongly dispatch B); intent + committed + snapshot all differ → `[model, fallbackSmallModel]` with `not.toContain` for the other two — three mutually exclusive outcomes identify the exact rule that fired. "Without an unnecessary primary attempt": every case shows EXACTLY two attempt spans (primary + the one fallback dispatch). Already-dispatched attempts stay fixed: preserved scenario "reads fallback intent after backoff and snapshots the dispatched model" (a later `stage(replacement)` cannot retarget the in-flight attempt) and preserved "keeps the pair an in-flight request started with…". Guards retained unchanged and passing: variant identity ("does not treat a variant of the active model…"), attempted-once ("attempts one fallback identity at most once…"), compaction ("keeps the selected fallback when compaction runs before its attempt" — `pendingFallback` survives the reload), retry caps and no-replay scenarios (`session-runner-retry.test.ts`, 7 tests, untouched and passing). |
| Staged intent answers the choice with NO committed read; obsolete values cannot survive a suspended committed read (T013/T014 read-window correction) | session-runner: "dispatches a staged fallback without any committed config read", "re-resolves when a newer intent is staged while the committed read is suspended", "resolves the committed document current after a staged revision clears during the read" | (A) committed document = B, validated `stage(D)` present, window armed at the retry-scheduled boundary and matched phase-for-phase: dispatched trace `[model, variantModel]` with `not.toContain(fallbackModel)` (the committed value never becomes an attempt) and `not.toContain(fallbackSmallModel)` (a later `stage` while the attempt streams cannot retarget the dispatched model), EXACTLY 2 attempt spans, and `readsWithIntent > 0` so the recorder is live in a window with no resolution read. The negative is a matched differential: the SAME window with nothing staged yields `readsWithoutIntent - readsWithIntent === 1` and serves B, i.e. exactly the one protected read the staged path skipped, through the runner's OWN instrumented instance (not a helper call). (B) no override → the committed read is PARKED inside the runner's `entries()` (`parked === 1`, recorded read `["fake/fallback-model"]`, trace `[model]` and 1 attempt span at the park point, so only `chooseFallback` can be the parked reader — `SessionProjector`'s reads happen inside `SessionStep.attempt`); a newer `stage(F)` lands in that window, the read is released, and the dispatch serves F with `not.toContain(fallbackModel)` and EXACTLY 2 attempt spans. (C) same window; committed document moves B→D, a newer revision staging F is then retired by `clearIfCurrent(revision)`; the dispatch serves D with `not.toContain(fallbackModel)` AND `not.toContain(fallbackSmallModel)`, 2 attempt spans, `parked === 1`, and the recorded read sequence across the window is exactly `["fake/fallback-model", "fake/variant-model"]` — the parked read's value is DISCARDED and the re-read of the current document decides. No sleeps or wall-clock polling: `Deferred` gate + `TestClock.adjust(2_400)` + the harness retry queue. |
| Admission ACROSS independently compiled runtime graphs (T011 wording) — HOLD for independent compiles, RESOLVED for the production one-build shape | admission: "independently compiled graphs hold separate admission instances (T011 HOLD boundary)" + `test/effect/app-node-builder.test.ts` scenarios 1 and 3 | Recorded COUNTEREXAMPLE, not an acceptance proof, for graphs compiled independently: two graphs each compiled from the module-level `SessionGenerationAdmission.node` yield `first === second === false`, a shared lease held in `first` does NOT withhold an `acquireExclusive` in `second` (admitted immediately, `Deferred.await(admitted)` while the lease is held), while the SAME-instance control DOES withhold it. The single-`AppNodeBuilder.build` production shape is covered by the cross-graph scenario in "S2 correction pass 2" below; this row only bounds the claim to independent compiles. |

### Intentional contract evolution (documented, not a weakened assertion)

The accepted S1-era scenario "does not retarget a request already waiting in backoff when the recorded fallback
and primary change" asserted the pending attempt serves the request-START fallback snapshot. FR-008, the spec
clarifications ("a pending recovery must resolve the latest eligible effective fallback — intent, then latest
committed — not an older recorded request-start snapshot") and Story 2 scenario 10 make that assertion the
behavior under test, so the scenario was rewritten (first half now serves the post-backoff recorded value D)
while its decisive negatives were STRENGTHENED, not removed: the in-flight request is still never relabeled onto
the new primary C, the older recorded B is now also forbidden, attempt-span counts are unchanged, and the second
request's `[replacementModel, variantModel]` trace is preserved. FR-025's PRIMARY half is kept by the preserved
scenario "keeps the primary model a request started with for its retry when fallback is off…" (`[model, model]`)
and by the preserved in-flight pair scenario; the old fallback-half assertion and FR-008 are mutually exclusive,
which is the reason for the rewrite. All other preexisting S1 assertions pass unchanged (71/71 config tests are
subsumed by the 80, 265/268 session-runner scenarios preserved verbatim).

### Boundary reachability

Every S2 boundary is proven by recorded operations, not by helper trust: read gates proven consumed by the
incremented `reads` count of the target path (baseline taken after graph load, so the gate is observed
consumed by the update's own pre-admission or commit-boundary read); `awaitUntil` spins on observable state (recorded
calls, `Deferred.isDone`, `intent.current()` through the graph's own instance) and dies loudly if a barrier is
never reached; write faults are armed per-path so only temp files fail; the cancellation interrupt is delivered only
while the writer is provably parked at the validation gate; the external lease is acquired from the same graph's
`SessionGenerationAdmission.Service` the config layer uses. Retry boundaries use the harness's retry-subscription
queue and `llm.gate()` (no sleeps); the first gap stays within `RETRY_GAPS_MAX`. The runner's protected READ boundary is
reached the same way: `instrumentConfig` wraps the runner's own `Config.testLayer` service, so `parked === 1` plus the
recorded value of the parked read proves the fallback resolution was sitting INSIDE `config.entries()`, and the
"no committed read required" claim is proven as a matched-window read COUNT differential against the same instrumented
instance (never by trusting a stand-in mock).

### S2 HOLD / carried-forward items

1. The pre-admission validation phase gates only FALLBACK-BEARING patches (an invalid precommit publishes no
   intent); shell-only patches have no intent to gate and are validated once at the commit boundary. T010's "both
   writer outcomes" holds under this design; S3's wire behaviors must not assume a pre-admission read for
   shell-only PATCHes.
2. Entry order is enforced among `update` owners via the shared revision line; DIRECT `stage` callers (composer
   runtime owners) take a position and retire immediately, so they interleave without blocking and are never
   ordered as durable commits. S3 integration must treat direct staging as intent-only.
3. `chooseFallback` performs the protected `config.entries()` read ONLY when no staged override is active — a
   validated override (including an explicit `null`) answers the choice with NO read. So a retry can still surface a
   reader-coherence failure from that protected read into the recovery path (an S1 HOLD-2 defect shape), and S3 must
   map it at its boundary; core adds no typed identity here. The narrower window this closes is that a change
   accepted WHILE the read is suspended can no longer be overruled by the value that read returned: the revision
   recheck forces re-resolution before the dispatch.
4. `generation-admission.ts` required NO production change for T012; the ownership-map exactly-once and queued-cancellation
   guarantees are S1 code now covered by S2 tests. If S3 changes lease ownership, T011's tests are the regression net.
5. The full-suite `tool-shell`/`bash-syntax` failures above are environment/spawn artifacts on this machine
   (bash `wait` semantics, exit 127), reproducible independent of this slice's code; S3 should re-run them in
   its own gate and expect the same baseline unless its environment differs.
6. **HOLD T011 — "separate configuration runtime graphs share admission" (FR-010) is NOT provided by the current
   graph assembly, so it cannot be evidenced without an unscoped process-global singleton.** Owner boundary, source
   grounded: `SessionGenerationAdmission.node` is ONE module-level `makeGlobalNode` (`session/generation-admission.ts:119`),
   and BOTH admission owners depend on it — `Config.configured()` (`config.ts:902`, the exclusive side used by
   `Config.update` at `config.ts:697`) and `SessionExecution.node` (`session/execution.ts:237`, the shared side passed
   to `SessionRunCoordinator.make` at `session/execution.ts:141`). But they are reached through DIFFERENT
   `LayerNode.compile` calls: `Config.node` is a LOCATION node in the per-location instance graph (`instance.ts:67`
   in `nodes`, compiled at `instance.ts:169` with `shared: Node.tags.values.global`), while a user-driven generation
   runs the SERVER graph's `Session.node`/`SessionExecution.node` (`server/src/routes.ts:78`, compiled once at
   `server/src/routes.ts:180` via `AppNodeBuilder.build(applicationServices, …)`); request handlers then resolve
   Config from the LOCATION services (`server/src/middleware/session-location.ts` `instances.provide(session)` and
   `server/src/location.ts` `locations.get(requestRef(request))`). `compile` (util/src/effect/layer-node.ts:244-328)
   dedupes a node by implementation identity ONLY within one call (`definitions.shared`/`definitions.local` are fresh
   per call) and builds a fresh wrapper layer per node per call, so the same global node becomes a DISTINCT service
   per compiled graph; `shared: global` shares those subgraphs inside that compile and with its ambient memoMap, NOT
   with an enclosing compile's node set. Concrete reproduction: the new admission scenario above shows two graphs
   built from the SAME node giving `first !== second`, a held `first.acquireShared` NOT withholding
   `second.acquireExclusive` (immediately admitted), while the same instance DOES withhold it. Consequence to fix in
   scope, NOT here: a generation lease taken by the server graph does not defer that location graph's durable
   `Config.update` commit, so FR-010's protection of active generation across graphs is unproven. Deliberately NOT
   done: no process-global singleton, no admission architecture replacement, and no claim that the existing single-
   graph config test covers the cross-graph requirement.
   **SUPERSEDED by "S2 correction pass 2" below, with the mechanism corrected.** The sentence "`shared: global` shares
   those subgraphs inside that compile and with its ambient memoMap, NOT with an enclosing compile's node set" is wrong
   about the ambient memo map: `compile` resolves GLOBAL-tagged nodes into `memoMap` (`layer-node.ts:317` builds them
   with `node.shared ? memoMap : local`), and `buildLocationServiceMap` hands that same memo map to every location entry
   build (`location-services.ts:28`, `Layer.buildWithMemoMap(Instance.layer(ref, …), memoMap, scope)`), so inside ONE
   `AppNodeBuilder.build` the SERVER graph and every location graph DO reach the same global-node service. Measured on
   this checkout: with the intent value binding REMOVED from `app-node-builder.ts`, `app-node-builder.test.ts` still
   passed 8 consecutive runs (the shared line is supplied by the graph tags), while re-tagging `FallbackRuntimeIntent.node`
   as a LOCATION node WITHOUT the binding fails the cross-location test. The correction pass therefore pins the
   guarantee at the owner that owns it - one VALUE per build injected through `bindings` - instead of relying on
   memo-map dedup, and the "independent compiled graphs are separate" reproduction in `session-generation-admission.test.ts`
   remains valid for graphs compiled independently.
7. As with S1, this record is implementation plus evidence for independent review; no acceptance is self-declared
   here, and `/speckit.slice-review S2` must adjudicate PASS/HOLD.

### S2 correction pass 2 (T011/T012 shared-state ownership, cross-location entry order)

Changed in this pass: `packages/core/src/effect/app-node-builder.ts` (one `FallbackRuntimeIntent` VALUE per build,
injected through the existing `bindings` path immediately after the admission binding, `...replacements` last so caller
overrides keep precedence; `build` stays synchronous) and `packages/core/test/effect/app-node-builder.test.ts`
(strengthened cross-location scenario, new entry-order boundary control). No other production file changed. No
process-static singleton, no second reservation manager, no new service, no new lock.

Third correction pass (committed-marker guard, S2's protected-read requirement): `packages/core/src/config/fallback-
runtime-intent.ts` gains a second monotonic line on the SAME per-build owner — the COMMITTED revision (`committedRevision
()`, advanced only by `recordCommit(revision)`) — kept INDEPENDENT of the staged line; `packages/core/src/config.ts`
calls `recordCommit(reservation)` inside the EXISTING commit block, immediately after the atomic temp+rename succeeds and
before `publishReaders`, so no new window is introduced, and each per-location `Config` records the marker it has OBSERVED
(around its initial load and in every `refresh()`), so its `entries()` reconciles when that marker lags the committed one.
Guard scope, stated exactly: a protected read of ANY location of ONE application build observes another location's
committed fallback after ONE read, with no forced disk reload while the markers agree, no second lock, no reload worker,
no shared document cache and no cross-location publication channel.

Ownership evidence, at the owner that owns it:

| Guarantee | Owner | Proof |
| --- | --- | --- |
| Lease ownership across the SERVER and LOCATION graphs of one application build | `AppNodeBuilder.build` (`src/effect/app-node-builder.ts`) injecting one `SessionGenerationAdmission` VALUE into `bindings` | Scenario 1 "shares one admission value…": real `SessionExecution.layer` (unreplaced) takes `acquireShared` for a busy period on the SERVER side while a real per-location `Config.update` (reached through `LocationServiceMap.Service.get(session.location)`) is withheld inside its commit window, and in the reverse direction a LOCATION writer parked inside its rename defers a second session's generation (active in the coordinator, `entered === 0`) until the writer's lease releases; the queued writer cancelled mid-window leaves `renames === 1`, clears only its own staged revision and does not strand the earlier writer; after the busy period settles the writer publishes with exactly one temp write and one rename |
| Entry order for the SAME global document written from TWO location graphs of one build | `FallbackRuntimeIntent` owner created ONCE per build and injected into both graphs | Scenario 2: `FallbackRuntimeIntent.node` listed as an un-replaced ROOT so the build's own owner is readable from outside the (private) location dependencies; the root line reads `revision 0 → 1` (control writer) and, with A parked in its pre-admission read, `revision === 3` with `override = model-second` - the control took 1, A took 2 and staged nothing, B entered from the OTHER location graph at 3. `renames === 1` and `writes === 1` while A's position is open, then `3/3` with `writes[1]` carrying `model-first` and `writes[2]` carrying `model-second`, every rename pair targeting `global/opencode.jsonc`, final bytes carrying `model-second` and `"username": "kept"`, and the settled line back to `override: none` |
| Recovery owner receives the shared intent instance | same VALUE reaches each location graph's `Config` (and therefore the runner's `llm.ts` read inside that graph) | Scenario 2 staging observed at the ROOT owner while the staging is performed by a writer entered from a location graph, and scenario 1 staging observed through the value the test injects; a staged value published in one location is on the same revision line every other location of that build reads |
| Committed-document freshness across location graphs (PROTECTED READS, FR-010/FR-011 read tier) | the `FallbackRuntimeIntent` owner's COMMITTED revision line (one per application build) + each per-location `Config`'s observed-committed marker, enforced in that owner's `entries()` (`src/config.ts`) | Scenario 4: A commits `model-first` (marker 1), B commits `model-second` into the SAME global document (marker 2). A's next PROTECTED read is proven not to return the older document: it serves `model-second` AND the recorder shows it actually re-read the global file (recorded reads grow), while B's read count does not grow (its marker was current), i.e. the reload happens on the one read that is behind, not on every read. Negative (read fails during that reconciliation): with a single-use read fault armed on a candidate ONLY A's graph reads, the read FAILS (`Exit.hasDies`, `Exit.isSuccess === false`) instead of presenting `model-first`, the failed read performs no write/rename (still `renames === 2`, `writes === 2`), the durable marker is unchanged, and A's NEXT read serves `model-second` — the revision it missed stays pending instead of being marked observed from bytes it could not read. B's own read is unaffected by A's failed reconciliation. Watcher delivery stays pinned in the same scenario (`hasSubscribed === true` for a `directory` watch on `global/`, the durable replacement appears in A's `changes()` stream), so the notification boundary is still evidenced; it is no longer what a protected read depends on. |

Deterministic negative assertions added in this pass (no sleeps; every wait is a Deferred gate, a recorded call count,
or a bounded `Effect.timeout` around a reservation gate):

- Cross-location entry order: `renames === 1` / `writes === 1` while the earlier entrant's position is open, and the
  root owner's `revision === 3` with the later entrant's staged value - separate per-location owners leave the root at
  `revision 0` with no override and let B commit.
- Entry-order boundary control (new scenario): two `AppNodeBuilder.build` calls give `first !== second`; with an
  open position in the first owner, `awaitPredecessors(n+1)` on the SAME owner times out while on the OTHER owner it
  returns immediately, and staging there lands at revision 1 while the first owner is still `revision 0` with
  `override: none`, so the out-of-order durable commit is what independent builds produce. This is why the guarantee
  is stated per application build.
- Lease boundary control (preserved scenario): two builds keep separate leases (`acquireExclusive` in the second build
  is admitted at once while the first build's shared lease is held).
- `session-generation-admission.test.ts` keeps the arbitrary `LayerNode.compile` control: independently compiled graphs
  are NOT required to share state; production sharing comes from the explicit `AppNodeBuilder` bindings.
- Cross-location read staleness (new scenario): the lagging location's read is proven to reload (recorded read count of
  the global file grows) and to serve the OTHER location's committed value, while the committing location serves from
  its current marker with NO additional read — the differential that a stale in-memory copy would break.
- Cross-location read failure (new scenario): single-use fault on the reconciliation's read → `Exit.hasDies === true`
  and `Exit.isSuccess === false` (never the older document), `renames`/`writes` unchanged, `committedRevision()` unchanged,
  and the NEXT read converges — so an unreadable commit is not silently marked observed.
- Cross-location rejected candidate (new scenario): `expect(error._tag).toBe("Config.CandidateRejected")`,
  `committedRevision()` and the staged line both unchanged, `renames`/`writes` unchanged, the on-disk bytes byte-identical,
  the other location's read still yields the PRIOR committed value, and the lagging location's OWN pre-existing fallback
  survives the rejected commit (its document was not replaced); a later valid commit advances the marker and BOTH
  locations follow it.
- Cross-location shell-only commit (new scenario): `committedRevision()` advances while `current().override` stays
  `none` (the staged line is not conflated with the durable one), and the other location's read shows the new `shell`
  while its own `fallback` entry is still served.
- Owner-level marker discipline (new `fallback-runtime-intent.test.ts` scenario): after `reserve`, `stageValidated`,
  `stage`, `clearIfCurrent` and `retire` the committed revision is UNCHANGED, and only `recordCommit` advances it
  (`1 → 2 → 3`) without ever moving backwards — this is the negative that keeps a RESERVED revision from being read
  as a COMMITTED one, which the guard depends on.
- One-build scope (new scenario): two `AppNodeBuilder.build` calls give `first.intent !== second.intent`, the new
  build's marker at boot is `0` while the first build's is `1`, the new build loads the durable document from disk
  itself (`diskReads > 0` and its entries carry the committed value), and its own commit lands at revision `1` while
  the first build's marker stays `1` — so no cross-application-build freshness is claimed.

Mutation measurements (source mutated, tests run, source restored - not committed tests):

| Mutation | Result |
| --- | --- |
| Remove the `FallbackRuntimeIntent` VALUE binding from `app-node-builder.ts` | `app-node-builder.test.ts` 4 pass in 8 consecutive runs: within one build, GLOBAL-tagged nodes already reach one service through the ambient memo map, so this mutation alone is NOT the observable defect |
| Retag `FallbackRuntimeIntent.node` as a LOCATION node, VALUE binding kept | 4 pass: the injected VALUE is shared regardless of the node's tag |
| Retag `FallbackRuntimeIntent.node` as LOCATION and remove the binding | cross-location scenario fails at the shared-line barrier (`barrier wait was never reached`), i.e. the binding is the owner boundary that pins one intent sequence |
| Retag `SessionGenerationAdmission.node` as a LOCATION node and remove the admission binding | scenario 1 fails (30s timeout at the deferral barrier): per-location admission instances do not gate the SERVER generation, so the cross-graph lease guarantee is provided by the injected VALUE |

Gate commands for this pass:

| Command | Result |
| --- | --- |
| `bun run --cwd packages/core test test/effect/app-node-builder.test.ts` | `8 pass / 0 fail`, 132 `expect()` calls, exit 0 (13 consecutive runs with identical results; the scenario count grew from 4 to 8 with this pass's cross-location read controls, so the earlier `4 pass / 72 assertions` record is superseded) |
| `bun run --cwd packages/core test test/config/config.test.ts test/config/fallback-runtime-intent.test.ts test/session-generation-admission.test.ts test/session-runner.test.ts test/session-runner-retry.test.ts` | `371 pass / 0 fail`, exit 0 — one test MORE than the `370` recorded above: the new owner-level committed-revision scenario in `test/config/fallback-runtime-intent.test.ts`. No earlier assertion changed; the two pre-existing scenarios in that file keep their exact names and pass (their inline recorder blocks were extracted into the shared `filesystemRecorder()` helper, which preserves the recorded calls, per-path write faults and rename gate, and gains a single-use read fault used by the new scenarios) |
| `bun run --cwd packages/core test test/config/` | `322 pass / 0 fail` across 23 files, exit 0 |
| `bun run --cwd packages/core typecheck` | `✓ No type errors in 2,019 files across 2 projects`, exit 0 |
| `git diff --check` | clean, exit 0 |

Residual boundaries after this pass (HOLD, exact owner named):

1. Residual window for COMMITTED-document freshness, narrowed by this pass (was HOLD 1). CLOSED within one application
   build: a PROTECTED READ (`entries()`) by any location of a build observes another location's committed fallback after
   ONE read, because the shared owner records the COMMITTED revision at the committing location's rename and each
   location compares it with the marker IT has observed; a read that cannot perform that reconciliation fails instead of
   serving its older copy, and the missed revision stays pending. STILL OPEN, exactly bounded: (a) a change to the global
   document made by something OUTSIDE this build (an editor, another opencode application root, an older V2 build) does
   NOT advance this build's committed marker, so that convergence still depends on the per-location `Watcher` reload worker
   (`requestReload` → `Stream.debounce("100 millis")` → `refresh`) — that boundary stays pinned in the same scenario
   (`hasSubscribed` for the `directory` watch on `global/`, and the replacement delivered into A's `changes()` stream);
   (b) propagation is READ-PULL, not eager: a location's in-memory copy changes only when it performs a protected read
   (or its watcher reload runs), so a non-reading consumer of that owner (for example a `changes()` subscriber) can still
   observe the older document until one of those boundaries fires; (c) a location inside its own commit, reader repair or
   intent delivery does not reconcile concurrently with it — its `entries()` waits for that owner to finish, which is
   where the per-location lock already applies. No cross-location publication channel, shared document cache, or per-read
   disk reload was introduced, so (a) is the real remaining boundary and belongs to S3's wire/integration gate if it must
   be closed there.
   SUPERSEDED STATEMENT, kept for review: the previous version of this item claimed the other location "converges only when
   ITS OWN reload worker runs, or when that owner performs its own commit/reader-repairing PATCH" and that the window
   "would need a cross-graph publication owner this slice does not introduce". That claim is now FALSE for protected reads
   inside one build (the read pulls against the committed marker); it remains TRUE only for the external-writer case in (a)
   and for non-reading consumers in (b). RACING-LOAD VARIANT, CLOSED: the one-read guarantee in this item had an
   unstated gap - a read whose OWN physical load was overtaken by a newer committed revision. That is closed by
   "S2 correction pass 3" below; (a) and (b) are unchanged by that pass.
2. Sharing is scoped to ONE application build. Independent builds own independent leases and independent revision lines
   (proven controls), so a second application root would need its own ownership story; no process-wide claim is made.
3. The runner's recovery read (`src/session/runner/llm.ts`) is proven to follow the shared intent owner only where it
   resolves it INSIDE a location graph of one build; a cross-graph recovery trace is not pinned here and belongs to
   S3's integration gate.


### S2 correction pass 3 (racing-load reconciliation, final S2 HOLD closure)

HOLD closed: the one-read guarantee recorded in boundary item 1 above compared the COMMITTED marker a location has
OBSERVED with the shared marker, but `refresh()` captures that marker BEFORE it loads the document and `reconcileReaders`
made exactly ONE refresh pass before returning. A protected read (`entries()`) whose physical disk load was overtaken
by a newer shared committed revision therefore installed the older bytes, armed neither `pendingCommit` nor
`readersStale`, and returned a document the read had itself overtaken - a stale protected read of the FR-002/FR-012
shape, reachable only when the commit lands INSIDE that load.

Production owner: `packages/core/src/config.ts`, the inner effect of `reloadLock.withPermit(...)` inside `reconcileReaders`
and nothing else - a `changed` accumulator across passes, the marker recheck AFTER the physical load, a SECOND marker
recheck after the mandatory announcement, and one exit path that still clears both faults. `Effect.exit` around the
permit, `Effect.provide(context)`, the `readersStale`/`deliveryPending` handling outside the permit, the `entries()`
fast-path guard, the boot marker capture, `Config.update`'s reserve/validate/stage/admission/rename/`recordCommit`
ordering, `FallbackRuntimeIntent`, `SessionGenerationAdmission`, `SessionRunner`/`llm.ts` and the watcher/debounce worker
are all untouched. A retry re-enters the SAME `refresh()` under the SAME held permit: no new lock, no second read path,
no publication channel, no per-read disk reload for an already coherent location.

Test owner: `packages/core/test/effect/app-node-builder.test.ts`. `filesystemRecorder()` gains the AFTER-READ barrier
(`AfterReadGate { release, reached, snapshot? }` held in a per-target map) that is ONE-SHOT per target - it stands down
as soon as a read of that target reaches it - and parks AFTER a successful real `readFileString`, returning the bytes
that read captured, with `armAfterReadGate(target, release)` in the fixture's public API; `reached` is the reached
control and `snapshot` records exactly what the parked fiber read, which is what makes the traces falsifiable.
Existing `readGates`, `renameGate`, the single-target read fault and call recording are unchanged, the shared
`awaitUntil` spin cap was raised from `2_000` to `20_000` (the boot scenario parks longer; this only loosens a
never-reached guard, which still dies rather than passing silently), and every S1/S2 assertion from the earlier
passes is preserved verbatim.

Two scenarios added, no others:

| Scenario | Barrier trace and assertions |
| --- | --- |
| `retries one protected read when a newer revision lands during its physical refresh load` | ONE location graph (project A) of the build. A serves `model-race-base` at marker `0`; revision 1 (`model-race-mid`) becomes durable; the racing `entries()` read parks INSIDE its load: the REACHED control shows `hold.reached === true` (the barrier was hit, never silently skipped) and `hold.snapshot` contains `"model": "model-race-mid"` while `committedText()` shows the shared file holding those same bytes. Revision 2 (`model-race-new`) is committed while that fiber is suspended, so the shared marker is `2` behind a read that captured revision 1. Final assertions: the SAME call returns `"model-race-new"`; recorded reads of the shared config file are STRICTLY GREATER than at release (it physically reloaded); exactly ONE `Event.Updated` announcement was published for that read; `renames === 0`, `writes === 0`, marker stays `2`, `current().override.type === "none"`; and the NEXT read leaves the read count unchanged (coherent, cached) - which is also what pins that the marker stayed at the revision whose bytes were actually installed. |
| `returns the newer committed document to a booting location whose initial load raced a commit` | Boot-capture negative. Revision 1 (`model-boot-old`) is durable at the shared owner; A's whole location boot is parked INSIDE `load(initial)` AFTER the OLD bytes were read; revision 2 (`model-boot-new`) lands during that park; the boot returns and its FIRST protected read reconciles to `"model-boot-new"` with the read count growing, `renames === 0`, `writes === 0`, marker `2`, NEXT read cached. Pinning role, stated honestly: this scenario passes on the pre-fix body too (the boot marker is already captured BEFORE `load(initial)`), and goes RED when that capture is moved to AFTER the load - measured below - so it pins boot ordering against the retry loop rather than adding a second red. |

Mutation measurements (source mutated, tests run, source restored; no scratch files):

| Mutation | Result |
| --- | --- |
| Remove BOTH marker rechecks, i.e. restore the pre-fix single-pass body | `app-node-builder.test.ts` `9 pass / 1 fail`, 153 `expect()` calls, exit 1. The racing scenario fails at `Expected: "model-race-new" / Received: "model-race-mid"` - the read returns the revision-1 document it overtook. Observed THREE times with identical results. |
| Remove ONLY the post-load recheck (keep the post-announcement one) | The racing scenario fails at the announcement count: `Expected: 1 / Received: 2`, exit 1. The returned document is still correct, so this guard's role is narrow and specific: without it the retrying read buys coherence by announcing a KNOWN-stale document first. |
| Remove ONLY the post-announcement recheck (keep the post-load one) | GREEN: `app-node-builder.test.ts` `10 pass / 0 fail` and the five-file gate `371 pass / 0 fail`, exit 0. NOT independently pinned, and recorded as a coverage limit rather than claimed as coverage: both scenarios commit during the physical LOAD, which the post-load recheck already catches. Closing that window in a test would need a `Bus` listener that commits mid-announcement, and a listener cannot itself observe the installed document because the reconciliation still holds the reload permit (a nested `entries()` there would self-deadlock). |

Gate commands for this pass, each run directly:

| Command | Result |
| --- | --- |
| `bun run --cwd packages/core test test/effect/app-node-builder.test.ts` | `10 pass / 0 fail`, 161 `expect()` calls, exit 0 - two scenarios more than the `8 pass / 132` record in pass 2. Run THREE times with identical results (`2.35s`, `2.40s`, `2.31s`). |
| `bun run --cwd packages/core test test/config/config.test.ts test/config/fallback-runtime-intent.test.ts test/session-generation-admission.test.ts test/session-runner.test.ts test/session-runner-retry.test.ts` | `371 pass / 0 fail`, 1936 `expect()` calls, exit 0 - unchanged from pass 2; this pass's owner is `test/effect/app-node-builder.test.ts`, so the S2 five-file count does not move. |
| `bun run --cwd packages/core test test/config/` | `322 pass / 0 fail` across 23 files, 1436 `expect()` calls, exit 0 |
| `bun run --cwd packages/core typecheck` | `✓ No type errors in 2,019 files across 2 projects`, exit 0 |
| `git diff --check` | clean, exit 0 |
| `git status --short` | this pass modified exactly `packages/core/src/config.ts` and `packages/core/test/effect/app-node-builder.test.ts` (plus this file); no scratch or debug artifacts remain (`console.log`, probe helpers and mutation markers grep clean) |

Coherence point: reconciliation stays read-only and stays inside the reload permit it already held; the only observable
change is that a protected read refuses to announce or return a document it knows it overtook. Durable state, intent
state, entry order, leases and the publication sequence of `Config.update` are byte-for-byte unchanged in these traces.

Scope, unchanged by this pass: the closed window is INSIDE ONE application build (one shared intent owner per
`AppNodeBuilder.build`). Boundary (a) - a document changed by something OUTSIDE the build (an editor, another
application root, an older V2 build) - still converges only through that location's `Watcher` reload worker
(`requestReload` → `Stream.debounce("100 millis")` → `refresh`), which this pass did not touch, and boundary (b) -
propagation stays READ-PULL, so a non-reading consumer of a location's owner such as a `changes()` subscriber can still
observe the older document until a protected read or that worker fires - is likewise unchanged.

Harness constraint recorded, so the racing commit is not overread: the newer revision in the racing scenario is made
durable at the shared owner through the intent protocol (`reserve` → real bytes at `global/opencode.jsonc` → `recordCommit`
→ `retire`) plus a direct write replacing that file, rather than through a second `Config.update`. In this harness a
second location graph's announcement/refresh burst repeatedly re-reads the shared file and would steal the one-shot
barrier, and an awaited second `update` cannot complete while the parked read holds the reload permit. The durable effect
being raced is exactly what `Config.update` leaves after its rename (`recordCommit` plus bytes on disk); the scenario's
`renames === 0`/`writes === 0` is the assertion that the reconciliation itself invents none. The writer path stays
pinned by the S1/S2 rename scenarios and by the earlier cross-location scenarios in this same file, so nothing here
should be read as "the writer path is unproven".

### Handoff to S3

- Ordered semantics to preserve on the wire: reserve → validate → stage → entry-order gate → exclusive lease →
  sparse commit → per-revision clear+retire; `Config.UpdateError` identities unchanged.
- Reproducible barriers for T020: `filesystemInjection()` with re-armable `armReadGate`/`armWriteGate`/`armRenameGate`
  + `awaitUntil`, and in `app-node-builder.test.ts`'s `filesystemRecorder()` the AFTER-READ gate
  `armAfterReadGate(target, release)` (park AFTER a successful read, `reached` as the reached control, `snapshot` as
  what that fiber captured) which is the template for a read that races a commit; `Config.testLayer` exposes
  `FallbackRuntimeIntent.node` and `SessionGenerationAdmission.node` for external leases and staging observation, and the
  session-runner fixture's `instrumentConfig` wrapper is the template
  for parking/observing the runner's OWN protected `entries()` read. The shared-lease deferral test is the template
  for a held real generation WITHIN one compiled graph AND across the SERVER/LOCATION graphs of ONE application build
  (`test/effect/app-node-builder.test.ts` scenarios 1-2 are the template for that). What S3 must NOT inherit: a lease
  guarantee ACROSS independent application builds (the two-build controls bound the claim), and synchronous
  COMMITTED-document freshness for a writer OUTSIDE the build. S3 MAY now rely on a PROTECTED READ in ANY location of
  the build observing another location's committed fallback after ONE read (residual boundary 1 above; scenario 4 of
  `test/effect/app-node-builder.test.ts` is the template for the barrier), and must NOT expect eager propagation to
  non-reading consumers of a location's config owner, nor immediate visibility of an edit made by another PROCESS —
  both still go through the per-location watcher reload worker and must state that owner boundary or take the HOLD.
  ALSO AVAILABLE AFTER correction pass 3: that protected read never returns a document it KNOWS it overtook - if its
  own physical load was raced, it rechecks the marker and reloads inside the same permit, and it announces at most
  once, after the newest committed bytes were installed. That guarantee is scoped to ONE build's shared owner; it says
  nothing about a writer OUTSIDE the build.
- Recovery evidence for T013/T020 coordination: the SEVEN retry traces above pin the resolution rule per physical
  dispatch — four for the post-backoff LATEST-eligible rule and three for the read window (no committed read while a
  validated intent is active; a newer intent staged across a suspended read wins; a revision retired across that
  read exposes the committed document current AFTER the transition). S3's integrated PATCH/client outcomes must
  agree with them.

## S3 evidence: T016–T021 record

Baseline HEAD `0d327ae0b842636c1327417c9bbd3e4799852903`. Everything below is the uncommitted S3 working tree: 17 modified
files plus `packages/app/src/runtime/server/config-outcome.ts` and `packages/server/test/fixture/config-fs.ts` as new
files. No git operation was used to stage, commit, revert or otherwise influence a gate. The S1 and S2 evidence above is
byte-for-byte unchanged.

### Gate commands (the single final S3 gate, run as written)

| Command | Actual result |
| --- | --- |
| `bun run --cwd packages/server test test/config.test.ts test/defect-response.test.ts` | `14 pass / 0 fail`, 110 assertions, exit 0 (the S3 pair's 12 plus the two wire-level abort keepers added in the correction pass) |
| `bun run --cwd packages/client test test/promise.test.ts test/effect.test.ts` | `56 pass / 0 fail`, 225 assertions, exit 0 |
| `bun test packages/app/src/session/composer/selection.test.ts packages/app/src/settings/general/controllers.test.ts` | exit 1 **before any test ran**: `Failed to scan non-existent root directory for tests: ".../do-not-run-tests-from-root"`. Actual form (from `packages/app`, adding the package's required preloads and the machine's owner): `bun test --conditions=solid --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src/session/composer/selection.test.ts ./src/settings/general/machine.test.ts ./src/settings/general/controllers.test.ts` → `58 pass / 0 fail`, 351 assertions, exit 0 (`selection.test.ts` 45 after the correction pass added five caller scenarios, `machine.test.ts` 11, `controllers.test.ts` 2) |
| `bun run --cwd packages/protocol check:generated` | exit 0 |
| `bun run --cwd packages/client check:generated` | **exit 0 in this pass.** The script is `bun run generate && git diff --exit-code -- src/promise/generated src/effect/generated src/effect/api`; its `git diff` step compares the WORKTREE with the INDEX, and in this working tree the S3 generated delta is already staged, so the regenerated bytes match and the step exits 0. The earlier S3 pass recorded **exit 1** for the same command because that regeneration was UNSTAGED then (`git diff --exit-code` was nonzero by construction against the index) while the delta was the expected two hunks (`declaredStatuses: [400, 401, 404] → [400, 401, 404, 500]`; `UnknownError` gains the optional `code` literal union). Reproducibility was proven separately and still holds: SHA-256 manifests of all 11 generated files taken before and after a second `bun run --cwd packages/client generate` are identical, and no generated file changed in the correction pass. No git operation was used to stage, commit or revert anything in either pass. |
| `bun run --cwd packages/protocol typecheck` | `✓ No type errors in 153 files`, exit 0 |
| `bun run --cwd packages/server typecheck` | `✓ No type errors in 1,606 files across 2 projects`, exit 0 |
| `bun run --cwd packages/client typecheck` | `✓ No type errors in 180 files`, exit 0 |
| `bun run --cwd packages/app typecheck` | `✓ No type errors in 2,433 files`, exit 0 |
| Wider regressions | `bun run --cwd packages/server test` → `142 pass / 1 skip / 0 fail` across 48 files, exit 0; `bun run --cwd packages/client test` → `268 pass / 0 fail` across 25 files, exit 0; app unit suite (`bun test --conditions=solid --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src`) → `2803 pass / 0 fail` across 277 files, exit 0; `bun run --cwd packages/core test test/config/config.test.ts test/config/fallback-runtime-intent.test.ts` → `88 pass / 0 fail`, exit 0 (re-run in the correction pass because the wire-level abort keepers rest on core's interruptible precommit boundary and its uninterruptible commit window); `bun run --cwd packages/protocol test` → `14 pass / 0 fail`, exit 0; `git diff --check` → exit 0 |
| `bun run lint:changed` | **exit 1, pre-existing on this branch.** It flags files outside the S3 change set, e.g. six `anti-slop(require-readable-spacing)` findings in `packages/session-ui/src/timeline/session-timeline-row.tsx`, which `git status --porcelain packages/session-ui` reports as unmodified. In S3-owned files the count is zero or unchanged: `config-outcome.ts` 0, `sync.tsx` 0, `machine.ts` 0, `controllers.ts` 0, `handlers/config.ts` 0, `test/config.test.ts` 0, `test/fixture/config-fs.ts` 0, `groups/config.ts` 0; `session/composer/selection.ts` 6 both before and after (the same `typeof`/`Record<string, unknown>` constructs at HEAD lines 3/9/13/14/18/23, shifted +2 by the new import); `providers/models/fallback-update.ts` 9 both before and after (HEAD content linted from a copy under the same rules). No S3 line introduced a finding. |

### Contract delta and generated artifacts (T017, T018)

- `packages/protocol/src/groups/config.ts` adds `ConfigUpdateFailure = Schema.TaggedError("UnknownError")
  { message: String, ref: optional(String), code: optional(Literals([CONFIG_COMMITTED_BUT_UNPUBLISHED,
  CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE])) } @ httpApiStatus 500`, attached ONLY as the `error:` of the PATCH
  endpoint. Its tag stays `UnknownError`, so this is a generic-compatible 500 rather than a new identity: the two
  committed `Config.UpdateError` tags in core are untouched, and no other endpoint gained a 500.
- `packages/protocol/openapi.json` regenerates accordingly: `/api/experimental/config` PATCH responses are now
  `204/400/401/404/500`, the 500 body `$ref`s a NEW component `UnknownErrorEncoded_e307db54c7af` whose `code` is
  `anyOf(string enum [the two literals], null)` with `required: [_tag, message]` and `additionalProperties: false`,
  while the pre-existing generic component `UnknownErrorEncoded_c4f29c80427d` is unchanged and still referenced 8× by
  every other endpoint. So the only place a code can be decoded is the PATCH's own 500.
- `packages/server/src/handlers/config.ts` maps by the core error's `_tag` only: `Config.CommittedButUnpublished` →
  `CONFIG_COMMITTED_BUT_UNPUBLISHED`, `Config.CommittedWithPostPublicationFailure` →
  `CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE`, everything else (precommit, ordinary defects) → the same shape with
  NO `code`. Nothing reads an HTTP status to choose a code.
- `packages/httpapi-codegen/` needed no change: the existing generator produced both client surfaces from the protocol
  edit alone.

### Wire and state evidence (T016) — `packages/server/test/config.test.ts`, `packages/server/test/defect-response.test.ts`

Both files now run through the real compiled route table (`serveRoutes`) with `verifyTlsCaMode("bundled")` so they pass
standalone, and through the injected filesystem fixture (`test/fixture/config-fs.ts`) that wraps the node filesystem layer
and records `reads` (per path, with the `failed` flag), `writes`, `renames`, `removes`, `chmods`, with re-armable read
gates keyed by exact path plus ordinal, write gates, rename gates and per-operation faults.

| Scenario (owner) | What is asserted on the wire and on disk |
| --- | --- |
| committed 204 | `204`, empty body, exactly ONE rename, `writes[0].path === renames[0][0]`, committed bytes contain the new value and the untouched JSONC neighbours, no `.` temp left in the directory, and a subsequent GET answers the new value, so the shared reader and disk agree |
| precommit rejection | `500` with `_tag: "UnknownError"`, message and ref, `code` ABSENT, `renames` and `writes` empty, disk bytes unchanged, and the NEXT PATCH still returns `204` (the entry position retired) |
| failed rename | `500` uncoded, nothing stranded (`readdir` free of temps), document unchanged |
| committed but unpublished | fault injected on the shared reader's publish path → `500` with `code: "CONFIG_COMMITTED_BUT_UNPUBLISHED"`, and the bytes ARE on disk |
| committed, published, mandatory announcement failed | fault injected on the announcement bus the owner must traverse (`Bus.Service`) → `500` with `CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE`, the document is committed AND published, and the later reader path still answers the committed value |
| diagnostic-only housekeeping | cleanup fault with nothing stranded → `204` with no error, i.e. a failed diagnostic-only remove does not turn a success into a failure |
| generic defect envelope (`defect-response.test.ts`) | a full-disk write answers a populated 500 with the storage reason; other defects answer with a `ref`; unknown routes keep their 404; and a config-route defect keeps the UNCoded envelope, so a committed outcome stays the only coded case |

### Both-client evidence (T018) — actual before/after types

- Promise client (`packages/client/test/promise.test.ts`, 3 new cases in the 56 that pass): before S3 the PATCH
  rejected with the shared `UnknownError` body (`_tag`, `message`, optional `ref`) and `declaredStatuses` stopped at
  404, so a 500 was reported as an undeclared response. After S3 the descriptor declares 500 and the rejection carries
  the decoded body: `_tag: "UnknownError"`, `message`, `ref` preserved, `code` present for each committed literal and
  `undefined` for an uncoded 500. A 204 still resolves `void`.
- Effect client (`packages/client/test/effect.test.ts`, 3 new cases): before S3 the same endpoint had no declared
  error, so its 500 surfaced as a `ClientError` decode failure. After S3 it fails with the declared error value, tag
  `UnknownError`, `message`/`ref` preserved and `code` decoded per literal. `code` is pinned to the two literals by the
  schema, so a response claiming `CONFIG_COMMITTED_FOREVER` is NOT decoded as a committed identity — the failure
  surfaces as `_tag: "ClientError"` rather than a fabricated code, and 500 stays undeclared on every other endpoint
  (`session.list()` still yields `ClientError`).
- Generated type change is therefore intentional and confined: the Promise client's `UnknownError` interface gains
  the optional `code` literal union (the generator keys interfaces by tag), while the runtime only ever populates it for
  the PATCH's 500 — proven by the uncoded-500 and other-endpoint assertions above, and the OpenAPI component separation
  above shows no other endpoint can carry a code.

### Caller outcomes (T019) — `packages/app`

- New recognizer `packages/app/src/runtime/server/config-outcome.ts`: `ConfigCommittedCode = NonNullable<UnknownError["code"]>`
  so the pinned `COMMITTED_CODES` tuple is checked against the generated contract in both directions;
  `committedConfigCode(cause)` returns a code only for an `isUnknownError` value whose `code` is one of those literals
  (`undefined` otherwise, so an unknown code is not guessed); `ConfigConfirmationFailure` names "the PATCH landed, the
  confirming re-read failed"; `configNeedsReconciliation(cause)` is the caller's question "read the source again rather
  than restore what was there before it". No message or status sniffing anywhere in the file.
- `providers/models/fallback-update.ts` gained an optional `reconcile` owner hook typed `() => Promise<void>` — see the
  correction pass below for the final form: the chain releases this revision's optimistic value ONLY when that GET's
  Promise has actually RESOLVED, keeps the value visible as unconfirmed when it REJECTS, and does nothing when the caller
  has no read at all. A newer revision always wins: the existing `state.revision === revision` guard is what stops an
  old reconciliation from clearing a newer intent. Every other failure keeps the old behavior (`publish(undefined)`
  immediately, then `failed`).
- `providers/models/selection.tsx` supplies that hook with the sync layer's own read (`server.ctx.sync.refreshConfig()`),
  and `runtime/server/sync.tsx` exposes `refreshConfig` as an ASYNCHRONOUS function awaiting `configQuery.refetch()` and
  throwing when the result is not successful, wrapping a failed confirming re-read as `ConfigConfirmationFailure(cause)`
  instead of letting it surface as an ordinary rejection, while `updateConfig` still rejects rather than claiming a
  confirmation the client never saw.
- `session/composer/selection.ts`: a pair-exchange failure whose cause satisfies `configNeedsReconciliation` — a
  committed-state code OR a `ConfigConfirmationFailure` after HTTP 204 — emits only `report` and NO compensation;
  restoring the pre-exchange pair would be a fresh write asserting an undone durable commit. Ordinary precommit causes
  still take the compensation path.
- `settings/general/machine.ts`: `SettingWriteFailure.failed` and the `write.failed` event carry `committed`, and
  `failed()` takes `authority = committed ? active : confirmed` plus a forced `reread`, so the control keeps showing
  what was written and reads the source again instead of rolling back to `confirmed`; ordinary rejections keep the
  rollback to `confirmed`. `settings/general/controllers.ts`: the write driver classifies the rejection with
  `committedConfigCode(cause) !== undefined` — the structural code off the generated error, never its message — and
  passes it into that event, so the re-read happens through the setting's own `load`.
- Focused app run after the correction pass: `58 pass / 0 fail` — `session/composer/selection.test.ts` 45 (the 40
  accepted scenarios, all assertions preserved, plus the five new caller scenarios), `settings/general/machine.test.ts`
  11, `settings/general/controllers.test.ts` 2; app typecheck exit 0; full app unit suite `2803 pass / 0 fail` exit 0, so
  no existing caller assertion was reduced.

### S3 correction pass (caller reconciliation, composer classification, wire-level abort)

Three recorded blockers were corrected in this pass; the accepted S1/S2 evidence and every existing S3 assertion are
untouched, and the pass changed no protocol, generated artifact, or core file.

**A. `refreshConfig` is now an awaited authoritative read** (`packages/app/src/runtime/server/sync.tsx`).
`refreshConfig: () => void configQuery.refetch()` made the caller's completion signal meaningless: `fallback-update.ts`
cleared the optimistic override as soon as the callback returned, i.e. before the GET that feeds `data.config` had run,
so an optimistic committed value could disappear while `data.config` still held the older document. It is now
`refreshConfig: async () => { const result = await configQuery.refetch(); if (!result.isSuccess) throw result.error ?? … }`
— a refetch that RESOLVES with an error result is a failed reconciliation, not a confirmation. `ServerSync.refreshConfig`
therefore returns `Promise<void>`, and `FallbackUpdate`'s `reconcile` hook is typed `() => Promise<void>` (a caller that
cannot return a completion Promise may not claim completed committed-state reconciliation; the parameter stays optional
because ordinary-save consumers need no read). The wiring at `providers/models/selection.tsx:802` supplies exactly
`server.ctx.sync.refreshConfig()`, which is the query that owns `globalStore.config`.

**B. Optimistic state is released only by a successful authoritative read** (`packages/app/src/providers/models/fallback-
update.ts`). The committed branch now reports once, returns early when no `reconcile` is available, and otherwise runs
`Promise.resolve().then(reconcile)` with the release in the RESOLVED arm only; the REJECTED arm keeps the revision visible
as unconfirmed rather than exposing the value it replaced, and never re-reports, retries or compensates. The old code
cleared the override in BOTH arms, and cleared it instantly when `reconcile` was absent.

**C. A confirmation failure can no longer be compensated** (`packages/app/src/session/composer/selection.ts`): the
condition moved from `committedConfigCode(event.cause) !== undefined` to the already-declared `configNeedsReconciliation
(event.cause)`, so a `ConfigConfirmationFailure` — the PATCH answered 204 and only the confirming GET failed — reports
once and issues no `restore.primary` / `restore.fallback` / `compensation.issued`.

Negative probes that prove the new app tests are decisive (each mutation applied, the focused command run, then reverted
byte-for-byte; no test was changed to accommodate a mutation):

| Probe | Observed |
| --- | --- |
| `configNeedsReconciliation` narrowed back to `committedConfigCode(cause) !== undefined` in `config-outcome.ts` | 2 failures: the new composer scenario `a confirmation that failed after the write landed reports once and compensates neither half` receives `compensation.issued` + `restore.primary` where it must receive one `report`, and the accepted chain scenario `a confirmation that failed after the write landed is not read as a rollback` fails too |
| `fallback-update.ts` committed branch restored to `void Promise.try(() => state.reconcile?.()).then(release, release)` | 2 failures: `a reconciliation GET that fails keeps the committed value visible rather than exposing the older one` and `a committed failure with no reconciliation read available does not release the override` — both are exactly the false-rollback paths; the deferred-GET and supersession scenarios pass on both versions because they pin the awaited contract rather than the old instant settle |

New app scenarios (all in the existing owner `packages/app/src/session/composer/selection.test.ts`, none of the 40
prior scenarios modified; three pre-existing fixtures were retyped to return `Promise.resolve()` / a held `Promise<void>`
because the `reconcile` parameter no longer admits `void`, with their assertions unchanged):

| Scenario | What it pins, without a clock |
| --- | --- |
| `an in-flight reconciliation GET holds the committed value, and the completed read settles the display` | B's PATCH reports `CONFIG_COMMITTED_BUT_UNPUBLISHED` once; exactly one read is issued (`reads === ["get"]`); while the GET is in flight the override is still `{ revision: 1, value: "committed" }` and the document is still `before`; resolving the SAME deferred releases the override and the document then equals the committed value; no second write |
| `a reconciliation GET that fails keeps the committed value visible rather than exposing the older one` | deferred GET rejected with a known error → override still `{ revision: 1, value: "committed" }`, `reported === [committedFailure]` (one report only), `written === ["committed"]` (no compensation), `reads === ["get"]` (no retry) |
| `a committed failure with no reconciliation read available does not release the override` | absence of `reconcile` is not a completed read: the override stays, one report, no write |
| `a reconciliation GET landing after a newer intent cannot settle the display on the older document` | B's GET is in flight when C is issued; B's completion neither clears C's override nor re-writes or re-reports C (`written === ["B","C"]`, `reads === ["get"]`), and only C's own write then releases it — the state stays live rather than frozen |
| `a confirmation that failed after the write landed reports once and compensates neither half` | `new ConfigConfirmationFailure(...)` → exactly one `report`; zero effects of each of `restore.primary`, `restore.fallback`, `compensation.issued`; state back to the idle singleton; negative control in the same claim: an uncoded `config` cause still emits `compensation.issued` + `restore.primary`; and an attempt-1 rejection while attempt 2 is current is completely inert |

Synchronization is by real signals only in the new cases: `writeQueue()` records each write the chain STARTS and
`answered(write)` awaits that write's outcome as the chain sees it (the chain adopts and reacts to the promise before any
test reaction can be attached, which is what makes the "nothing changed" assertions about settled state rather than a
reaction that has not run yet); the GET's issue is awaited through a `Deferred`-like signal the reconcile callback itself
resolves. `setTimeout(0)` appears in no new scenario.

Type-level pin in the same owner: `const awaitableConfigRefresh: (sync: ServerSync) => Promise<void> = (sync) => sync.refresh
Config()` (`import type { ServerSync } from "@/runtime/server/sync"`). With the fix the app typecheck passes; restoring
`refreshConfig: () => void configQuery.refetch()` fails it at `selection.test.ts:48` (TS2322) and again at
`providers/models/selection.tsx:802`, which is the runtime contract this pass was about. This pin was verified by a
temporary revert and then restored; it supplements, not replaces, the deferred-GET scenarios above.

### Integrated trace (T020) — `a held generation defers a queued commit, and two PATCHes still commit in entry order`

One compiled application build, real route table, production admission instance: the test builds
`SessionGenerationAdmission.make` and injects it for the config node exactly as `AppNodeBuilder.build` does
(`SessionGenerationAdmission.node.replace(Layer.succeed(Service, admission))` passed as `serveRoutes`' layer replacement).
Sequence, with no sleeps — every wait is a `Deferred` or a counter on recorded filesystem calls:

1. A primer PATCH completes one whole write, so the counters below start from a state where the next read of the target
   document is the update's own candidate read, not the shared owner's first load.
2. A generation acquires the SHARED lease (`admission.acquireShared`).
3. The older PATCH is forked; the test waits until its candidate read of the exact target is recorded (its entry
   position is already reserved), then forks the newer PATCH and waits until ITS candidate read is recorded — which is
   only possible while the older holds no lease, so the newer request has validated and staged its document while
   queued behind the older's entry position.
4. With the shared lease held: `renames` is still at the primer's count (nothing durable), so the exclusive lease is
   demonstrably what defers the commit. Releasing the lease makes exactly ONE rename appear: the older request's, whose
   rename is itself parked, and the staged write under it is the older's bytes, so the two durable commits never
   overlap and entry order, not arrival at the lease, decides which document lands first.
5. Opening the parked rename lets both requests finish: `204` and `204`, TWO renames, disk holds the newer value only,
   the directory has no stranded temp, and the reader answers `{ providerID: "openai", model: "newer" }` — which agrees
   with the four LATEST-eligible and three read-window retry traces S2 pinned for the integrated PATCH/client outcome.

#### Wire-level abort keepers (added by the correction pass)

Both keepers run in the same owner and fixture as the trace above — `packages/server/test/config.test.ts` over the real
compiled route table (`serveRoutes`) with the injected filesystem, and where the claim involves the lease, a production
`SessionGenerationAdmission.make` injected exactly as `AppNodeBuilder.build` injects it. `wire()`'s `patch()` helper now
takes an optional `AbortSignal`, which `serveRoutes`' `handler(new Request(input, init))` path carries to the real
`Request.signal` that `HttpEffect.toWebHandlerWith` watches.

| Keeper | Sequence and what is asserted |
| --- | --- |
| `a real request abort cancels the queued PATCH inside Config's owner and leaves the next writer unblocked` | primer PATCH answers `204` and forces Location-service construction, so the counters below (`readCount(config)`, `.tmp` writes, renames whose `to === config`) start at a completed whole write; `armReadGate(config, parked, seen)` parks the request in its OWN candidate read, i.e. past the entry reservation; the PATCH is forked with `controller.signal` and `awaitedReads(config, seen + 1)` proves it reached that owner with `writes`/`renames` unmoved; `controller.abort()`; the joined request answers exactly `{ status: 499, body: "" }`, which is `HttpServerError.causeResponse`'s own mapping of a delivered `ClientAbort` and cannot be produced by a request that was never cancelled; then the parked gate is RELEASED and the request contributes still-zero temp writes and zero renames, proving it was not merely client-side-abandoned; a fresh PATCH in the same graph answers `204`, `awaitedReads(config, seen + 2)` proves it reached the owner, and exactly ONE temp write plus ONE rename appear afterwards whose temp path equals that rename's source, the bytes carry `model: "next"` and never `"aborted"`, `readdir` shows no `.` entry, and the protected reader agrees — so the abandoned writer retired its exclusive lease and entry reservation and left no staged override |
| `a cancellation arriving mid-commit completes publication and cleanup forward instead of truncating` | `armRenameGate` parks the request exactly AT its rename (`awaitedRenames` after the primer's count, `writes === stagedAt + 1`); `controller.abort()` fires there, in the region core wraps as `Effect.uninterruptible` (`packages/core/src/config.ts:849`, temp write → `chmod` → rename → `recordCommit` → `publishReaders` → advisory rescan, with `Effect.ensuring(cleanup())`); releasing the gate still lands the document whole — one temp write and one rename only, bytes contain `"model": "cancelled-mid-commit"` alongside the untouched `// keep this comment`, `readdir` free of temps, the protected reader answers that fallback, the request itself answers `{ status: 499, body: "" }` only once the region has exited, and a later PATCH still answers `204` |

Mechanism, read off the installed effect 4.1.0 rather than assumed: `HttpEffect.toHandled` opens the request frame with
`fiberEnterUninterruptibleUnsafe`, and `toWebHandlerWith` delivers the client's cancellation as
`fiber.interruptUnsafe(undefined, ClientAbort.annotation)` (`http/HttpEffect.ts:358-366`). The route still takes that
cancellation because the router re-opens the region for every matched handler: `http/HttpRouter.ts:253-256` calls
`fiberEnterInterruptibleUnsafe(fiber)` (and returns an already-recorded interruption immediately) unless the route itself
declares `uninterruptible: true`. No route in `packages/server/src` opts out — the only `Effect.uninterruptible` in that
package is `process.ts:93`, unrelated to the config PATCH — so NO production change was needed, and none was made: the
PATCH handler's `config.update(...).pipe(Effect.catch(...))` with its two committed-state mappings and `Effect.die(error)`
is byte-for-byte what T017 accepted, and core's write→publish window stays protected.

Decisive negative for the first keeper (applied temporarily, reverted byte-for-byte, no test changed to accommodate it):
wrapping the update as `config.update(ctx.payload).pipe(Effect.uninterruptible, Effect.catch(...))` makes that scenario
FAIL (`(fail) a real request abort cancels the queued PATCH inside Config's owner and leaves the next writer unblocked`
— the request fiber takes no cancellation while parked, the test times out after 5000ms in the join). The second keeper
passes under that mutation, which is the point of the pair: the commit window must NOT accept cancellation, the precommit
region must.

Probes discarded on the way (recorded so the earlier conclusion is not repeated): a diagnostic probe printed the joined
outcome as `{ status: 499, body: "" }` for the parked-request case with `renames`/`writes` unmoved and, after releasing the
gate, `renames` still at the primer's count while the two extra recorded writes were the unrelated persistence files
(`heartbeat`, `meta.json`) — which is why both keepers count `.tmp` writes and renames whose `to === config` rather than
raw call lengths. A scratch probe file was created under `packages/server/test/` during that diagnosis and DELETED;
`git status --porcelain` shows no such file.

### Corrections to earlier records (found while implementing S3, not inherited)

1. **Read-barrier template needs an ordinal snapshot on the wire.** The handoff's "park the update's own candidate read"
   template is ambiguous at the wire level: the shared config owner reads the document during the Location build INSIDE
   the first request, so an ungated `armReadGate(target, wait)` parks the wrong read and the queueing evidence becomes
   vacuous. `armReadGate(target, wait, after)` + a per-path `readCount` snapshot (the primer PATCH above) is the corrected
   form; a version that gated at `after: 0` "passed" for the masked reason and was rejected as evidence.
2. **The admission service is not reachable from the route context.** `SessionGenerationAdmission.Service` is not in the
   PATCH handler's context type, so a typed `Context.get` cannot observe it. S3 must INJECT a production-built instance
   through `serveRoutes`' layer replacements (later entries win in `LayerNode.compile`), not reach through the context;
   the S2 handoff's `Config.testLayer` route does not carry over to the server graph.
3. **"Real HTTP abort cannot be evidenced in this process" was WRONG, and is corrected by the two keepers above.** That
   record reasoned from `toHandled`'s `fiberEnterUninterruptibleUnsafe` and `interruptUnsafe`'s interruptible check alone
   and concluded the request fiber could never be cancelled; it also chose the wrong observables — a client-side rejection
   of `server.fetch`, and "the queued writer never progressed" while its own gate stayed armed, which cannot distinguish a
   cancelled writer from a parked one. The installed router re-opens the region for every matched handler
   (`http/HttpRouter.ts:253-256`, `fiberEnterInterruptibleUnsafe`, and it returns an already-recorded interruption
   immediately) unless the route itself declares `uninterruptible: true`, so the cancellation IS delivered at the production
   route: the aborted request answers the layer's own `{ status: 499, body: "" }`, contributes no temp write and no rename
   even after the read it parked in is released, and the next PATCH commits in the same graph. The earlier probe was
   removed rather than kept; the two keepers now in `config.test.ts` replace it, and the first of them fails the moment the
   precommit region is made uninterruptible. No requirement wording was changed to obtain that result, and no production
   file changed to obtain it.

Two other API realities of the installed effect 4.1.0 shaped the code, both recorded rather than worked around:
`Effect.catchAll` does not exist (the handler uses `Effect.catch`), and `Effect.fork` does not exist
(`Effect.forkChild({ startImmediately: true })` + `Fiber.join`, matching `packages/core/test/shared-cache.test.ts`).

### S3 HOLD / blockers

1. **Wire-level abort evidence (T020's "including real HTTP abort and later writer progress") — HOLD CLOSED at the
   route boundary by the correction pass.** It was recorded as NOT demonstrated; it now is, by two keepers in
   `packages/server/test/config.test.ts`: the request is proven inside Config's read/queue owner before the signal fires,
   the route answers the HTTP layer's own client-abort response `{ status: 499, body: "" }` (only a delivered
   `ClientAbort` produces it), the abandoned writer contributes zero temp writes and zero renames AFTER the read it parked
   in is released, and a fresh PATCH in the same graph commits, with the document carrying only the successful writer's
   bytes and the directory free of temps — so the lease and entry position were retired, not stranded. The companion
   keeper proves the other half of the boundary: a cancellation that arrives inside core's write→`recordCommit`→publish
   window (`config.ts:849`, `Effect.uninterruptible`) completes publication and cleanup forward, leaving a whole document
   (`// keep this comment` plus the new field) and no stranded temp, with the 499 only after the region exits. Decisive
   negative: making the precommit region uninterruptible in the handler turns the first keeper red (timeout at the join,
   the parked fiber taking no cancellation), and the second stays green — which is the distinction the pair exists to hold.
   Core's owning keepers remain in force and were re-run (`test/config/config.test.ts`, `test/config/fallback-runtime-
   intent.test.ts` → `88 pass / 0 fail`, exit 0), so the wire-level claim and the owner-level claim now agree rather than
   one standing in for the other. No production change was required, so none was made.
2. **`bun run --cwd packages/client check:generated` is Git-state dependent, not a generation fault.** In the correction
   pass it exits 0: its `git diff --exit-code` step compares the worktree with the INDEX, and the S3 generated delta is
   staged in this working tree, so regeneration matches it. The earlier pass recorded exit 1 for the same command because
   that delta was unstaged then. Both numbers are recorded as they happened; S3 does not stage, commit or revert anything
   to change either result, and reproducibility was proven separately by identical pre/post SHA-256 manifests over the 11
   generated files (no generated file changed in this pass).
3. **`bun run lint:changed` exit 1 is pre-existing branch state** (findings in files S3 never touched); the per-file
   counts above show S3 introduced no finding. Not fixed here because it is outside S3's owners.
4. **The gate's literal app command form cannot run from the repo root** (`do-not-run-tests-from-root` guard); the
   package-scoped form with the required preloads is what actually ran and passed.

No task here declares ACCEPT, and this pass does not either. S1 and S2 remain as recorded above; S3's evidence is now
complete — its former HOLD 1 (the wire-level abort) is closed by the two keepers in `packages/server/test/config.test.ts`
rather than narrowed in T020's wording — and what remains outside S3's own control is unchanged: the generated-artifact
check's dependence on the working tree's Git state, the pre-existing branch lint findings, and the fact that an
independent S3 review has NOT been run for this correction pass. Feature-level acceptance must wait for that review.

## Phase 7: Convergence

- [x] T022 Add a controller-level negative regression in `packages/app/src/settings/general/controllers.test.ts` proving
  the settings write driver classifies a coded committed PATCH as `committed: true` (forced re-read, no rollback) and an
  uncoded rejection as `committed: false` (rollback), per FR-005, FR-012 and the Convergence H1 finding.

### T022 — closing Convergence H1 (the untested production `committed:` classification)

H1 was that `packages/app/src/settings/general/controllers.ts:96` — `committed: committedConfigCode(cause) !==
undefined` — was never exercised: every existing test constructed `write.failed` machine events by hand, so a mutation
forcing that Boolean either way escaped the suite. The new test is the controller-level keeper that was missing.

**Test:** `settings controllers > the settings write driver distinguishes committed PATCH failures from ordinary rejections`
in `packages/app/src/settings/general/controllers.test.ts`. The two existing tests in that file (`normalizes shell
names…`, `debounces previews…`) are unchanged byte-for-byte; only the import block grew (`createEffect`,
`OpenCode` from `@opencode/client/promise`, `createOptimisticSetting` from `./controllers`,
`SettingWriteFailure` from `./machine`).

**Five scenarios**, each rebuilt from scratch (own `createRoot`, own counters, own `Deferred`s — no shared state between
cases):

| Scenario | Wire body | Expected classification and display |
| --- | --- | --- |
| `committed but unpublished` | `_tag: "UnknownError"`, `code: "CONFIG_COMMITTED_BUT_UNPUBLISHED"`, HTTP 500 | `committed: true`, stays `/bin/zsh`, `loads === 2` (forced re-read), settles on the re-read's `/bin/fish` |
| `mandatory postpublication failure` | same tag, `code: "CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE"` | identical: no rollback, one authoritative re-read |
| `ordinary uncoded HTTP 500` | `_tag: "UnknownError"`, `message` only, HTTP 500 | `committed: false`, rolls back to `/bin/bash`, `loads === 1` |
| `unknown error code` | same tag, `code: "CONFIG_COMMITTED_UNKNOWN"` | `committed: false` — a code outside the two literals names no committed state, so rollback stays |
| `unrelated Error` | `write` rejects with a plain `new Error(message)` | `committed: false`, existing rollback semantics intact |

**The error is the real generated one.** `write` builds the client with `OpenCode.make({ baseUrl, fetch })` and calls
`client.experimental.config.update({ shell: "/bin/zsh" })`; the injected `fetch` returns
`Response.json({ _tag: "UnknownError", message, code? }, { status: 500 })`. `experimental.config.update` declares 500
(`packages/client/src/promise/generated/client.ts:1788-1799`), so the client's own `responseError` → `declared()`
(`client.ts:2894`) produces `Object.assign(new Error(message), body)` — an `Error` carrying `_tag` and `code` as own
properties, which is exactly what `isUnknownError`/`committedConfigCode` read. `fetch` carries a `preconnect: () => {}`
because `ClientOptions.fetch` is typed as the whole `typeof globalThis.fetch` (Bun's extension is a required member), and
without it `bun check` fails the test file.

**How it reaches the production expression:** `owner.setting.select("/bin/zsh")` dispatches `write.requested` inside
`createOptimisticSetting`, whose driver effect emits the `write` effect; `run()` calls the real `options.write`, its rejection
goes to the `.then(…, (cause) => …)` handler at `controllers.ts:87-98`, and the object built there — including
`committed: committedConfigCode(cause) !== undefined` — is dispatched as `write.failed`. `machine.ts:186-198`
(`const committed = failure.kind === "failed" && failure.committed`, `const authority = committed ? state.active :
state.confirmed`) then either keeps `state.active` and queues the `settled` re-read (`reread || committed`) or rolls back
to `state.confirmed`. The test asserts the `notify.error` payload the callback actually received
(`expect(failures).toEqual([{ kind: "failed", message, committed: scenario.committed }])`), the counter of `write`s (1)
and `load`s, and the value the control displays at each step. Nothing in it constructs a machine event.

### The fixture problem the gate exposed, and the fix it required

Under the gate as written the test could not run: `--conditions=solid` is dead configuration for the installed
`solid-js` 1.9.17, whose `exports["."]` keys are `worker`, `browser`, `deno`, `node`, `development`, `types`,
`import`, `require` — no `solid`. Bun therefore matches `node` and loads `dist/server.js`, whose `createEffect` is literally
`function createEffect(fn, value) {}`. Verified directly: `createEffect.toString()` printed that body under the gate, and a
probe controller logged neither `load` nor an effect body, while the identical probe under `--conditions=browser` logged
`load 1`, `effect /bin/bash`, `onError { kind: "failed", …, committed: true }`, `load 2`. Because `createOptimisticSetting`
starts its machine from `createEffect` (`controllers.ts:101`), no driver in `packages/app/src` is reachable in the unit
env — which is also why no existing `src` test uses `createEffect` (grep: only the new test).

`packages/app/happydom.ts` (the app-only unit preload) now serves the client build for the root specifier: an `onLoad`
hook matching `solid-js[/\]dist[/\]server\.js$` returns the contents of `import.meta.resolve("solid-js/dist/solid.js")`
— the same file `--conditions=browser` resolves, so `test:browser` is untouched. A `Bun.resolve.sync` form was rejected
(`TypeError: Bun.resolve.sync is not a function` in Bun 1.4.4) and `onResolve` hooks were rejected: they never fire for
these third-party specifiers (a probe logged only the preload's own path, with `args.specifier` undefined), so only the
content swap works.

Scope of the swap is deliberate. Swapping `solid-js/store` and `solid-js/web` too turns **5 unrelated tests red** —
`Composer submission > a failed quote send retains its latest comment…`, `… restores and retries an unacknowledged
admission`, `… restores first-prompt comments into the promoted Session`, `… moves a first prompt and its quote
sources to the promoted Session…` and `Composer store > prepends a skill mention to an attachment-only draft…` — because
the client store build carries `Symbol(solid-proxy)`/`Symbol(store-node)` in the objects those `toEqual`s compare. Those
belong to another feature's owners, so the swap stays at the root specifier and the narrowing is recorded here.

Re-ran the whole app unit suite rather than trusting the focused run, since the fixture is suite-wide:
`bun test --conditions=solid --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src` → **2804 pass / 0
fail across 277 files, exit 0** (the S3 record's baseline was 2803 across 277, so +1 is exactly this test). A throwaway
probe file `packages/app/src/settings/general/scratch.t022.test.ts` was created during that diagnosis and DELETED;
`git status --porcelain` now lists only the two files below.

### Mutation probes (temporary edits, no Git)

| Mutation applied at `controllers.ts:96` | Focused gate result |
| --- | --- |
| `committed: false,` | `(fail) … distinguishes committed PATCH failures from ordinary rejections` — `expect(failures).toEqual` diff `- "committed": true` / `+ "committed": false` at `controllers.test.ts:196`, first scenario (`committed but unpublished`); `13 pass / 1 fail` |
| `committed: true,` | same test fails with the mirror diff `- "committed": false` / `+ "committed": true`, first uncoded scenario (`ordinary uncoded HTTP 500`); `13 pass / 1 fail` |

Restoration after each mutation used the saved copy: `md5` `f26450df73b026cca1abfa629676ef1c` before and after, `cmp`
reports the file byte-identical, and line 96 reads `committed: committedConfigCode(cause) !== undefined,` again. No Git
command applied or reverted anything, and no test was altered to accommodate a mutation.

### Gates as run

- Focused: `bun test --conditions=solid --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src/settings/general/controllers.test.ts ./src/settings/general/machine.test.ts` → **14 pass / 0 fail, 79 assertions across 2 files, exit 0** (the same command timed out at 5000ms before the fixture fix).
- `bun run --cwd packages/app typecheck` → `✓ No type errors in 2,433 files across 1 project`, exit 0.
- App unit suite (fixture-change blast radius): **2804 pass / 0 fail, 10075 assertions, 277 files, exit 0**; `test:browser` spot check `./test-browser/settings-keybinds.test.ts` under `--conditions=browser` → 7 pass / 0 fail, exit 0.
- `git diff HEAD --check` → empty output, exit 0. `git status --porcelain` → `M packages/app/happydom.ts`, `M packages/app/src/settings/general/controllers.test.ts`.
- No production file changed: `controllers.ts`, `machine.ts` and every `packages/client` source are untouched.

### Status

H1 is demonstrably closed: the controller's real classification now has a positive (two committed codes → `committed: true`,
no rollback, forced re-read) and a negative (uncoded, unknown code, plain `Error` → `committed: false`, rollback) keeper,
and both faulty Booleans fail it. The only change beyond the test is the app unit fixture's Solid build selection, which
made the driver reachable at all. This pass does NOT claim the feature is CONVERGED: no independent feature-level review
has been run since S3's correction pass, and acceptance remains the review's to grant.
