<!--
Sync Impact Report
- Version change: 2.0.0 -> 2.1.0
- Bump rationale: MINOR. The charter is broadened from a telemetry-specific constitution into
  a project-wide OpenCode V2 engineering constitution. No prior normative telemetry guarantee
  is removed or weakened; each is retained and re-scoped as a mandatory domain requirement, so
  the change is backward compatible and is not MAJOR. The added universal principles and the
  new domain section are additive, which is MINOR under this constitution's versioning policy.
- Modified principles (old -> new):
  - I. Upstream- and Protocol-First Reuse -> II. Upstream- and Architecture-First Reuse (generalized
    beyond provider and protocol reuse to every subsystem).
  - II. Additive Provider Support and Regression Compatibility -> XVII. Provider Compatibility and
    Additive Telemetry Support (moved to the telemetry domain section; obligations unchanged).
  - III. One Attempt-Scoped Telemetry Lifecycle -> XIII. Attempt-Scoped Telemetry Lifecycle (moved;
    obligations unchanged).
  - IV. Correct Attribution Over Metric Availability -> XIV. Correct Attribution Over Metric
    Availability (moved; obligations unchanged).
  - V. Authoritative Data and Provenance -> XV. Provider-Native Provenance and Metric Arbitration
    (moved) plus the new universal VI. Data Honesty and Provenance.
  - VI. Telemetry Is Observational and Must Never Break Generation -> XVI. Telemetry Is Observational
    and Must Never Break Generation (moved; obligations unchanged).
  - VII. Preserve the Dispatch Source of Truth -> folded into XVII. Provider Compatibility and
    Additive Telemetry Support for provider-side resolution, and III. One Authoritative Owner for
    Each Mutation and Persistence Operation as the project-wide generalization.
  - VIII. Streaming Before Polling -> XVIII. Streaming Before Polling (moved; obligations unchanged).
  - IX. Tests Define Telemetry Semantics -> XX. Telemetry-Specific Regression Coverage (moved) plus
    the new universal VIII. Deterministic Tests for Changed Behavior.
  - X. Minimal, Evidence-Driven Change -> split into II. Upstream- and Architecture-First Reuse,
    VII. Bounded Change Scope, and X. Evidence-Driven Change.
  - XI. Performance and UI Stability -> XIX. Telemetry Presentation Stability and Bounded Overhead
    (moved) plus the new universal XI. Accessibility, Responsiveness and UI Stability.
  - XII. Constitution Governance -> XII. Constitution Governance (re-scoped from the telemetry charter
    to project-wide review; the rejection criteria are generalized, not relaxed).
- Added principles: I. Preserve Existing User-Visible Behavior (restored from the 1.0.0 charter as
  a universal requirement); III. One Authoritative Owner for Each Mutation and Persistence Operation;
  IV. Ordered Asynchronous Updates and Stale-Result Suppression; V. Domain Invariants Across Subsystem
  Boundaries; VI. Data Honesty and Provenance; IX. Preservation of Existing Test Assertions; and
  XI. Accessibility, Responsiveness and UI Stability in universal form.
- Removed principles: none. All twelve 2.0.0 principles are either generalized into the universal
  list or retained in the telemetry domain section with their obligations intact.
- Added sections: Domain-Specific Requirements: Telemetry, which separates domain requirements from
  universal engineering principles without relaxing either set.
- Removed sections: none.
- Removed content: obsolete references to the pre-migration layout
  (`packages/opencode/src/session/llm/attempt-telemetry.ts`,
  `packages/opencode/src/session/llm/mlx-telemetry.ts`,
  `packages/opencode/src/session/llm/fallback-telemetry.ts`, and
  `packages/opencode/test/session/mlx-telemetry.test.ts`), which do not exist in this checkout.
  They are replaced only with paths verified to exist in the current checkout.
- Feature-specific UX kept out of governance: composer model swapping, variant placement, and fallback
  picker behavior are explicitly excluded and remain the responsibility of their feature specification.
- Follow-up TODOs: TODO(RATIFICATION_DATE) records that the original adoption date is not recorded;
  the historical placeholder is preserved rather than inventing a date.
