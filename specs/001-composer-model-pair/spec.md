# Feature Specification: Consistent Composer Model-Pair Persistence

**Feature Branch**: `dev`

**Created**: 2026-09-21

**Status**: Draft

**Input**: User description: "Simplify composer model-pair persistence and close the remaining legacy composer mutation bypass. Users must get identical model-selection behavior from both the current and legacy composer layouts, including ordered persistence, failure isolation, variant preservation, and simplified preference handling."

## Clarifications

### Session 2026-09-21

- Q: Should accepted model-pair actions be admitted while earlier persistence is pending while model-pair mutations and persistence requests remain strictly FIFO and non-overlapping? → A: Yes; accepted actions enter a controller-local FIFO immediately, but each later action waits for the preceding operation to fully settle before computing, mutating model-pair state, or sending persistence.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Select models consistently in either composer (Priority: P1)

As a user, I can select a primary model, fallback model, or model variant from either composer layout and receive the same resulting primary/fallback configuration.

**Why this priority**: Inconsistent model selection between the current and legacy layouts can silently change which model is used for work. Consistent behavior is the central user-visible outcome.

**Independent Test**: Start with the same configured primary, fallback, and variants, perform each supported model-selection action once in each layout, and compare the resulting model pair and variants.

**Acceptance Scenarios**:

1. **Given** primary model A and fallback model B, **When** the user selects B as the primary model in either composer layout, **Then** primary becomes B and fallback becomes A.
2. **Given** primary model A and fallback model B, **When** the user selects a different primary model C in either composer layout, **Then** primary becomes C and the configured fallback behavior is preserved according to the existing composer semantics.
3. **Given** a configured primary and fallback, **When** the user changes either model's variant, **Then** the selected variant changes only for that model and the other model's variant remains unchanged.
4. **Given** a configured primary and fallback, **When** the user swaps models or cycles through variants, **Then** both layouts produce the same final model-pair configuration.

### User Story 2 - Preserve valid variants across model changes (Priority: P1)

As a user, I can change or swap models without losing a variant that the newly selected model supports, while unsupported carried variants are cleared and a null fallback variant continues to use the provider default.

**Why this priority**: Variants affect model behavior and are part of the user's selection. Incorrectly carrying or dropping them changes the effective model configuration even when the model names appear correct.

**Independent Test**: Exercise primary changes, fallback changes, swaps, and variant cycling with combinations of supported, unsupported, and null variants, then verify the effective configuration for each model.

**Acceptance Scenarios**:

1. **Given** a model change where the existing variant is supported by the newly selected model, **When** the change is accepted, **Then** that variant is preserved for the corresponding model.
2. **Given** a model change where a carried variant is unsupported by the newly selected model, **When** the change is accepted, **Then** that variant is cleared.
3. **Given** a fallback with a null variant, **When** the fallback is retained or swapped, **Then** its variant remains null and the model/provider default applies.
4. **Given** primary A and fallback B with valid variants, **When** the user selects B as primary, **Then** B's valid variant follows B and A's valid variant follows A after the symmetric swap.

### User Story 3 - Keep rapid model actions ordered and isolated on failure (Priority: P1)

As a user, I can make multiple model-pair changes while persistence is delayed, and a late failure from an earlier action cannot undo a later accepted action or unrelated changes.

**Why this priority**: Delayed persistence and recovery are normal during use. Stale failures must not replace the configuration the user most recently chose.

**Independent Test**: Delay persistence, accept later actions while an earlier operation is pending, and inject failures into selected operations; verify that queued operations start and complete in acceptance order while preserving the final model pair, variants, agent selection, and preferences.

**Acceptance Scenarios**:

1. **Given** two model-pair actions accepted in order while the first operation is pending, **When** the second action is accepted, **Then** it enters the controller-local FIFO immediately but does not mutate model-pair state or send a persistence request until the first operation fully settles; at most one pair-persistence request is active.
2. **Given** an earlier model-pair action that fails and a later action that was accepted, **When** the earlier operation settles, **Then** it restores only the state owned by that operation, the later action starts, computes against the resulting valid or restored state, persists, and remains effective rather than being dropped.
3. **Given** a fallback-only change that fails, **When** failure recovery completes, **Then** the primary model and primary variant are unchanged.
4. **Given** a primary-changing operation that fails while the active agent changes during persistence, **When** failure recovery completes, **Then** only the authoritative model-pair state changed by the failed operation is restored and the newer agent selection remains active.
5. **Given** unrelated recent-model or visibility preference changes during model-pair persistence, **When** the model-pair operation fails, **Then** those unrelated preference changes are not rolled back or replaced.

