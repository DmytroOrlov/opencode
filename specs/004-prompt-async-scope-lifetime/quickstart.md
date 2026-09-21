# Quickstart: Prompt Async Scope Lifetime

Run these commands from `packages/opencode` unless a path is shown relative to the repository root.

## Record the existing primary RED

Before the production change:

```sh
bun run script/httpapi-exercise.ts --mode effect --include prompt_async
```

The current behavior is a deterministic failure: the endpoint accepts the prompt but generation does not reach the fake LLM.

## Verify the writer-held regression

Run the focused real-HTTP test:

```sh
bun test test/server/httpapi-session.test.ts
```

The added case should observe `204` and no fake-LLM start while the writer is held, then exactly one generation after release. It must use Deferred/Queue coordination and no sleeps.

## Validate the fix and neighboring invariants

```sh
bun run script/httpapi-exercise.ts --mode effect --include prompt_async
bun test test/server/httpapi-session.test.ts test/server/httpapi-promptasync-context.test.ts test/effect/runner.test.ts test/server/global-config-update.test.ts ../core/test/generation-gate.test.ts
bun run typecheck
bun run test:httpapi

From the repository root, run `git diff --check`.
```

Reuse existing tests for context inheritance, runner ownership, global configuration serialization, and GenerationGate semantics; do not add duplicate lower-level tests. If the primary HTTP exercise remains red after the scoped-background change, stop and report the contradiction without expanding the patch.
