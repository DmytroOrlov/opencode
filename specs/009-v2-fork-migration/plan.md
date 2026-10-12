# Implementation Plan: OpenCode Fork Migration to V2

**Branch**: `009-v2-fork-migration` (planning label only; no branch was created) | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Accepted feature specification in `specs/009-v2-fork-migration/spec.md`.

## Summary

Preserve four original feature areas as V2 behavior: verified TLS CA selection, attempt-owned telemetry, compact primary/fallback model selection, and the integrated recovery/SSE/compaction fixes. Implement each behavior at its V2 owner, keeping upstream V2 execution, protocol, persistence, and UI ownership. The paused TLS change is a semantic port into CLI bootstrap, ServerInfo, and the current app shell; deleted `packages/opencode` and V1 SDK artifacts stay deleted. Subsequent changes map respectively to the V2 AI/session telemetry path, the V2 composer/model-selection state, and the V2 session execution, provider transport, config, and event/projector boundaries.

The detailed contracts are in [contracts/server-info.md](contracts/server-info.md), [contracts/fallback-config.md](contracts/fallback-config.md), and [contracts/session-events.md](contracts/session-events.md). [research.md](research.md) records source evidence and the 20-path TLS conflict matrix. [data-model.md](data-model.md) defines only the state boundaries needed by those changes. [quickstart.md](quickstart.md) gives the paused-rebase implementation and verification sequence.

## Technical Context

**Language/Version**: TypeScript, Bun, and supported Node.js standalone runtime; preserve repository-pinned versions.

**Primary Dependencies**: Existing Effect services/layers and event bus in Core; Schema and Protocol contracts; AI SDK/provider streaming; SolidJS app and session UI; existing localization and client code generation.

**Storage**: Existing SQLite event log and projections for sessions/messages/inbox; existing config persistence for committed fallback selection; existing app server/workspace persistence for primary selection. Attempt telemetry and admission leases are runtime state, not durable transcript records. Compaction publication adds durable event/projection facts only where required by the contract.

**Testing**: Focused Bun tests from affected package directories, focused app browser tests where composer interaction requires them, package-local typechecks, `bun run generate` from `packages/client` after public Protocol/Server HttpApi changes, and one final root `bun run check`. Repository guard prohibits tests from the repository root.

**Target Platform**: V2 CLI/server in Bun and Node-supported standalone builds, desktop/web app connected to a V2 server, and local provider transports including explicitly opted-in Splash and MLX telemetry.

**Project Type**: TypeScript monorepo with CLI, core, AI/provider, protocol/schema/server, generated client, app, and session UI packages.

**Performance Goals**: Keep existing dispatch and retry behavior; timeout adaptation measures only pending SSE reads; telemetry adds no inference request and does not block successful generation; titlebar uses the existing health record rather than polling; config mutation waits only for protected generation admission to drain.

**Constraints**: Do not restore V1 packages or generated files, change upstream behavior outside specified deviations, weaken TLS verification, replay unknown tool outcomes, make Splash adaptation default, use assistant-message identity as attempt identity, or allow compaction candidate state to change model-visible history before publication.

**Scale/Scope**: Four original feature areas and their focused regressions across existing V2 package boundaries. No broad refactor, schema-wide cleanup, new provider runtime, or unrelated UI redesign.

## Constitution Check

### Before research

- **Upstream-first and protocol ownership**: Pass. Reuse V2 CLI/server, session execution, AI stream, schema/protocol and app state. New public facts are added at Schema/Protocol/Server boundaries and generated client surfaces are regenerated through the repository workflow.
- **Telemetry correctness and isolation**: Pass. One attempt owns every metric; provider-native and estimated provenance stay distinct; telemetry setup, events, and cleanup are observational and bounded.
- **Compatibility**: Pass. Preserve accepted V1 behavior at the user contract level, retain strict legacy compaction reads, and reuse existing V2 behavior when it already meets acceptance. Removed paths are not compatibility targets.
- **Evidence-driven change**: Pass. The source and conflict inventory in `research.md` identifies owners, gaps, call sites, and focused regression gates. No speculative default or unrelated cleanup is planned.
- **V2 session semantics**: Pass. Prompt admission remains durable before scheduling; process-local session execution owns drains; one physical `llm.stream(request)` remains one attempt; event replay remains separate from execution admission; compaction stays Session-owned.

