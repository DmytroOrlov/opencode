# Research: Prompt Async Scope Lifetime

Root cause and Effect lifetime semantics were independently reviewed and are established inputs to this plan. No new root-cause research is required.

## Decisions

- **Decision**: Give the accepted `prompt_async` background operation its own `Effect.scoped` lifetime before forking into the existing supervising scope.
  - **Rationale**: The current handler in `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` forks into the long-lived handler scope, but the child still carries the request's ambient resource Scope. The request can close that Scope before admission completes. An operation-local scope separates accepted-operation cleanup from HTTP request cleanup while retaining the existing fork supervisor and runtime context.
  - **Alternatives considered**: Changes to GenerationGate, Runner, SessionRunState, or general SessionPrompt scope ownership are out of scope and unnecessary unless the reviewed change contradicts the established primary RED.

- **Decision**: Use the existing free-gate HTTP exercise as the primary bug regression and add one writer-held real-HTTP integration regression.
  - **Rationale**: `bun run script/httpapi-exercise.ts --mode effect --include prompt_async` already deterministically reproduces the accepted prompt failing to reach the fake LLM. The writer-held case adds only the missing admission interaction assurance.
  - **Alternatives considered**: Duplicate free-gate cases, separate timing-window tests, gate-state matrices, cancellation permutations, and direct Effect semantics tests are excluded.

## Repository Evidence

- The production `prompt_async` handler and existing `Effect.forkIn(scope, { startImmediately: true })` are in `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`.
- The existing prompt_async exercise is declared in `packages/opencode/test/server/httpapi-exercise/index.ts` and is invoked through `packages/opencode/script/httpapi-exercise.ts`.
- Real HTTP session tests live in `packages/opencode/test/server/httpapi-session.test.ts`.
- Runtime context inheritance coverage already lives in `packages/opencode/test/server/httpapi-promptasync-context.test.ts`.
- Existing gate, runner, and global config coverage lives in `packages/core/test/generation-gate.test.ts`, `packages/opencode/test/effect/runner.test.ts`, and `packages/opencode/test/server/global-config-update.test.ts`.
