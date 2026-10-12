# Feature Specification: Prompt Async Scope Lifetime

**Feature Branch**: `004-prompt-async-scope-lifetime`

**Created**: 2026-09-29

**Status**: Draft

**Input**: User description: Focused bugfix specification for the accepted `/prompt_async` generation hang, using the independently established request-scope lifetime diagnosis and preserving GenerationGate safety.

## Problem Context

`POST /session/{sessionID}/prompt_async` can persist the user message and return `204 No Content`, then lose the accepted background prompt before generation begins. The observed state has no AssistantMessage, an empty session status response, no provider connection or LLM activity, and a free GenerationGate. The existing real HTTP exercise reproduces the failure with a free gate, so a queued exclusive writer can widen the timing window but is not required to trigger it. The synchronous `session.prompt` control passes.

The established cause is a lifetime ownership mismatch. The handler supervises the background fiber with a long-lived scope, but that supervision scope does not replace the fiber's inherited request context. The child therefore retains the HTTP request's resource Scope as its ambient scope. A non-stream request closes that Scope when the `204` response completes. Later, session admission obtains the ambient Scope and associates the shared GenerationGate reservation with it. If the request Scope closes while admission is pending, its finalizer cancels the reservation. This can happen while the child is already waiting for admission or before it attempts admission, in which case registering the reservation against the already-closed scope cancels it immediately.

The resulting cancellation can be reported as a successful prompt result: the cancellation path may resolve the latest assistant lookup to the persisted user message when no assistant exists, so the asynchronous handler emits no error. Changing that fallback is outside this feature; the required fix is that request completion does not own the accepted operation's resources.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Accepted prompt continues after acceptance (Priority: P1)

A client submits a prompt asynchronously and receives successful acceptance. The same accepted prompt continues to generation after the HTTP request has finished, without requiring the client to submit it again.

**Why this priority**: A successful acceptance that silently loses the generation is the primary user-visible defect.

**Independent Test**: Submit one asynchronous prompt with a free GenerationGate, observe acceptance, and verify that one assistant result completes for that prompt without another request. The existing real HTTP exercise for `prompt_async` is the primary regression scenario; it currently accepts with `204` but times out waiting for generation.

**Acceptance Scenarios**:

1. **Given** a free GenerationGate, **When** `POST /session/{sessionID}/prompt_async` is accepted, **Then** the request may return `204 No Content`, and that same accepted prompt subsequently reaches generation and completes exactly one assistant result without another `POST`.
2. **Given** an accepted asynchronous prompt whose generation is cancelled, fails, or is stopped by shutdown, **When** the background operation terminates, **Then** it ends through that cancellation, failure, or shutdown path without changing the successful-acceptance HTTP contract.

### User Story 2 - Accepted prompt respects exclusive configuration work (Priority: P2)

A client submits a prompt while an exclusive GenerationGate writer is active. The request is accepted promptly, but provider work waits until the writer releases admission; then the same accepted prompt proceeds once.

**Why this priority**: Global configuration changes must remain serialized safely against generation while asynchronous acceptance remains reliable.

**Independent Test**: Hold exclusive admission, submit one asynchronous prompt, verify acceptance and no provider activity while the writer is held, then release the writer and observe exactly one generation for that prompt.

**Acceptance Scenarios**:

1. **Given** an exclusive writer owns GenerationGate admission, **When** an asynchronous prompt is accepted, **Then** the request returns `204` without starting provider work and its shared generation remains queued; **When** the writer releases, **Then** that same prompt proceeds and exactly one generation completes without another `POST`.
2. **Given** an exclusive writer remains active, **When** an asynchronous prompt has been accepted, **Then** the provider or fake LLM has not started.
3. **Given** shared admission has transferred to an active generation, **When** the HTTP request completes, **Then** the request's resource cleanup does not release that generation's admission.

### User Story 3 - Runtime context and cancellation cleanup are preserved (Priority: P3)

An accepted prompt retains the runtime context it inherited when submitted. If its background operation is cancelled or its durable supervising lifetime shuts down before admission transfers to generation, any untransferred admission is released.

**Why this priority**: Reliable async execution must preserve existing context behavior and avoid stranded admission when it terminates before generation takes ownership.

**Independent Test**: Verify the accepted operation can still use inherited `InstanceRef` and `WorkspaceRef`; cancel it or shut down its supervising lifetime before admission transfer and verify no untransferred reader token remains.

**Acceptance Scenarios**:

1. **Given** an asynchronous prompt submitted with `InstanceRef` and `WorkspaceRef` in its runtime context, **When** it proceeds after HTTP acceptance, **Then** generation observes the same context values.
2. **Given** an accepted background operation is cancelled or its supervising lifetime shuts down before admission transfers, **When** the operation terminates, **Then** its untransferred reservation is cancelled and no reader token leaks.

### Edge Cases