-->

# OpenCode Constitution

## Core Principles

These principles apply to every OpenCode subsystem: UI, session, provider, configuration,
storage, tools, and infrastructure. The domain-specific requirements later in this file are
additional obligations and are not a relaxation of these principles.

### I. Preserve Existing User-Visible Behavior

Existing working behavior is a regression contract. A change MUST NOT alter, weaken, remove,
or silently redefine behavior that users, configured providers, stored sessions, or existing
clients already depend on, unless the active specification explicitly changes that behavior.
Where the active specification is silent, current observable behavior MUST be preserved.
Existing configuration keys and settings MUST remain supported unless a separately specified
migration provides a backward-compatible path and updates the affected schema, generated
clients, and documentation. A change MUST NOT claim compatibility by relying on an
unrequested rewrite of a working subsystem.

### II. Upstream- and Architecture-First Reuse

Before adding custom infrastructure, a change MUST inspect the current checkout, the
relevant upstream protocol or SDK, and the existing OpenCode abstraction that already covers
the concern. Current upstream APIs and existing architecture MUST be preferred over parallel
implementations, reconstructed state, polling, or duplicated event and store paths. A
capability MUST NOT be reimplemented locally solely to obtain a more convenient internal
shape. A shared abstraction MUST be extracted only when at least two real implementations
require it. A proposal MUST state what upstream and the checkout already provide and what
remains as the genuine gap; new code is permitted only for that gap.

### III. One Authoritative Owner for Each Mutation and Persistence Operation

Every state mutation, persistence write, and event publication MUST have exactly one
authoritative owner. Authority MUST NOT be duplicated across call sites, adapters, or UI
layers, and no second store, cache, or event type may hold the same authority. Derived
copies MUST be produced from the same effective configuration, endpoint, or request path the
primary operation uses rather than reconstructed independently. An implementation MUST NOT
introduce a competing source of truth for session, provider, configuration, or storage
state.

### IV. Ordered Asynchronous Updates and Stale-Result Suppression

Dependent asynchronous updates MUST be serialized so their effects land in the order the
operations were initiated. A result from a superseded attempt, aborted request, replaced
selection, or stale read MUST NOT overwrite newer intent. Registration, reset, retry, abort,
finalize, discard, stale-result suppression, and terminal state MUST have deterministic
ownership. A retry of the same logical entity MUST supersede results from the prior attempt,
and results from one request MUST NOT be attributed to another. Publication and observation
paths MUST be cancellable and bounded.

### V. Domain Invariants Across Subsystem Boundaries

Invariants MUST hold across UI, session, provider, configuration, and storage boundaries. A
value MUST be validated or normalized once, at its authoritative owner, and MUST remain
representable at every later boundary without a competing representation. Schema
declarations, resolution logic, generated clients, and rendering MUST agree on the same
semantics for a field. OpenCode-owned settings MUST be resolved by the owner whose dispatch
path consumes them, and MUST be removed before options reach a third-party package or a wire
request unless that provider explicitly defines them.

### VI. Data Honesty and Provenance

Derived or approximate values MUST remain distinguishable from authoritative ones.
Unavailable, failed, or unmeasured values MUST NOT be represented as zero, as a default, or
as an exact measurement. When the same semantic quantity can come from an authoritative
source and an estimate, the authoritative source MUST take precedence, and estimates MUST
retain provenance sufficient to identify them as estimated. Counters with incompatible
boundaries or semantics MUST NOT be combined solely because they share a unit.

### VII. Bounded Change Scope

Changes MUST stay within the active specification and its directly necessary dependencies.
Unrelated broad refactors, opportunistic rewrites, and speculative infrastructure MUST be
deferred. A plan MUST name the ownership boundary it touches, the affected user-visible
behavior, and the validation coverage it expects. The smallest sufficient generalization of
existing code MUST be preferred over introducing a new mechanism.

### VIII. Deterministic Tests for Changed Behavior

