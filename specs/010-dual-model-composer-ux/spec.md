# Feature Specification: Dual-Model Composer UX Restoration

**Feature Branch**: `dev`

**Created**: 2026-11-18

**Status**: Draft

**Input**: User description: "Specify restoration of the original OpenCode V2 dual-model composer UX. This is a focused UI behavior correction, not a model-selection architecture redesign. Required behavior: 1. Display controls in this exact order: Primary model → Primary variant → Fallback model → Fallback variant. 2. Both variant selectors must be visible, independent, and immediately adjacent to their corresponding models. 3. Remove the separate Swap and Clear buttons. 4. Selecting the current fallback model in the primary picker automatically swaps the two model selections. 5. Selecting the current primary model in the fallback picker performs the same automatic swap. 6. Model identity is providerID + modelID, independent of variant. The same model must not occupy both slots after a user selection. 7. Automatic swapping preserves each model's associated variant. A model must not inherit the other model's unrelated variant. 8. Selecting a different model changes only the selected slot. 9. The fallback picker provides None, which persists explicit fallback: null without changing primary. 10. Preserve existing session-scoped primary selection, globally persisted fallback, optimistic update ordering, failure rollback, keyboard accessibility, editor focus, desktop/mobile layouts, and compact styling. 11. Cover both automatic swap directions, model identity collisions, variant preservation, None, persistence/reload, and rapid asynchronous changes with deterministic regression tests. 12. Do not modify core recovery, provider transport, schemas, generated clients, or unrelated UI. Follow constitution 2.1.0. Identify existing selection ownership and reusable behavior. Specify observable behavior and acceptance criteria without introducing premature implementation abstractions. Produce a focused, testable specification."

## Clarifications

### Session 2026-11-18

- Q: After an automatic exchange has been applied on screen, if one of its two recorded values is later rejected, which pair must the composer show once it settles? → A: Both slots return to the pair the user had before the exchange, with the failure reported. **FR-032** (user decision)
- Q: When a session's primary model and its effective fallback resolve to the same model with no user selection involved, what must the composer show and record? → A: A distinct "fallback inactive because it is the same model" state, never two identical active models, and nothing at all is recorded: the global fallback setting is left untouched and stays distinguishable from a saved no-fallback value. Recovery must apply the same rule. **FR-029, FR-030, FR-031** (user decision)
- Q: When the primary model and the configured fallback are the same provider and model but differ only by variant, which side defines the duplicate check? → A: Request recovery, using provider and model with the variant ignored, so the composer and recovery share one identity rule. **FR-031** (user decision; see Out of Scope for the one permitted recovery change)
- Q: When the user selects a model that is in neither slot, what must happen to the variant of that slot? → A: The slot keeps a variant already recorded for that newly selected model, and never takes a variant from the model it replaced or from the other slot. This replaces the draft's unconditional variant reset. **FR-034** (user decision)
- Q: For an automatic exchange to be reachable, must each model picker offer the model currently in the other slot, including a hidden model or the default fallback? → A: Yes, whenever that model can be selected in the current workspace. **FR-033** (user decision)

Decisions settled by existing behavior rather than by the user, recorded here so they are not re-litigated:

- Carrying each model's own variant through an exchange, and dropping a variant the destination model does not offer, already work as specified and stay as they are.
- Session scope for the primary model, global scope for the fallback, a saved no-fallback value surviving restart, showing a new selection before it is confirmed, ignoring results from superseded selections, and rolling back only the affected slot for a one-slot change are existing behavior and are preserved unchanged.
- Request recovery already declines to retry a model as its own fallback; only the identity it compares is being aligned with this feature.
- The composer's fallback value and the value request recovery acts on remain one shared setting; this feature adds no second fallback state.

Correction made while planning (not a user decision, recorded so it is not mistaken for one): **FR-017** and its acceptance scenarios originally treated "fails" and "is not confirmed within the existing confirmation window" as the same outcome. The primary slot's existing owner separates them — a commit whose server echo never arrives keeps showing the user's choice and reconciles later, while a failure of the slot's own record reverts it — and existing scripted coverage asserts that separation, which FR-028 requires to stay in force. FR-017 and scenarios 5 and 10 were therefore narrowed to the record-failure case. See `plan.md` → "Spec correction" and "Complexity Tracking".

### Remediation amendments (2026-11-19)

Made after `/speckit.analyze`, from a user-approved remediation direction supplied in this session. Provenance is recorded honestly: the direction and the four decisions quoted below are **user-approved**; no maintainer, reviewer, or repository-authority approval is claimed for them, and none was supplied. `.specify/memory/constitution.md` is unchanged at **2.1.0** — every conflict was resolved on the spec side, never by relaxing a principle.