### Re-check after design

Pass. The design uses a small CLI bootstrap boundary, additive health/config/event contracts, existing SessionExecution ownership, and explicit publication. It does not introduce a parallel session engine, provider store, or generated-client hand edits. The new shared admission service is justified by the accepted cross-runtime-graph configuration safety requirement; its owner and lease lifecycle are explicit. Persistent additions are limited to fallback configuration and compaction publication facts. No constitution exception or genuine product-contract HOLD is identified from current source.

## V2 Ownership and Migration Map

| Area / original source | V2 owner and call path | Reuse unchanged | Required V2 change | Do not carry over | Focused regression and primary risk |
|---|---|---|---|---|---|
| TLS CA policy, `af1531f1a8` | `packages/cli/src/index.ts` → command graph; `commands/handlers/serve.ts` → `server-process.ts` → `@opencode/server/process`; `util/process.ts` → service/standalone re-exec. Node build: `vite.node.config.ts` and `script/build-node.ts`. Shared actual-trust verifier/attestation: `@opencode/util`. Health: Protocol `groups/server.ts` → `server/handlers/server.ts` → `server-info.ts` → `/api/info` → app `runtime/server/health.ts` → `shell/titlebar/titlebar.tsx`. | V2 CLI command/server lifecycle, shared effective-CA verification, ServerInfo, health cache, and titlebar layout. | Select and verify mode in a CLI-owned pre-import launch boundary for Bun and Node paths; only actual trust-set verification creates process-local attestation; preserve non-CA Node flags; propagate verified mode to child processes; report only verified mode through ServerInfo; show unknown when absent. | V1 `packages/opencode` entrypoints/build/package, `/global/health`, old app titlebar, SDK-generated types. | CLI process/standalone and service lifecycle tests; server `/api/info`; app health and shell badge tests. Risk: static imports or a hard-coded `--use-system-ca` can act before mode selection. |
| Attempt telemetry, `35dd5f2fc6` | `Config.Provider.Settings` → `packages/core/src/model-resolver.ts` → `Provider.CORE_KEYS` / `packages/core/src/aisdk.ts::prepareOptions`; prepared request in `SessionModelRequest.Prepared` → Core `SessionStep.attempt` → AI protocol observers → ephemeral Session event → V2 app reducer/timeline. | One AI stream per physical attempt, normalized events, Session event handling, and existing V2 timeline. | Give each physical attempt its own identity and lifecycle; capture effective endpoint and redacted `route.auth` after request hooks; keep attribution/arbitration/publication/cancellation/cleanup in Core and protocol-only observation in AI adapters; preserve MLX-over-Splash precedence and opt-in Splash. | V1 provider telemetry registry/store, inference polling or second request, shared assistant-ID ownership, provider-specific parallel UI, credentials in telemetry. | Core attempt lifecycle and option-stripping tests, AI observer cleanup tests, app reducer/timeline. Risk: retry may reuse assistant message ID; late watcher data must not update the next attempt or fail inference. |
| Compact composer selectors, `a0c8c7e123` | `packages/app/src/composer/composer.tsx` and `editor/editor.tsx` own current model, agent, and variant selector triggers. | Existing V2 selector actions, dialogs, focus behavior, and accessibility. | Carry only the incoming `!px-0` compact trigger styling into active V2 controls. Fallback schema, persistence, pair selection, swaps, and locale status are Stage 3 integration work (T020–T024, T027–T028). | V1 `prompt-input*`, obsolete session-ui V2 paths, duplicate pair persistence, local-only fallback state that diverges from config. | Focused App composer component test for model/agent/variant trigger padding and existing interactions. Risk: adding pair behavior before Config PATCH is durably implemented can make the UI report an update that was not persisted. |
| Integrated recovery, SSE liveness, crash-safe compaction, `af9515d01a` | Admission/recovery: `session/execution.ts`, `run-coordinator.ts`, `runner/llm.ts`, `runner/step.ts`, `runner/retry.ts`, Config service/API. Transport: `packages/ai/src/route/transport/http.ts`. Persistence: Session events, `message-updater.ts`, `history.ts`, `projector.ts`, `bus.ts`; compaction in `session/compaction.ts`. | Durable inbox admission, process-local Session-ID execution, write-ahead execution claim, retry timing, per-read stream timeout, event transaction, legacy history selection, and fork projection. | Add shared interruptible generation admission; separate retry scheduling from recovery decision; read current fallback intent after backoff; keep config intent separate from commit; classify tool state; use per-read opt-in Splash adaptation; explicitly publish validated compaction candidate; enforce delete/replay/fork reference integrity. | V1 Effect.Runner/GenerationGate orchestration, old retry/provider loop, old durable event model, total-generation timeout, and unconditional `Compaction.Ended` authority. | Core run-coordinator/subagent/retry/compaction/projector tests; AI HTTP timeout tests; config cross-graph tests. Risk: a queued cancellation can strand an admission lease; loose projector matching can resurrect or publish a deleted candidate. |

