# Implementation Plan: Prompt Async Scope Lifetime

**Branch**: `004-prompt-async-scope-lifetime` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-prompt-async-scope-lifetime/spec.md`.

## Summary

An accepted `prompt_async` operation currently inherits the HTTP request's resource Scope, so request completion can cancel it before or during shared GenerationGate admission. Give this one background operation a local `Effect.scoped` lifetime before forking it into the existing supervising scope. The operation keeps the request's inherited runtime context, but its resources close when that operation ends. The only expected production change is in `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`.

Planning relies on the already-established real-HTTP RED and reviewed scope diagnosis. No additional root-cause investigation or Effect internals study is part of this plan.

## Technical Context

**Language/Version**: TypeScript, Bun runtime
**Primary Dependencies**: Effect, Effect HTTP API, GenerationGate
**Storage**: Existing session persistence; no schema or migration changes
**Testing**: Bun tests and the `packages/opencode/script/httpapi-exercise.ts` HTTP exercise
**Target Platform**: OpenCode server
**Project Type**: TypeScript server application
**Performance Goals**: Preserve prompt acceptance without waiting for generation; no new work on the generation path beyond local scope ownership
**Constraints**: Keep `204 No Content`, inherited context, admission ordering, and generation ownership semantics unchanged
**Scale/Scope**: One handler lifetime composition, one writer-held HTTP regression, and reuse of existing focused suites

## Constitution Check

- **Principle X, Minimal, Evidence-Driven Change**: Pass. The reviewed diagnosis identifies one precise handler boundary and one existing lifetime abstraction. The plan changes no gate, runner, or session ownership semantics.
- **Development Workflow and Quality Gates**: Pass. Reuse the established primary HTTP reproduction, add only the missing writer-held interaction regression, and run focused neighboring suites plus typecheck and diff hygiene.
- Other telemetry-specific principles do not apply to this server lifetime fix.

Post-design re-check: Pass. The design adds no provider behavior, telemetry, public API shape, state store, or broad abstraction.

## Design Decisions

1. In `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`, scope the `promptSvc.prompt(...).pipe(Effect.catchCause(...))` operation with `Effect.scoped` before the existing `Effect.forkIn(scope, { startImmediately: true })`. Follow local composition style. This makes the operation-local scope own its reservations until the operation completes, fails, or is interrupted, while the existing scope continues to supervise the fork.
2. Add exactly one writer-held, real-HTTP regression to `packages/opencode/test/server/httpapi-session.test.ts`, adjacent to the existing session prompt HTTP tests. Use the existing Deferred/Queue and fake-LLM test seams. Assert `204` while the exclusive writer is held, no LLM start before release, then exactly one completed generation for that accepted request.
3. Treat `bun run script/httpapi-exercise.ts --mode effect --include prompt_async` as the primary existing free-gate RED. Do not add another free-gate case or duplicate either request-scope timing window.
4. Reuse `packages/opencode/test/server/httpapi-promptasync-context.test.ts`, `packages/opencode/test/effect/runner.test.ts`, `packages/opencode/test/server/global-config-update.test.ts`, and `packages/core/test/generation-gate.test.ts` for context inheritance, runner ownership, config serialization, and gate invariants. Also run the existing HTTP API exercise target and package typecheck.
5. Do not modify `packages/core/src/session/generation-gate.ts`, `packages/opencode/src/effect/runner.ts`, `packages/opencode/src/session/run-state.ts`, `packages/opencode/src/session/llm.ts`, or `packages/opencode/src/session/llm/splash-telemetry.ts`. Their relevant semantics are already covered, and the proposed change does not alter their ownership or admission rules.

**Stop condition**: If the exact scoped-background change does not make the established free-gate HTTP RED pass, stop implementation and report the contradiction. Do not expand the patch into another subsystem without new review.

## Implementation Sequence

1. Record the existing primary RED with `bun run script/httpapi-exercise.ts --mode effect --include prompt_async` before production changes.
2. Add the single writer-held real-HTTP regression in `packages/opencode/test/server/httpapi-session.test.ts`; confirm it fails before the fix.
3. Apply the minimal `Effect.scoped` lifetime composition in the `prompt_async` handler.
4. Confirm both the primary HTTP exercise and the writer-held regression pass.
5. Run the reused neighboring suites, the full existing HTTP API exercise/test target, package typecheck, and diff hygiene. Stop.

No implementation code, tests, or task list are created by `/plan`. No additional phase is needed.

## Project Structure

```text
specs/004-prompt-async-scope-lifetime/
├── plan.md
├── research.md
├── data-model.md
├── contracts/
│   └── prompt-async.md
└── quickstart.md

packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts
packages/opencode/test/server/httpapi-session.test.ts
packages/opencode/test/server/httpapi-promptasync-context.test.ts
packages/opencode/test/effect/runner.test.ts
packages/opencode/test/server/global-config-update.test.ts
packages/core/test/generation-gate.test.ts
packages/opencode/test/server/httpapi-exercise/
```

**Structure Decision**: This is a focused change in the existing OpenCode server handler. The new interaction regression belongs in the real HTTP session suite, while the existing exercise remains the primary free-gate reproduction. No new source module or contract implementation is needed.

## Complexity Tracking

No constitution violations or additional abstractions are proposed.