- **Supersession precedence** (resolves the FR-032 ↔ FR-018 contradiction): a newer user selection outranks an older failed exchange. In the documented sequence A/B → exchange to B/A → select primary C → the exchange's fallback write is rejected, the settled pair is **C/B**, provided no later fallback write succeeded after it. FR-032 and SC-009 are now qualified; the displayed-validity/durable-atomicity distinction from FR-019 is kept.
- **Hidden-model visibility** (resolves the Principle I conflict): a hidden opposite-slot model stays hidden in the ordinary model list after an automatic exchange, and stays available in the opposite-slot picker so the exchange is reachable. This is recorded as an explicit, intended exception to existing selection-side visibility behavior (`FR-033`) rather than a side effect, and one acceptance scenario was added to User Story 2.
- **FR-017 retained unchanged**: the existing primary commit-acknowledgment timeout is not a record failure, and its existing tests stay in force. The user re-affirmed this correction in the same direction, so it is no longer planner-only.
- **Coordinator boundary** (resolves the FR-026 ↔ FR-032 tension): exactly one non-durable, action-scoped exchange phase is permitted; it owns no authoritative primary/fallback value, persists nothing, queues nothing, and opens no transaction boundary.
- **Attribution honesty**: a monotonic failure id orders persistence observations and detects whether one was superseded by a later successful save. It does **not** attribute a workspace-document save failure to a user action, and no requirement may claim causal attribution to an action (see Assumptions).
- Qualified: FR-003, SC-003 (variant controls only where their model offers a choice); FR-025 (in-flight request attribution); FR-029 + SC-001 (concise label plus accessible description); FR-021/FR-013 and the reload edge case (reload guarantees apply to recorded values only). Added: **FR-036** (named variant wins over a carried variant; a plain row selection writes no variant) and **FR-037** (a picker's variant preview must match the outcome it previews). The requirement range is now **FR-001…FR-037**; SC-012 was updated to match.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read and set both models and both variants at a glance (Priority: P1)

A user composing a prompt needs to know, and control, the full model pair at once: which model will answer, how that model behaves, which model answers if the first one cannot, and how that backup behaves. Today the composer shows the two model triggers together with two small icon-only buttons, and only the primary model has a variant control, which sits after the fallback controls, so the user has to open a picker or press an icon to learn the state. After this change the composer header presents exactly four controls, left to right (right to left in right-to-left locales): primary model, primary variant, fallback model, fallback variant. Each variant control sits directly beside the model it applies to, and there is no separate Swap or Clear button.

**Why this priority**: This is the core correction. Without the paired reading order the user cannot tell which variant belongs to which model, and the remaining icon buttons are the affordance the feature removes.

**Independent Test**: Render the composer with a primary model that offers variants and a fallback model that offers variants, list the visible controls and their reading order, and confirm four controls in the required order with each variant control immediately beside its model and no swap or clear affordance present.

**Acceptance Scenarios**:

1. **Given** a composer with a primary model offering variants and an enabled fallback model offering variants, **When** the composer header is shown, **Then** exactly four model controls appear in this order: primary model, primary variant, fallback model, fallback variant.
2. **Given** the same composer, **When** the user changes the fallback variant, **Then** only the fallback model's variant changes and the primary model and its variant are unchanged.
3. **Given** the same composer, **When** the user reads the header without opening any picker, **Then** the displayed state names the primary model, names the fallback model or names that the fallback is inactive because it would repeat the primary model, and names every variant the user has explicitly chosen for either model.
4. **Given** the same composer, **When** the user looks for a way to swap the models or clear the fallback, **Then** no separate swap or clear control is shown, and the same outcomes are reachable from the two model pickers.
5. **Given** a composer in a right-to-left locale, **When** the header is shown, **Then** the same four controls appear in the same logical order, mirrored to the reading direction, with nothing clipped or overlapping.
6. **Given** a composer whose primary variant is left at the model's default and whose fallback variant is set to a named value, **When** the composer is read at rest and then engaged, **Then** both variant controls follow the same at-rest and engaged treatment, and the named fallback variant is readable in both states.

---

### User Story 2 - Exchange the two models by choosing the one already in the other slot (Priority: P1)

A user who wants to promote their backup model to primary, or demote their primary to backup, currently has to press a swap icon. With the swap icon removed, choosing the model that already sits in the other slot performs the exchange directly, in both directions, and each model keeps the variant the user last chose for it.

**Why this priority**: This is the behavior the removed buttons carried. If it is missing or half-implemented, the user silently loses the ability to promote a backup model or ends up with the same model in both slots.

**Independent Test**: Start from primary A with variant `x` and fallback B with variant `y`, choose B in the primary picker, and read back the pair; then start from the same state and choose A in the fallback picker and read back the pair.

**Acceptance Scenarios**:

1. **Given** primary A and fallback B, **When** the user chooses B in the primary picker, **Then** primary becomes B, fallback becomes A, and no other control's value changes.
2. **Given** primary A and fallback B, **When** the user chooses A in the fallback picker, **Then** fallback becomes A, primary becomes B, and no other control's value changes.
3. **Given** primary A with variant `x` and fallback B with variant `y`, **When** the user chooses B in the primary picker, **Then** primary B is shown with variant `y` and fallback A is shown with variant `x`, and neither model takes the other's variant.
4. **Given** primary A with variant `x` and fallback B, where B offers no variant named `x`, **When** the user swaps by choosing B in the primary picker, **Then** A keeps `x`, B is shown with its model default, and no variant is invented for B.
5. **Given** primary A and fallback B, where A and B have the same model name under different providers, **When** the user chooses B in the primary picker, **Then** the pair still swaps, because a model is identified by provider and model name together.
6. **Given** primary A, **When** the user opens the primary picker and chooses A again, in any of its variants, **Then** the primary slot still shows A, the fallback slot is unchanged, and no state shows A in both slots.
7. **Given** primary A and no fallback, **When** the user chooses A in the fallback picker, **Then** nothing is exchanged, the fallback stays off, and A never appears in both slots.
8. **Given** primary A and fallback B, **When** the user chooses a model C that is in neither slot, **Then** only the chosen slot changes to C and the other slot keeps its model and variant.
9. **Given** a composer whose fallback is inactive because it names the same model as the primary, **When** the user chooses that model again in either picker, **Then** both slots keep their model and the fallback stays inactive.
10. **Given** a hidden fallback model or a fallback model that the ordinary picker list does not show, **When** the user opens the primary picker, **Then** that fallback model is offered there, and choosing it exchanges the pair.
11. **Given** a fallback model the user has hidden in the ordinary model list, **When** the user exchanges the pair by choosing that model in the primary picker, **Then** the pair exchanges and each model keeps its own variant, and that model is still hidden in the ordinary model list afterwards while remaining available in the opposite-slot picker (FR-033: preserving the user's visibility is intended behavior, not a side effect).

---

### User Story 3 - Turn the fallback off with None, and tell "off" from "inactive" (Priority: P1)

A user who wants no backup model at all currently presses a small clear icon. The fallback picker now lists an explicit "None" entry. Choosing it writes an explicit no-fallback state that survives reload, and it must never disturb the primary choice. Separately, a fallback that names the same model as the primary is not off: it is inactive for that session, and the composer must say so without rewriting the user's saved fallback setting.

**Why this priority**: The removed clear button was the only way to disable the fallback, and an unconfigured fallback still resolves to a shipped default model, so an off-state that does not persist is a visible bug — and an inactive state reported as "off" would misreport a setting the user never changed.

**Independent Test**: Choose "None" in the fallback picker, confirm the primary selection is untouched, reload the composer, and confirm no fallback model (including a default one) reappears. Then load a composer whose primary and effective fallback name the same model and confirm it reads as inactive rather than off, with the saved setting unchanged.

**Acceptance Scenarios**:

1. **Given** primary A with variant `x` and fallback B with variant `y`, **When** the user chooses "None" in the fallback picker, **Then** the fallback control shows no fallback, and primary remains A with variant `x`.
2. **Given** the user has chosen "None", **When** the composer is reloaded or the application restarts, **Then** the fallback is still shown as no fallback rather than a configured or default fallback model.
3. **Given** a fallback that was never configured and therefore resolves to a default fallback model, **When** the user chooses "None", **Then** the state is recorded as explicitly off and that default model does not reappear on reload.
4. **Given** the fallback already shows no fallback, **When** the user chooses "None" again, **Then** nothing else changes and no additional state is written for the primary slot.
5. **Given** the fallback shows no fallback, **When** the user chooses a model in the fallback picker, **Then** the fallback becomes that model, showing a variant already recorded for that model or its own default, and never the primary's variant.
6. **Given** a composer whose primary model and effective fallback name the same model, whether that fallback was chosen, hidden, or left at its default, **When** the user reads the fallback control, **Then** it shows a distinct inactive state and not the "None" off state, and nothing is written to the fallback setting.
7. **Given** that inactive state, **When** the user chooses a different model as primary, **Then** the configured fallback becomes visible as the active fallback again, keeping the variant recorded for it, and the saved setting is unchanged.

---

### User Story 4 - Keep each change scoped, visible at once, and durable through failure (Priority: P2)

Users switch models while the application is slow or failing. Each change must show immediately, belong to the right place (the session's own primary model, the user's own global fallback setting), survive a reload, and a late failure must not undo something newer or something unrelated. An exchange is one user action that changes both stored values, so it is either fully in place or fully not in place from the user's point of view.

**Why this priority**: The display, scope, and recovery behavior already work today; the swap makes one user action change two stored values at once, so the ordering and rollback guarantees have to be re-proven.

**Independent Test**: Delay or fail the storage step for one action, then issue further selections including a swap, and compare the displayed pair with the last intended pair after the delayed results land.

**Acceptance Scenarios**:

1. **Given** a session whose primary model the user has changed, **When** the user opens another session or starts a new draft, **Then** the other composer shows its own primary model, not this session's choice.
2. **Given** a fallback model chosen in one composer, **When** the user opens any other composer after the change is recorded, **Then** that composer shows the same fallback model and variant.
3. **Given** the user chooses a new fallback model, **When** storage of that change is still in progress, **Then** the composer already shows the chosen model rather than the previous one.
4. **Given** a one-slot fallback change whose storage fails, **When** the failure is reported, **Then** the fallback shows the last recorded value and the primary model and variant are unchanged.
5. **Given** a one-slot primary change whose own record fails, **When** the composer settles, **Then** the primary shows the last recorded value and the fallback model and variant are unchanged. A primary change whose server confirmation never arrives is not treated as a failure: the primary keeps showing the model the user chose, and the composer reconciles when the server's value arrives.
6. **Given** several model selections made quickly while storage is delayed, **When** the delayed results arrive, **Then** the displayed pair matches the last selection the user made and no earlier model or variant reappears.
7. **Given** a swap whose two storage steps take different amounts of time, **When** the user reads the composer while it is in progress, **Then** the pair is applied in the order the user acted and never shows the same model in both slots.
8. **Given** a swap that would name a model the current workspace cannot select for the primary slot, **When** the user attempts it, **Then** both slots keep their previous model and variant, and no half-applied pair remains.
9. **Given** a swap whose fallback storage fails after the pair has been applied, **When** the composer settles, **Then** both slots show the model and variant each held before the swap, and the failure is reported.
10. **Given** a swap whose primary storage fails after the pair has been applied, **When** the composer settles, **Then** both slots show the model and variant each held before the swap, and the failure is reported. If instead the primary's server confirmation merely does not arrive within the existing window, the applied pair stays displayed rather than being reverted.
11. **Given** a request that could not proceed with the primary model and recovered by using the fallback, **When** the user reads the composer, **Then** the fallback shown is the same recorded value recovery acted on, and the composer never reports a fallback that differs from it.

---

### User Story 5 - Keep the composer usable by keyboard, on a phone, and at current compact size (Priority: P2)

Users reach model controls without a pointer, and use the composer on narrow screens. The new fourth control must not steal space, break focus handoff, or change the compact look.

**Why this priority**: These are preservation requirements the change can easily break by adding a control and removing two.

**Independent Test**: Drive the composer with the keyboard only, then at a phone width, and compare control heights, spacing, and focus behavior with the current compact composer.

**Acceptance Scenarios**:

1. **Given** a composer showing all four controls, **When** a user tabs forward, **Then** the controls receive focus in their displayed order and each can be opened by keyboard.
2. **Given** the user opens a model picker by pressing it with a pointer, **When** the picker closes, **Then** text-entry focus returns to where it was before, as it does today.
3. **Given** the user opens a model picker from the keyboard, **When** the picker closes, **Then** focus stays on that control, as it does today.
4. **Given** a phone-width composer, **When** the user opens the primary or fallback model picker, **Then** the picker opens as a bottom drawer, and the variant controls remain beside their models.
5. **Given** a desktop-width composer, **When** the four controls are shown, **Then** control height, spacing, and label truncation match the current compact composer, and long model names truncate instead of pushing controls apart.
6. **Given** both variant controls are present, **When** a user reaches either by screen reader or by keyboard, **Then** the two controls are told apart by name in displayed order, and neither is reachable under the same name as the other.

---

### Edge Cases

- Fallback is off (None) and the user picks the current primary model in the fallback picker: there is nothing to exchange, so the pair is left unchanged and the fallback stays off.
- The fallback names the same model as the primary without any user selection — because it was chosen, because it is hidden, or because an unconfigured fallback resolves to a default model: the fallback is inactive for this session, the composer says so with its own state, and no fallback setting is written or cleared.
- The fallback names the same model as the primary with a different variant: this is the same model under this feature's identity rule, so the fallback is inactive and request recovery does not retry the identical model as its own fallback.
- The primary model later changes to a different model while the fallback stays as it was: the configured fallback becomes effective again automatically, with the variant recorded for it.
- An inactive fallback and a saved no-fallback state are never interchangeable: each has its own display, and only "None" records an off setting.
- A hidden model, an unconnected model, and an unresolved model name are three different conditions: only an unconnected or unresolved model prevents an exchange; a hidden model is still offered in the opposite picker so it can be exchanged, and an exchange leaves it hidden in the ordinary model list exactly as the user left it (FR-033).
- A configured fallback model that sits outside the ordinary visible model list is still named in the fallback control rather than reduced to a generic label, and is still eligible for an automatic exchange.
- A model the user selects for one slot is offered under two different providers: the same model name in both slots is allowed only when the providers differ, because provider and model name together identify a model.
- A variant carried by an exchange is not offered by the model it lands on: that model is shown with its own default, and the other model's variant is never borrowed.
- A model with no variants, or a fallback that is off: that slot's variant control is not shown, while the other slot keeps its own variant control.
- A fallback that is inactive: its model control shows the inactive state, and its variant control keeps showing the variant recorded for that fallback, which becomes effective again if the primary model changes.
- The model catalog is still loading: the composer shows its current preview state and the four controls appear once there is a real selection to act on; a late catalog load does not open a picker on its own.
- A fallback model whose provider is not connected in this workspace, or whose name is not in the loaded catalog, cannot be moved into the primary slot: the whole exchange is refused and both slots stay exactly as they were.
- A storage failure is reported after the user has already made newer selections: the older failure rolls back only what that older action owned and cannot restore an obsolete model or variant.
- A half-failed exchange is undone in both slots, and a newer selection made before the failure is reported is never undone by that older failure.
- A reload settles on what the system actually recorded: a fallback change that had not been recorded when the page reloaded is not promised to survive it, while every recorded value — model, variant, or the explicit no-fallback state — must be restored (FR-013, FR-021, FR-019's honesty limit). An in-flight, unconfirmed write is never treated as durable.
- Two composers or tabs share the fallback setting: the most recently recorded fallback is what each shows, and a swap in one session never changes another session's primary model.
- An active request is already failing over to the fallback while the user swaps the pair: an already dispatched attempt cannot be relabeled, while a future physical recovery dispatch within that logical request MUST use the newer eligible effective fallback immediately before dispatch (FR-025).
- An exchange triggered from the variant flyout or by keyboard applies the variant the user named; an exchange triggered by a plain model-row click writes no variant and so keeps the one the pair rule carries, and the flyout's current marker already shows the value the exchange will produce (FR-036, FR-037).
- An exchange recorded on one side and rejected on the other never leaves the pair in a state where a later request would repeat the same model as its own backup.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The composer MUST present its model controls in exactly this order: primary model, primary variant, fallback model, fallback variant, in that reading order in both left-to-right and right-to-left locales.
- **FR-002**: The system MUST place each model's variant control immediately beside that model's control, and MUST keep the two variant controls independent: changing one never changes the other model or its variant. Both controls MUST remain part of the composer's control row whenever the model beside them offers a choice, and neither may be merged into, substituted by, or shared with the other.
- **FR-003**: The system MUST treat the two variant controls the same way visually and interactively: both are keyboard-reachable whenever shown, a control whose value is the model's default keeps its existing quiet at-rest appearance while the composer is not being pointed at or keyboard-focused, and both reveal their value under the same conditions. Where the model in each slot offers a choice, a variant control MUST NOT be reachable for one slot while missing for the other. Where one slot's model offers no choice, or the fallback is off, that slot shows no variant control and the other slot keeps its own; that asymmetry is required behavior, not a mismatch. In both cases the controls that are shown MUST be distinguishable by name to a keyboard or screen-reader user.
- **FR-004**: The system MUST NOT present separate swap or clear controls for the model pair; the swap outcome MUST be reachable only by choosing a model already in the other slot, and the off outcome only by choosing "None" in the fallback picker.
- **FR-005**: When the user selects, in the primary model picker, the model currently shown in the fallback slot, the system MUST automatically exchange the two model slots. When the primary slot shows a model the user did not choose in that session, the exchange MUST still name that previously shown primary model in the fallback slot rather than dropping it.
- **FR-006**: When the user selects, in the fallback model picker, the model currently shown in the primary slot, the system MUST automatically exchange the two model slots with the same result as FR-005. When the fallback slot holds no model, there is nothing to exchange, and the system MUST leave both slots' models and variants unchanged.
- **FR-007**: The system MUST identify a model for collision, exchange, and fallback-effectiveness rules by its provider and model name together, ignoring any variant, so two variants of one model count as the same model and the same model name under different providers counts as two different models.
- **FR-008**: After any single user model selection, the system MUST NOT show the same model in both the primary and fallback slots, including when the selection is made using a different variant of that model.
- **FR-009**: During an automatic exchange, each model MUST keep the variant the user had associated with it, and MUST NOT acquire the other model's variant.
- **FR-010**: If a variant moving with a model is not offered by that model, the system MUST show that model with its own default instead of an unsupported or borrowed variant, and an explicit no-variant choice MUST continue to mean the model's default.
- **FR-011**: When the user selects a model that is in neither slot, the system MUST change only that slot, leaving the other slot's model and variant untouched, and the newly selected model MUST NOT take a variant belonging to the model it replaced or to the other slot.
- **FR-012**: The fallback model picker MUST offer a "None" entry that records an explicit no-fallback state and MUST leave the primary model and primary variant unchanged.
- **FR-013**: An explicit no-fallback state, once it has been recorded, MUST survive reload and restart, and MUST NOT be replaced by a configured or default fallback model. A no-fallback choice whose write had not been recorded when the page reloaded carries no such promise (see FR-019's honesty limit).
- **FR-014**: The system MUST keep the primary model choice scoped to the session or draft the composer belongs to, and MUST keep the fallback choice recorded in the user's global settings so it is shown by every composer once recorded.
- **FR-015**: The system MUST show the new state of a model selection immediately after the user acts, before storage confirms it, and multiple rapid selections MUST be displayed in the order the user made them.
- **FR-016**: If storing a fallback change made to one slot fails, the system MUST revert only the fallback slot to its last recorded value and MUST leave the primary model and variant unchanged.
- **FR-017**: If a one-slot primary model change's own record reports a failure, the system MUST revert only the primary slot to its last recorded value and MUST leave the fallback model and variant unchanged. A primary change whose server confirmation does not arrive inside that existing confirmation window is not a failure: the primary slot keeps showing the user's choice, as it does today, and reconciles when the server's value arrives.
- **FR-018**: A result, echo, or failure from a superseded selection MUST NOT overwrite a newer selection, in either slot, including during an automatic exchange.
- **FR-019**: An automatic exchange MUST be applied as one pair: the system MUST first check that the exchange is possible for this workspace and change neither slot when it is not, both slots MUST then update in the user's action order without any point at which the same model is shown in both, and the two settings are NOT changed as one durable operation and MUST NOT be described or relied on as such.
- **FR-020**: If an automatic exchange would move a model into the primary slot that this workspace cannot currently select, the system MUST refuse the exchange before changing either slot, and both slots' models and variants MUST stay unchanged.
- **FR-021**: After reload, the primary model and variant MUST be restored for the session or draft they belong to, and the fallback model, its variant, or the explicit no-fallback state MUST be restored globally — for values the system actually recorded. Nothing in this feature may claim that an unconfirmed or in-flight write survives reload; reload guarantees apply to confirmed, recorded values only.
- **FR-022**: The system MUST keep the existing keyboard affordances working: every shown control is reachable by keyboard in displayed order, pickers open and close by keyboard, closing a pointer-opened picker returns text-entry focus as it does today, and closing a keyboard-opened picker leaves focus on that control.
- **FR-023**: The system MUST preserve the existing compact composer presentation at desktop and phone widths, including control height, spacing, label truncation, and phone-width pickers opening as drawers, with no clipping, overlap, or control shift when labels change length.
- **FR-024**: The system MUST keep a fallback model that is outside the ordinary visible model list named in the fallback control, and MUST offer that model in the primary picker so it can take part in an automatic exchange whenever the workspace can select it.
- **FR-025**: The fallback the composer shows and writes MUST remain the same value that request recovery uses when a primary model attempt cannot proceed; changing presentation MUST NOT redefine, duplicate, or bypass that fallback meaning. Each physically dispatched attempt MUST retain its model and variant attribution; a pending recovery attempt MUST use the latest eligible effective fallback immediately before dispatch, including after a composer change or automatic exchange, and recovery MUST NOT replay uncertain external tool effects.
- **FR-026**: The system MUST reuse the existing per-session primary selection and the existing global fallback setting as the only sources of these values, and MUST NOT add a second store, a parallel fallback state, or a new generic queue or transaction layer to make the pair work. Exactly one non-durable, action-scoped exchange phase IS permitted, and is required by FR-032 and FR-018: it holds only the pair the two owners were showing at the moment of the action plus a token identifying that attempt, it owns no primary or fallback value of its own, it persists nothing, it queues nothing, and it opens no transaction boundary; it issues only the two existing owners' own writes. The existing owners remain authoritative for their halves, and nothing in this feature may add a durable pair store, a lock, a queue, or any second holder of the same authority.
- **FR-027**: Each automatic exchange direction, identity collision, variant-preservation case, "None" case, inactive-fallback case, recorded-value reload case, hidden or default fallback exchange, visibility-preservation case, variant-preview-consistency case, and rapid or failed asynchronous case above MUST be covered by a deterministic scripted scenario that fails against the pre-change behavior, without relying on live services, real elapsed time, or unbounded waits.
- **FR-028**: The change MUST keep every existing test assertion in force unless this specification explicitly replaces the behavior it covers, and MUST NOT weaken existing coverage of the model pair.
- **FR-029**: When the effective fallback names the same model as the primary — whether that fallback was chosen, inherited, hidden, or left at its shipped default — the composer MUST present the fallback slot as a distinct inactive state rather than two identical active models, and MUST NOT write, clear, or otherwise alter the global fallback setting. That state is conveyed by a concise visible label — "None" for a saved no-fallback state, "Same model" for an inactive fallback — and MUST additionally carry an accessible description naming the state and its reason (the fallback is inactive because it would repeat the primary model), so the meaning is not left to be inferred from the two-word label.
- **FR-030**: That inactive state MUST be distinguishable from a saved no-fallback state in display and meaning, and MUST revert to showing the configured fallback, with its recorded variant, automatically as soon as the primary model no longer collides with it.
- **FR-031**: Request recovery MUST decide whether a fallback would repeat the model already in use using the same model identity this feature defines — provider and model, ignoring variant — so that a fallback differing from the primary only by variant is not retried as a separate model, and the composer and recovery never disagree about whether a fallback is in effect.
- **FR-032**: If one half of an automatic exchange cannot be recorded and no newer model selection has superseded that exchange, the system MUST return both slots to the model and variant each held before that exchange, report the failure once, and leave no state in which the same model occupies both slots. Where the compensating write is itself not recorded, the restore is one attempt and one report: the guarantees in force are a valid displayed pair (a colliding fallback presented as inactive), one report, no retry loop, and no older pair restored over a newer choice — not that both durable records hold the pre-exchange values, which FR-019 and Out of Scope forbid claiming. Where a newer user selection has superseded the exchange, FR-018 takes precedence and the exchange MUST NOT undo that newer intent: the settled pair is the one the newer selection left, with the failed half reverted to its own owner's last recorded value. For the documented sequence A/B → exchange to B/A → select primary C → the exchange's fallback write is rejected, that pair is **C/B**, provided no later fallback write succeeded after it; never C/A and never A/B.
- **FR-033**: Each model picker MUST offer the model currently held in the other slot, including one the user has hidden or that comes from a default fallback setting, so the exchange is reachable in both directions in one action; an exchange involving a model this workspace cannot select remains refused under FR-020. Offering a hidden model in the opposite picker is display only: after an automatic exchange the model keeps the visibility the user gave it, staying hidden in the ordinary model list while staying available in the opposite-slot picker. This preservation is specified as intentional behavior and is an explicit exception to the existing selection-side visibility behavior, which re-shows a model when it is selected.
- **FR-034**: When the user selects a model that is in neither slot, the system MUST keep a variant already recorded for that newly selected model, and MUST NOT carry over the variant of the model it replaced or of the other slot; where nothing is recorded for it, the model shows its own default.
- **FR-035**: The rules for fallback effectiveness — an inactive fallback for a collision, a saved no-fallback state for "None", and provider-and-model identity — MUST have one meaning shared by the composer, the recorded setting, and request recovery, with no second source of truth for any of them.
- **FR-036**: One selection in a model picker is one intent carrying a model and, when the user named one, a variant. When the user names a variant — through the variant flyout or by keyboard — that named variant MUST win over any variant the pair rule would carry and MUST be the variant the model shows after the resulting automatic exchange. When the user selects only a model, with no variant named, no variant may be written for it, so the variant that model carries in the pair is preserved rather than cleared or reset.
- **FR-037**: A picker's variant preview MUST match the outcome of the selection it previews: the variant marked current for a model that sits in the other slot MUST be the variant that model will show after the resulting exchange, and the preview and the applied selection MUST NOT be produced by two rules that can disagree.

### Key Entities

- **Model slot**: One of two composer positions, primary or fallback, each holding a model or, for the fallback slot, the explicit no-fallback state or the inactive state.
- **Model identity**: Provider and model name together; variants do not change identity. This identity governs collisions, exchanges, and whether a fallback would repeat the model already in use.
- **Model variant**: A behavior choice belonging to one specific model, optionally unset, meaning that model's default; variants of one model may not be applied to another.
- **Primary selection**: The model and variant a session or draft will use, scoped to that session or draft.
- **Fallback selection**: The model and variant the user's global settings name as backup, or explicitly off.
- **Inactive fallback**: A session-level presentation of a configured fallback that would repeat the primary model; recorded settings stay unchanged and the fallback returns to effect automatically when the collision ends.
- **Explicit no-fallback**: A recorded "off" state for the fallback slot, distinct from an unconfigured fallback that still resolves to a default model, and distinct from an inactive fallback.
- **Composer control set**: The four visible controls — primary model, primary variant, fallback model, fallback variant — in fixed order.
- **Automatic exchange**: A single user action that swaps the two slots' models and their variants, with no separate swap action.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can read the complete model pair — primary model, its variant, fallback model and its variant, or the fact that the fallback is inactive because it would repeat the primary model — from the composer header without opening any picker, in 100% of states where the user chose a value; a variant left at its model's default keeps its existing at-rest treatment. For the inactive state the concise label ("None" / "Same model") plus its accessible description, which names the reason, are what is measured — a label alone is not sufficient.
- **SC-002**: The four model controls always appear in the required order with each variant control directly beside its model, verified at desktop width, phone width, and in a right-to-left locale, with zero misordered, detached, merged, or missing variant controls for a model that offers a choice.
- **SC-003**: The two variant controls behave identically in presentation and reachability in 100% of states where both slots' models offer a choice, with zero cases where one slot's variant control is available while the other's is absent or shared **in such a state**, and zero cases where the two controls share a name. A slot whose model offers no choice, or a fallback that is off, shows no variant control while the other slot keeps its own (FR-002, FR-003); that asymmetry is expected and is not counted as a mismatch.
- **SC-004**: Promoting the backup model to primary takes exactly one user action in both directions, replacing the previous two-action sequence (selection plus swap press), including when the backup is a hidden or default fallback model; zero swap or clear controls remain in the composer.
- **SC-005**: In 100% of scripted selections, no single user action leaves the same model in both slots, including selections made with different variants of the same model.
- **SC-006**: After every automatic exchange, each model shows the variant the user last chose for it, and zero cases show a model carrying the other model's variant; where a variant is unsupported, the model shows its own default.
- **SC-007**: Choosing "None" changes zero primary values and, after reload, leaves the fallback shown as off in 100% of cases, including where an unconfigured fallback would otherwise show a default model.
- **SC-008**: Across scripted scenarios with delayed, failed, and superseded storage of 10 consecutive selections, the displayed pair matches the user's latest intent in 100% of cases; a failed one-slot write reverts zero values in the other slot, and a failed half of an exchange reverts both halves of that exchange and zero other value.
- **SC-009**: A refused exchange leaves both slots exactly as they were, in 100% of cases. An exchange that failed to record leaves both slots as they were whenever no newer selection superseded it, and in every such case leaves zero half-applied pairs and zero pairs naming the same model twice — including where the compensating write also failed, where the countable guarantees are one report, no retry loop, a collision-free displayed pair, and no older pair restored over a newer choice (FR-018, FR-032).
- **SC-010**: Keyboard-only users can reach and operate every shown control in displayed order, and focus handoff after closing a picker is unchanged from today, verified with zero new focus traps.
- **SC-011**: The composer's compact presentation is unchanged: control heights and gaps are identical to the current compact composer at desktop and phone widths, with zero control-position shifts when variant or fallback labels appear, disappear, or change length.
- **SC-012**: Existing composer, selection, and fallback validation continues to pass with equal or greater assertion strength, and every requirement in FR-001…FR-037 is demonstrated by at least one deterministic scripted scenario.
- **SC-013**: In 100% of scripted collision states, including a fallback that differs from the primary only by variant, what the composer shows about the fallback matches what request recovery does with it, with zero disagreement between the two.
- **SC-014**: An inactive fallback is never presented as a saved off state and a saved off state is never presented as inactive, in 100% of scripted cases, with zero writes to the fallback setting caused by an inherited collision.

## Assumptions

- Existing ownership is reused, not replaced: the per-session primary model and variant remain owned by the composer's existing session-scoped selection, including its optimistic display while the server confirms a change; the fallback remains owned by the user's global settings and the single serialized write path already shared by every composer, including its optimistic display and rollback on failure.
- An undone half-exchange is achieved by re-issuing each existing owner's own recorded value, not by a shared transaction, lock, or new coordination layer. Nothing here promises that the two settings change as one durable operation: a value can be recorded on one side and rejected on the other, and the composer's obligation is to end in a valid pair either way.
- Where the re-issue itself is also rejected — the realistic case being storage that has already failed for the whole workspace, or a settings write the server keeps rejecting — the restore is one attempt, not a retry loop, and is reported once. The obligation that still holds is that the composer shows a valid pair (with a colliding fallback presented as inactive) and that no later failure notification restores an older pair over a newer choice; what is explicitly not promised is that both durable records hold the pre-exchange values after two failed writes. Detecting that the primary model record failed is a workspace-document signal, never an action-level one: edits to that document coalesce into a single save window, so no per-action write exists to fail. Such an observation may be read as evidence about an exchange only when the failed write's own payload carries the pair that exchange wrote for this composer's session, no successful save of that document has landed since the exchange wrote it, and the phase still holds that attempt — which honestly means "the exchange's values are not known to be durable". A monotonic failure id orders observations and detects one superseded by a later successful save; ordering alone establishes nothing about which action failed, and no requirement, contract, or test in this feature may claim action-level causation. Obtaining real causation would require a per-record write identity in the persistence layer, which FR-026 and Out of Scope forbid, so it is recorded as a blocking gate on FR-032's primary direction rather than assumed away.
- The pair-exchange rule already implemented for the two model slots — carry each model's own variant, drop a variant the destination model does not offer — is the rule this feature specifies; no new exchange mechanism is designed.
- Variant display and default resolution continue to use the existing per-model chain of user choice, preference, configuration, and model default; the fallback's variant is stored where the fallback setting is already stored, and an ordinary model change never imports a variant from another model or another slot.
- A model's variant control is shown when that model offers more than one variant, matching current behavior; a model that offers no variants, and a fallback that is off, show no variant control. The existing treatment of a variant control that shows the model's default while the composer is not engaged is kept, and is applied the same way to both variant controls.
- The two variant controls are told apart by name rather than by position alone, so keyboard, screen-reader, and scripted access stay unambiguous when the second control is added.
- A swap where the other slot is off has nothing to exchange and therefore changes nothing, rather than emptying the primary slot. A swap where the other slot is inactive names the same model in both slots, so it changes nothing either.
- Swapping writes both a session-scoped primary value and a global fallback value; that cross-scope effect is expected and is the user's visible intent, and it never changes another session's or draft's primary value.
- The composer already knows the configured fallback model even when it sits outside the ordinary visible model list; this feature names it in the fallback control and offers it in the opposite picker rather than broadening which models the catalog shows as a whole.
- A fallback that would repeat the primary model is treated as ineffective for that session and request, consistently in the composer and in request recovery, without changing what is stored; making recovery use this identity rule is the one specified exception to the recovery exclusion below.
- The presentation surfaces that show model state in the session timeline and other views keep reading the same values; this specification covers composer controls and the fallback-effectiveness rule only.
- Model catalog loading, preview chips, and the current behavior that a late catalog load must not open a picker on its own are preserved as-is.
- Variant names, provider catalogs, and configured fallback defaults come from the running application's own data; scripted scenarios use injected catalog fixtures rather than live provider data.

## Out of Scope

- Changing request recovery, fallback policy, provider transport, provider catalogs, configuration schemas, generated clients, or unrelated UI — with one specified exception: recovery's own check for whether a fallback would repeat the model already in use uses the provider-and-model identity defined here, so a fallback differing only by variant is no longer retried as a different model. No other recovery, policy, transport, schema, or generated-client work is in scope.
- Redesigning how model pickers, drawers, or dialogs are built, or unifying them with other model selectors in the application.
- Adding new keyboard shortcuts, new labels for unrelated actions, or new model-selection features such as multi-model routing or per-agent fallbacks.
- Introducing a generic pair-store, transaction layer, queue, or universal selection abstraction.
- Promising durable atomicity across the session setting and the global fallback setting, or making either setting's storage more reliable than it is today.
- Non-composer surfaces: settings dialogs, model management dialogs, session timeline layout, tabs, and dialogs outside the composer header.
- Visual restyling beyond restoring the four-control order, adjacency, and the current compact presentation.