## Implementation Strategy

The stages below follow the user's paused rebase order. They describe semantic integration and gates; they do not instruct or perform index/rebase actions. Within each incoming change, port only the behavior owned by the listed V2 packages. Keep each behavioral change independently reviewable and run its discriminator tests before moving to the next change.

### Stage 0 — Current TLS CA change (`af1531f1a8`)

1. Keep V2-deleted paths deleted. Apply the path-by-path policy in `research.md`; no `packages/opencode` or old SDK artifact is restored.
2. Put mode parsing and the pre-import launcher in `packages/cli/src/bootstrap.ts`. The shim must initialize policy before dynamically loading the statically imported command graph. Route every development, package-bin, Bun build, and Node standalone entry through it, including `packages/cli/vite.node.config.ts` and `packages/cli/script/build-node.ts`. Cover Bun and Node, `serve`, service re-exec, and standalone/stdio child paths. Default to bundled; explicit system/bundled selection is validated once. Conflicting/unknown/repeated-invalid values and disabled verification fail before network activity.
3. Implement the shared effective-CA verifier and process-local attestation in a low-level module under `packages/util`, exported through `@opencode/util` for CLI and Server use. Only verification of the actual effective trust set may establish attestation. Remove the V2 build-time unconditional system-CA selection where it would override bundled mode. Replace only the CA flag during Node self-reexec; preserve unrelated runtime flags, including `--experimental-ffi` and warning settings. Sanitize hostile inherited CA overrides without dropping non-CA `NODE_OPTIONS`/`BUN_OPTIONS` options.
4. Make `packages/server/src/process.ts::ServerProcess.start` require verified process-local attestation before it binds/listens; a `ServerOptions` mode string is metadata, never evidence. CLI `serve`, service, and standalone paths must use the shared verifier. A direct server host must verify the actual effective set or fail before bind. Add optional verified mode to V2 ServerInfo at `packages/protocol/src/groups/server.ts` and supply it through `packages/server/src/handlers/server.ts` / `server-info.ts`. Regenerate client types from `packages/client` using `bun run generate`.
5. Extend V2 health extraction and its tests in `packages/app/src/runtime/server/health.ts`; unknown or old-server absence maps to `unknown`. Render the accessible indicator in current `packages/app/src/shell/titlebar/titlebar.tsx`, using the selected server's existing health state. Port V1 fixture/probe semantics to CLI tests and adapt the old HTTP contract test to V2 `/api/info`.
6. Gate: isolated process and built-artifact smoke tests for Bun and Node in bundled/system modes, invalid/conflicting input, hostile environment, actual effective trust set, child propagation and pre-network fail-closed; server process/API verified and forged/unverified mode cases; app health unknown/verified and badge states. Adapt `packages/server/test/fixture/server.ts` to perform actual trust verification or enter through CLI bootstrap. `bun run generate` is required because the public Server contract changes.

