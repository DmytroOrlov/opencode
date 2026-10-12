# Tasks: Splash Adaptive SSE Timeout

**Input**: Design documents from `/specs/007-splash-adaptive-sse-timeout/`

**Prerequisites**: `plan.md`, `spec.md`, `data-model.md`, `contracts/provider-options.md`, and `quickstart.md`

**Tests**: Deterministic test work is required by FR-011 and the plan. Hardware-dependent full-context and post-compaction validations are separate gates for default promotion only; they do not gate opt-in implementation.

**Organization**: Tasks are grouped by the three P1 user stories in `spec.md`. Because all production behavior is owned by the same provider transport file, implementation tasks in that file are ordered and are not marked parallel.

## Phase 1: Setup

**Purpose**: Prepare the focused provider timeout validation scope.

- [X] T001 Confirm the feature implementation and validation scope against `specs/007-splash-adaptive-sse-timeout/plan.md` and `specs/007-splash-adaptive-sse-timeout/quickstart.md`; keep production changes within the three files named by the plan

---

## Phase 2: Foundational

**Purpose**: No separate infrastructure is required; the existing timeout owner and focused test harness are reused. The option must remain disabled by default throughout implementation and validation.

---

## Phase 3: User Story 1 - Complete healthy local Splash generations (Priority: P1)

**Goal**: Opted-in eligible local Splash SSE requests adapt future per-read deadlines to observed successful read cadence while retaining the conservative timeout until calibration is ready.

**Independent Test**: A deterministic stream establishes five qualifying waits and resumes after a gap shorter than the derived timeout; verify successful completion, exact threshold arithmetic and unchanged deadline for any already pending read.

### Tests for User Story 1

- [X] T002 [US1] Add deterministic calibration and read-deadline cases in `packages/opencode/test/provider/header-timeout.test.ts` for empty state, the 100 ms boundary, nonempty successful reads, the rolling five-sample window, longest-sample exclusion, ×10 calculation, 30-second floor, provider-timeout ceiling, changing cadence, and future-reads-only threshold updates

### Implementation for User Story 1

- [X] T003 [US1] Implement request-local rolling calibration and per-read deadline selection in `packages/opencode/src/provider/provider.ts`, retaining the existing provider timeout before five qualifying samples and applying recalculated thresholds only to reads that start afterward
- [X] T004 [US1] Add bounded request-level calibration and terminal outcome diagnostics in `packages/opencode/src/provider/provider.ts`, with no per-chunk log events and logger failures isolated from stream behavior

**Checkpoint**: Deterministic tests establish correct healthy-stream adaptation and bounded diagnostics with no total-generation timeout.

---

## Phase 4: User Story 2 - Stop genuinely stalled streams (Priority: P1)

**Goal**: Adaptation preserves established timeout failure, cancellation, retry, fallback, compaction isolation, and tool replay safety behavior.

**Independent Test**: Deterministic transport streams verify a stall expires at its selected per-read deadline and that a separately started SSE request has empty calibration. T007 and T008 retain the real-runtime recovery and post-compaction validation requirements.

### Tests for User Story 2

- [X] T005 [US2] Add deterministic transport lifecycle cases in `packages/opencode/test/provider/header-timeout.test.ts` for stalled reads, cancellation/abort cleanup, long healthy generations with repeated progress, two separate SSE generations with independent calibration, and bounded terminal diagnostics

> T005 verifies separate SSE generations in a controlled transport harness; it does not exercise an automatic session-processor retry or tool replay. The existing session-processor silent-stream fallback regression uses `chunkTimeout: 50`, so it covers fixed-timeout recovery only. T007 and T008 retain real-runtime validation of adaptive-enabled recovery and tool replay safety.

### Implementation for User Story 2

- [X] T006 [US2] Preserve existing timeout error, cancellation, retry and fallback behavior while integrating adaptive deadlines in `packages/opencode/src/provider/provider.ts`; ensure every wrapped SSE response discards calibration on completion, error, timeout, cancellation, retry request creation, and compaction request creation
- [ ] T007 [US2] Perform and record the real near-ceiling model-context full-request validation in `specs/007-splash-adaptive-sse-timeout/quickstart.md`, covering local Splash opt-in, extended healthy progress, stall handling, cancellation, retry/fallback, and tool replay safety; keep the option default disabled
- [ ] T008 [US2] Perform and record a separate real post-compaction validation in `specs/007-splash-adaptive-sse-timeout/quickstart.md`, proving compaction and subsequent generation each begin with empty calibration and preserve cancellation, retry/fallback, and tool replay safety; keep the option default disabled

> Runtime evidence status: T007 remains incomplete because the completed request used 10,732 input tokens, far below the 262,144-token ceiling, and the subsequent near-ceiling attempt timed out without SSE output, usage, or a terminal transport summary. T008 was not executed; no genuine compaction evidence exists. T013 is complete.

**Checkpoint**: Both real-context validation gates have independently recorded passing evidence before any proposal to change the disabled default.

---

## Phase 5: User Story 3 - Keep existing timeout controls and other providers stable (Priority: P1)

**Goal**: Adaptive behavior requires explicit local Splash opt-in and an eligible resolved loopback HTTP(S) endpoint, while existing timeout precedence and SDK cache separation remain intact.

**Independent Test**: Verify the default remains disabled; only explicit opt-in with the dispatch-resolved loopback HTTP(S) endpoint enables adaptation; numeric and `false` chunk timeout overrides, header/request timeouts, other providers, and SDK option/cache behavior retain their contract.