### User Story 4 - Preserve model availability and session flows (Priority: P2)

As a user, I can use the same model-pair behavior in an existing session, before a session has an ID, and in the dedicated new-session flow, including when the configured fallback is not in the ordinary visible model catalog.

**Why this priority**: Model selection must remain dependable during session creation and for configurations that intentionally use a less-visible fallback model.

**Independent Test**: Repeat the model-selection matrix in a normal session, an ID-less session, and the dedicated new-session flow with a fallback outside the ordinary visible catalog.

**Acceptance Scenarios**:

1. **Given** a normal session, **When** the user performs any supported model-pair action, **Then** the resulting models and variants match the shared composer behavior.
2. **Given** a session without an ID yet, **When** the user performs any supported model-pair action, **Then** the resulting models and variants match the behavior of an existing session.
3. **Given** the dedicated new-session flow, **When** the user performs any supported model-pair action, **Then** the resulting models and variants match the other session flows.
4. **Given** a configured fallback that is absent from the ordinary visible catalog, **When** the existing composer behavior exposes that fallback for selection or swapping, **Then** it remains selectable and participates in the same model-pair semantics.

### Edge Cases

- Selecting the currently configured fallback as primary performs the symmetric primary/fallback swap; it does not leave both positions pointing to the same model.
- Selecting the already configured primary or fallback does not create a duplicate model pair or corrupt either variant.
- A null fallback variant remains null through selection, swapping, cycling, persistence, and recovery.
- A model with no supported variants uses its default behavior after an unsupported carried variant is cleared.
- A persistence failure arriving after newer model-pair actions cannot restore an obsolete pair or erase newer variants.
- A failed fallback-only operation cannot change primary state, even when other unrelated actions occur while persistence is pending.
- A configured fallback outside the visible catalog remains available wherever the existing composer currently exposes it.
- Recent-model history and other incidental preference entries are not required to be perfectly reconstructed after a failed model-pair operation; unrelated entries must not be lost or replaced.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST apply the same primary-model selection, fallback-model selection, primary-variant change, fallback-variant change, model-swap, and variant-cycling semantics from both composer layouts.
- **FR-002**: The system MUST ensure that selecting the currently configured fallback as primary performs the existing symmetric primary/fallback swap.
- **FR-003**: The system MUST preserve supported model-specific variants with their corresponding models during model changes and swaps.
- **FR-004**: The system MUST clear a carried variant when the resulting model does not support it.
- **FR-005**: The system MUST preserve a null fallback variant as null, meaning the model/provider default remains in effect.
- **FR-006**: The system MUST make the same model-pair semantics available in normal sessions, sessions without an ID, and the dedicated new-session flow.
- **FR-007**: The system MUST keep a configured fallback selectable wherever the existing composer behavior exposes it, even when it is absent from the ordinary visible model catalog.
- **FR-008**: The system MUST admit accepted model-pair actions to a controller-local FIFO immediately, while starting each later action only after its predecessor fully settles; later actions MUST NOT mutate model-pair state or send a pair-persistence request early, pair-persistence requests MUST execute in acceptance order without overlap, and at most one pair-persistence request may be active.
- **FR-009**: The system MUST prevent a late failure from an earlier model-pair action from overwriting or dropping a later accepted model-pair action.
- **FR-010**: If an earlier model-pair operation fails, the system MUST allow a later accepted operation to execute against the resulting valid state.
- **FR-011**: A failed fallback-only operation MUST leave the primary model and primary variant unchanged.
- **FR-012**: A failed primary-changing operation MUST restore only the authoritative primary/fallback state changed by that operation.
- **FR-013**: Failure recovery for a model-pair operation MUST preserve unrelated user actions made while persistence is pending, including active-agent changes.
- **FR-014**: Recent-model history, visibility bookkeeping, saved model preferences, and similar incidental preference state MUST NOT be part of the atomic model-pair transaction.
- **FR-015**: Incidental preference effects that cannot be safely reversed without reconstructing concurrent state MUST occur only after the authoritative model-pair operation succeeds.
- **FR-016**: A failed model-pair operation MUST NOT roll back unrelated preference changes or remove unrelated recent-model entries.
- **FR-017**: The resulting behavior MUST preserve the current model selector appearance and layout, existing backend fallback/recovery behavior, telemetry, TLS behavior, fallback configuration semantics, and unrelated legacy model selectors outside the active composer model-pair behavior.
- **FR-018**: The implementation MUST remove or simplify rollback behavior that exists only to reconstruct incidental preference state, while retaining protections required for authoritative model-pair correctness.
- **FR-019**: The system MUST preserve the existing user-visible error and recovery behavior for model-pair persistence failures except where needed to satisfy the ordering and isolation requirements above.