**Hold condition**: If any supported V2 runtime cannot establish or verify bundled mode before TLS imports/network work, stop that startup path for a product/runtime contract decision. Do not substitute an unverified label or system-CA default.

### Stage 1 — Attempt-scoped telemetry (`35dd5f2fc6`)

1. Place ownership in `SessionStep.attempt` (`packages/core/src/session/runner/step.ts`), not in the assistant message or session. Create an attempt ID before the one `llm.stream(request)` call. Reset/finalize attempt state at every retry/fallback/continuation that is a new physical attempt, even if V2 reuses the assistant message ID.
2. Add typed `mlxTelemetry` and `splashTelemetry` provider settings in `Config.Provider.Settings`; resolve through `packages/core/src/model-resolver.ts`, then strip these Core-only options through `Provider.CORE_KEYS` and `packages/core/src/aisdk.ts::prepareOptions` before provider/SDK dispatch. AI adapters observe provider protocol only and carry no session identity.
3. Keep attempt attribution, source arbitration, accepted-value state, event publication, cancellation, and resource cleanup in `SessionStep.attempt`. Capture the effective endpoint and `route.auth` from `SessionModelRequest.Prepared` after request hooks; preserve Redacted credentials and never put secrets in events or diagnostics. Accept observations synchronously into the current attempt before asynchronous publication so a retry or terminal event cannot be overtaken by stale async data.
4. Consume normalized V2 `LLMEvent` data for generic estimates and provider-native data. Keep MLX ahead of Splash when both supply an equivalent native metric; validate provisional terminal-rate values before publication. Native data replaces estimates only when finite, semantically equivalent, valid, and current-attempt-owned; prefill-only data cannot claim decode rate. Parse, watcher, event-publication, and cleanup errors remain observational.
5. Preserve MLX behavior through a V2 protocol observer. Preserve Splash support behind explicit opt-in on the already-dispatched request; it must not mutate inference options or implicitly enable `return_progress`, issue another inference request, poll, or switch runtime. Bound provider observer resources to the attempt and close them on success, retry, error, interruption, and abort.
6. Publish an ephemeral `session.telemetry` event with session, assistant message, attempt ID, phase, values, and provenance. The app session reducer accepts updates only for the current attempt and the existing V2 timeline renders native versus estimated values consistently. Do not persist telemetry into conversation history or add a second telemetry store.
7. Gate: deterministic fake streams for same-message retry, overlapping attempts, stale/duplicate/out-of-order data, fallback, native-vs-estimate selection, malformed/aggregate/zero data, cancellation, provider watcher cleanup, and event publisher failure; option-resolution/stripping tests; Splash mapper tests; app reducer/timeline ownership tests. GPU inference is not part of the gate.

### Stage 2 — Compact composer styling (`a0c8c7e123`)

1. Port only the incoming compact horizontal padding change to active V2 selector triggers in `packages/app/src/composer/composer.tsx` and `packages/app/src/composer/editor/editor.tsx`. Reuse existing model, agent, and variant controls, selector dialogs, focus behavior, and accessibility. Do not restore the three deleted V1 prompt-input component paths or add fallback/pair behavior.
2. Gate: focused `packages/app/component-tests/composer.spec.ts` coverage verifies zero horizontal trigger padding for model, agent, and variant selectors and retains existing selector interactions. This commit does not add a fallback request or claim model-pair functionality.

### Stage 3 — Integrated recovery, per-read SSE liveness, crash-safe compaction (`af9515d01a`)

