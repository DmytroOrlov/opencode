# Feature Specification: Safe Global Configuration Updates

**Feature Branch**: `003-safe-global-config-update`

**Created**: 2026-09-28

**Status**: Draft

**Input**: User description: Prevent ordinary global configuration changes from interrupting active generations, with process-wide coordination covering all generation paths.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Change configuration while generations are running (Priority: P1)

A user changes a global setting while OpenCode is generating a response or executing a tool. The update and active work are coordinated so the generation can reach its normal terminal state, and the user receives a clear outcome for the configuration change.

**Why this priority**: An ordinary setting change must not unexpectedly interrupt unrelated work across the server process.

**Independent Test**: Start a generation, submit a changed global setting from another client, and verify the HTTP request remains pending until the generation reaches its normal terminal/cleanup boundary and the update is applied.

**Acceptance Scenarios**:

1. **Given** no generation is active, **When** a user applies a changed global setting, **Then** the setting takes effect and the usual process-wide invalidation behavior occurs.
2. **Given** a generation is active in the caller's project, **When** the caller submits a changed global setting, **Then** the setting change cannot invalidate resources used by that admitted generation before its normal completion or cleanup.
3. **Given** a generation is active in another loaded project or directory, **When** a user submits a changed global setting, **Then** the same protection applies across projects.
4. **Given** a generation was started by a different tab, client, or CLI, **When** a user submits a changed global setting, **Then** the request waits under the same process-wide rule and reports success only after application completes.

---

### User Story 2 - Preserve every supported generation path (Priority: P1)

Users can run generations through either the existing v1 or V2 execution path, including both paths at once, without ordinary global configuration changes interrupting work that has already been admitted.

**Why this priority**: A guarantee that covers only one execution path would leave the same user-visible failure reachable through another.

**Independent Test**: Repeat the configuration-update scenario with one v1 generation, one V2 generation, and concurrent v1 plus V2 generations; confirm that every already-admitted generation reaches its own terminal or cleanup boundary without a configuration-induced interruption.

**Acceptance Scenarios**:

1. **Given** a v1 generation is active in the caller's project, **When** a global setting changes, **Then** that generation is not interrupted solely because of the change.
2. **Given** a v1 generation is active in another loaded project, **When** a global setting changes, **Then** that generation is protected as well.
3. **Given** a V2 generation is active, **When** a global setting changes, **Then** that generation is not interrupted solely because of the change.
4. **Given** v1 and V2 generations are active concurrently, **When** a global setting changes, **Then** neither is interrupted solely because of the change.

---

### User Story 3 - Resolve simultaneous starts and updates predictably (Priority: P1)

When generation starts and global configuration updates race, users receive outcomes consistent with one atomic, writer-fair ordering rule. A generation cannot slip into the unsafe interval between checking activity and applying the update, and new generations cannot indefinitely overtake a waiting update.

**Why this priority**: Without a shared ordering rule, even an accurate activity check can become stale before configuration is applied.

**Independent Test**: Use controlled concurrency tests to force generation admission before a configuration request, a configuration request before new admissions, and multiple config requests. Verify existing generations drain, waiting config requests apply in arrival/admission order, and queued generations are admitted only after the protected application sequence completes.

**Acceptance Scenarios**:

1. **Given** generation admission wins the race, **When** a changed configuration request arrives, **Then** it waits until all already-admitted generations reach their normal terminal/cleanup boundaries and cannot invalidate them.
2. **Given** a configuration update is waiting for exclusive application ownership, **When** new generations attempt to start, **Then** they queue behind the update and cannot indefinitely overtake it.
3. **Given** existing generations drain while configuration updates are waiting, **When** the coordination boundary is released, **Then** updates acquire exclusive ownership in arrival/admission order, and mutation plus required invalidation completes before queued generations may be admitted.
4. **Given** multiple changed global settings are submitted while generations remain active, **When** the requests are resolved, **Then** each request receives its own explicit outcome in deterministic arrival/admission order, with no coalescing, silent loss, or last-write-wins behavior.

---

### User Story 4 - Recover cleanly from completion and failures (Priority: P2)

Users can continue working when a generation finishes, fails, or is aborted independently while configuration requests wait, and receive explicit outcomes when validation, persistence, application, invalidation, cancellation, or shutdown affects a request.

**Why this priority**: Busy and failure paths must preserve both the safety guarantee and a truthful view of effective configuration.

**Independent Test**: Exercise normal generation completion, independent generation failure/abort, invalid configuration, failed persistence/application, failed instance invalidation, cancellation while waiting and after application begins, and server shutdown while requests wait. Verify explicit outcomes and a consistent effective configuration after each case.

**Acceptance Scenarios**:

