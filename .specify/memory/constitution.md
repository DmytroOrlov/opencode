<!--
Sync Impact Report
- Version change: 1.0.0 -> 2.0.0
- Modified principles: the former general compatibility, ownership, validation, and simplicity
  requirements are retained where applicable in Scope and Change Constraints, Development
  Workflow and Quality Gates, and Governance.
- Added principles: I. Upstream- and Protocol-First Reuse; II. Additive Provider Support and
  Regression Compatibility; III. One Attempt-Scoped Telemetry Lifecycle; IV. Correct
  Attribution Over Metric Availability; V. Authoritative Data and Provenance; VI. Telemetry Is
  Observational and Must Never Break Generation; VII. Preserve the Dispatch Source of Truth;
  VIII. Streaming Before Polling; IX. Tests Define Telemetry Semantics; X. Minimal,
  Evidence-Driven Change; XI. Performance and UI Stability; XII. Constitution Governance.
- Removed principles: the composer- and persistence-specific I. Preserve Existing User-Visible
  Behavior; II. Minimal Ownership Model; III. Authoritative State Mutation; IV. Ordered Async
  Persistence; V. Defer Incidental Preference Effects; VI. Shared Composer Mutation Authority;
  VII. Bounded Change Scope; VIII. Authoritative Validation; IX. Reachable Review Findings;
  X. Simplify Accidental Complexity. Applicable general requirements were retained in the
  supporting sections below; composer-specific policy is outside this telemetry charter.
- Added sections: Scope and Change Constraints; Development Workflow and Quality Gates.
- Removed sections: None.
- Follow-up TODOs: TODO(RATIFICATION_DATE) records that the original adoption date is unknown.
-->

# OpenCode Constitution

## Core Principles

### I. Upstream- and Protocol-First Reuse

Before adding custom infrastructure, a change MUST inspect the target OpenCode checkout, the
provider SDK or protocol, and the inference backend for capabilities that already provide the
required semantics. Provider-native request-scoped data MUST be preferred over reconstructed,
polled, inferred, or duplicated data. Standard OpenAI, Anthropic, and AI-SDK mechanisms MUST be
preferred over provider-specific plumbing when they preserve those semantics. For provider
extensions, the proposal MUST document what the backend exposes and what OpenCode preserves through
its request and stream abstractions; custom code is permitted only for the remaining gap. A change
MUST NOT reimplement an upstream capability solely for a more convenient internal shape.

### II. Additive Provider Support and Regression Compatibility

Existing working provider integrations are regression contracts. Adding telemetry support for a
provider MUST NOT replace, weaken, or silently alter existing MLX telemetry, generic fallback
telemetry, provider dispatch, model behavior, or UI semantics. The `mlxTelemetry: true`
configuration MUST remain supported unless a separately specified migration provides a
backward-compatible path. Provider-specific telemetry MUST coexist as peer adapters behind shared
attempt and session semantics. A new provider MUST NOT be used to justify rewriting a proven
provider implementation.

### III. One Attempt-Scoped Telemetry Lifecycle

Generation telemetry belongs to a concrete OpenCode generation attempt and its AssistantMessage.
Every provider source MUST use the existing attempt lifecycle and normalized `session.telemetry`
path; it MUST NOT establish a parallel store, event type, or UI pipeline. Attempt registration,
reset, retry, abort, finalize, discard, stale-attempt suppression, and terminal state MUST have
deterministic ownership. A retry for the same AssistantMessage MUST supersede telemetry from the
prior attempt, and telemetry from one request MUST NOT be attributed to another. Shared abstractions
MUST be extracted only when at least two real implementations require them.

### IV. Correct Attribution Over Metric Availability

A metric MUST NOT be presented as request-scoped unless its ownership of that request is provable.
Process-wide, batch-wide, scheduler-wide, and other aggregate metrics MUST remain explicitly
aggregate. When concurrent activity makes attribution ambiguous, implementations MUST omit the
metric or label it as aggregate instead of assigning it to a generation. Request-local provider
telemetry MUST take priority over aggregate telemetry. Aggregate counters MAY become attempt-local
deltas only when isolation and attribution are demonstrably valid and covered by tests. Unavailable
measurements MUST NOT be represented as zero.

### V. Authoritative Data and Provenance

Measurements MUST be sourced from the component that owns the measured interval whenever available.
Provider-native exact measurements MUST take precedence over OpenCode-local estimates for the same
semantic quantity. Generic OpenCode telemetry MUST remain the fallback when authoritative provider
data is absent or unusable. Normalized metrics whose meaning can differ by source MUST retain enough
provenance or semantics to distinguish provider-native values from approximate or client-observed
values. Approximate values MUST remain visibly distinguishable from exact values. Counters with
incompatible timing boundaries MUST NOT be combined solely because they use the same unit.

### VI. Telemetry Is Observational and Must Never Break Generation

Generation MUST NOT depend on telemetry. Connection failures, malformed telemetry, unsupported
backend versions, timeouts, polling failures, missing stream metadata, and parser failures MUST
degrade to another valid source or no telemetry without failing or delaying the model request.
Telemetry teardown MUST respect abort and stream lifecycle. Watchers, timers, subscriptions,
pending attempts, replay or tombstone sets, and similar state MUST be bounded and cleaned up.
OpenCode-owned telemetry controls MUST NOT leak into third-party SDK constructor options or wire
requests unless that provider explicitly defines them.

### VII. Preserve the Dispatch Source of Truth

Any provider-side telemetry connection MUST derive its endpoint and authentication from the same
effective provider configuration used for model dispatch. Implementations MUST NOT guess localhost
ports, independently reconstruct endpoint precedence, or duplicate environment and configuration
resolution. Existing effective endpoints and request transports MUST be reused when OpenCode exposes
them.