1. **Shared admission**: add a process-global Core service shared by distinct runtime graphs, but keep actual drains process-local and Session-ID based. Generation obtains an interruptible lease owned by the execution chain (`SessionExecution`/`RunCoordinator`), not by the HTTP `Session.prompt` request. Protected destructive global config update obtains the exclusive lease. Acquire/wait cancellation, transfer, and exactly-once release are defined in `data-model.md`; do not conflate the lease with the existing write-ahead Session execution claim.
2. **The parked runner regression**: adapt the old admitted-runner test to V2's real boundary. Arrange a parent agent/subagent from `packages/core/src/tool/plugin/subagent.ts` using `packages/core/src/session/subagent-job.ts` that is admitted/active, then a child execution parked behind exclusive config mutation (and the converse queued protected operation as needed). Interrupt the parked parent/child through the V2 `Session.interrupt` → `SessionExecution` → `RunCoordinator` chain; assert the operation settles within a fixed bound, lease release occurs exactly once, the next queued owner proceeds, and cancellation of a joined waiter does not cancel the owner. Include lease release in both cancellation and failure tests.
3. **Fallback config contract and durable commit (T020–T021, T027–T028)**: add optional nullable `fallback` to public `Config.Info`/`Config.Patch`, regenerate the client, and preserve absent/legacy-default, explicit-null, and omitted-patch meanings. In the same ordered integration sequence, stage backend `FallbackRuntimeIntent` before exclusive admission and persist/refresh fallback only after leases drain. A fallback-only patch with no `shell` property must preserve the existing configured shell; patch application cannot replace unrelated config fields. Test this preservation alongside read-after-commit and failed-save behavior. Do not implement app fallback updates until T020, T021, T027, and T028 are complete.
4. **Composer pair selection and fallback presentation (T022–T024)**: only after T028, wire the generated Config client into app fallback updates, keep client optimistic revision separate from backend runtime intent and committed config, and reuse V2 primary/variant ownership across existing, draft, and new-session flows. Preserve symmetric swaps and model-associated supported variants, fallback visibility outside the ordinary catalog, and locale parity. The locale-only task may run independently but does not enable fallback updates.
5. **Recovery**: retain `runner/retry.ts` only as retry scheduling. At each wake after backoff, the recovery decision reloads current accepted fallback intent before dispatch; a selection while sleeping prevents another primary attempt. Snapshot model/variant at dispatch so later changes do not retarget in-flight work. Classify no-side-effect/replay-safe work, settled tool result, and executing/unknown tool outcome. Continue settled results without another tool call; do not replay unknown effects. Explicit cancellation is terminal and distinct from provider retry. Preserve same-model, invalid/used model, attempt cap, variant, and retry-after policy.
6. **SSE**: change only the V2 response-body read wrapper in `packages/ai/src/route/transport/http.ts`. Continue enforcing header timeout and per-pending-read idle timeout. Preserve the generic 300,000 ms chunk default and port the original `opencode-go` 150,000 ms chunk default through actual V2 provider-settings resolution. An explicit numeric `chunkTimeout` wins over either default and bypasses adaptation; explicit `false` disables both timeout and adaptation. Leave total `http.timeout` infinite unless explicitly configured. For explicitly enabled local Splash only, require the configured effective endpoint and actual request URL to share the eligible HTTP(S) loopback origin. Calibrate per request from five successful nonempty reads with at least 100 ms wait; exclude longest, multiply largest remaining by ten, clamp to 30s and the resolved provider default. Apply a computed threshold only to future reads. The existing transport error path remains retryable; abort remains cancellation. Do not change the Splash adaptation default or add a retry loop.
7. **Compaction**: retain V2 `SessionCompaction` and event bus ownership. Make a candidate identity explicit at prepare; completion stores exact summary content but cannot make it authoritative. A distinct durable publication decision must bind that same request/summary identity and pass reader-equivalent nonempty validation before projection changes. Validate exact pair, session ownership, status, uniqueness and delete/cancel tombstones in the same transaction that accepts the durable mutation; rejected publication writes neither event nor partial projection. New-format records missing identity/publication cannot fall back to legacy. Keep legacy selection strict and unchanged. Readers use the last published pair while preparing/unpublished; keep SessionInbox pending work independent and exclude candidates from ordinary message/response selection. Existing orphan-running → failed handling remains; no new restart reconciler is added.
8. **Fork/delete/replay**: extend `projectFork` and compaction reader references only for fields made necessary by the candidate/publication contract. Every copied published pair and event reference must resolve to fork-owned message/part IDs. Do not invent unrelated provenance fields. Delete/cancel is terminal for the candidate identity: later duplicate parts, completion, replay, restart, or retyping cannot recreate an authoritative row. Verify publication + projection atomicity and pending inbox survival independently.
9. Gate: focused Core tests for schedule versus recovery decision, fallback changed during delay, tool outcomes, cancellation, cross-graph config commits, and parked subagent regression; `packages/ai` deterministic fake-reader tests for long healthy stream versus silent read, adaptation formula/origin/explicit precedence/new request/cancel; Core event/projector/history/fork tests for every publication/deletion boundary and pending inbox. No live GPU.