1. **Given** a configuration request is waiting behind admitted generations, **When** those generations complete normally, **Then** the request acquires exclusive application ownership in writer-fair order and remains pending until application completes.
2. **Given** a configuration request is waiting behind admitted generations, **When** a generation independently fails or is aborted, **Then** that generation releases its shared execution ownership at its normal cleanup boundary and the request proceeds without misattributing the failure to the configuration change.
3. **Given** a global configuration update fails validation before waiting, **When** the request ends, **Then** it may fail immediately without entering the exclusive queue, provided it has not mutated effective configuration or lifecycle state.
4. **Given** persistence, application, or required instance invalidation fails after exclusive application begins, **When** the request ends, **Then** the caller receives an explicit failure and the system preserves or recovers a consistent effective configuration and instance lifecycle before releasing exclusive ownership for normal operation.
5. **Given** a client disconnects while its request is waiting, **When** application has not begun, **Then** the request may be removed from the waiting queue; once destructive application begins, disconnect does not interrupt that critical application sequence partway through.
6. **Given** the server shuts down while configuration requests are waiting, **When** the server stops, **Then** those HTTP requests fail through shutdown or connection loss, no durable queued-request recovery is required, and callers may retry after restart; a change that did not complete successful application is not considered accepted or effective.

### Edge Cases

- A submitted configuration serializes to the same value as the effective global configuration; it must not trigger unnecessary process-wide invalidation.
- A second or later update arrives while an earlier update is waiting or applying; updates are serialized in arrival/admission order at the same coordination boundary, are not coalesced, and each receives its own explicit success or failure.
- New generation admissions queue behind a waiting update so repeated arrivals cannot starve it; generations already admitted may finish normally.
- A generation independently fails or is explicitly cancelled while a configuration request is waiting; that terminal outcome must not be misattributed to the configuration change.
- A waiting request is cancelled before application starts; it may be removed from the queue. A client disconnect after destructive application begins cannot interrupt the protected application sequence.
- The server shuts down while requests are waiting; the requests fail by shutdown/connection loss, without durable recovery or a successful/effective outcome for an unapplied change.
- Required invalidation fails after configuration validation or persistence begins; the system must not report an ambiguous partial success and must restore consistency before releasing exclusive ownership.
- The existing explicit `/global/dispose` operation is an intentionally destructive, user-requested action and remains outside this feature's protection contract; this feature does not silently change that endpoint's semantics.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST enforce protection from ordinary global configuration changes through coordination shared by generation admission and configuration application across the whole server process.
- **FR-002**: The system MUST apply the same safety contract regardless of frontend state, event-stream delivery, client or tab, project directory, or configuration caller.
- **FR-003**: The system MUST include both v1 and V2 generation paths in the shared coordination contract, including concurrent executions through both paths.
- **FR-004**: The system MUST make generation admission and destructive configuration application mutually ordered as one atomic coordination boundary; a separate activity check followed by mutation is insufficient.
- **FR-005**: After a generation has been admitted, an ordinary global configuration change MUST NOT invalidate or dispose resources beneath it until it reaches its normal terminal and cleanup boundary.
- **FR-006**: Once destructive global configuration application has acquired the right to invalidate instances, a new generation MUST NOT cross its admission boundary until that application is complete.
- **FR-007**: When no generation is active, a changed global configuration MUST retain behavior compatible with the current update and required process-wide invalidation behavior.
- **FR-008**: A configuration update that does not change the serialized effective configuration MUST NOT trigger unnecessary destructive lifecycle work.
- **FR-009**: The feature MUST protect the full ordinary global configuration update hazard class rather than special-case the fallback model setting.
- **FR-010**: A changed ordinary `/global/config` request MUST remain pending as an HTTP request until it atomically acquires exclusive configuration-application ownership and completes application. It MUST NOT mutate effective global configuration before acquiring that ownership, and MUST NOT report success before the effective configuration and instance lifecycle are consistent. There is no separate durable pending-configuration state.
- **FR-011**: A failed or rejected update MUST NOT leave a partially mutated effective global configuration or a half-applied lifecycle transition.
- **FR-012**: After successful application, users MUST observe a consistent configuration and instance state, with no stale mixed state left exposed by the update.
- **FR-013**: Multiple changed configuration requests MUST be serialized deterministically in arrival/admission order at the same coordination boundary. Each request MUST receive its own explicit success or failure outcome; requests MUST NOT be coalesced, silently discarded, or resolved by implicit last-write-wins behavior.
- **FR-014**: When any generation is already admitted, a changed ordinary `/global/config` request MUST wait for exclusive configuration-application ownership while already-admitted v1 and V2 generations retain shared execution ownership through their normal terminal/cleanup boundaries. Ordering MUST be writer-fair: once an update is waiting, new generation admissions queue behind it; after existing generations drain, the update acquires exclusive ownership; configuration mutation and required process-wide invalidation complete before queued generations may be admitted. The HTTP request remains pending and reports success only after effective configuration and instance lifecycle are consistent. No durable pending-configuration state is created. A validation failure determinable before waiting MAY fail immediately if it cannot mutate effective configuration or lifecycle state. Once exclusive application begins, no generation may be admitted, and client disconnect or request cancellation MUST NOT interrupt the protected application sequence partway through. Persistence, application, or invalidation failure MUST produce an explicit failure and preserve or recover a consistent effective state before normal operation resumes. Server shutdown fails waiting requests through shutdown or connection loss; queued requests need no durable recovery and callers may retry after restart. An unapplied change is not considered accepted or effective.
- **FR-015**: Failures during validation, writing, application, or required instance invalidation MUST have an explicit caller-visible outcome and a defined recovery path that preserves a consistent effective configuration before another update is reported successful. Validation failures determinable before waiting MAY fail immediately if they cause no effective configuration or lifecycle mutation.
- **FR-016**: The existing explicit `/global/dispose` endpoint MUST remain an intentionally destructive, user-requested operation outside this feature's generation-protection guarantee unless its behavior is separately specified for change.