### Tests for User Story 3

- [X] T009 [US3] Add deterministic compatibility and boundary cases in `packages/opencode/test/provider/header-timeout.test.ts` for disabled-by-default behavior, explicit opt-in, HTTP and HTTPS loopback eligibility, remote/non-loopback rejection, explicit numeric and false `chunkTimeout`, existing header/request timeout precedence, and SDK option stripping/cache-key separation

### Implementation for User Story 3

- [X] T010 [P] [US3] Verify no-op for `splashAdaptiveSseTimeout` in `packages/core/src/v1/config/provider.ts`; the existing open provider-options schema accepts the option, so no schema edit is needed
- [X] T011 [US3] Gate adaptive transport behavior on explicit opt-in, the dispatch-resolved HTTP(S) loopback endpoint, and unspecified `chunkTimeout` in `packages/opencode/src/provider/provider.ts`; preserve numeric/false overrides and existing header/request timeout semantics
- [X] T012 [US3] Strip `splashAdaptiveSseTimeout` from SDK constructor options while retaining it in SDK cache-key identity in `packages/opencode/src/provider/provider.ts`; do not add the option to SDK or wire request arguments

> T011 is complete: adaptive calibration is gated by explicit opt-in, a dispatch-resolved loopback HTTP(S) endpoint, and an unspecified `chunkTimeout`.

**Checkpoint**: Compatibility tests prove behavior remains opt-in, scoped to eligible local Splash requests, and separate in the SDK cache.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Confirm opt-in implementation readiness and preserve the independent default-promotion gates.

- [X] T013 Review `specs/007-splash-adaptive-sse-timeout/quickstart.md` against implemented deterministic coverage and the recorded outcomes of both independent promotion gates; run `bun run --cwd packages/opencode typecheck` successfully and confirm opt-in implementation readiness while keeping the adaptive default disabled until T007 and T008 both pass

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 can proceed immediately.
- **Foundational (Phase 2)**: No implementation task; existing provider transport and test infrastructure are reused.
- **User Stories (Phase 3+)**: Start after T001. The three stories share `provider.ts`, so implementation is sequenced as listed even though their acceptance criteria are separately testable. The US2 validations (T007, T008) run only after T009, T011 and T012 are completed.
- **Polish (Phase 6)**: T013 follows deterministic work and reviews the recorded outcome of each validation gate; either gate may remain outstanding without blocking opt-in implementation completion.

### User Story Dependencies

- **User Story 1 (P1)**: Starts after T001; establishes calibration and per-read deadline behavior.
- **User Story 2 (P1)**: Depends on US1's deadline lifecycle; deterministic lifecycle tests precede the recovery integration. T007 and T008 depend on completed T009, T011 and T012 (not merely T006) and gate default promotion, not opt-in implementation.
- **User Story 3 (P1)**: Depends on the transport behavior from US1/US2 for end-to-end compatibility; option/schema work and its tests verify eligibility, precedence, and cache handling.

### Within Each User Story

- Deterministic tests identify the required behavior before implementation.
- Same-file provider transport tasks remain sequential to avoid conflicting edits.
- Intermediate implementation must not enable adaptive behavior before eligibility gating (T009, T011, T012) is complete.
- Hardware-dependent validations are not substitutes for deterministic tests; they must pass separately before default promotion and never gate the opt-in implementation itself.

### Parallel Opportunities

- T001 is independent setup work.
- After US1's transport implementation, US2 lifecycle test preparation and US3 provider-option schema work can be performed in parallel by separate contributors, provided edits to `provider.ts` remain serialized.
- The real near-ceiling full-context and post-compaction validations are separate runs and may be performed independently after eligibility gating (T009, T011, T012) is complete.
- T013 is complete after its documented package typecheck succeeds; T007 and T008 remain independent gates that must both pass before default promotion.

---

## Parallel Example: Independent validation gates

```text
After completed T009, T011 and T012 (not merely T006):
Task: T007 Real near-ceiling model-context full-request validation
Task: T008 Separate post-compaction validation
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Complete T001.
2. Complete deterministic calibration and read-deadline coverage (T002).
3. Implement and verify request-local adaptive reads and bounded diagnostics (T003-T004).
4. Keep the feature explicitly opt-in; do not promote the default based on deterministic results alone.

### Incremental Delivery

1. Complete US1 to deliver deterministic, opt-in adaptation for healthy local Splash streams.
2. Complete US2 deterministic coverage and implementation to preserve stalled-stream recovery and request lifecycle semantics. T007 and T008 remain separate real-runtime gates for default promotion only.
3. Complete US3 to lock down explicit eligibility, timeout precedence, and SDK cache isolation; keep adaptive behavior disabled until this gating is in place.
4. Complete T013 by reviewing deterministic coverage and honestly recording both real-runtime gate outcomes. T007 and T008 remain independently required; default stays disabled unless both pass and a later change explicitly promotes it.

## Notes

- [P] marks tasks that can proceed independently without editing the same file or depending on unfinished work.
- Story labels map directly to the three user stories in `specs/007-splash-adaptive-sse-timeout/spec.md`.
- Automated deterministic tests use the planned focused provider timeout suite; no tests are run as part of task generation.
- Near-ceiling model-context and post-compaction checks require real model/runtime validation and are distinct from automated deterministic tests.