New or changed behavior MUST be covered by deterministic tests for the primary path, the
relevant edge cases, failure and abort handling, and regression of previously working
behavior. Tests MUST NOT rely on live services, real latency, wall-clock sleeps, unbounded
timers, or network access as the primary means of establishing behavior; protocol-faithful
fakes, injected clocks, and fake streams SHOULD be used. Real service smoke tests MAY
supplement and MUST NOT replace deterministic coverage. A test that cannot fail
deterministically MUST NOT be counted as coverage.

### IX. Preservation of Existing Test Assertions

Existing assertions are regression contracts. A change MUST NOT delete, weaken, skip,
disable, or silently rewrite an existing assertion to accommodate new behavior. Where the
active specification explicitly changes the covered behavior, the affected assertions MUST
be updated deliberately and reviewed as part of that specified change. Passing fewer tests,
reduced coverage, or a green run obtained by relaxing checks is not acceptable. For
unaffected behavior, assertion count and strength MUST be equal or greater after the change.

### X. Evidence-Driven Change

Refactoring, new abstraction, or new infrastructure MUST be justified by evidence of a
reachable defect: an added failing test that then passes, a cited concrete code path, or a
demonstrated correctness, data-loss, duplicate-execution, security, performance, or contract
violation. Speculative architecture preference alone MUST NOT establish a violation or
authorize a rewrite.

### XI. Accessibility, Responsiveness and UI Stability

Where a change touches presentation, existing keyboard accessibility, focus handling, and
input affordances MUST remain functional, and new interactive surfaces MUST be reachable by
keyboard and appear in a sensible focus order. Layout MUST remain stable across responsive,
narrow, resized, and RTL or LTR viewports without clipping, overlapping, or shifting
controls. Live-updating surfaces MUST be throttled or coalesced to a bounded rate and MUST
NOT cause per-token or per-frame churn that destabilizes text, scroll position, or control
placement. Directional affordances MUST follow the resolved reading direction.

### XII. Constitution Governance

These principles are mandatory gates for specification, planning, task generation,
implementation, review, and convergence across every OpenCode subsystem. A plan that
duplicates an available upstream capability, splits authority over a mutation or persistence
operation, allows a stale result to overwrite newer intent, weakens existing test
assertions, or makes observational machinery capable of failing user-facing work MUST be
rejected or redesigned before implementation. This constitution MUST be amended only when an
intentional project-wide engineering policy changes, never to make a single feature easier
to implement and never to encode a feature-specific product decision.

## Domain-Specific Requirements: Telemetry

These requirements are the retained normative core of the previous telemetry charter. They
are additional domain obligations, not general preferences, and MUST be satisfied in full by
any change that touches generation telemetry, provider telemetry adapters, telemetry
publication or persistence, or telemetry presentation. They bind to changes in other
subsystems only where that change can affect these guarantees.

### XIII. Attempt-Scoped Telemetry Lifecycle

Generation telemetry belongs to a concrete generation attempt and its AssistantMessage.
Every provider source MUST use the existing attempt lifecycle and the normalized session
telemetry event path; it MUST NOT establish a parallel store, event type, or UI pipeline.
Attempt registration, reset, retry, abort, finalize, discard, stale-attempt suppression, and
terminal state MUST have deterministic ownership in the attempt owner. A retry for the same
AssistantMessage MUST supersede telemetry from the prior attempt, and telemetry from one
request MUST NOT be attributed to another. Shared telemetry abstractions MUST be extracted
only when at least two real implementations require them.

### XIV. Correct Attribution Over Metric Availability

A metric MUST NOT be presented as request-scoped unless its ownership of that request is
provable. Process-wide, batch-wide, scheduler-wide, and other aggregate metrics MUST remain
explicitly aggregate. When concurrent activity makes attribution ambiguous, implementations
MUST omit the metric or label it as aggregate instead of assigning it to a generation.
Request-local provider telemetry MUST take priority over aggregate telemetry. Aggregate
counters MAY become attempt-local deltas only when isolation and attribution are
demonstrably valid and covered by tests. Unavailable measurements MUST NOT be represented as
zero.

### XV. Provider-Native Provenance and Metric Arbitration

