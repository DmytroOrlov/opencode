# Research: Composer Model-Pair Persistence Simplification

## Current-tree findings

Decision: Treat the current working tree as the source of truth, including its
staged Spec Kit/spec files and unchanged application implementation. The tree has
no unstaged changes and no extension hooks. The existing implementation already
contains the shared pair controller, FIFO tail, fallback augmentation, raw prompt
snapshot, local authoritative snapshot, and awaited server refresh.

Rationale: Replacing those pieces would violate the active specification and the
constitution's minimal ownership/shared-authority principles. The remaining UI
gap is in packages/app/src/components/prompt-input.tsx: the legacy paid selector
has no pair items/selection callback, the unpaid path invokes model.set inside
DialogSelectModelUnpaid, and the legacy variant selector invokes
selection.variant.set directly. prompt-input-v2.tsx already uses the pair.

Alternatives considered: Creating a controller inside PromptInput; rejected
because it would split mutation authority and FIFO state. Reworking commands or
layout construction; rejected because session-composer-controls.ts already
injects/reuses the authoritative pair instance.

## Legacy selector callback seam

Decision: Add only the callback plumbing needed for the old layout. Pass the
pair's primary model list and selection callback to the paid popover, add an
optional primary-selection callback to the unpaid dialog, and route the legacy
variant selection to pair.selectVariant.

Rationale: Both selector components already support callback injection in their
general/current-layout forms, and the unpaid dialog's default behavior can remain
unchanged for non-composer callers. This preserves presentation and closes every
legacy composer primary/variant direct-mutation path.

Alternatives considered: Making ModelSelectorPopover globally own pair logic;
rejected because the shared pair is composer/session scoped. Replacing the legacy
selector UI with V2; rejected because layout preservation is explicit.

## FIFO and persistence ordering

Decision: Retain the controller-local promise tail. Ensure every operation body
computes state at FIFO-head time, applies authoritative state, awaits config
persistence plus the existing server refresh, performs post-success preference
commit, and only then settles the tail item.

Rationale: The existing tail.then(() => operation(intent)) already admits actions
immediately while preventing later operations from computing, mutating, or sending
requests early. Its catch continuation keeps the FIFO usable after a failed
operation. The active spec explicitly prohibits revision IDs, generic queue
infrastructure, and concurrent stale-result suppression.

Alternatives considered: Capturing a generation ID and reconciling stale results;
rejected by the specification. Starting all operations concurrently and suppressing
late failures; rejected because the required contract is non-overlapping FIFO.

## Authoritative transaction boundary

Decision: Keep exact raw primary model/variant snapshots and exact fallback-config
rollback, but remove model-catalog preference snapshots. Agent state is never
owned by pair rollback.

Rationale: prompt-state.ts already preserves model absence and explicit variant
presence/value. local.model.snapshot() already restores only model/variant fields
within the local session/draft record, preserving the shared agent field. The
additional models.selectionSnapshot() reconstructs visibility, recent ordering,
and saved variants against later state; this is precisely the incidental
concurrent merge problem the spec says to avoid.

Alternatives considered: Improving the recent-list merge algorithm; rejected by
FR-014 through FR-018 and the constitution's preference for deferral/deletion.
Snapshotting the whole local state; rejected because it could overwrite an
unrelated agent change.

## Apply versus preference commit

Decision: Add the smallest repository-local separation needed by pair operations:
an authoritative apply path for raw model/variant state and a post-success commit
path for existing catalog preferences. Preserve the existing combined setter
behavior for ordinary non-pair callers by composing those paths.

Rationale: The current setters combine raw selection mutation with
models.setVisibility, models.recent.push, and models.variant.set. An option flag
alone would suppress effects but would not provide a clean post-success commit
operation. A narrow apply/commit boundary makes the mutation phases explicit
without introducing a transaction abstraction.

Alternatives considered: Keeping all side effects optimistic and rolling them
back; rejected because it recreates unsafe concurrent preference reconstruction.
Moving all preference behavior out of model setters globally; rejected because it
would broaden non-composer behavior and risk regressions.

## Preference classification

Decision: Classify existing effects as follows.

| Existing effect | Classification | Final behavior |
| --- | --- | --- |
| Prompt/local primary model raw state | authoritative | Apply optimistically; exact rollback on owned failure. |
| Prompt/local primary variant raw state | authoritative | Apply optimistically; preserve raw presence/value on rollback. |
| Server fallback config, including null/variant | authoritative | Optimistically set and persist; restore exact pre-operation config on failure. |
| Active agent selection | unrelated | Never capture or restore from a pair operation. |
| models.setVisibility(primary, true) | incidental-after-success | Commit after successful operation, preserving hidden fallback usability. |
| models.recent.push(primary) | incidental-after-success | Commit after success when existing primary selection requests recent. |
| models.variant.set(primary, value) | incidental-after-success | Commit after success for the selected primary's saved variant preference. |
| Fallback model/variant preference writes | unnecessary | Pair fallback operations persist authoritative config only; do not add catalog side effects. |
| last bookkeeping | incidental bookkeeping, not rollback state | Preserve ordinary updates; never use it to restore agent or preferences. |

Rationale: This preserves successful user-visible behavior while ensuring a failed
operation cannot remove unrelated recent/visibility/preference changes or create a
rollback reconstruction problem.

## Persistence refresh contract

Decision: Retain server-sync.tsx's updateConfig mutation and its awaited
bootstrap.refetch success hook. Pair FIFO settlement must await that promise.

Rationale: The current server-sync implementation already makes required refresh
completion part of the mutation promise. Changing it would expand scope and risk
provider/config behavior unrelated to composer selection.

Alternatives considered: Fire-and-forget refresh or parallel config persistence;
rejected because the next FIFO action must wait for full persistence/refresh settle.

## Validation boundary

Decision: Update focused Bun/browser tests at real controller and legacy UI seams,
retain current-layout/command tests, and run the specified backend and root checks.

Rationale: Unit transition tests alone cannot prove the legacy callback path, while
existing browser tests already exercise real controller construction and
current-layout ownership. Failure-injection tests should assert timing, raw
rollback, agent isolation, and deferred preference commits.

Alternatives considered: Rewriting existing current-layout tests; rejected because
they already prove the authoritative pair instance and should remain stable.