- The request completes before the background operation attempts shared admission; request completion must not cancel that later admission attempt.
- The background operation is already waiting for shared admission when the request completes; request completion must not cancel the accepted operation or its pending admission.
- An exclusive writer remains active for the entire interval after asynchronous acceptance; provider work must remain unstarted until shared admission succeeds.
- The HTTP request completes after admission has transferred to generation; request cleanup must not shorten the active generation's admission lifetime.
- A genuine cancellation, shutdown, or generation failure may still end an accepted operation; the requirement is independence from the completed request lifetime, not immunity from valid termination.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: After `POST /session/{sessionID}/prompt_async` returns successful acceptance, the accepted prompt MUST continue independently of the completed HTTP request's resource lifetime.
- **FR-002**: The asynchronous endpoint MUST retain its acceptance contract: it returns `204 No Content` after acceptance while generation continues in the background; it MUST NOT wait for generation to finish.
- **FR-003**: Each accepted background prompt MUST have resource ownership that outlives its HTTP request and ends when that specific operation completes, fails, or is interrupted, subject to server or layer shutdown.
- **FR-004**: An accepted prompt MUST remain pending for shared GenerationGate admission when an exclusive writer is active. Provider or generation work MUST NOT begin before shared admission succeeds.
- **FR-005**: GenerationGate writer fairness and ordering MUST remain unchanged: an exclusive writer already ahead of a queued generation MUST complete before that generation begins.
- **FR-006**: Transfer from a pending reservation to generation ownership MUST remain atomic. Closing the HTTP request MUST NOT release admission after ownership has transferred to the actual generation.
- **FR-007**: Existing inherited runtime context, including `InstanceRef` and `WorkspaceRef`, MUST remain available to the asynchronous operation.
- **FR-008**: If the accepted background operation is cancelled or its supervising lifetime shuts down before admission transfer, its untransferred reservation MUST be cancelled and no reader token may leak.
- **FR-009**: Global configuration mutation MUST continue to serialize safely against active generation and retain its ability to dispose and rebuild affected resources.
- **FR-010**: The primary regression is the existing real HTTP `prompt_async` exercise: with a free gate, one accepted request must reach generation and complete without another request. The synchronous `session.prompt` control behavior MUST remain passing.
- **FR-011**: The intended change boundary is narrowly limited to the `/prompt_async` background-operation lifetime in `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`. Unless implementation evidence contradicts the established diagnosis, the feature MUST NOT require changes to `packages/core/src/session/generation-gate.ts`, `packages/opencode/src/effect/runner.ts`, `packages/opencode/src/session/run-state.ts`, `packages/opencode/src/session/llm.ts`, or `packages/opencode/src/session/llm/splash-telemetry.ts`.

### Key Entities

- **Accepted asynchronous prompt**: A prompt whose request has returned successful acceptance and whose generation remains pending or active in the background.
- **Background operation lifetime**: The resource ownership interval for one accepted asynchronous prompt, extending beyond its HTTP request and ending with that operation or its supervising server/layer lifetime.
- **Generation admission**: Shared access granted through GenerationGate before provider or generation work may begin, with ownership transferring to the actual generation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the existing real HTTP `prompt_async` regression exercise with a free gate, 100% of accepted prompts reach generation and exactly one assistant result completes without a second submission.
- **SC-002**: In the exclusive-writer scenario, zero provider starts occur while the writer is held, and the accepted prompt completes exactly once after release.
- **SC-003**: In cancellation or pre-transfer shutdown scenarios, zero untransferred reader reservations remain after the operation terminates.
- **SC-004**: The asynchronous request continues to return successful acceptance before generation completes, preserving the `204 No Content` contract.
- **SC-005**: Existing synchronous prompt behavior and inherited runtime context behavior remain unchanged.

## Assumptions

- The independently reviewed diagnosis is the basis for this focused feature: the forked prompt operation inherits the per-request resource Scope, which can close before GenerationGate reservation ownership transfers to durable generation work.
- An operation-local resource lifetime is required by behavior, but the specification does not prescribe implementation syntax.
- Normal explicit cancellation, genuine generation failure, and server/layer shutdown remain valid termination paths for an accepted prompt.
- GenerationGate itself is not defective; this feature preserves its existing admission and ownership semantics.

## Constraints and Non-Goals

- **Primary bug**: An accepted prompt can die with its HTTP request Scope before generation starts, while its user message is already persisted.
- **Safety constraint**: The accepted prompt must continue to obey GenerationGate shared admission and exclusive-writer ordering.
- **Non-goals**:
  - Changing `lastAssistant` cancellation fallback behavior.
  - Redesigning GenerationGate or changing Runner admission ownership.
  - Moving durable Runner ownership before admission.
  - Generalizing operation scopes across all `SessionPrompt` callers.
  - Changing TaskTool's existing long-lived Scope behavior.
  - Changing Splash telemetry or provider/LLM behavior.
  - Unrelated HTTP lifecycle refactors.
  - Changing the `204` API contract.
  - Broad validation-tooling cleanup.