Measurements MUST be sourced from the component that owns the measured interval whenever
available. Provider-native exact measurements MUST take precedence over OpenCode-local
estimates for the same semantic quantity, and generic OpenCode estimation MUST remain the
fallback when authoritative provider data is absent or unusable. Normalized metrics whose
meaning can differ by source MUST retain enough provenance to distinguish provider-native
values from approximate or client-observed values, and approximate values MUST remain
visibly distinguishable in presentation. Counters with incompatible timing boundaries MUST
NOT be combined solely because they use the same unit.

### XVI. Telemetry Is Observational and Must Never Break Generation

Generation MUST NOT depend on telemetry. Connection failures, malformed telemetry,
unsupported backend versions, timeouts, polling failures, missing stream metadata, and
parser failures MUST degrade to another valid source or no telemetry without failing or
delaying the model request. Telemetry teardown MUST respect abort and stream lifecycle.
Watchers, timers, subscriptions, pending attempts, and replay or tombstone sets MUST be
bounded and cleaned up. OpenCode-owned telemetry controls MUST NOT leak into third-party SDK
constructor options or wire requests unless that provider explicitly defines them.

### XVII. Provider Compatibility and Additive Telemetry Support

Existing working telemetry is a regression contract. Adding telemetry support for a provider
MUST NOT replace, weaken, or silently alter existing MLX telemetry, generic fallback
telemetry, provider dispatch, model behavior, or UI semantics. The `mlxTelemetry: true`
setting MUST remain supported unless a separately specified migration provides a
backward-compatible path. Provider telemetry MUST coexist as peer adapters behind shared
attempt and session semantics, and a new provider MUST NOT justify rewriting a proven
provider implementation. Any provider-side telemetry connection MUST derive its endpoint and
authentication from the same effective provider configuration used for model dispatch;
implementations MUST NOT guess localhost ports, independently reconstruct endpoint
precedence, or duplicate environment and configuration resolution.

### XVIII. Streaming Before Polling

Live per-request telemetry MUST use metadata carried by the generation stream or an existing
provider event stream when available. Polling is permitted only for information with no
request-scoped streaming source. Polling MUST be bounded, cancellable, and low-overhead and
MUST NOT present aggregate state as request-local state. A change MUST NOT add polling for
data the provider already supplies as equivalent request-local progress or final timing.

### XIX. Telemetry Presentation Stability and Bounded Overhead

Telemetry work MUST stay off the generation critical path as far as practical. Live updates
MUST be throttled or coalesced to a bounded rate and MUST NOT cause token-by-token UI or
store churn. The normalized telemetry path in the session timeline MUST remain the
presentation contract. Provider support SHOULD enrich that path; provider-specific
presentation is permitted only when a metric has semantics that cannot be represented
honestly in the shared model.

### XX. Telemetry-Specific Regression Coverage

Every provider telemetry integration MUST have deterministic tests for its parser or adapter
and its lifecycle. Changes to telemetry arbitration MUST retain coverage for provider and
fallback coexistence; retries reusing the same AssistantMessage; abort and failed setup;
stale terminal reset; short generations without authoritative rates; concurrent requests and
ambiguous attribution; malformed or unavailable provider data; resource cleanup; and
prevention of provider control options leaking into SDK configuration. Coverage MUST
continue to prove that existing MLX telemetry behavior still works.

## Scope and Change Constraints

- The active specification defines intentional behavior changes and takes precedence over
  default compatibility only for behavior it explicitly covers; it does not silently waive
  these principles.
- A change MUST identify its ownership boundary, affected user-visible behavior,
  configuration, schema, storage, and presentation impact, and the validation coverage that
  demonstrates the impact is safe.
- Work outside the active specification MUST be deferred unless it is necessary to preserve
  correctness.
- The constitution MUST NOT encode feature-specific product or UX decisions. Composer model
  swapping, variant placement, and fallback picker behavior belong to their feature
  specification; this document only requires that such decisions preserve existing behavior,
  keep one authoritative owner, and stay testable.