### Key Entities

- **Model pair**: The authoritative primary model, fallback model, primary variant, and fallback variant selected for a composer session.
- **Model-specific variant**: An optional behavior setting supported by a particular model; a null fallback variant means the provider/model default.
- **Composer layout**: Either the current composer layout or the legacy composer layout that can initiate model-pair actions.
- **Model-pair action**: A user-initiated primary/fallback model or variant selection, swap, or variant-cycle operation.
- **Accepted model-pair action**: A model-pair action for which the user completed the interaction and which entered the controller-local FIFO; acceptance does not mean its optimistic mutation or persistence has started.
- **Incidental preference state**: Recent-model history, visibility bookkeeping, saved model preferences, and other preference data that is not authoritative for the active model pair.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the supported model-pair action matrix produces the same primary model, fallback model, and variant results from the current and legacy composer layouts.
- **SC-002**: In every tested swap scenario, selecting fallback B while primary is A results in primary B and fallback A, with each supported variant still attached to its model.
- **SC-003**: In 100% of tests where a later model-pair action is accepted while an earlier persistence operation is pending, the later action enters the FIFO immediately, pair-persistence requests execute in acceptance order without overlap, and the later action computes from the state produced when its predecessor settles.
- **SC-004**: In failure-injection tests, zero earlier failures overwrite a later accepted model-pair action, and zero failed fallback-only operations change primary model or primary variant state.
- **SC-005**: In concurrent-action tests, 100% of unrelated agent and preference changes remain present after model-pair failure recovery.
- **SC-006**: In catalog-visibility tests, every fallback already exposed by composer behavior remains selectable even when absent from the ordinary visible model catalog.
- **SC-007**: Existing focused composer tests and typechecks pass, and existing backend recovery validation remains unchanged and passing.
- **SC-008**: Review of the production change confirms that model-pair persistence no longer requires rollback reconstruction for incidental preference state, with no new generic transaction or queue layer added for this feature.

## Assumptions

- The existing model catalog, variant support information, session flows, backend fallback/recovery behavior, telemetry, TLS behavior, and selector presentation remain the source of compatibility expectations.
- The current composer behavior defines when a configured fallback outside the ordinary visible catalog is exposed; this feature preserves that exposure rather than broadening catalog visibility.
- An accepted model-pair action is one for which the user completed the corresponding selection, swap, or cycling interaction and which entered the controller-local FIFO; acceptance does not imply that its optimistic model-pair mutation or persistence has started.
- User actions may be accepted while an earlier model-pair operation is pending, but model-pair mutations and pair-persistence requests are serialized in the controller-local FIFO: a later action starts only after its predecessor fully settles, and at most one pair-persistence request is active.
- The authoritative model-pair state can be validated independently of incidental preference state.
- Perfect rollback equivalence for global recent-model history is not required, provided failed operations do not corrupt or remove unrelated entries.
- Generic transaction infrastructure, generic queue infrastructure, global model-preference redesign, universal selector abstractions, backend recovery redesign, telemetry changes, TLS changes, routing, generated SDKs, and unrelated architecture cleanup are out of scope.

## Out of Scope

- Redesigning backend recovery or fallback policy.
- Changing telemetry, TLS, routing, generated SDKs, or unrelated legacy model selectors.
- Building generic transaction or queue infrastructure.
- Redesigning global model preferences or introducing universal selector abstractions.
- Pursuing additional rollback equivalence, state-merging behavior, or architecture cleanup unless a reproducible correctness, data-loss, duplicate-execution, security, or contract violation is demonstrated.