### Key Entities

- **Generation**: A unit of v1 or V2 work admitted by the server and owned until its terminal and cleanup boundary.
- **Global configuration update**: A user's requested change to process-wide configuration, which may be rejected, waiting, pending, or effective according to the selected behavior.
- **Effective configuration**: The single consistent configuration state currently used by active server services and loaded instances.
- **Instance invalidation**: The process-wide lifecycle work required after a changed global configuration becomes effective.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: There are zero interruptions caused solely by an ordinary global configuration change among already-admitted generations in all protected concurrency cases.
- **SC-002**: There are zero generation admissions during an in-progress destructive configuration application.
- **SC-003**: One hundred percent of changed configuration requests remain pending until successful application or return an explicit failure; no unapplied change is reported successful, and none silently disappear.
- **SC-004**: Verification covers generations in the same project, another loaded project, another client, v1, V2, and concurrent v1 plus V2 execution.
- **SC-005**: A deterministic regression scenario that reproduces the historical configuration-update race against the previous behavior passes under the specified behavior.
- **SC-006**: An idle changed global configuration continues to produce the established successful update and required process-wide invalidation outcome.
- **SC-007**: No correctness outcome depends on frontend `session_status`, event-stream delivery, frontend caches, or one client's view of active work.
- **SC-008**: Simultaneous starts and updates tested in both orderings have deterministic results; once an update waits for exclusive ownership, new admissions cannot indefinitely overtake it, and no generation passes the configuration application boundary unsafely.
- **SC-009**: Multiple waiting configuration updates apply in arrival/admission order with one explicit outcome per request, and queued generations are admitted only after each protected mutation and required invalidation sequence completes.
- **SC-010**: Cancellation before application may remove a waiting request; disconnect after destructive application begins does not interrupt the sequence. Shutdown fails waiting requests without durable recovery or treating unapplied changes as accepted/effective.

## Assumptions

- Ordinary global configuration updates are process-wide and can require invalidation of every loaded instance.
- A generation's admission and normal terminal/cleanup boundaries are meaningful for both existing v1 and V2 execution paths.
- The server process is the coordination scope for this feature; coordination across separate server processes is not required unless those processes share execution and configuration state.
- The current fallback-model client guard may remain as a user-experience optimization, but it is not evidence of or a dependency for the safety guarantee.
- Changed ordinary `/global/config` requests wait for exclusive application ownership when generations are admitted; the server provides writer-fair ordering between waiting updates and new generation admissions.
- Queued configuration requests are in-memory request coordination only. Shutdown may fail them, and callers may retry after restart.
- The existing `/global/dispose` endpoint remains intentionally destructive and outside the guarantee defined here.

## Out of Scope

- Redesigning the complete configuration subsystem or the generation coordinator.
- Making frontend status authoritative, adding polling, or hiding interruption errors.
- Special-casing fallback configuration writes in the backend.
- Preventing explicit user-requested session cancellation.
- Guaranteeing graceful behavior for `/global/dispose` or coordinating separate server processes that do not share state.
- Cleaning up tests for the separate fallback-selector guard.

## Testing Requirements

The feature MUST be validated by backend-level concurrency tests; frontend-only or mocked frontend tests cannot establish the safety invariant. Coverage MUST demonstrate:

- an active v1 generation and an active V2 generation are not interrupted by configuration-induced disposal;
- execution in another project and execution started by another client are protected;
- v1 and V2 can be active concurrently without either being interrupted by configuration application;
- generation-start/config-update races are forced in both orderings, with no check-then-act gap;
- multiple starts while a configuration update is waiting queue behind it, so new admissions cannot indefinitely overtake the update;
- multiple writes while execution remains active apply in arrival/admission order, do not coalesce, and have an explicit outcome per request;
- normal completion and independent failure or abort release or resolve blocked configuration work correctly;
- pre-wait validation failure may fail immediately only without mutation; persistence, application, invalidation, and shutdown failures have explicit, consistent outcomes, and shutdown requires no durable waiting-request recovery;
- cancellation may remove a request before application begins, while disconnect after destructive application begins cannot interrupt the protected sequence;
- the effective configuration has no mixed or stale state after successful application;
- an idle update remains compatible and process-wide invalidation still occurs when safe and required;
- a no-op serialized configuration change does not cause unnecessary invalidation.

Frontend tests MAY verify messaging and user experience, but MUST NOT be treated as evidence of the safety invariant.

## Clarifications

### Session 2026-09-28

- Q: What should `/global/config` do when a generation is already active? → A: Wait for exclusive application ownership with writer-fair ordering; serialize each request in arrival/admission order and return success only after consistent application.