### VIII. Streaming Before Polling

Live per-request telemetry MUST use metadata carried by the generation stream or an existing
provider event stream when available. Polling is permitted only for information with no
request-scoped streaming source. Polling MUST be bounded, cancellable, and low-overhead, and MUST NOT
present aggregate state as request-local state. A change MUST NOT add polling for data already
provided as equivalent request-local progress or final timing by the provider.

### IX. Tests Define Telemetry Semantics

Every provider telemetry integration MUST have deterministic tests for its parser or adapter and
lifecycle. Changes to telemetry arbitration MUST retain coverage for provider and generic fallback
coexistence; retries using the same AssistantMessage; abort and failed setup; stale terminal reset;
short generations without authoritative rates; concurrent requests and ambiguous attribution;
malformed or unavailable provider data; resource cleanup; and prevention of provider control
options leaking into SDK configuration. Splash support MUST include regression coverage proving
existing MLX behavior still works. Tests SHOULD use protocol-faithful fake servers or streams rather
than require a GPU or live backend. Real-backend smoke tests MAY supplement, but MUST NOT replace,
deterministic tests.

### X. Minimal, Evidence-Driven Change

Implementation planning MUST inspect the exact target checkout. Research decisions MUST cite
concrete existing code or upstream protocol/backend behavior. When the repository already provides a
suitable lifecycle, event, store, UI, endpoint-resolution, or fallback abstraction, changes MUST
extend it instead of duplicating it. Feature plans MUST identify: existing code reused unchanged;
existing code needing the smallest generalization; genuinely new provider-specific code; and
functionality omitted because attribution or source semantics are insufficient. Changes MUST stay
within the active specification and directly necessary dependencies; unrelated broad refactors MUST
be deferred.

### XI. Performance and UI Stability

Telemetry work MUST stay off the generation critical path as far as practical. Live updates MUST be
throttled or coalesced to a bounded rate and MUST NOT cause token-by-token UI or store churn. The
normalized UI path MUST remain the presentation contract. Provider support SHOULD enrich that path;
provider-specific UI is permitted only when a metric has semantics that cannot be represented
honestly in the shared model.

### XII. Constitution Governance

These principles are mandatory gates for specification, planning, task generation, implementation,
review, and convergence. A plan that duplicates an available upstream or backend capability,
weakens attribution guarantees, breaks existing MLX telemetry, or makes telemetry capable of
failing generation MUST be rejected or redesigned before implementation. This constitution MUST
be amended only when an intentional project-wide architectural policy changes, not to make a single
feature easier to implement.

## Scope and Change Constraints

- The active specification defines intentional behavior changes and takes precedence over default
  compatibility only for behavior it explicitly covers; it does not silently waive these principles.
- Changes MUST identify the ownership boundary, affected user-visible behavior, provider and
  fallback semantics, and validation coverage when those concerns apply.
- Work outside the active specification MUST be deferred unless necessary to preserve correctness.
- Existing implementation evidence includes the attempt lifecycle in
  `packages/opencode/src/session/llm/attempt-telemetry.ts`, provider and fallback adapters in
  `packages/opencode/src/session/llm/mlx-telemetry.ts` and
  `packages/opencode/src/session/llm/fallback-telemetry.ts`, and lifecycle regression coverage in
  `packages/opencode/test/session/mlx-telemetry.test.ts`. These are repository examples to inspect,
  not permission to assume future APIs or preserve implementation details that an approved
  project-wide policy change explicitly replaces.

## Development Workflow and Quality Gates

- Before implementation, contributors MUST document upstream, protocol, backend, and checkout
  capabilities relevant to the change, then identify the existing attempt owner and request-scoped
  data flow.
- Feature plans MUST explain reused code, the smallest required generalization, new provider code,
  and data deliberately omitted for insufficient attribution, as required by Principle X.
- During review, contributors MUST assess attribution, stale async results, duplicate mutation or
  event paths, provider option leakage, resource cleanup, performance, UI stability, and scope when
  relevant.
- New or changed behavior MUST add or update focused deterministic validation when existing checks
  do not cover the contract. Completion MUST record applicable checks that could not be run and why.
- Review findings MUST identify a reachable correctness, data-loss, duplicate-execution, security,
  performance, or contract violation; speculative architecture preferences alone do not establish a
  violation.
- Accidental complexity SHOULD be simplified before adding a compensating layer. Any retained
  layer MUST have a documented, reachable correctness or contract purpose.

## Governance

This constitution governs specification, planning, task generation, implementation, review, and
validation decisions in OpenCode. Amendments MUST be proposed as documented changes to this file
and MUST state their rationale, affected principles or sections, compatibility impact, and validation
implications. Approval requires review by the project maintainers or equivalent repository
authority. An amendment MUST NOT be made solely to ease one feature implementation.

Constitution versions follow semantic versioning: MAJOR for backward-incompatible governance
removals or redefinitions; MINOR for a new principle or materially expanded requirement; PATCH for
clarifications, wording fixes, and other non-semantic refinements. Every amendment MUST update the
version and last-amended date and retain a Sync Impact Report at the top of this file.

Every feature proposal, implementation review, and convergence review MUST assess applicable
principles. A conflict MUST be resolved before completion or documented as a specific
maintainer-approved exception with its risk. This constitution is the authoritative record of these
governance requirements.

**Version**: 2.0.0 | **Ratified**: TODO(RATIFICATION_DATE): original adoption date is not recorded | **Last Amended**: 2026-09-28
