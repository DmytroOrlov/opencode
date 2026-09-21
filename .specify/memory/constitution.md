<!--
Sync Impact Report
- Version change: unratified scaffold -> 1.0.0
- Modified principles: PRINCIPLE_1_NAME -> Preserve Existing User-Visible Behavior;
  PRINCIPLE_2_NAME -> Minimal Ownership Model; PRINCIPLE_3_NAME -> Authoritative State
  Mutation; PRINCIPLE_4_NAME -> Ordered Async Persistence; PRINCIPLE_5_NAME -> Deferred
  Incidental Preference Effects
- Added principles: Shared Composer Mutation Authority; Bounded Change Scope; Authoritative
  Validation; Reachable Review Findings; Simplify Accidental Complexity
- Added sections: Scope and Change Constraints; Development Workflow and Quality Gates
- Removed sections: None; scaffold placeholders were replaced with project-specific content
- Follow-up TODOs: TODO(RATIFICATION_DATE) records the unknown original adoption date
-->

# OpenCode Constitution

## Core Principles

### I. Preserve Existing User-Visible Behavior

OpenCode changes MUST preserve existing user-visible behavior unless the active specification
explicitly changes that behavior. Specifications that change behavior MUST identify the affected
experience and the intended replacement behavior. This keeps maintenance work compatible by
default and makes intentional product changes reviewable.

### II. Minimal Ownership Model

Changes MUST use the smallest ownership model that prevents a real correctness failure. Teams MUST
NOT add abstractions solely to make rollback, state, or architecture theoretically complete. New
ownership or coordination layers require a concrete failure mode that they prevent and tests or
other evidence that exercise that failure mode. This limits accidental complexity and keeps
responsibility understandable.

### III. Authoritative State Mutation

Each state mutation MUST have one authoritative owner. Other layers MAY request, validate, or
render a mutation, but MUST NOT independently perform the same domain mutation. This prevents
conflicting writes, duplicate side effects, and divergent state transitions.

### IV. Ordered Async Persistence

Asynchronous persistence MUST prevent stale failures from overwriting newer user actions. A
persistence flow MUST associate completion or failure with the user action that initiated it and
MUST ignore, reconcile, or supersede results that no longer represent the latest action. This
protects user intent when operations complete out of order.

### V. Defer Incidental Preference Effects

Incidental preference state MUST NOT be transactionally rolled back when the same correctness goal
can be achieved by deferring that side effect until persistence succeeds. Implementations MUST
prefer sequencing the incidental effect after the authoritative write and MUST add rollback only
when deferral cannot preserve correctness. This avoids compensating layers for non-authoritative
state.

### VI. Shared Composer Mutation Authority

Legacy and new UI paths that represent the same composer operation MUST use the same domain
mutation authority. UI-specific adapters MAY translate input or presentation state, but MUST NOT
create separate mutation semantics for the same operation. This keeps behavior consistent during
incremental UI migration.

### VII. Bounded Change Scope

A change MUST remain within the active specification and its directly necessary dependencies. It
MUST NOT expand into recovery, telemetry, TLS, backend fallback policy, generated SDKs, routing,
or unrelated UI architecture unless the active specification explicitly includes that work. This
keeps review scope and risk proportionate to the requested outcome.

### VIII. Authoritative Validation

Existing repository tests and typechecks MUST be used as the authoritative validation mechanisms
for changes that affect their covered behavior. New or changed behavior MUST add or update focused
validation when existing checks do not cover the relevant contract. A change MUST NOT claim
completion while required authoritative checks are failing or have not been run without an
explicitly documented reason.

### IX. Reachable Review Findings

A review finding blocks completion only when it demonstrates a reachable correctness, data-loss,
duplicate-execution, security, or contract violation. Architectural purity concerns and
speculative edge cases alone MUST NOT block completion. This focuses review effort on material
user and system risk.

### X. Simplify Accidental Complexity

When an implementation contains accidental complexity, changes SHOULD delete or simplify it
before adding another compensating layer. Any retained layer MUST have a documented, reachable
correctness or contract purpose. This keeps the system understandable while preserving necessary
protections.

## Scope and Change Constraints

- The active specification defines intentional behavior changes and takes precedence over the
  default compatibility rule in Principle I for the behavior it explicitly covers.
- A proposal MUST identify its ownership boundary, persistence ordering, affected UI paths, and
  validation coverage when those concerns apply.
- Work outside the active specification MUST be deferred to a separately scoped proposal unless it
  is required to preserve correctness of the requested change.

## Development Workflow and Quality Gates

- Before implementation, contributors MUST identify the authoritative domain mutation and the
  user-visible behavior that must remain stable.
- During review, contributors MUST check for stale async results, duplicate mutation paths,
  incidental preference writes, and scope expansion when relevant to the change.
- Before completion, contributors MUST run the applicable repository tests and typechecks and MUST
  record any unavailable check and its reason.
- Review comments MUST distinguish reachable contract or correctness violations from architectural
  preferences and speculative risks.

## Governance

This constitution governs design, implementation, review, and validation decisions in OpenCode.
An active specification MAY explicitly change a user-visible behavior, but it MUST NOT silently
override the ownership, persistence, scope, validation, or review requirements in this document.

Amendments MUST be proposed as a documented change to this file. Each amendment MUST state its
rationale, affected principles or sections, compatibility impact, and validation implications.
Approval requires review by the project maintainers or the equivalent repository authority.

Constitution versions follow semantic versioning: MAJOR for backward-incompatible removals or
redefinitions of governance; MINOR for new principles or materially expanded requirements; and
PATCH for clarifications, wording fixes, and other non-semantic refinements. The amendment MUST
update the version and last-amended date, and MUST retain a Sync Impact Report at the top of the
file.

Every feature proposal and code review MUST assess compliance with the applicable principles.
When a conflict is found, the author MUST resolve it before completion or document the specific
maintainer-approved exception and its risk. The constitution is the authoritative record for
these governance requirements.

**Version**: 1.0.0 | **Ratified**: TODO(RATIFICATION_DATE): original adoption date is not recorded | **Last Amended**: 2026-09-21
