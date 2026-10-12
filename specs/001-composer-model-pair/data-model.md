# Data Model: Composer Model-Pair Persistence

## Entities

### Model pair

The active composer pair consists of:

- primary: provider/model identity selected for the next composer action;
- fallback: optional server config { model, variant }, displayed only when it does
  not collide with the primary;
- primary raw variant override in prompt/local state;
- fallback raw variant override in fallback config; null means provider default.

The pair is exposed through one ModelPairController instance. The controller owns
public pair commands and their local FIFO.

### Model-pair action

An accepted action is a queued intent, not an already-applied state change. It may
be primary model selection, fallback model selection/removal, primary variant
selection/cycle, fallback variant selection, or pair swap.

The action's model/variant argument is captured at acceptance. Current primary,
fallback, supported variants, and rollback snapshots are read/computed only when
the action reaches the FIFO head.

### Authoritative rollback snapshot

The snapshot is operation-scoped and contains only fields the operation can own:

| Field | Exactness requirement | Restore rule |
| --- | --- | --- |
| Primary raw model | Preserve absent/present and provider/model value | Restore only primary model fields owned by the failed operation. |
| Primary raw variant | Preserve property presence and undefined, null, or string value | Restore only primary variant fields; preserve current agent field. |
| Fallback config | Preserve absent/undefined, null, model, and variant values | Restore only if that operation optimistically changed fallback config. |
| Agent | Not captured | Never restored by model-pair recovery. |
| Recent/visibility/saved model preferences | Not captured | Never reconstructed or restored. |

prompt-state.ts remains the exact raw prompt-model snapshot implementation.
local.tsx remains responsible for restoring model/variant fields inside a shared
session/draft record without replacing its agent field.

### Incidental model preferences

These are catalog convenience/history state, not pair authority:

- recent-model ordering;
- explicit visibility bookkeeping;
- saved per-model variant entries.

They are committed only after authoritative operation success. A failed operation
does not attempt to reconstruct them.

## Relationships

    PromptInput (legacy) ─┐
    PromptInputV2         ├─> PromptInputControls.model.pair
    Composer commands     ┘                 │
                                            v
                                  ModelPairController
                                  - controller-local FIFO
                                  - transition computation
                                  - authoritative apply/persist
                                  - post-success preference commit
                                            │
                         ┌─────────────────┴─────────────────┐
                         v                                   v
               prompt/local raw model state        server fallback config
                    (authoritative)                    (authoritative)
                         │                                   │
                         └─────────────────┬─────────────────┘
                                           v
                    models recent/visibility/variant (incidental)

## State transitions

### Primary selection

1. At FIFO head, read current primary and displayed fallback.
2. If selected item is the displayed fallback, compute the existing symmetric swap
   and carry each model's supported variant with its model.
3. Otherwise compute selected primary and whether fallback config must be cleared
   because of a primary collision.
4. Capture raw primary state and fallback config only when changed.
5. Apply raw primary model/variant and optimistic fallback config.
6. Persist/refresh fallback config when required.
7. On failure, restore only captured authoritative fields.
8. On success, commit primary visibility/recent/saved-variant effects.

### Fallback model or variant selection

1. At FIFO head, read current primary and raw fallback config.
2. Compute fallback config with existing helpers, preserving supported variant or
   null-default semantics.
3. Capture exact fallback config and persist it.
4. On failure, restore fallback config only; primary model/variant remains untouched.
5. On success, do not add primary catalog preference effects.

### Primary variant selection/cycle

1. At FIFO head, compute the next supported variant from current raw/configured
   state using existing cycling rules.
2. Capture raw primary model/variant state.
3. Apply the raw variant only.
4. Commit the saved variant preference after the authoritative apply succeeds.
5. On failure, restore raw primary state only.

### FIFO admission and settlement

    accept op1 -> tail(op1) starts
    accept op2 -> queued immediately
                 op2 does not read/mutate/persist yet
    op1 apply -> persist + required refresh -> commit or restore -> settle
    op2 reads resulting state -> apply -> persist -> commit or restore -> settle

At most one pair persistence request is active. An operation failure is reported
and converted into a settled tail continuation so later accepted actions execute.
