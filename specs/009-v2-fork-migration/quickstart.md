# Feature 009 implementation and verification sequence

This is the implementation sequence for the accepted Plan. The current checkout is paused in a user-owned rebase at the TLS change. Do not begin these steps by changing the index or rebase state; the user controls when conflict resolution is complete and when the next commit is applied. Commands below are verification commands only.

## 1. Finish the TLS semantic port

Implement the V2 mapping in `plan.md` and resolve each of the 20 paths according to the matrix in `research.md`. Keep all V2-deleted V1 paths deleted. Route every supported executable through the CLI bootstrap shim and shared `@opencode/util` effective-CA verifier; fail closed before listening in `ServerProcess.start` unless actual verification established process-local attestation. A `ServerOptions` mode string alone is not evidence. Preserve non-CA Node flags during re-exec, including `--experimental-ffi` and warning settings. Add ServerInfo `tlsCaMode`, update current app health/titlebar, and port the existing TLS probes/tests to CLI/server/app owners.

Because `/api/info` is a public Server contract, regenerate from the client package after its source schema is updated:

```sh
cd packages/client
bun run generate
```

Focused verification from package directories (adapt test filenames to their final V2 locations):

```sh
cd packages/cli
bun test test/tls-ca-mode.test.ts test/tls-ca-mode.integration.test.ts test/service-lifecycle.test.ts test/standalone.test.ts

cd ../server
bun test test/process.test.ts

cd ../app
bun test src/runtime/server/health.test.ts src/shell/titlebar/titlebar-ca-badge.test.ts
```

The process regression must make a controlled TLS request and prove the child uses the same trust policy. Health and badge tests alone do not prove trust verification.

Smoke-test built Bun and Node artifacts in both bundled and system modes. Verify `packages/server/test/fixture/server.ts` uses actual trust verification or CLI bootstrap rather than trusting a configured mode string. At the Stage 0 user Git gate, the user must separately remove the eight obsolete staged additions listed in `research.md` from the index before continuing the rebase; deleting their worktree copies is insufficient.

## 2. Port attempt-scoped telemetry

Keep attribution, source arbitration, publication, cancellation, and cleanup in Core `SessionStep.attempt`; AI adapters observe provider protocol only and carry no session identity. Resolve typed `mlxTelemetry`/`splashTelemetry` provider settings through the Core model resolver and strip them before SDK dispatch. Capture the effective endpoint and Redacted `route.auth` from prepared requests after hooks without exposing credentials. Accept measurements before asynchronous publication, retain MLX-over-Splash precedence, keep Splash opt-in without mutating inference options or implicitly enabling `return_progress`, and make observer errors non-fatal. Do not add a second inference request or durable telemetry store.

```sh
cd packages/core
bun test test/session-runner.test.ts test/session-runner-retry.test.ts

cd ../ai
bun test test/splash-telemetry.test.ts

cd ../app
bun test src/session/timeline/telemetry.test.ts
```

The discriminating fake-stream cases are retry reusing assistant ID, concurrent attempts, stale terminal events, native/estimated source selection, malformed/aggregate/zero data, cancellation, bounded cleanup, and telemetry publisher failure. No GPU service is needed.

## 3. Port compact composer selector styling

The incoming `a0c8c7e123` change adds only `!px-0` to V1 selector triggers. Keep all three V1 prompt-input paths deleted and carry that styling to the active V2 model, agent, and variant controls. Do not add fallback state or a Config update request in this stage.

```sh
cd packages/app
bun run test:components -- component-tests/composer.spec.ts
```

Verify compact horizontal padding and that the existing V2 selector interactions and focus behavior remain intact.

## 4. Integrate fallback configuration and composer pair behavior

In Stage 3, implement `Config.Info`/`Config.Patch`, regenerate the V2 client, stage backend runtime intent, and complete backend persistence/refresh together before implementing any UI fallback update. A fallback-only PATCH that omits `shell` must preserve the existing configured shell. Then add app-only optimistic revision ordering, pair swaps, model-associated variants, existing/new-session flows, and locale parity. Treat only the post-persistence backend response as durable success.

```sh
cd packages/client
bun run generate

cd ../core
bun test test/config/fallback-runtime-intent.test.ts test/config/config.test.ts

cd ../server
bun test test/config.test.ts

cd ../app
bun test src/session/composer/selection.test.ts src/session/composer/submit.test.ts test-browser/model-selection.test.ts
```

Exercise fallback absent, configured, and cleared; symmetric pair swap; model-associated variant retention/clearing; hidden-from-catalog fallback; new-session consistency; shell preservation on fallback-only PATCH; and a delayed old failure arriving after newer intent.

## 5. Port integrated recovery, SSE, and compaction

Keep retry scheduling in `runner/retry.ts`, but move dispatch choice to a post-backoff recovery decision using current runtime fallback intent. Add process-global admission and atomic config commit coordination. Adapt the parked agent/subagent cancellation test at the actual SessionExecution/RunCoordinator boundary, with the owner in `packages/core/src/tool/plugin/subagent.ts` and child job in `packages/core/src/session/subagent-job.ts`. Keep Splash calibration in AI response reads. Preserve the generic 300,000 ms chunk default and resolve the `opencode-go` 150,000 ms default through `packages/core/src/model-resolver.ts`; explicit numeric overrides bypass adaptation and explicit `false` disables timeout/adaptation. Separate compaction generation from durable publication and validate deletion/replay/fork through the real Session readers.

```sh
cd packages/core
bun test test/session-execution.test.ts test/session-run-coordinator.test.ts test/session-runner-retry.test.ts test/tool-subagent.test.ts test/session-compaction.test.ts test/session-native-compaction.test.ts test/session-projector.test.ts

cd ../ai
bun test test/http-timeout.test.ts
```

For every compaction interruption/deletion case, assert three results separately: authoritative model-visible history, pending inbox work, and selected response. Cover publication reject/rollback, replay/restart, full and tailed summaries, strict legacy behavior, and fork-owned references.

## 6. Final cross-feature gate

From each affected package, run its `bun typecheck` after focused regression tests. Run the canonical full lint/typecheck once from the repository root:

```sh
bun run check
```

Then review all changed source and generated client files together. Record unrelated failures against the upstream V2 baseline separately. Keep Splash adaptation opt-in and do not use live GPU inference as an acceptance gate. If a supported runtime cannot prove its CA mode before network work, or if a V2 behavior cannot meet a required contract without being reduced, stop that area as HOLD and record the precise evidence.