- Existing implementation evidence in the current checkout includes:
  - `packages/core/src/session/runner/step.ts`, which owns the generation attempt,
    serializes telemetry publication, and suppresses superseded attempts.
  - `packages/core/src/session/runner/telemetry.ts`, which keeps fallback estimation and
    teardown failure observational rather than part of generation.
  - `packages/ai/src/telemetry/mlx.ts` and `packages/ai/src/telemetry/splash.ts`, which are
    peer provider adapters observing provider protocol only and carrying no session
    identity.
  - `packages/core/src/model-resolver.ts` and `packages/core/src/provider.ts`, which resolve
    effective provider settings and separate OpenCode-owned settings from provider-native
    options.
  - `packages/core/src/aisdk.ts`, which projects resolved settings into provider options at
    dispatch.
  - `packages/session-ui/src/timeline/generation-telemetry.ts`, the normalized presentation
    path.
  - deterministic coverage in `packages/core/test/session-telemetry.test.ts`,
    `packages/ai/test/mlx-telemetry.test.ts`, `packages/ai/test/splash-telemetry.test.ts`,
    and `packages/session-ui/src/timeline/generation-telemetry.test.ts`.

These are current repository examples to inspect, not permission to assume future APIs or to
preserve implementation details that an approved project-wide policy change explicitly
replaces.

## Development Workflow and Quality Gates

- Before implementation, contributors MUST document the upstream, protocol, backend, and
  checkout capabilities relevant to the change, then identify the authoritative owner of the
  state or publication the change touches.
- Feature plans MUST explain reused code unchanged, the smallest generalization required,
  genuinely new code, and capability deliberately omitted because attribution, provenance,
  or source semantics are insufficient, as required by Principles II and VII.
- During review, contributors MUST assess stale asynchronous results, duplicate mutation or
  publication paths, ownership of persistence and configuration, invariant preservation
  across boundaries, option and credential leakage, resource cleanup, performance,
  accessibility, UI stability, and scope.
- Validation gate: existing tests MUST continue to pass with their current assertions. A
  change that requires deleting, weakening, skipping, or reducing assertions MUST be
  rejected unless the active specification explicitly changes the covered behavior and the
  assertion update is reviewed as part of that change. Completion MUST record applicable
  checks that could not be run and why.
- Evidence gate: a review finding or refactor MUST identify a reachable correctness,
  data-loss, duplicate-execution, security, performance, or contract violation. Speculative
  architecture preference alone does not establish a violation.
- Complexity gate: accidental complexity SHOULD be simplified before adding a compensating
  layer, and any retained layer MUST have a documented, reachable correctness or contract
  purpose.

## Governance

This constitution governs specification, planning, task generation, implementation, review,
and validation decisions across every OpenCode subsystem. The domain-specific telemetry
requirements apply in full to any change that can affect those guarantees. Amendments MUST
be proposed as documented changes to this file and MUST state their rationale, affected
principles or sections, compatibility impact, and validation implications. Approval requires
review by the project maintainers or equivalent repository authority. An amendment MUST NOT
be made solely to ease one feature implementation and MUST NOT introduce a feature-specific
product decision.

Compatibility check for amendments: an amendment MUST state which prior obligations remain
in force and MUST NOT silently convert a mandatory guarantee into a preference. Where a
guarantee is re-scoped from one subsystem to another, the amendment MUST preserve it in the
narrower domain and record that preservation explicitly, as done for Principles XIII through
XX above.

Constitution versions follow semantic versioning: MAJOR for backward-incompatible governance
removals or redefinitions; MINOR for a new principle or materially expanded requirement;
PATCH for clarifications, wording fixes, and other non-semantic refinements. Every amendment
MUST update the version and last-amended date and retain a Sync Impact Report at the top of
this file.

Every feature proposal, implementation review, and convergence review MUST assess applicable
principles. A conflict MUST be resolved before completion or documented as a specific
maintainer-approved exception with its risk. This constitution is the authoritative record
of these governance requirements.

**Version**: 2.1.0 | **Ratified**: TODO(RATIFICATION_DATE): original adoption date is not recorded | **Last Amended**: 2026-11-18