### Final cross-feature integration gate

- Run focused regression tests for all changed owners after the last integration; package-local typechecks for affected packages and the canonical root `bun run check` once. Do not rerun the entire suite at each commit stage.
- Regenerate client code after Protocol/Server HttpApi changes by running `bun run generate` from `packages/client`; inspect schema/protocol source and generated diff as one contract change. Never patch generated files manually.
- Run the user-facing CLI/ServerInfo/health/titlebar acceptance flow against both supported launch types; run the composer state matrix and session telemetry reducer tests; run integrated admission/retry/compaction tests. Track existing upstream baseline failures independently from migration failures.
- Validate unchanged upstream paths still pass the touched adjacent tests (session inbox, provider stream, session model selection). Report only relevant failures, with failure owner and whether reproducible on the upstream base.
- Do not proceed past a V2 semantic conflict by disabling a regression test, adding a stub, using dead V1 code, or reducing required behavior. Mark that area HOLD with the exact evidence and requested contract choice.

## Project Structure

### Documentation (this feature)

```text
specs/009-v2-fork-migration/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── server-info.md
    ├── fallback-config.md
    └── session-events.md
```

No `tasks.md` is part of this Plan deliverable.

### Source Code (existing V2 monorepo)

```text
packages/
├── ai/src/route/transport/http.ts                  # SSE read liveness and provider frame adapters
├── cli/src/{index.ts,server-process.ts,util/process.ts} # early TLS bootstrap and child propagation
├── cli/test/                                       # TLS process/fixture regressions
├── core/src/session/                               # execution, retry, attempts, compaction, history
├── core/src/config.ts                              # fallback intent and coordinated commit
├── core/test/                                      # admission, recovery, event, fork regressions
├── schema/src/{config.ts,session-event.ts}         # persisted and ephemeral schema facts as required
├── protocol/src/groups/                            # public ServerInfo/config request contracts
├── server/src/{handlers/server.ts,server-info.ts}  # V2 HTTP contract ownership
├── client/                                         # generated public client, repository workflow only
└── app/src/{composer/,providers/models/,runtime/server/,shell/titlebar/}
                                                   # selection, health, session telemetry presentation
```

**Structure Decision**: Keep the existing package boundaries. Schema owns shared data shapes; Core owns execution, recovery, telemetry lifecycle, compaction and persistence decisions; Protocol and Server own public HTTP behavior; generated Client follows those contracts; CLI owns process bootstrap; App owns composer selection and presentation. AI owns HTTP stream mechanics and provider-specific frame decoding. There is no new project or replacement architecture.

## Complexity Tracking

No constitution violations. The process-global admission coordinator and revisioned runtime fallback intent are the minimum state required by FR-012–FR-014; telemetry remains attempt-local and compaction publication remains session-event-owned.
