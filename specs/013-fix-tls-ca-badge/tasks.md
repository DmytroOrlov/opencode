# Tasks: TLS CA Policy and Badge Parity

**Feature directory**: `specs/013-fix-tls-ca-badge`
**Branch**: `011-restore-config-integrity`
**Input**: Design documents from `specs/013-fix-tls-ca-badge/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/ca-badge-server-context.md`, `quickstart.md`

**Tests**: Required by FR-013, FR-014 and FR-015. Existing assertions must be retained; new deterministic coverage is part of the delivery.

**Organization**: Four architecture-owned implementation slices under one feature and one dedicated final commit. S1 owns health observation identity and focused health acceptance. S2 owns authoritative context wiring, titlebar integration and deterministic app acceptance. S3 owns CLI bootstrap isolation; S4 atomically owns fresh default/verified child launches and artifact acceptance. Each slice has one independent acceptance review. Final independent Convergence closes the feature.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on the other parallel task)
- **[Story]**: US1, US2, US3 or US4 from `spec.md`
- Every task names its owner, affected files, observable acceptance and dependencies

---

## Phase 1: Setup (Baseline and mandatory analysis)

**Purpose**: Establish evidence and independently validate the planning package before any production change.

- [X] T001 Capture baseline evidence before production edits. Owner: independent evidence owner. Run and record exact exit codes and counts, without pipelines: `bun run --cwd packages/app test:harness`; `bun run --cwd packages/app typecheck`; `bun run --cwd packages/app typecheck:e2e`; `bun run --cwd packages/app test:unit`; `(cd packages/app && bun test --conditions=browser --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./test-browser/ssh-health.test.ts)`; `bun run --cwd packages/app test:e2e -- --project=chromium regression/multi-server.spec.ts`; `bun run --cwd packages/sdk test`; `bun run --cwd packages/core test`. Re-capture the documented feature-012 baseline: SDK exit 1, 44 pass / 10 fail, all `TLS CA mode has not been verified` at `packages/util/src/tls-ca.ts:104` in `packages/sdk/test/instances.test.ts`, `packages/sdk/test/request-retention.test.ts` and `packages/sdk/test/instances-effect.test.ts`; Core exit 1, 7636 pass / 38 skip / 3 fail: `packages/core/test/tool-shell.test.ts` ×2 ("conditional substitutions respect once/always", `/bin/bash: wait: pid N is not a child of this shell`, exit 127) and `packages/core/test/shell-scan/compound-parity.test.ts` ×1 (Bash 3.2 compound syntax parse error). Affected evidence: the listed test files plus `specs/013-fix-tls-ca-badge/quickstart.md`. Also capture existing S3/S4 targeted CLI TLS, self-command, service, standalone and server process gates and affected typechecks per quickstart §8 before production edits; reuse already captured valid evidence. SDK attestation failures require expanded-scope attribution, and incomplete Core evidence must be completed. Acceptance: baseline report records every command, exit code and count; out-of-scope failures are identified by exact file, reason and count, never claimed as passing or used to waive an in-scope gate. Dependencies: none.
- [X] T002 [P] Run mandatory Spec Kit Analyze before any production implementation. Owner: independent planning reviewer. Reuse the accepted S1/S2 Analyze closure; independently Analyze the scope-amendment delta (US4, FR-018–023, SC-008–010, T017–T022 and changed integration/gates) before edits. Analyze `specs/013-fix-tls-ca-badge/spec.md`, `plan.md`, `tasks.md`, `research.md`, `data-model.md`, `contracts/ca-badge-server-context.md` and `quickstart.md` for requirement coverage, consistency and scope. Acceptance: zero unresolved blocking findings, or implementation is blocked with the exact contradiction returned. Dependencies: none; may run in parallel with T001.

**Checkpoint**: Baseline evidence exists and Analyze is clear. No production implementation may start before both are complete.

---

## Phase 2: S1 — Health observation identity (Priority: P2 user story US3; foundational for US1/US2 truthfulness)

**Goal**: Make the existing health owner reject stale observations exactly: listing incarnations distinguish discarded/recreated slots, probe acceptance requires exact current attempt equality, attempts stay increasing while a slot is listed, retry waiters remain correct, and cache identity is bounded and collision-free.

**Independent Test**: Drive the existing health state machine and real driver with controlled promises through initial checking, accepted answers, remove/relist, credential replacement, retry waiters, refresh and cache reuse. No UI is required for S1 acceptance.

### Implementation for S1

- [X] T003 [US3] Implement listing-incarnation identity and exact-attempt probe acceptance in `packages/app/src/runtime/server/health-machine.ts`, with deterministic coverage in `packages/app/src/runtime/server/health-machine.test.ts`. Owner: S1 health implementer. Add `incarnation` to slots and carry it through probe effects and `probe.settled`; accept a probe only on exact current key, slot type, incarnation and attempt equality; reject non-exact completions before state update or listener notification; keep `answeredSince` exclusively as the retry-waiter completion predicate. Preserve increasing attempts while a slot remains listed, including endpoint/credential transitions; reset to attempt 1 only when remove/relist recreates the slot. Cite `data-model.md` `Verified server answer and incarnation.incarnation`, `Verified server answer and incarnation.attempt`, `Verified server answer and incarnation.endpoint`, `Verified server answer and incarnation.type`, `Verified server answer and incarnation.result`, `Verified server answer and incarnation.tlsCaMode`, and invariants H1-H5 and H7. Allocate a pure state counter; preserve it in every state constructor. Staged→ready creates a new endpoint incarnation even with unchanged credentials. Tests must cover stale successful `bundled`, stale unauthorized, zero stale notifications, exact-attempt mismatch rejection, current answer acceptance, and a pending retry waiter after credential replacement settling on the current accepted answer. Acceptance: those cases are deterministic and fail against pre-correction behavior where applicable; every existing health-machine assertion remains. Dependencies: T001, T002.
- [X] T004 [US3] Carry incarnation through the real driver and make the 750 ms cache identity bounded and collision-free in `packages/app/src/runtime/server/health.ts`, with deterministic cache/HTTP coverage in `packages/app/src/runtime/server/health.test.ts` and real-driver coverage in `packages/app/test-browser/ssh-health.test.ts`. Owner: S1 health implementer. Dispatch `probe.settled` with the exact incarnation and attempt. Implement the exact scope/checker seam in internal contract §5: `createServerHealth` passes `{ key, incarnation }` as second checker argument; `useServerHealth` creates one owner-local `createServerHealthChecker` and registers disposal; `useCheckServerHealth()` retains its one-argument non-owner API. Key by instance lifetime plus JSON tuple `[key, incarnation, endpointCredentials(http)]`. Guard expiry/settlement, clear owner entries/timers on disposal, prevent late reinsertion and preserve legitimate coalescing. Test staged→ready reuse at the same endpoint, remove/relist, credential replacement and actual driver notifications; keep old one-argument fakes and auth assertions. Cite `data-model.md` `Verified server answer and incarnation.incarnation`, `Verified server answer and incarnation.attempt`, `Verified server answer and incarnation.endpoint` and invariant H6. Tests must use controlled promises for old-incarnation rejection before listener notification, exact-attempt acceptance, no cross-incarnation/owner/key coalescing, TTL/owner-disposal cleanup, same-lifetime coalescing, non-owner endpoint-keyed consumers, and unchanged authentication. Acceptance: all cases deterministic; existing driver assertions remain; no new store, poller or request path. Dependencies: T003.
- [X] T005 [US3] Run the focused S1 health acceptance gate. Owner: S1 gate runner. Run the health tests from `quickstart.md` §2 against `packages/app/src/runtime/server/health-machine.test.ts` and `packages/app/src/runtime/server/health.test.ts`, plus the browser-condition `test-browser/ssh-health.test.ts` gate in quickstart §2, `bun run --cwd packages/app typecheck` and `bun run --cwd packages/app test:harness`. Acceptance: exact exit codes and pass/fail counts recorded; no in-scope failure; existing assertions preserved; only S1 files changed. Dependencies: T003, T004.
- [X] T006 [US3] Perform the independent S1 acceptance review. Owner: independent acceptance reviewer, not an S1 author. Review the S1 diff and evidence against FR-009, FR-010, FR-015, SC-003 and SC-006. Verify exact-incarnation/exact-attempt probe acceptance, `answeredSince` used only for retry waiters, increasing attempts across credential replacement, remove/relist stale rejection, zero stale notifications, bounded cache identity/cleanup, no collision across owner lifetimes/keys, unchanged polling/auth, and no competing health owner. Affected: `packages/app/src/runtime/server/health-machine.ts`, `health.ts`, their tests and `packages/app/test-browser/ssh-health.test.ts`. Acceptance: written PASS or concrete blocking findings; the reviewer makes no edits. Findings return to T003/T004, then T005 and T006 repeat. Dependencies: T005.

**Checkpoint**: S1 accepted. Health truthfulness is deterministic before context wiring builds on it.

### S1 implementation evidence (T003–T005)

**Preflight and baseline**: HEAD `2cf7eb27e02e583347978fd25bcd9eac27ff026b`. `git diff --stat e21900d938f805d3ab3f1e65e2568966eff8bc1a HEAD` is empty outside `specs/013-fix-tls-ca-badge/`, so every repository input matches the accepted T001 baseline tree. All five accepted S1 SHA-256 values matched exactly: `health-machine.ts bd6c8569…f27f`, `health-machine.test.ts cb53b5fa…1c23`, `health.ts 39c7107f…21dc`, `health.test.ts fd7f49cf…573f`, `test-browser/ssh-health.test.ts 1b4f13c1…f18a`. `checklists/requirements.md` has 17/17 items checked. No `.specify/extensions.yml` exists, so no extension hooks were registered.

**T003 — listing incarnation and exact acceptance (`health-machine.ts`)**

- `ServerHealthState.nextIncarnation` starts at 1 and is allocated only by `synced`/`listed`; every slot variant, probe effect and `probe.settled` event carries `incarnation`. `polled`, `retried` and `settle` preserve the counter, and disposal clears entries/waiters without resetting the sequence.
- `answered` accepts only an exact key, `checking`/`refreshing` slot type, incarnation and attempt. `answeredSince` is unchanged and remains exclusively the retry-waiter completion predicate (`slot.attempt >= target`). Selectors, result objects, CA interpretation, notification payload, public health record and the 10-second poll are unchanged.
- Remove/relist allocates a new incarnation and restarts at attempt 1; changed URL/password allocates a new incarnation and increments the listed slot's attempt; staged→ready at identical credentials allocates a new incarnation and increments the attempt; unchanged/managed-only changes allocate nothing.
- Pre-correction red evidence, captured immediately after appending the decisive regression and before implementing T003: `bun test --conditions=solid --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src/runtime/server/health-machine.test.ts -t "remove/relist rejects a discarded probe"` exited `1`, with `2 fail`, `16 filtered out`, `2 expect()` calls. Both cases failed at `expect(late.state).toBe(relisted.state)`: the discarded completion produced a `settled` slot (`{ type: "healthy", tlsCaMode: "bundled" }` and `{ type: "unauthorized" }`) instead of leaving the recreated slot `checking`.
- Every synthetic `answered(name, attempt, result)` event was migrated to the actually dispatched `probeEffect`/`answerFrom`; stale completions retain their original dispatched effect, and multi-dispatch scenarios capture each batch separately. All 16 pre-existing cases and 56 assertions remain. Eight decisive cases were added (including the two remove/relist cases above): exact attempt mismatch at attempts 0 and future 2 while the incarnation matches; credential replacement with increasing attempts and old-completion rejection; pending retry resolving on the accepted replacement attempt ≥ target; staged→ready at identical credentials; unchanged refresh retaining verified CA mode. Machine file: **24 pass, 0 fail, 87 expect() calls**.
- Entities: `Verified server answer and incarnation.incarnation`, `.attempt`, `.endpoint`, `.type`, `.result`, `.tlsCaMode`. Invariants H1–H5 and H7.

**T004 — real driver and scoped cache (`health.ts`)**

- Added `HealthProbeScope`, `HealthChecker` and `createServerHealthChecker(fetcher)`. `createServerHealth` now accepts `HealthChecker`, dispatches `probe.settled` with the effect's exact `incarnation` and `attempt`, and passes `{ key, incarnation }` as the checker's second argument. `useServerHealth` creates one owner-local checker and registers `onCleanup(checker.dispose)`. `useCheckServerHealth()` and the non-owner controller call site are unchanged, retaining the one-argument endpoint-credential API.
- The checker owns a lifetime-local map, a disposed flag and per-entry promise/expiry/timer. Keys are `JSON.stringify([key, incarnation, endpointCredentials(http)])` (attempt deliberately excluded). Lookup reuses only a current entry whose stored expiry is still in the future; expired entries and timers are removed before replacement. New entries expire at start + 750 ms; completion extends retention to completion + 750 ms only while the owner is live, the same entry is current and the stored expiry has not passed. Each expiry callback identity-checks its entry, so an older timer cannot delete a replacement. Disposal cancels every timer, clears the map, blocks new requests and prevents late settlement from reinserting or retaining anything. No polling interval or request path was added.
- `health.test.ts`: all 9 pre-existing HTTP/auth/timeout/retry cases and 16 assertions remain; 7 deterministic cache cases were added (same-scope coalescing; no sharing across incarnations, keys, owners or credentials; bounded completion retention; actual expiry plus late-answer non-renewal; expired entry cannot replace a newer promise; disposal timer cancellation/late reinsertion). Result: **16 pass, 0 fail, 47 expect() calls**. Timer/clock globals are restored in `finally`; no wall-clock sleeps.
- `test-browser/ssh-health.test.ts`: all 4 pre-existing driver cases and 16 assertions remain; 8 controlled cases were added (discarded bundled and unauthorized remove/relist answers; staged→ready at identical credentials; credential replacement during retry; disposal with retry-after-dispose and late answer; one-argument checker compatibility; real `createServerHealthChecker` remove/relist regression; non-owner endpoint coalescing). The real-cache case passes the cache checker to the real driver, proves remove/relist starts a second request, ignores the discarded bundled answer, emits no stale notification, and accepts only the new system answer with exactly one notification. Result: **12 pass, 0 fail, 72 expect() calls**.
- Entity: `Verified server answer and incarnation.incarnation`, `.attempt`, `.endpoint`. Invariant H6.

**T005 — focused acceptance gates**

| Command (from stated directory) | Exit | Evidence |
|---|---|---|
| `cd packages/app && bun test --conditions=solid --only-failures --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src/runtime/server/health-machine.test.ts ./src/runtime/server/health.test.ts` | 0 | 40 pass, 0 fail, 134 expect() calls, 2 files |
| `cd packages/app && bun test --conditions=browser --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./test-browser/ssh-health.test.ts` | 0 | 12 pass, 0 fail, 72 expect() calls |
| `bun run --cwd packages/app typecheck` | 0 | No type errors in 2,433 files across 1 project |
| `bun run --cwd packages/app test:harness` | 0 | 3 pass, 0 fail, 22 expect() calls |
| `git diff HEAD --check` | 0 | No whitespace errors |

Only the five S1 source/test files in the task scope changed; this tasks document records the evidence. No S2, S3 or S4 work was started; T006 is not marked complete; no full app/SDK/Core/CLI/Playwright baseline was rerun; no Git index, staging or commit operation was performed. **Original implementation report; coordinator test-only corrections and revalidation follow below.**

---

## Phase 3: S2 — Authoritative context, titlebar integration and runtime acceptance (Priority: P1 user stories US1 and US2)

**Goal**: Restore the badge's current-server ownership through the existing session, draft, Home, project-navigation and Settings owners; preserve healthy-only presentation and exact identity isolation; prove the complete three-identity and runtime behavior.

**Independent Test**: Run the production-app fixture and e2e keeper with three actual identities, controlled Home hydration and route/Settings switching, then repeat in development and compiled modes. Every step must show only the destination identity's healthy answer.

### Implementation for S2

- [X] T007 [US1] Add the route-lifetime Home key-accessor binding in `packages/app/src/shell/state/layout.tsx`, bind it in `packages/app/src/home/route.tsx` and `packages/app/src/home/projects/landing.tsx`, and cover it in `packages/app/src/shell/state/layout.test.ts`. Owner: S2 context implementer. Expose `layout.home.focusedServer()` and `bindFocusedServer(accessor)` accepting `Accessor<ServerConnection.Key | undefined>`; store only a reactive accessor reference using the exact `createHomeServerBinding` helper in plan. In `HomeOverview`, bind a read-only projection `() => { const connection = home.server.focused(); return connection ? ServerConnection.key(connection) : undefined }` and register cleanup with `onCleanup`. In `EmptyProjects` bind the guarded key projection of its existing `action.target().connection`, including a resolved loading target, with identical cleanup. Cite `data-model.md` `Home focused accessor binding.focusedServer`, `Home focused accessor binding.bindFocusedServer` `Home focused accessor binding.focusedConnection`, `Home focused accessor binding.layout.home.focusedServer()`, `Server identity.connection` and `Server identity.key`. Acceptance: reader-before-binding observes binding and subsequent key changes; same-accessor rebinding and stale cleanup cannot clear newer binding; project Home target/fallback is used; hydration override is visible without persistence; an undefined focused connection yields `undefined`; cleanup removes only its own binding and never a newer one; no Home selection, persistence or worktree behavior changes. Dependencies: T006.
- [X] T008 [US1] Implement exact Settings context ownership in `packages/app/src/settings/route.ts`, `packages/app/src/settings/shell.tsx`, `packages/app/src/settings/surface.tsx` and `packages/app/src/settings/route.test.ts`. Owner: S2 settings implementer. Keep one canonical five-tab server-scoped definition (`projects`, `workspaces`, `providers`, `models`, `extensions`) consumed by the page owner and selector. Project view uses exact `view.server`; server-scoped root uses `surface.server()?.key`; other pages use the captured source-context server. `SettingsSurface.show(view)` captures source via `layout.home.focusedServer()` for both Home layouts, route server for session, matching draft tab for draft, otherwise undefined; writes `sourceKey?: ServerConnection.Key | null` (null explicitly unresolved) into existing state before `navigate()`. Preserve captured key/null across replacements; only missing legacy capture uses existing source resolution. `sourceServer()` reads captured value before old fallback while open. Cover both Home variants and explicit unresolved vs legacy. Do not add a navigation owner in `packages/app/src/settings/command.tsx`; do not call `useProjectStart` from the surface. Cite `data-model.md` `Settings view context.view`, `Settings view context.selectedRoot`, `Settings view context.project`, `Settings view context.source` and invariants C2-C4. Acceptance: exact project identity never falls back through inventory; root/source/general cases pass; redirects, page availability and navigation lifecycle remain; explicit unresolved yields unknown while legacy state keeps existing resolution. Dependencies: T007.
- [X] T009 [US1] Integrate the titlebar context selector in `packages/app/src/shell/titlebar/titlebar-ca-badge.ts`, `packages/app/src/shell/titlebar/titlebar.tsx` and `packages/app/src/shell/titlebar/titlebar-ca-badge.test.ts`. Owner: S2 titlebar implementer. Add pure `selectCaBadgeServer`: session route server, resolved draft server, Layout-bound Home key for both layouts (including project-navigation resolved loading), or Settings visible-surface context; otherwise `undefined`. Perform exactly one exact-key lookup into `global.servers.health` through the existing healthy-only `selectServerTlsCaMode`, then the existing mapping. No fallback, readiness gate, fetch, timer or CA inference. Keep markup, labels, colours, tooltip, `role="status"` and the `!props.verticalTabs` guard unchanged. Cite `data-model.md` `CA badge presentation` `Current server context`, `Server identity.key`, `Server identity.health` and `Verified server answer and incarnation.tlsCaMode`. Acceptance: route matrix, unlisted/removed route, healthy-only bundled/system/unknown, and exact 4096/4097/sidecar keys pass; badge rendering adds no probe. Dependencies: T007, T008.
- [X] T010 [US1] Add the production-app three-identity fixture in `packages/app/e2e/utils/tls-ca-badge.fixture.tsx`, its HTML entry `packages/app/e2e/utils/tls-ca-badge.html`, fixture-only Vite input in `packages/app/vite.config.ts`, and mandatory mock mode control in `packages/app/e2e/utils/mock-server.ts` (value remains optional to test older servers). Owner: S2 fixture implementer. Use the existing `AppInterface` servers/router fixture architecture with the real titlebar, registry and health path. Follow `app-direction.html` module mount and `settings-wsl.fixture.tsx` held async storage; add HTML to existing `VITE_OPENCODE_TEST_FIXTURES === "1"` Vite inputs. Extend `MockServerConfig` and its info handler; controlled `/api/info` overrides support held/changed/unauthorized answers and per-identity request counts. Use distinct test credentials when sidecar and HTTP alias share URL. Provide the actual identities 4096, 4097 and `{ type: "sidecar", variant: "base", http: { url: endpoint } }` whose `ServerConnection.key()` is `"sidecar"` independent of URL. Cite `data-model.md` `Server identity.key` and `Verified server answer and incarnation.result`. Acceptance: fixture supports controlled initial Home resolution, hydration override, persistence completion, owner cleanup and per-identity health answers; both Home layouts and fixture HTML work in built mode; production build entries/behavior unchanged without fixture flag. Dependencies: T009.
- [X] T011 [US2] Add the production-wiring e2e keeper in `packages/app/e2e/regression/tls-ca-badge.spec.ts`. Owner: S2 e2e implementer. Cover: tabless Home with bundled/system/unknown; empty database; session-before-tab; draft; Settings project exact identity, server-scoped root and general/source; three actual identities; Home hydration override/persistence; two servers with the same mode followed by destination-only invalidation; removed-route identity; stale health loss/recovery; request accounting proving zero added `/api/info` probes; and identical development/compiled outcomes. Explicitly cover healthy missing mode, unresolved draft→resolved, Home A→session B→Home A, destination checking→accepted, Settings select A→return B, same-endpoint sidecar/HTTP alias, both Home layouts opening Settings before persistence or during resolved project loading, initial answer without navigation, refresh retention and unauthorized/credential invalidation on tabless and session routes. Assert label, CSS state, tooltip and status role; compare request/poll/auth/retry counts over equal controlled intervals. Cite `data-model.md` `Current server context`, `CA badge presentation` and `Verified server answer and incarnation.tlsCaMode`. Acceptance: each multi-server, removed-route, same-mode and empty-state case fails decisively against pre-correction behavior where applicable and passes after; existing multi-server assertions remain. Dependencies: T010.
- [X] T012 [US2] Run the complete S2 runtime gate. Owner: S2 gate runner. Run `bun run --cwd packages/app test:harness`; `bun run --cwd packages/app typecheck`; `bun run --cwd packages/app typecheck:e2e`; `bun run --cwd packages/app test:unit`; `bun run --cwd packages/app test:e2e -- --project=chromium regression/tls-ca-badge.spec.ts`; `bun run --cwd packages/app test:e2e -- --project=chromium regression/multi-server.spec.ts`; and `PLAYWRIGHT_BUILD=1 PLAYWRIGHT_WORKERS=1 bun run --cwd packages/app test:e2e -- --project=chromium regression/tls-ca-badge.spec.ts`. Acceptance: exact exits/counts recorded; all in-scope gates pass; existing assertions preserved; development and compiled outcomes match. Dependencies: T011.

### S2 implementation evidence (T007–T012)

**Preflight and scope**: actual HEAD `f79a1fb8591753c9325abb9645edcea55c089ba6` is the accepted S1 commit above planning commit `2cf7eb27e02e583347978fd25bcd9eac27ff026b`; T001–T006 are checked. `git diff HEAD` leaves all five accepted S1 files byte-identical. No Git index/history writes, staging, reset, stash or destructive restoration was performed.

**T007 — Home focused accessor binding.** `LayoutProvider` now creates one `createHomeServerBinding()` and exposes `home.focusedServer()` plus `home.bindFocusedServer(accessor)`. The binding stores only a reactive accessor wrapper; cleanup is identity-checked so a stale binding cannot clear a newer one, including a repeated binding of the same accessor. `HomeOverview` binds `() => home.server.focused()` through `ServerConnection.key`, and `EmptyProjects` binds `action.target().connection` without checking `target().type`, so a resolved loading target keeps its authoritative server. No selection, fallback, persistence or worktree owner changed. `layout.test.ts` adds three Solid reactive-reader cases covering reader-before-binding, key changes, explicit undefined, B-after-A, same-accessor rebinding, stale cleanup, current cleanup and owner cleanup. Entities: `Home focused accessor binding.focusedServer`, `.bindFocusedServer`, `.focusedConnection`, `.layout.home.focusedServer()`, `Server identity.connection`, `Server identity.key`. FR-001/002/007; SC-001/002.

**T008 — Settings visible context.** `settingsServerTabs` is the single canonical five-tab list in `settings/route.ts`; `isSettingsServerView` and `selectSettingsContextServer` select project → exact project key, server-scoped root → selected root, other pages → captured source. `settings/shell.tsx` consumes the shared list. `SettingsSurface` adds `sourceKey?: ServerConnection.Key | null` to existing navigation state, reads it before legacy source resolution while Settings is open, computes `contextServer`, and captures the source before each `navigate()`: current Settings reuses `sourceServer()` (preserving prior null/concrete), while a new open uses session/draft/Home context. Missing `sourceKey` keeps legacy resolution; `null` remains explicitly unresolved. `route.test.ts` retains all round-trip/transient/redirect/availability assertions and adds the five-tab order, all client/server/project page cases, exact missing project identity and undefined root/source cases. Entities: `Settings view context`, `Current server context`, invariants C1–C4. FR-003/004/005/011/012; SC-001/002/005/007.

**T009 — Titlebar route ownership.** `selectCaBadgeServer` is a pure route switch: session → exact `route.server`, draft → resolved draft key only, Home → Layout binding, Settings → `settingsSurface.contextServer()`, connect/components → undefined. The titlebar performs one exact-key health lookup through the unchanged healthy-only `selectServerTlsCaMode` and mapping, with no fallback, readiness check, fetch, timer or inference. Markup, tooltip, classes, `role="status"` and the `!props.verticalTabs` guard are unchanged. `titlebar-ca-badge.test.ts` retains all five mapping tests and adds the route matrix, removed-route unknown, healthy bundled/system/missing-mode, checking, starting, unauthorized, incompatible and unreachable cases. Entities: `Current server context`, `CA badge presentation`, `Verified server answer and incarnation.tlsCaMode`. FR-006/008/013/014; SC-003/004/007.

**T010 — Production fixture.** `tls-ca-badge.fixture.tsx` mounts the real `AppInterface`/MemoryRouter with HTTP A `http://127.0.0.1:4096`, HTTP B `http://127.0.0.1:4097` and sidecar key `sidecar` on endpoint A, with distinct passwords. Controls change the provided registry list, credential A and MemoryRouter path; async storage holds layout/tabs/plugin inventory and records actual layout writes. A minimal desktop bridge exposes main's empty plugin GUI list and an empty SSH subscription so the real startup gate can settle; the health lifecycle uses the web platform to keep the separate terminal capability `/api/info` owner out of identity-level holds. `tls-ca-badge.html` follows the existing module-mount pattern and is added only to the `VITE_OPENCODE_TEST_FIXTURES === "1"` Vite input. `mock-server.ts` adds optional `tlsCaMode` and preserves the base info version/PID/URLs/paths. Same-origin alias control identifies A and sidecar by Basic auth, counts each independently, skips OPTIONS and returns controlled optional modes.

**T011 — Deterministic keeper.** `tls-ca-badge.spec.ts` covers tabless Home checking → bundled, B system, sidecar unknown, Home focus, tooltip/classes/role, session-before-tab, exact B while metadata held, unresolved and resolved draft, removed route unknown, Settings captured source, server-scoped page A vs captured B, exact project A, readiness-held project removal (exact path stays `/settings?...project=/work/a` with `CA:UNKNOWN`, then release redirects to `/settings?tab=projects` and sidecar's verified `CA:SYSTEM`), explicit-unresolved source through replacements, missing legacy source, both Home hydration lifecycles, project-navigation resolved loading target with hidden vertical badge and retained Settings capture, refresh retention, same-label B-only invalidation/recovery, shared-endpoint sidecar isolation, credential replacement, remove/relist pending rejection, and request accounting. Initial stable Home makes exactly one `/api/info` observation per identity. The session→Settings cycle adds exactly one B terminal-capability support request and no badge probe; repeated cycles and returning Home add none. Comparative built diagnostic: corrected and old selectors both reported before `{a:1,b:1,sidecar:1}`, after Settings `{a:1,b:2,sidecar:1}`, after repeat `{a:1,b:2,sidecar:1}`, exit 0, so the badge change adds zero requests. Entities: `Current server context`, `CA badge presentation`, `Verified server answer and incarnation.tlsCaMode`, `Server identity.key/health`. FR-006–010/013–015; SC-003–007.

**Decisive old-selector negative evidence.** A bounded built-mode run replaced only the titlebar CA memo with the exact pre-correction `currentTab()?.server` selector. Both selected cases failed with exit 1 at the initial tabless Home badge assertion (`CA:BUNDLED` expected, `CA:UNKNOWN` observed). This proves the tabless Home defect; it did not independently reproduce every downstream route defect. The pre-run file was restored from backup, and the later comparative diagnostic wrapper verified the titlebar SHA-256 was identical before/after (`18c6eb0a6ea01f91d2de390d7d6be0d1815a5aef3b29fc25503a5e6352fc7c5e`).

**T012 gates (final inputs)**

| Command | Exit | Observed |
|---|---:|---|
| targeted `layout.test.ts` + `route.test.ts` + `titlebar-ca-badge.test.ts` | 0 | 39 pass, 0 fail, 156 expects |
| `bun run --cwd packages/app test:harness` | 0 | 3 pass, 0 fail, 22 expects |
| `bun run --cwd packages/app typecheck` | 0 | 2,433 files, no type errors |
| `bun run --cwd packages/app typecheck:e2e` | 0 | No diagnostics (baseline exit 2 / 189) |
| `bun run --cwd packages/app test:unit` | 0 | 2,835 pass, 0 fail, 10,220 expects, 277 files |
| dev `regression/tls-ca-badge.spec.ts` | 0 | 10 pass |
| `regression/multi-server.spec.ts` | 0 | 11 pass (baseline 5 pass / 6 fail) |
| built `PLAYWRIGHT_BUILD=1 PLAYWRIGHT_WORKERS=1 ... tls-ca-badge.spec.ts` | 0 | 10 pass (same fixture identities, explicit ports) |
| targeted composer free/Go limits | 0 | 3 pass |
| review context/cost compaction fixture | 0 | 1 pass |
| timeline compaction + working animation | 0 | 3 pass |
| settings background activity alignment (en/ar) | 0 | 2 pass |
| session-panel scrollbar (reduced motion false/true) | 0 | 2 pass |
| `git diff HEAD --check` | 0 | No whitespace errors |

**Baseline harness disposition.** E2E typecheck now includes `vite/client`; the two outdated composer defaults were replaced with `providerID`/`modelID`; four obsolete compaction `recent` fields were removed; the activity `pageMessages` callback is contextually typed as `SessionMessageInfo[]`; one unused scrollbar locator was removed; the animation listener is an `Event` with an `AnimationEvent` guard; and multi-server/settings use platform-aware `mod+,` (plus `mod+]` in the existing history assertion). No residual non-ambient E2E diagnostic remains. Existing assertions were preserved; the only changed test mechanics are the baseline corrections above.

**Remaining scope.** T013 (final embedded artifact smoke) remains pending after S4/T021. T014 independent acceptance remains open and was not executed in this slice. No S3/S4 work, embedded build, SDK/Core/CLI baseline rerun or convergence was performed.

### Coordinator HOLD remediation (T010–T012 evidence refresh)

**Scope and provenance.** The accepted S1 commit remains `f79a1fb8591753c9325abb9645edcea55c089ba6`. The planning file was committed by the coordinator as `dc9dba589e` before this correction run, which changes only the base of `git diff HEAD`; every S1 file still matches `f79a1fb`. This run changed only `packages/app/e2e/regression/tls-ca-badge.spec.ts`, `packages/app/e2e/utils/tls-ca-badge.fixture.tsx` and this evidence file. Production T007–T009, all prior harness corrections, `mock-server.ts`, the Vite input and both HTML/fixture identities are unchanged. No Git index/history writes, staging, reset, stash or production edit was performed.

**MemoryRouter and capture assertions.** The captured-source test now reads the application path from `window.__tlsCaFixture.path()`: after selecting A's Models page and returning to Preferences it is `/settings?server=<A>&tab=general`; after Back to app it is session B's exact route. The hydration comment now states that Home has unmounted, so releasing storage restores stored A while Settings retains captured B. Badge assertions are unchanged.

**Empty database and destinations.** `setup` accepts `empty?: boolean`; both HTTP servers then receive `sessions: []` and `projects: []` while keeping the valid directory and location. A new independent case asserts real tabless Home with `CA:BUNDLED`, the empty project and session inventories (`Nothing here yet`, no project/session rows), Settings retaining bundled with no session, then Home focusing Server B and Settings retaining system. The draft case now runs on the empty inventory too. The first Home case holds B's initial `/api/info` response, shows accepted A bundled, focuses checking B through B's real Add project action (the server row itself is disabled while checking), observes `CA:UNKNOWN`, releases B and observes `CA:SYSTEM` in place. All three tooltips are exercised.

**Project-navigation ownership.** The test seeds an absent stored server `http://127.0.0.1:4999`. While the real A `/api/project` is held, the tabless project-navigation loading action names Server A in its containing region, the vertical titlebar has no badge, and the stored selection still names the absent server. Opening Settings from the sidebar and switching to top tabs shows captured A `CA:BUNDLED` after Home unmounts. No selection was injected and the production visibility guard was not changed.

**Explicit null.** The unresolved-source test now seeds the real draft B under `missing-draft` while the tabs store is held. Settings opens from the vertical sidebar with `sourceKey: null`. Hydration then resolves the actual draft to B and the new read-only fixture accessors prove B is healthy with system mode; the captured Settings context remains `CA:UNKNOWN` through Appearance and Preferences replacements. Missing legacy state remains a separate case.

**Credential invalidation and health.** Tabless Home now establishes accepted A system, changes its controlled answer to 401 on the existing poll, observes exactly one unauthorized request in the next window and no authentication retry within the window, then restores success and recovers system. A Home credential replacement with held response shows `CA:UNKNOWN` before release and `CA:SYSTEM` after. B-only invalidation, accepted refresh retention and sidecar isolation remain. The final coverage delta below restores the same-mode Home refresh and the session-route credential replacement.

**Late-response boundary.** `AliasGate.arrived` now resolves with `route.request()`. In remove/relist the test waits for every `/api/info` request to settle, then arms the gate on a session A route with no preceding credential change, retains that exact request and registers `page.waitForEvent("requestfinished", request === oldRequest)` before releasing the discarded answer. `Promise.all([old.done, finished])` then proves the response completed while the new incarnation's `CA:BUNDLED` remains. The accepted S1 real-driver tests remain the direct proof of rejection at the health owner's settlement boundary.

**Presentation and request accounting.** `expectBadge` now checks the matching foreground class (`text-v2-state-fg-success|warning|danger`) as well as the background class, and the first Home sequence checks the bundled, system and unknown tooltips. The desktop short-window cycle retains `{a:1,b:2,sidecar:1}`. The web full-poll case first settles its startup observations and the terminal capability owner's support check, takes that exact baseline, then asserts one `/api/info` observation per identity in each full 10-second window and no addition from the Home/session/Settings cycle. Development and compiled runs both pass. The web fixture still performs the one session-entry terminal support check, so it is included in the baseline rather than assumed absent.

**Independent old-selector cases.** Two cases start independently of Home: a direct session B route with metadata held and no tab, and a resolved session B followed by Settings. A bounded development run substituted only the exact old `currentTab()?.server` titlebar memo. Exit was 1: both cases expected `CA:SYSTEM` and observed `CA:UNKNOWN`, at the direct session badge and at the Settings B badge respectively. The file was restored byte-for-byte (SHA-256 before/after `18c6eb0a6ea01f91d2de390d7d6be0d1815a5aef3b29fc25503a5e6352fc7c5e`). The earlier built Home negative evidence remains.

**Final gates (this evidence refresh)**

| Command | Exit | Observed |
|---|---:|---|
| `bun run --cwd packages/app typecheck:e2e` | 0 | No diagnostics |
| development `regression/tls-ca-badge.spec.ts` (pre-delta, retained) | 0 | 14 pass |
| `PLAYWRIGHT_BUILD=1 PLAYWRIGHT_WORKERS=1 ... regression/tls-ca-badge.spec.ts` (pre-delta, retained) | 0 | 14 pass |
| bounded development old-selector run (two independent cases) | 1 expected | 2 failed, both `CA:SYSTEM` expected / `CA:UNKNOWN` observed |
| `git diff HEAD --check` | 0 | No whitespace errors |
| S1 files against `f79a1fb` | 0 | Empty diff |
| titlebar SHA-256 | — | `18c6eb0a6ea01f91d2de390d7d6be0d1815a5aef3b29fc25503a5e6352fc7c5e`, restored |

**Disposition.** Every coordinator HOLD correction is now covered by a decisive assertion. T010–T012 are accepted at this evidence boundary. T014 remains exclusively for the independent reviewer and was not executed; T013 remains pending the final embedded artifact after S4.

### Final S2 coverage delta

This delta changed only `packages/app/e2e/regression/tls-ca-badge.spec.ts` and this evidence. Production, fixture architecture, prior gates and all other keeper cases are unchanged; no Git writes, old-selector rerun, comparative diagnostic, full unit suite or unrelated E2E run was performed.

**Restored same-mode transition.** Before navigating from Home A to session B, the health case now proves both identities are `{ type: "healthy", tlsCaMode: "system" }` through the fixture health accessor. It keeps B's navigation, unauthorized and recovery assertions, and additionally proves A remains healthy/system while B is unauthorized. After B recovers, it returns Home, asserts system, and runs the held refresh there: the previous accepted system remains while the answer is held, the released bundled answer is accepted, and A's default answer is then set to bundled. This restores the actual same-mode Home refresh seam before the sidecar and remove/relist sequence.

**Restored session credential replacement.** At the end of the case the session A route remains open. After pending `/api/info` requests settle, the badge is bundled on `routes.sessionA`. The test installs a `holdRoute` barrier on endpoint A's `/api/info` GET, which holds every matching request rather than one queued response, then replaces A's password with `fixture-a`. While held it asserts the health record is `{ type: "checking" }`, the badge is `CA:UNKNOWN`, and the path is still `routes.sessionA`; the release runs in `finally`. After release it asserts `CA:SYSTEM`, healthy/system on A, and the same session path. It deliberately does not assert one total endpoint request, because the terminal capability owner may legitimately share that endpoint. The Home exact-request assertion and separate request-accounting cases remain unchanged.

**Final delta gates**

| Command | Exit | Observed |
|---|---:|---|
| `bun run --cwd packages/app typecheck:e2e` | 0 | No diagnostics |
| development affected `health lifecycle keeps accepted answers` | 0 | 1 pass |
| built `PLAYWRIGHT_BUILD=1 PLAYWRIGHT_WORKERS=1 ... health lifecycle keeps accepted answers` | 0 | 1 pass |
| `git diff HEAD --check` | 0 | No whitespace errors |
| prior complete development keeper | 0 | 14 pass, retained |
| prior complete built keeper | 0 | 14 pass, retained |

- [X] T014 [US2] Perform the independent S2 acceptance review. Owner: independent acceptance reviewer, not an S2 author. Review S2 against FR-001 through FR-008, FR-011 through FR-014 (S2 portion), SC-001 through SC-005 and SC-007. Verify exact Home/Settings/session/draft ownership, three actual identities, Home hydration, same-mode destination invalidation, removed-route unknown, exact Settings project identity, healthy-only presentation, unchanged accessibility/visibility, zero added probes, development/compiled parity and retained assertions. Affected: S2 source files, `packages/app/e2e/utils/tls-ca-badge.fixture.tsx`, `packages/app/e2e/utils/tls-ca-badge.html`, `packages/app/vite.config.ts`, `packages/app/e2e/regression/tls-ca-badge.spec.ts` and `packages/app/e2e/utils/mock-server.ts`. Acceptance: written PASS or concrete blocking findings; the reviewer makes no edits. Findings return to the owning S2 task, then affected T012 gates and T014 repeat; T013 runs on the final embedded artifact. Dependencies: T012. Final embedded smoke T013 remains mandatory after S4.

**Checkpoint**: S2 accepted for deterministic development/built-app behavior. The final embedded smoke remains required after S4.

---

## Phase 4: S3 — CLI bootstrap runtime isolation (US4)

- [X] T017 [US4] Implement FR-020–023 bootstrap/verifier corrections and explicit recovery propagation from FR-018 at `packages/cli/src/bootstrap.ts`, `packages/util/src/tls-ca.ts`, and the existing pure flag allowlist in `packages/cli/src/util/process.ts` where necessary. Reuse strict parser, verifier, protected entrypoints and one recovery path. Keep the old ordinary selection fallback until T020 changes it together with self-launch propagation. Explicit selected mode in recovery, exact source/native user arguments, clean-only verified fast path, actual live environment deletion, sanitized/rejected dirty launch, no arbitrary hook/inspector replay; preserve required flags, marked single inspector and exact effective trust-set checks. Cite `data-model.md` `TLS launch.selectedMode`, `TLS launch.verifiedMode`, `TLS launch.applicationArgs` and `TLS launch.environment`. Add negatives to `packages/cli/test/tls-ca-mode.test.ts`, `tls-ca-mode.integration.test.ts` and existing fixtures: process-level malformed selector/no output; dirty option isolation; source replay/recovery; empty override deletion; system retention; failed verifier never publishes, guarded imports/unverified commands, input immutability, marked inspector. Distinguish native recovery proof deferred to T021. Acceptance: actual source regressions reproduced and corrected, existing assertions preserved, no unverified production graph/listener. Dependencies: T014. Also implement FR-011 embedded SDK disposition: `packages/util/src/tls-ca.ts` optional read-only attestation accessor; `packages/server/src/server-info.ts` embedded-only optional metadata layer; `packages/server/src/routes.ts` select it only via existing `embedded` branch. Strict getter, listener guard in `packages/server/src/process.ts` and verified listener metadata unchanged. Add fresh-process public Promise/Effect SDK tests without verification preload, successful requests, absent unattested mode and exact attested mode; preserve prior SDK and forged-listener assertions. No host TLS mutation, fake default or global optional listener guard. Source per-key cleanup must preserve permitted system `SSL_CERT_DIR` and verification `1`, remove verification `0`; cover empty bundled override keys.
- [X] T018 [US4] Run S3 focused gates: quickstart §8 CLI TLS unit/integration, affected CLI/util typechecks and existing server process test; record exact exits/counts and preserved assertions. Acceptance: no in-scope failure; controlled source paths decisive. Dependencies: T017. Also run full `bun run --cwd packages/sdk test`, affected server/SDK typechecks and fresh-process SDK coverage; all ten historical SDK attestation failures must be corrected, not waived or preloaded.
- [X] T019 [US4] Independent S3 acceptance review of T017/T018 against FR-020–023, explicit recovery from FR-018 and SC-009 (source scope). Verify current source and negative assertions, no silent policy widening, no stale mode publication, no runtime flag replay or argv corruption. Artifact-specific evidence remains T021. Acceptance: PASS or concrete HOLD; no edits; repeat affected evidence only after a correction. Dependencies: T018. Review the embedded-only SDK disposition against FR-011/023 and SC-009; confirm absence is honest and strict listener rejection/verified reporting and all SDK assertions survive.

### S3 implementation evidence (T017–T018)

**Preflight and scope**: the supplied review capture was `7cc1d0e1a95c830a8540cfad49c45d4a1601c266`; the actual branch HEAD at S3 execution was `4e4f1165733a9fd115b56329451135d15ec18e09`, which contains the accepted S2 commit `516ec21549` and the recorded T014 acceptance. T001–T012 and T014 were checked. `git diff HEAD -- packages/app` is empty, so no accepted App file changed. The strict listener guard, both production CLI entrypoints, `runCli`, the existing unverified-server fixture and its process test are byte-identical to HEAD.

**Embedded SDK disposition (FR-011/023, SC-009 source scope)**: `packages/util/src/tls-ca.ts` adds the read-only `getVerifiedTlsCaModeIfAvailable()` accessor without selecting, inferring or verifying a policy. `packages/server/src/server-info.ts` keeps the strict `layer` (`getVerifiedTlsCaMode`) and adds `embeddedLayer`, which projects the mode only when verification already exists. `packages/server/src/routes.ts` selects it only through the existing `embedded` argument; no caller bypass or second embedded flag was introduced. The authenticated info handler omits `tlsCaMode` with a conditional spread because the actual Effect encoder serialized `undefined` as JSON `null`; the protocol and generated clients are unchanged. The listening `ServerProcess` guard still calls `getVerifiedTlsCaMode()` before binding.

**Expected-red proof**: temporarily substituting only the original strict request-layer selection produced exit 1, 5 pass / 12 fail. The 12 failures were the ten historical SDK attestation failures plus the two new unattested fresh-process cases, all with `TLS CA mode has not been verified`. The temporary strict source hash was `f38b4e6bc7851a3e3c5f2ab3b0fdd643308011d1b3ce3246ee8f91620ec34f88`; restoration returned `25acb505fa6cf2eb4b971a34f143847c518d0bcd6b7286bdd0f0c77b2da4c0cb` and matched the pre-substitution bytes exactly. No unrelated source was substituted.

**Fresh public SDK coverage**: four isolated processes exercised Promise unattested (ambient `OPENCODE_TLS_CA_MODE=system`), Effect unattested (ambient bundled), Promise attested bundled and Effect attested system through `../../src` and `../../src/effect`. Both unattested cases performed ordinary `/api/info` requests, reported version `sdk-tls-attestation-test`, omitted `tlsCaMode` on the wire, kept the optional accessor undefined and the strict getter throwing, and left the `node:tls` default CA set unchanged. Both attested cases reported the exact verified mode before and after requests. The internal embedded `fetch` was used only as a supplementary raw-wire observation; no public SDK API was added.

**Bootstrap correction (FR-018 explicit recovery, FR-020–023)**: startup classification now runs before verification. Nonempty `BUN_OPTIONS`, `NODE_OPTIONS` or `BUN_BE_BUN` is dirty even when the effective CA set already matches; argv is classified with the runtime-specific pure allowlists, respecting `--conditions` value boundaries. Clean launches keep approved CA/CA-neutral flags; compiled Bun's baked `--smol`, user agent and `--no-warnings`, and Node SEA's baked flags, are accepted without replaying them on native recovery. Recovery rejects marked dirty launches, constructs one explicit command with the selected mode immediately after the source entrypoint or packaged executable, omits the synthetic argv entrypoint slot for packaged runtimes, validates source entrypoints, and replays only Bun's browser condition plus selected CA flag or the shared Node allowlist. One marked Bun inspector is accepted only on an otherwise clean source launch; a second inspector, preload, loader or runtime environment option rejects. Parser failures and `afterVerified` failures are not converted into recovery or retries.

**Environment and verifier**: live cleanup now faults in deletions for omitted keys: bundled removes all four certificate override keys even when empty, system retains permitted inputs including `SSL_CERT_DIR`, `NODE_TLS_REJECT_UNAUTHORIZED=1` is preserved, `0` is removed through real recovery, and markers, `BUN_OPTIONS`, `NODE_OPTIONS` and `BUN_BE_BUN` are removed without replacing `process.env` or mutating sanitizer input. The effective trust-set verifier retains exact set equality and strict publication after success. Fresh verifier subprocesses covered missing `getCACertificates`, empty bundled/default sets, a system-only root in bundled, extra roots, ambient certificate overrides, system sets missing or adding a root, disabled verification, nonpublication after every failure, and exact-union success.

**Source runtime regressions**: process-level malformed/conflicting/missing/legacy selectors against the real Bun CLI exit nonzero with parser diagnostics and zero command stdout; a valid selector reaches `--version`; direct `runCli()` without bootstrap rejects with `TLS CA mode has not been verified` and no command output. Marker, preload and callback sentinels proved initial-on-process hostile execution, sanitized recovered children, no replay, marked dirty rejection, no recursive relaunch, and no protected callback import. Mixed arguments (`command`, empty string, spaced argument, `--flag=value`, `--`, post-separator selector, literal tail) survived recovery byte-exact in Bun and Node with explicit mode bundled despite ambient system. The Node fixture is a test-owned Bun `target: "node"` ESM source bundle, not a native artifact; it ran under Node v26.12.0, loaded `node:ffi` with `--experimental-ffi`, retained conditions/warning options and reported no Bun runtime. Ordinary recovery of an unmarked inspector changed PID and dropped the inspector, while the marked Bun inspector path executed one CLI process, exited 0 with version output, emitted exactly one `Listening:` line and no EADDRINUSE or inspector-startup failure.

**Controlled HTTPS source matrix (SC-009 source scope)**: Bun and Node each obtained a service-level positive control with the fixture root, one handled HTTPS request in system mode, and a certificate-trust rejection in bundled mode after a reachable callback attempt marker. Both negative cases recorded the runtime, PID, mode and URL, captured the actual error/cause/code, and left the HTTP handler count at zero after the positive control. Existing positive-control, direct-probe and zero-handler assertions were retained.

**Gates (final inputs)**:

| Gate | Exit | Result |
|---|---:|---|
| `cd packages/cli && bun test --timeout 30000 ./test/tls-ca-mode.test.ts ./test/tls-ca-mode.integration.test.ts ./test/self-command.test.ts` | 0 | 66 pass, 245 expects, 3 files |
| `cd packages/server && bun test --only-failures ./test/process.test.ts` | 0 | 4 pass, 143 expects |
| `bun run --cwd packages/sdk test` | 0 | 58 pass, 918 expects, 12 files |
| `bun run --cwd packages/util typecheck` | 0 | 74 files |
| `bun run --cwd packages/cli typecheck` | 0 | 2,191 files across 2 projects; readonly tuple baseline corrected |
| `bun run --cwd packages/server typecheck` | 0 | 1,609 files across 2 projects |
| `bun run --cwd packages/sdk typecheck` | 0 | 1,612 files across 2 projects |
| `git diff HEAD --check` | 0 | Clean |

The historical SDK baseline of 44 pass / 10 fail is corrected: all ten `TLS CA mode has not been verified` failures now pass, with four additional fresh-process cases. The server process negative still contains `cannot listen before effective TLS CA policy is verified`, and its authenticated verified-info assertion still reports `tlsCaMode: "bundled"`.

**Citations and deferrals**: this evidence covers `data-model.md` `TLS launch.selectedMode`, `TLS launch.verifiedMode`, `TLS launch.applicationArgs` and `TLS launch.environment`, FR-011, FR-020–023, explicit recovery from FR-018 and SC-009 source scope. Native Bun/SEA recovery, native artifact matrices and final embedded acceptance remain T021/T013 under S4; the ordinary ambient fallback and `selfCommand()` propagation remain T020. T019 is the independent S3 review and was not executed here. No native artifact was built, no S1/S2 App gate was rerun, and no Git commit, reset, stash or destructive restoration was performed.

## Phase 5: S4 — Fresh default, verified child launch and native artifact parity (US4)

- [X] T020 [US4] Implement FR-018/019 atomically: restore fresh no-flag bundled selection at `packages/cli/src/bootstrap.ts` (and parser contract in `packages/util/src/tls-ca.ts` if necessary), together with explicit self-launch propagation at `packages/cli/src/util/process.ts` and `packages/cli/src/services/service-config.ts`; touch `packages/cli/src/services/standalone.ts` only if needed for the normal child path. `selfCommand` carries the verified mode explicitly for all CLI-owned self-launches. Filter saved override keys at the CLI-owned boundary so the generic `service-contender` merge cannot restore them; preserve allowed system CA inputs, unrelated env, configuration persistence, authentication, registration and lease cleanup. Cite `data-model.md` `TLS launch.selectedMode`, `TLS launch.applicationArgs`, `TLS launch.environment` and `TLS launch.verifiedMode`. Extend existing `packages/cli/test/self-command.test.ts`, `service.test.ts`, `standalone.test.ts` and fixtures. Add real fresh invocation tests ignoring ambient system/invalid selector in `packages/cli/test/tls-ca-mode.test.ts` and integration fixtures. Acceptance: fresh default is bundled, normal launch owners in both modes report the parent's selected mode with hostile saved overrides; no injected-command-only substitute; all original lifecycle assertions preserved. Dependencies: T019. Explicit selector immediately after native executable or source entry, before command args; after saved env resolution use explicit undefined overlay entries for forbidden inherited keys that might remain, and assert final merged child env.
- [X] T021 [US4] Restore artifact regression coverage at existing `packages/cli/script/build.ts`, `build-node.ts`, `service-smoke.ts` and existing CLI TLS/service fixtures/tests, per FR-023 and quickstart §8. Preserve all build checks. Exercise clean no-flag bundled, explicit bundled/system on both native artifacts; authenticated service reporting; normal child propagation in both modes; controlled HTTPS positive/negative on both source and both native runtimes; exact SEA recovery args and required FFI; zero rejected HTTP invocations after positive control and proof TLS callback was reached. Record actual artifact identities, exit codes, counts, mode and cleanup. Run affected CLI/util/server/client tests and typechecks. T021 is the sole owner of the final embedded Bun build (`bun run --cwd packages/cli build --single --skip-install`, no web UI skip). Run the native Bun matrix on that artifact; retain the tested binary and a JSON manifest outside the worktree with its absolute `binary` path and lowercase `sha256`. Record build command, exit and relevant input identity; pass the exact manifest path to T013. No second embedded build on unchanged inputs. Acceptance: all applicable source/native matrices pass, no coverage inferred from a different runtime, no in-scope failure. Dependencies: T020. Use real `service start` via `packages/cli/src/commands/handlers/service/start.ts`, normal standalone resolution via `packages/cli/src/services/server-connection.ts` and `Standalone.start()` with isolated state and a live lease, and the existing `service-smoke.ts` plugin installation path for a controlled fixture plugin making ordinary fetch inside the artifact process. Capture authenticated child endpoint/PID/mode, TLS attempt marker/PID and certificate-rejection outcome (not just a failed process); preserve positive control and zero rejected HTTP calls. Force actual SEA recovery using `NODE_TLS_REJECT_UNAUTHORIZED=0`, prove exact application args and required FFI in the recovered artifact. Native no-flag matrix includes clean, ambient system and invalid selectors. No test-only production bypass or injected command as proof.
- [X] T022 [US4] Independent S4 review of child-policy and native evidence against FR-018/019, FR-023 and SC-008–010; verify saved-env merge cannot override the verified selection, normal process owner and exact runtime evidence, retained assertions, no unrelated owner changes; verify the retained T021 artifact identity and build-input provenance for T013. Acceptance: PASS or concrete HOLD; no edits. Dependencies: T021. Verify the native drivers actually exercise normal managed and standalone resolution, in-artifact fetch and real SEA recovery, not direct `serve --service` alone or source-only fixtures.

## Phase 6: Final embedded acceptance and independent Convergence

- [X] T013 [US2] Execute the isolated compiled standalone acceptance with the corrected lifecycle. Owner: independent runtime evidence owner. Follow the single Python child-lifetime script in `quickstart.md` §5 (cleanup on startup/validation failure as well as success; verify listener PID): consume the retained T021 embedded Bun artifact via its manifest and verify its SHA-256 before launching; do not build or substitute another artifact. If missing, mismatched or stale against the accepted build inputs, return to T021/T022 for affected evidence; start the verified binary with `--hostname 127.0.0.1 --port 4097` in a fresh isolated database/environment with all ambient TLS selectors, CA overrides, runtime options and bootstrap state removed (including empty values); no explicit CA selector; verify authenticated `/api/info` reports `tlsCaMode: "bundled"`; keep the smoke-owned process alive; open the actual binary-served frontend in isolated browser state, complete the existing pairing flow, and record Home without session tabs showing `CA:BUNDLED`; then teardown only the recorded PID and temporary root while preserving the validation status. Acceptance: authenticated-info and badge observations are recorded separately before cleanup; no Vite; no unrelated server stopped; no process-wide kill; original failure status preserved. Dependencies: T022, T014.

- [X] T015 Reconcile the complete mandatory final-tree gate matrix. Owner: independent gate runner. Account for every original app/SDK/Core gate, new CLI/TLS gate and native/embedded smoke. Reuse exact successful evidence only when all relevant inputs and runtime configuration are demonstrably unchanged; rerun affected dependency closures, including SDK/Core where TLS changes affect them. Reconcile pre-existing red gates by exact baseline, scope and reason; The ten SDK attestation failures are explicitly in scope under FR-011/023 and T017–T019; require successful full SDK evidence on the final relevant inputs, fresh public host coverage and preserved strict listener rejection. Any in-scope failure blocks completion, and an exception requires explicit maintainer approval. Record actual commands/exits/counts, retained assertions and evidence provenance; never mask statuses or claim an incomplete run passed. Dependencies: T013, T022, T014.
- [ ] T016 Perform final independent Convergence. Owner: independent convergence reviewer, not an implementation author. Verify every FR and SC, all four slice boundaries, ownership invariants, preserved existing assertions, no out-of-scope changes to effective trust attestation/auth/health ownership/features 011/012, and readiness for one dedicated feature commit containing all four slices. Acceptance: written PASS or concrete blocking findings; no edits; any finding returns to its owning slice and requires the affected acceptance review to repeat. Dependencies: T015.

---

## Dependencies and Execution Order

```text
T001 ─┐
      ├─→ T003 → T004 → T005 → T006 → T007 → T008 → T009 → T010 → T011 → T012 → T014 → T017 → T018 → T019 → T020 → T021 → T022 → T013 → T015 → T016
T002 ─┘
```

- Setup: T001 and T002 are independent and parallel.
- S1: T003 → T004 → T005 → independent review T006.
- S2: T007 → T008 → T009 → T010 → T011 → T012 → independent review T014.
- S3: T017 → T018 → independent review T019.
- S4: T020 → T021 → independent review T022; then final embedded smoke T013.
- Convergence: T015 → T016.
- No implementation task may start before T001 and T002 complete.
- S2 must not start until S1's independent acceptance review passes.

## Parallel Opportunities

- T001 baseline evidence and T002 Analyze can run concurrently.
- T008 consumes the shared Layout binding from T007; sequential edits within one S2 session, not separate micro-slices.
- Within S1, T003 must precede T004 because the driver carries the machine's event shape; tests are owned with their implementation to avoid micro-slices.
- T005 and T006 are intentionally sequential: gate evidence before independent review.

## Gate Matrix

| Stage | Gate owner | Commands | Required outcome |
|---|---|---|---|
| Baseline T001 | independent evidence | app `test:harness`, `typecheck`, `typecheck:e2e`, `test:unit`; browser-condition `ssh-health.test.ts`; e2e `multi-server.spec.ts`; SDK and Core full suites | Exact baseline recorded; documented SDK 44/10 and Core 7636/38/3 failures attributed by file/reason/count |
| S1 T005 | S1 gate runner | targeted `health-machine.test.ts` + `health.test.ts`; browser-condition `test-browser/ssh-health.test.ts`; app `typecheck`; app `test:harness` | All in-scope green; exact-attempt/incarnation and cache/waiter cases pass |
| S2 T012 | S2 gate runner | app `test:harness`, `typecheck`, `typecheck:e2e`, `test:unit`; e2e `tls-ca-badge.spec.ts` dev; e2e `multi-server.spec.ts`; e2e `tls-ca-badge.spec.ts` with `PLAYWRIGHT_BUILD=1` | Complete context/runtime matrix green; dev/compiled parity; zero added badge probes |
| Compiled T013 | independent runtime evidence | Retained T021 embedded artifact, manifest/hash check (no build); isolated `serve --hostname 127.0.0.1 --port 4097`; authenticated `/api/info`; browser pairing/Home badge | Authenticated `tlsCaMode: "bundled"` and Home `CA:BUNDLED` recorded before cleanup; status preserved |
| S3 T018 | S3 gate runner | Existing CLI TLS tests + affected typechecks + server process tests + full SDK and fresh public embedded host tests | Source negatives and isolation pass; SDK attestation baseline corrected; strict listener guard preserved |
| S4 T021 | S4 gate runner | Six-file CLI gate (`bun test --timeout 30000 ./test/tls-ca-mode.test.ts ./test/tls-ca-mode.integration.test.ts ./test/self-command.test.ts ./test/service.test.ts ./test/standalone.test.ts ./test/server-connection.test.ts`), affected typechecks, two native artifact matrices, sole final embedded Bun build + retained path/SHA-256 manifest | Verified inheritance, real recovery and trust tests pass; all six files and assertions remain mandatory; port-owner answers use the deterministic snapshot/replay fixture |
| Convergence T015 | independent gate runner | Reconcile every mandatory baseline/final app/SDK/Core and new TLS gate; rerun affected inputs | No in-scope failure, exact evidence, one-commit readiness |

## Implementation Strategy

1. Complete T001/T002 and record evidence. Do not implement while Analyze is unresolved.
2. Deliver S1 as the independently accepted health-truth slice. Its focused gate and review must pass before context wiring.
3. Deliver S2 as the user-visible route/Home/Settings/titlebar slice with production-app fixtures and development/compiled e2e. Then deliver S3 bootstrap and S4 child/artifact parity, each as one bounded slice with an independent review.
4. Run the final embedded smoke, reconcile mandatory gates and run one final Convergence. All four slices remain one feature and one dedicated commit; no separate micro-slice review between individual edits.

**MVP scope**: S1 is the correctness foundation, but no user-visible MVP exists until S2. The minimum demonstrable increment is S1 + S2 with US1 Home/Settings/draft behavior, then US2 multi-server isolation and US3 health transitions. Final feature acceptance additionally requires US4 TLS launch parity and native evidence.

## Format Validation

All tasks use `- [ ] T### [P?] [US?]` where applicable, name an owner, list affected paths, state observable acceptance and list dependencies. Setup and Convergence tasks intentionally omit story labels; all slice implementation tasks carry US1, US2, US3 or US4.

## T001 accepted baseline — 2026-11-24

Baseline commit: `e21900d938f805d3ab3f1e65e2568966eff8bc1a`. Implementation HEAD: `2cf7eb27e02e583347978fd25bcd9eac27ff026b`. The coordinator verified identical committed trees, the five pre-S1 source blobs, the accepted planning amendment and the archived baseline evidence. T001 records completion of evidence collection, not universal PASS. T002 remains accepted.

Evidence archives: `spec013-baseline-diagnostics.zip`, `spec013-gate-details.zip`, `spec013-final-baseline(1).zip`.

| Gate | Exit | Observed baseline |
|---|---:|---|
| App harness | 0 | 3 pass, 22 expects |
| App typecheck | 0 | 2433 files |
| App e2e typecheck | 2 | 189 diagnostics |
| App unit | 0 | 2804 pass, 10075 expects |
| Health browser (corrected path) | 0 | 4 pass, 16 expects |
| Multi-server e2e | 1 | 5 pass, 6 fail |
| SDK | 1 | 44 pass, 10 fail, 498 expects |
| Core | 1 | 7664 pass, 38 skip, 3 fail, 98950 expects |
| CLI TLS | 0 | 19 pass, 56 expects |
| CLI children | 0 | 38 pass, 147 expects |
| Server process | 0 | 4 pass, 143 expects |
| CLI typecheck | 1 | self-command.test.ts:77 TS2769 |
| Util typecheck | 0 | 74 files |
| Server typecheck | 0 | 1609 files |
| Client typecheck | 0 | 180 files |
| SDK typecheck | 0 | 1610 files |

Disposition: E2E typecheck and multi-server failures remain open for S2/T012 attribution and correction. All ten SDK embedded-host attestation failures belong to S3. The CLI readonly tuple type error must be corrected without weakening the assertion before CLI acceptance. Core has the three documented Bash shell parity failures in tool-shell.test.ts (conditional substitutions once/always, wait PID not a child) and shell-scan/compound-parity.test.ts (compound syntax). No red gate is waived. T006 remains independent.

### S1 coordinator correction

Correct the browser test type-only import and strengthen owner isolation using the same fetcher, key, incarnation and endpoint across two live owners, including disposal of one owner while the other remains live. T004/T005 revalidation is pending; the original gate records above are historical evidence. No production behavior changed by this correction.

Revalidation completed (affected gates only):

- `health`: exit 0; 16 pass, 0 fail, 48 expect() calls
- `ssh-health`: exit 0; 12 pass, 0 fail, 72 expect() calls
- `app-typecheck`: exit 0; ✓ No type errors in 2,433 files across 1 project [709.73ms]
- `diff-check`: exit 0.

Unchanged machine and harness evidence retained. T006 independent acceptance remains unchecked.

## T006 independent acceptance — 2026-11-24

Verdict: ACCEPT — S1/T006. Blocking findings: none.

Independent source comparison confirmed:
- Exact key/incarnation/attempt probe acceptance before notification.
- Pure allocator preservation and waiter-only answeredSince.
- Correct remove/relist, credential and staged-to-ready transitions.
- Owner-local bounded cache, timer ownership and disposal.
- Unchanged polling, authentication and non-owner checker.
- Preservation of all substantive original assertions.
- Corrected HealthProbeScope import and same-fetch owner isolation.
- Real-cache driver rejection and exactly one accepted notification.

Operative evidence:
- Machine: 24 pass, 87 expects.
- HTTP/cache: 16 pass, 48 expects.
- Browser driver: 12 pass, 72 expects.
- App typecheck and harness: exit 0.
- Final diff check: exit 0.

S1 is accepted. Remaining baseline failures retain their
previously assigned S2, S3 and final reconciliation ownership.

## T014 independent acceptance — 2026-11-24

Verdict: ACCEPT — S2/T014. Blocking findings: none.

Reviewed HEAD: `7cc1d0e1a95c830a8540cfad49c45d4a1601c266`.
Reviewed delta: 23 staged App files, 20 modified and 3 added,
1698 insertions and 39 deletions.
Independent INITIAL slice review, read-only, separate from
the implementation author.

The reviewer confirmed exact context ownership, reactive Home
binding and cleanup, Settings capture semantics, healthy-only
titlebar selection, real three-identity fixtures, unchanged
visibility/accessibility, zero added badge probes, preserved
assertions and final-delta coverage.

Fresh independent gate measurements on final S2 inputs:

| Gate | Exit | Result |
|---|---:|---|
| App harness | 0 | 3 pass, 22 expects |
| App typecheck | 0 | 2433 files |
| E2E typecheck | 0 | No diagnostics |
| App unit | 0 | 2835 pass, 10220 expects, 277 files |
| CA keeper dev | 0 | 14 pass |
| Multi-server | 0 | 11 pass |
| CA keeper built | 0 | 14 pass |
| Diff check | 0 | Clean |

The initial static wrapper failed because zsh reserves `status`.
The four static commands were executed directly afterward;
the table records their actual successful exits.

Accepted S1 sources remain unchanged. Prior targeted
baseline-correction regression evidence is retained.
A separate resolved-draft-to-Settings E2E is not required
by the accepted task coverage.

T013 remains mandatory after T021/T022.
T015 and T016 remain pending. No gate is waived.
S2 is independently accepted; T017 may proceed.

## T019 independent acceptance — 2026-11-24

Verdict: ACCEPT — S3/T019. Blocking findings: none.

Reviewed HEAD: `4e4f1165733a9fd115b56329451135d15ec18e09`.
Reviewed delta: 22 staged files, 1800 insertions,
109 deletions, including six production owners.

Independent INITIAL read-only review, separate from
the implementation author.

The coordinator inspected the independent session,
confirmed the direct gate exits, and reconstructed
the accepted source snapshot from the original inputs
and both implementation patches. All 22 reviewed
final Git blob identities were checked before closure.

| Gate | Exit | Result |
|---|---:|---|
| CLI TLS + self-command | 0 | 66 pass, 245 expects |
| Server process | 0 | 4 pass, 143 expects |
| Full SDK | 0 | 58 pass, 918 expects |
| Isolated historical SDK trio | 0 | 13 pass, 475 expects |
| Util typecheck | 0 | 74 files |
| CLI typecheck | 0 | 2191 files |
| Server typecheck | 0 | 1609 files |
| SDK typecheck | 0 | 1612 files |
| Direct diff check at closure | 0 | Clean |

Verified: embedded-only optional attestation, honest wire
omission, unchanged strict listener guard and production
entrypoints, clean-only fast path, sanitized recovery,
explicit recovery selector, exact source arguments,
required Node FFI, live environment cleanup, verifier
nonpublication, controlled source HTTPS and preserved
original assertions.

The SDK expected-red evidence remains decisive.
The old CLI bootstrap fails the new cleanup, replay
and dirty-launch assertions by direct source comparison;
another historical mutation run is unnecessary.
The marked inspector case is intentionally Bun-source-only.
Raw wire omission establishes the SDK metadata guarantee.

S1/S2 remain unchanged and accepted.
S3 is independently accepted; T020 may proceed.
Ordinary fresh selection and normal child propagation
remain T020. Native artifact acceptance remains T021/T022.
T013, T015 and T016 remain mandatory. No gate is waived.

## S4 implementation evidence (T020–T021)

**Preflight and scope.** The supplied capture was
`3c46605a47a9b6132f302feab93b252c38e6e508`; execution started at the actual
accepted branch HEAD `a8828368db58dbb80e2aeaf95818c655ca98a3bf`
(`a709ec8e0d` S3 commit plus the following spec-kit commit) with a clean
worktree. T001–T012, T014 and T017–T019 are checked complete; T019 records
ACCEPT. No App source or test changed. The S4 diff is confined to the declared
CLI production owners, the two narrow client environment type declarations,
the declared CLI tests/fixtures and the existing smoke/build script owner.
The S3 source and its accepted assertions were retained.

**T020 — fresh selection and self-launch.** `bootstrap.ts` now calls
`parseTlsCaMode(process.argv.slice(2))`, so a fresh no-selector process chooses
bundled even with ambient `OPENCODE_TLS_CA_MODE=system`, `bundled` or an
invalid value; explicit invalid/conflicting/missing/legacy selectors still
reject. The S3 recovery command still pushes the explicit
`--tls-ca-mode=<parsed.mode>` selector. `selfCommand()` now decides packaged
identity by runtime (`process.versions.bun`, `/$bunfs/`, `isNodeSea()`) instead
of executable basename, producing
`bun [browser conditions] [CA flag] entrypoint --tls-ca-mode=<verified>`,
`node [required flags] [CA flag] entrypoint --tls-ca-mode=<verified>`, or
`executable --tls-ca-mode=<verified>` for compiled Bun/Node SEA. It still uses
the strict verified getter and never replays inspectors, preloads, loaders or
arbitrary options.

**Saved overlay versus actual child environment.** `selfLaunchEnvironment()`
creates a minimal overlay, removes saved TLS authority, and uses own
`undefined` entries to delete forbidden inherited keys at the generic spawn
merge. Bundled removes all four certificate keys even when empty; system keeps
permitted saved `NODE_EXTRA_CA_CERTS`/`SSL_CERT_DIR`; markers,
`BUN_OPTIONS`, `NODE_OPTIONS`, `BUN_BE_BUN` and disabled verification are
always removed; an enabled inherited `NODE_TLS_REJECT_UNAUTHORIZED=1` is
preserved. `ServiceConfig.options()` applies this projection and omits an empty
overlay. The actual contender boundary was exercised with a child observation
fixture: inherited hostile variables were absent in the operating-system child,
the unrelated inherited value survived, and the saved sentinel survived.
`packages/client/src/service.ts` and `PtyHandoff.environment` were narrowed to
the already implemented `string | undefined` overlay semantics; the generic
merge/lifecycle and PTY handoff behavior are unchanged.

**Live saved-environment owner.** `server-process.ts` no longer reapplies the
raw saved environment after attestation. The new
`ServiceConfig.verifiedProcessEnv()` strips every TLS launch input while
preserving unrelated saved settings. A real source managed-service regression
loaded a server plugin from `$HOME/.opencode/plugins` after the live
`Object.assign` point and observed the executing child: saved opposite/invalid
selector, marker, `BUN_OPTIONS`, `NODE_OPTIONS`, `BUN_BE_BUN`, disabled
verification and bundled certificate keys were absent; the unrelated sentinel
was present; the system extra root and allowed certificate directory survived
normal launch; the persisted configuration still contained the hostile values
and only gained the existing generated password. The same plugin proved the
direct `serve --service` path, in both modes, never applies saved TLS inputs
after verification and therefore cannot gain trust from a saved CA path.

**T020 source regressions.** Fresh Bun and Node-source matrices cover clean,
ambient system, ambient bundled and ambient invalid no-selector launches (all
bundled) plus explicit bundled/system against conflicting/invalid ambient
values. Fresh-process self-command observations cover both modes, selector
position, no inspector/preload/loader replay, Bun browser condition/CA flag,
required Node flags, exactly one application selector, the source entrypoint,
and strict-getter rejection in an unattested process. Normal source managed
launch (`service start`) and normal source standalone resolution
(`api get /api/info` with `disabled: true`) were exercised in both modes with
hostile saved environments. The original owner-killed standalone lease test
and all original service/lifecycle assertions remain.

**T021 — final artifacts.** The required order was used. The Bun build ran
first with `bun run --cwd packages/cli build --single --skip-install` (exit 0,
embedded web UI present, existing artifact graph/architecture/verify checks
retained); the Node build then ran with
`bun run --cwd packages/cli build:node --single --skip-install` (exit 0, Node
26.4.0 selected by the existing cache/download owner, macOS codesign and
`--version`/`--help` checks retained). No production input changed after these
builds, and the Bun artifact was not rebuilt.

| Artifact | Path | SHA-256 | Runtime |
|---|---|---|---|
| Final embedded Bun | `packages/cli/dist/cli-darwin-arm64/bin/opencode` | `9f4353e21affd77864aed31f18aa3d727f5d6994c4f49d89a87c625415287b85` | Bun 1.4.4 |
| Node SEA | `packages/cli/dist/node/cli-node-darwin-arm64/bin/opencode2-node` | `73e8e5d81ad040854d6a098aa5a4ca7488dd32fd334f85aa0c26df5050c914c9` | Node 26.4.0 SEA |

**Native matrices.** The existing extended `service-smoke.ts` retained every
registration, election, authenticated/query-token, MCP WebSocket, embedded web
UI, plugin discovery, CORS/unauthorized and removed-stop-route check. Its new
per-artifact matrix uses isolated roots and owned loopback ports and executed
12 cases on each artifact; both full smoke commands exited 0.

| Case (each artifact) | Selected | Reported | PID relationship | Outcome / cleanup |
|---|---|---|---|---|
| clean default | bundled | bundled | spawn = listener | authenticated, argv exact, probe clean; stopped |
| ambient system | bundled | bundled | spawn = listener | ambient selector ignored; stopped |
| ambient invalid | bundled | bundled | spawn = listener | ambient selector ignored; stopped |
| explicit bundled | bundled | bundled | spawn = listener | selector removed from application argv; stopped |
| explicit system | system | system | spawn = listener | authenticated; stopped |
| managed bundled | bundled | bundled | detached child | hostile saved env filtered; HTTPS certificate rejection; stopped |
| managed system | system | system | detached child | saved system root retained; HTTPS success once; stopped |
| direct service bundled | bundled | bundled | spawn = listener | post-attestation filter removed saved TLS keys; rejection; stopped |
| direct service system | system | system | spawn = listener | saved CA not reapplied after attestation; rejection; stopped |
| recovered system | system | system | recovered child | PID changed; exact argv; Bun 1.4.4 / Node SEA FFI; HTTPS success once; stopped |
| standalone bundled | bundled | bundled | two private children | `/api/info` lease then activation-probe lease; no registration; saved env absent; both children exited |
| standalone system | system | system | two private children | `/api/info` lease then activation-probe lease; no registration; saved env absent; both children exited |

The native recovered Node case ran as `node/26.4.0`, reported `sea: true`,
loaded `node:ffi` with `DynamicLibrary`, retained baked `--experimental-ffi`
and `--use-bundled-ca`, and saw exactly
`serve --hostname 127.0.0.1 --port <owned>` with no replayed selector, marker
or disabled verification. The managed and recovery probes observed runtime
argv/execArgv/environment inside the actual artifact process and matched the
separate authenticated `/api/info` PID/mode. For bundled HTTPS cases the
handler count was zero after the harness positive control; for system cases it
was exactly one. No rejected case was accepted as connection refusal, DNS
failure, plugin failure or generic process exit.

**Retained handoff.** Manifest:
`/var/folders/yg/jt10cw_114z0fdrh_bmbzlsh0000gn/T/spec013-t021-artifact-39rsn7n9/manifest.json`
containing the absolute Bun binary path and
`9f4353e21affd77864aed31f18aa3d727f5d6994c4f49d89a87c625415287b85`.
The hash was recomputed from the actual executable bytes after the native
smoke. Relevant retained source hashes: `bootstrap.ts`
`19721744239454ff547de116d8bf9a974ad2cb7b1ea3e1da5ea6f9e11d987ec1`,
`util/process.ts`
`77874748331638cb92ebc82a0c515b82654aab030b6c63cd2c096577bdc2ac33`,
`service-config.ts`
`4d9cd6f3517b38e84b9895dd47e3f67e8659f2105aa3885c6b83e60b30e1098f`,
`server-process.ts`
`1b9bbeb8223ad34540909060be6de863da8faee9b896ab40b1ae31fd78559745`,
`standalone.ts`
`aba97e36c35707c501f8ecb30169151663b6c11b4f40f746b1a3ed02d6d9ced5`,
`native-matrix.ts`
`39d517cfcafdc3b63610735293940cd09cc716f0dc6ca904eb06dd70c26d35d1`,
`service-smoke-process.ts`
`1676e1f2dea6824c1e39ee8492c5e57c097bcbd65c769db1dc83b89a5cf669ae`.
T013 must consume this exact artifact after T022; do not rebuild or substitute.

**Mandatory final gates.**

| Gate | Exit | Result |
|---|---:|---|
| Focused CLI suite (six files, final inputs) | 0 | 128 pass, 680 expects |
| `packages/server` process test | 0 | 4 pass, 143 expects |
| `packages/util` test | 0 | 155 pass, 688 expects, 22 files |
| `packages/client` test | 0 | 268 pass, 1,196 expects, 25 files |
| Util typecheck | 0 | 74 files |
| CLI typecheck | 0 | 2,195 files across 2 projects |
| Server typecheck | 0 | 1,609 files across 2 projects |
| Client typecheck | 0 | 180 files |
| SDK typecheck (client environment closure) | 0 | 1,612 files across 2 projects |
| `git diff HEAD --check` | 0 | Clean |

**Citations and distinctions.** FR-018 and FR-019 are covered by the fresh
default plus explicit verified self-launch and saved/live environment
separation; FR-020–023 guarantee reuse is retained; SC-008, SC-009 and SC-010
are covered by artifact identity, authenticated native behavior, in-artifact
ordinary HTTPS, exact recovery argv and retained lifecycle checks. Entities:
`TLS launch.selectedMode`, `TLS launch.verifiedMode`,
`TLS launch.applicationArgs` and `TLS launch.environment`. The evidence
separates (1) fresh source default/explicit selectors, (2) normal source child
propagation, (3) saved spawn overlay, (4) actual merged child environment,
(5) post-bootstrap live saved environment, (6) native clean startup,
(7) native managed child propagation, (8) native standalone lease propagation,
(9) actual native recovery, (10) in-artifact controlled HTTPS, (11) native
recovered Node FFI, and (12) retained final artifact identity. T022 independent
review, T013 and T015/T016 were not executed. No Git index/history write,
commit, stage, reset, stash or destructive restoration was performed.

## S4 coordinator HOLD correction — 2026-11-25

**Scope.** T020 production acceptance is retained unchanged. This correction
touches only `packages/cli/script/service-smoke-process.ts`,
`packages/cli/script/native-matrix.ts`, `packages/cli/test/service.test.ts` and
this evidence file. Both pre-built artifacts and the manifest were verified
before and after the affected smoke runs; neither build command was executed.
Production hashes remained exactly the six values recorded above.

**Restored ServerInfo validation.** `waitForReady` again decodes the
authenticated response through `Schema.decodeUnknownPromise(ServerInfo)` rather
than a type assertion. The standalone `/api/info` response is decoded through
the same `ServerInfo` schema, and owned registration records used for cleanup
are decoded through `Service.Info`. The original protocol schema was not
changed or reduced.

**Truthful cleanup.** `stopOwnedProcess` now returns success only after the
owned PID is observed gone; a signal error is accepted only when the process is
actually absent. Every native case uses the result and publishes
`cleanup: true` only after verified cleanup. Success paths verify the actual
managed/direct registration file is removed, not merely that the isolated root
was deleted. Failures retain the root when an owned process survived.
Foreground and direct cases use the real Bun subprocess `exited` promise;
managed failure cleanup discovers the owned registration directory even when
the short-lived `service start` process finished before the listener was
assigned. Standalone tracks and cleans both private-child PIDs.

`runCommand` now has a 30-second deadline, drains stdout/stderr concurrently,
escalates through bounded SIGTERM/SIGKILL, retains captured output in the
failure, and reports a surviving owned process rather than hanging.
`startNormalManagedService` now stops the published service through
`Service.stop` and bounded PID checks before removing its root, and the direct
service test drains stderr while the process runs.

**Standalone evidence separation.** The native standalone case still performs
two independent normal-resolver invocations and records them as separate
observations: (1) `api get /api/info`, which establishes authenticated mode,
endpoint, private child PID and lease exit; (2) a location-scoped plugin
observation, which establishes executing runtime, argv, saved-environment
isolation and its own private child PID and lease exit. The record does not
attribute runtime/argv to the info child. The plugin observation uses the
location-scoped provider endpoint, which awaits plugin activation; the
non-awaiting `/api/plugin` route remains exercised by the managed/recovery
probes and the original smoke. Both standalone modes now assert all four saved
CA keys were absent, plus the unrelated-sentinel, mode, forbidden-option,
no-registration and both lease-exit checks.

**Artifact provenance.** Recomputing the artifact hash at the end of the
matrix is now mandatory; a mismatch fails the matrix. Verified identities:

| Artifact | SHA-256 before | SHA-256 after |
|---|---|---|
| Bun `dist/cli-darwin-arm64/bin/opencode` | `9f4353e2…87b85` | `9f4353e2…87b85` |
| Node SEA `dist/node/cli-node-darwin-arm64/bin/opencode2-node` | `73e8e5d8…14c9` | `73e8e5d8…14c9` |

Manifest
`/var/folders/yg/jt10cw_114z0fdrh_bmbzlsh0000gn/T/spec013-t021-artifact-39rsn7n9/manifest.json`
still names the same Bun binary and full hash
`9f4353e21affd77864aed31f18aa3d727f5d6994c4f49d89a87c625415287b85`.

**Fresh affected gates.**

| Gate | Exit | Result |
|---|---:|---|
| `bun run --cwd packages/cli typecheck` | 0 | 2,195 files across 2 projects |
| `bun test --timeout 30000 ./test/service.test.ts` | 0 | 37 pass, 278 expects |
| `bun run script/service-smoke.ts` | 0 | original lifecycle + 12 native cases, all `cleanup: true`; no surviving owned roots/processes |
| `bun run script/service-smoke.ts --node` | 0 | original lifecycle + 12 native cases, all `cleanup: true`; no surviving owned roots/processes |
| `git diff a8828368db58dbb80e2aeaf95818c655ca98a3bf --check` | 0 | Clean |

Retained pre-correction evidence remains valid where inputs did not change:
server process 4 pass / 143 expects, util 155 pass / 688 expects, client 268
pass / 1,196 expects, previously successful util/server/client/SDK typechecks,
and both successful artifact builds. The earlier non-isolated focused CLI
result of 128 pass / 678 expects is retained as historical pre-correction
evidence only; S4-B1 later replaced its environmental live-lookup assumption
with the deterministic snapshot/replay fixture, and the final six-file gate is
128 pass / 680 expects. T021 remains complete; T022 remains exclusively for
the independent reviewer. No T013/T015/T016, build, Git index/history write or
unrelated production change was performed.

## S4-B1 port-owner fixture correction — 2026-11-25

**Classification.** S4-B1 was a test-environment determinism defect in the
existing `unresponsive managed port occupancy reports a bounded conflict`
integration test, not a production defect, skipped test, weakened assertion or
waived failure. Production `PortOwner.describe` keeps its best-effort one-second
lookup budget, matcher, parser and diagnostic construction unchanged. The
independent reviewer accepted all S4 production and native artifact
obligations; T021 was open solely because this affected gate was red.

**Correction.** The test now captures the actual OS `lsof` and `ps` stdout for
the test-owned listener while it is alive, using a separate five-second setup
budget. It then writes exact-argument child PATH fixtures for both commands;
each fixture verifies its complete production argument vector before emitting
the captured stdout. The real contender still runs the real production CLI, the
real unresponsive socket stays open, and production still parses the captured
PID/address, performs the command lookup and constructs the diagnostic. The
fixture records the inherited `XDG_STATE_HOME` exactly as before. Capture or
setup failure cleans the owned root and listener, and no successful PID record
or final diagnostic is synthesized. The original Windows/no-`lsof` fallback is
preserved.

**Preserved assertions.** The two-request recognition barrier, 20-second
recognition and contender deadlines, exit-code 1, exact `PID <pid> (` or
`another process` diagnostic, saved `XDG_STATE_HOME`, stale registration
equality and the 45-second test timeout are unchanged. No production timeout
or behavior was increased or weakened.

**Final gate reproof.** The deterministic fixture was validated with the
affected service suite and then the complete original six-file gate:

| Command | Exit | Observed |
|---|---:|---|
| `bun test --timeout 30000 ./test/service.test.ts` | 0 | 37 pass, 278 expects |
| six-file gate without `--isolate` | 0 | 128 pass, 0 fail, 680 expects, 60.54 s |

The six-file gate used the original accepted command from `packages/cli`
(`tls-ca-mode.test.ts`, `tls-ca-mode.integration.test.ts`,
`self-command.test.ts`, `service.test.ts`, `standalone.test.ts`,
`server-connection.test.ts`). No `--isolate` workaround is required or cited as
final evidence. The historical non-isolated red result (127 pass / 1 fail /
678 expects, reproduced twice by the independent reviewer, including with
`--concurrency 1`) and the failed isolated attempt remain recorded as
pre-correction evidence; neither is claimed as a waiver.

**Status.** S4-B1 is resolved. T021 is complete. T022 remains unchecked pending
independent CLOSE-HOLD acceptance. T020 production acceptance and all retained
native artifact evidence remain valid because their inputs did not change.

**Unchanged inputs and artifacts.** The correction changed only
`packages/cli/test/service.test.ts`, `quickstart.md` and this evidence file;
production source, fixtures, package configuration, timeouts and assertions
outside the port-owner setup are unchanged. `git diff
961de71dd8f77120c3dea417537425c1683e14bb --check` exited 0. Retained artifact
hashes remained:

| Artifact | SHA-256 |
|---|---|
| Bun `packages/cli/dist/cli-darwin-arm64/bin/opencode` | `9f4353e21affd77864aed31f18aa3d727f5d6994c4f49d89a87c625415287b85` |
| Node SEA `packages/cli/dist/node/cli-node-darwin-arm64/bin/opencode2-node` | `73e8e5d81ad040854d6a098aa5a4ca7488dd32fd334f85aa0c26df5050c914c9` |

Manifest unchanged:
`/var/folders/yg/jt10cw_114z0fdrh_bmbzlsh0000gn/T/spec013-t021-artifact-39rsn7n9/manifest.json`.
No artifact build, native smoke rerun, unrelated suite, T013/T015/T016 work,
Git index/history write or scope expansion was performed.

## T022 independent acceptance — 2026-11-25

Verdict: ACCEPT — S4/T022. S4-B1 closed.
Blocking findings: none.

Independent INITIAL baseline:
`961de71dd8f77120c3dea417537425c1683e14bb`,
tree-identical to `a8828368db58dbb80e2aeaf95818c655ca98a3bf`.

The INITIAL review accepted S4 production and native
obligations. Its sole HOLD was the red focused CLI gate.

Historical evidence retained:
- Non-isolated gate: exit 1, 127 pass / 1 fail /
  678 expects, reproduced twice.
- Independent isolated run: exit 0, 128 pass / 680 expects.
- Isolation-only correction: exit 1, 127 pass /
  1 fail / 678 expects, 73.60 seconds.

The unsuccessful isolation-only correction was superseded
by the real-OS snapshot/replay fixture in service.test.ts.
The exact internal reason for the intermittent live
lookup failure was not instrumentally established.
Production PortOwner and its one-second budget are unchanged.

The independent CLOSE-HOLD reviewed only S4-B1 and its
three-file correction. Original diagnostic, recognition,
exit, inherited-environment, registration and deadline
assertions remain. Existing direct live OS lookup and
timeout coverage passed unchanged.

| Final independent gate | Exit | Result |
|---|---:|---|
| Original six-file CLI gate, without isolate | 0 | 128 pass, 0 fail, 680 expects, 61.17 s |
| CLI typecheck | 0 | 2195 files, 2 projects |
| Diff check | 0 | Clean |

The implementation author's corresponding final CLI gate
also exited 0 with 128 pass / 680 expects in 60.54 s.

Retained independent INITIAL evidence:
- Both native artifact matrices: exit 0, 12 cases each.
- Actual managed/standalone launches, controlled HTTPS,
  native recovery, Node SEA FFI and verified cleanup.
- Server process: 4 pass / 143 expects.
- Unchanged applicable package gates and typechecks.

The coordinator reconstructed the final correction and
checked the accepted S4 delta and artifact identities
before recording closure.

Bun SHA-256:
`9f4353e21affd77864aed31f18aa3d727f5d6994c4f49d89a87c625415287b85`

Node SEA SHA-256:
`73e8e5d81ad040854d6a098aa5a4ca7488dd32fd334f85aa0c26df5050c914c9`

All four slices are independently accepted.
T013 may consume the retained T021 manifest.
T015 and T016 remain mandatory. No gate is waived.

## T013 and T015 final runtime acceptance — 2026-11-25

### T013 — retained embedded artifact runtime acceptance

**Preflight.** Branch `011-restore-config-integrity`; HEAD
`e60ea16ffd8adb0876425b77bd96350d83c694de`; clean worktree. The
mandatory Spec Kit prerequisite check
(`.specify/scripts/bash/check-prerequisites.sh --json --require-tasks
--include-tasks`) exited 0 for `specs/013-fix-tls-ca-badge`. T001–T012,
T014 and T017–T022 were checked; T013, T015 and T016 were unchecked.
The current tree equals the accepted S4 tree at `eea0fdd109` except this
evidence record, and differs from accepted S4 baseline
`a8828368db58dbb80e2aeaf95818c655ca98a3bf` by exactly the accepted 20
S4 paths. Both retained artifact hashes matched their accepted values
before execution. No accepted implementation input had changed.

**Command.** The exact approved wrapper from the T013 assignment, run
from the repository root with
`T021_ARTIFACT_MANIFEST=/var/folders/yg/jt10cw_114z0fdrh_bmbzlsh0000gn/T/spec013-t021-artifact-39rsn7n9/manifest.json`.
The wrapper verified quickstart blob
`c94e73f30cb9ac07aa6d69ee61d16f072888523c`, the absolute manifest
binary path, the manifest SHA-256 and that the quickstart contains
exactly one approved §5 Python smoke script. It then executed that
script unchanged. No build, Vite, explicit bundled selector, substitute
binary or ambient TLS selector was used.

**Actual observations.**

| Item | Actual |
|---|---|
| Retained executable | `/Users/do/git/opencode/packages/cli/dist/cli-darwin-arm64/bin/opencode` |
| SHA-256 before and after | `9f4353e21affd77864aed31f18aa3d727f5d6994c4f49d89a87c625415287b85` (unchanged) |
| Isolated launch | `serve --hostname 127.0.0.1 --port 4097`; isolated HOME/XDG roots and database; ten ambient TLS/runtime keys removed, including empty values |
| Authenticated `/api/info` | `tlsCaMode: "bundled"`; owned child PID `5280`; the listening PID was verified to belong to that child |
| Browser | actual binary-served frontend in fresh Chromium state; existing pairing navigation; exactly one `CA:BUNDLED` `role="status"` badge in the actual titlebar; zero session tab labels |
| Browser validation exit | `0` |
| Wrapper exit | `0` (`T013_EXIT=0`) |
| Cleanup | PID `5280` exited; port 4097 free; no smoke temporary root remained; only the owned child and temporary root were cleaned |

Credentials and the pairing code were not recorded. Post-run checks
confirmed the artifact bytes were unchanged, the owned process was gone
and no substitute listener existed. T013 is complete.

### T015 — final mandatory gate reconciliation

**Final tree and scope.** HEAD `e60ea16ffd8adb0876425b77bd96350d83c694de`
adds only this `tasks.md` evidence to the accepted S4 tree
`eea0fdd109`. Against feature baseline
`e21900d938f805d3ab3f1e65e2568966eff8bc1a`, the implementation changes
61 non-spec paths, all inside the accepted S1–S4 owners: S1 health
machine/driver, S2 App context/titlebar/fixtures plus the accepted
baseline harness corrections, S3 server/util/CLI/SDK owners, and the S4
CLI/client/script/test owners. The S4 delta from `a8828368` is exactly
the accepted 20 paths. `packages/core` has no feature diff, and both
Core test files that fail are byte-identical to `e21900d`
(`tool-shell.test.ts` blob `97ff4f57…`; `compound-parity.test.ts` blob
`437ab147…`).

**Dependency closure.** The App package has zero changes after accepted
S2 commit `5cfd6f449f`. The S4 Client changes are type-only environment
overlay declarations; their runtime bodies are unchanged. The S3 Util
`tls-ca.ts` change adds an optional accessor and refactors its own
constant; the App imports only `@opencode/util/{path,uuid,encode,
session-title-fallback}`, never `tls-ca`. The S3 Server change is
`embedded`-only and the App has no `@opencode/server` dependency. The
App fixtures use the app-local controlled mock server and real App
context/health path, not normal CLI child selection. Thus the App
runtime-suite dependency closure is unchanged; only App type closure
crosses Client/Util, and both App typechecks were rerun.

**Fresh final measurements (this pass).**

```sh
# repository root
bun run --cwd packages/app typecheck
bun run --cwd packages/app typecheck:e2e
bun run --cwd packages/app test:harness
bun run --cwd packages/sdk test
bun run --cwd packages/core test
git diff HEAD --check

# packages/app
bun test --conditions=solid --only-failures --isolate \
  --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts \
  src/runtime/server/health-machine.test.ts \
  src/runtime/server/health.test.ts \
  src/shell/state/layout.test.ts \
  src/settings/route.test.ts \
  src/shell/titlebar/titlebar-ca-badge.test.ts

bun test --conditions=browser --isolate \
  --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts \
  ./test-browser/ssh-health.test.ts
```

| Gate (working directory) | Exit | Actual result | Measurement |
|---|---:|---|---|
| App typecheck (root) | 0 | 2,433 files, 1 project | fresh |
| App e2e typecheck (root) | 0 | No diagnostics | fresh |
| App harness (root) | 0 | 3 pass, 0 fail, 22 expects, 1 file | fresh |
| Targeted five-file unit gate (`packages/app`) | 0 | 79 pass, 0 fail, 291 expects, 5 files | fresh |
| Real-driver browser gate (`packages/app`) | 0 | 12 pass, 0 fail, 72 expects, 1 file | fresh |
| Full SDK (root) | 0 | 58 pass, 0 fail, 918 expects, 12 files, 12.18 s | fresh |
| Full Core (root) | 1 | 7,664 pass, 38 skip, 3 fail, 98,804 expects, 7,705 tests, 332 files, 214.47 s | fresh |
| `git diff HEAD --check` (root) | 0 | Clean | fresh |

The targeted five-file result is the same final inputs as the accepted
S1 and S2 individual evidence: health machine 24 pass / 87 expects plus
health HTTP/cache 16 pass / 48 expects, and layout/route/titlebar 39
pass / 156 expects.

**Retained accepted measurements (reused, not rerun).**

| Gate (working directory) | Accepted result | Input identity and reuse reason |
|---|---|---|
| App full unit (`bun run --cwd packages/app test:unit`, root) | 2,835 pass, 0 fail, 10,220 expects, 277 files | T014 fresh on final S2 inputs; App has zero diff after S2 and runtime closure is unchanged |
| Development CA keeper (`bun run --cwd packages/app test:e2e -- --project=chromium regression/tls-ca-badge.spec.ts`, root) | 14 pass | T014 fresh; App, fixture, mock server and Vite config unchanged after S2 |
| Existing multi-server keeper (`bun run --cwd packages/app test:e2e -- --project=chromium regression/multi-server.spec.ts`, root) | 11 pass | T014 fresh; unchanged after S2 |
| Built CA keeper (`PLAYWRIGHT_BUILD=1 PLAYWRIGHT_WORKERS=1 bun run --cwd packages/app test:e2e -- --project=chromium regression/tls-ca-badge.spec.ts`, root) | 14 pass | T014 fresh; Vite fixture build, no CLI artifact rebuild; unchanged inputs |
| Original six-file CLI gate (final accepted command, `packages/cli`, no isolate) | 128 pass, 0 fail, 680 expects, 61.17 s | T022 independent final inputs; current tree equals the accepted S4 tree except this record |
| CLI typecheck (`bun run --cwd packages/cli typecheck`, root) | 2,195 files, 2 projects | T022 final inputs; unchanged |
| Server process (`bun test --only-failures ./test/process.test.ts`, `packages/server`) | 4 pass, 143 expects | T022 retained; server source unchanged after S3 |
| Util tests (`bun run --cwd packages/util test`, root) | 155 pass, 688 expects, 22 files | S4 final inputs; unchanged |
| Client tests (`bun run --cwd packages/client test`, root) | 268 pass, 1,196 expects, 25 files | S4 final inputs; Client change is type-only |
| Util typecheck (root) | 74 files | S4 final inputs; unchanged |
| Server typecheck (root) | 1,609 files, 2 projects | S4 final inputs; unchanged |
| Client typecheck (root) | 180 files | S4 final inputs; unchanged |
| SDK typecheck (root) | 1,612 files, 2 projects | S4 final inputs; unchanged; runtime result freshly measured above |
| Bun artifact build (`bun run --cwd packages/cli build --single --skip-install`, `packages/cli`) | 0 | T021 retained build; no rebuild in this pass |
| Node SEA build (`bun run --cwd packages/cli build:node --single --skip-install`, `packages/cli`) | 0 | T021 retained build; no rebuild in this pass |
| Bun native matrix (`bun run script/service-smoke.ts`, `packages/cli`) | 0 | Original lifecycle plus 12 native cases; retained artifact bytes unchanged |
| Node SEA native matrix (`bun run script/service-smoke.ts --node`, `packages/cli`) | 0 | Original lifecycle plus 12 native cases; retained artifact bytes unchanged |

Retained exact commands for the gate groups above that are not repeated
as rows:

```sh
# packages/cli
bun test --timeout 30000 \
  ./test/tls-ca-mode.test.ts \
  ./test/tls-ca-mode.integration.test.ts \
  ./test/self-command.test.ts \
  ./test/service.test.ts \
  ./test/standalone.test.ts \
  ./test/server-connection.test.ts

# packages/server
bun test --only-failures ./test/process.test.ts

# repository root
bun run --cwd packages/util test
bun run --cwd packages/client test
bun run --cwd packages/util typecheck
bun run --cwd packages/cli typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/client typecheck
bun run --cwd packages/sdk typecheck
```

Also retained as accepted S3 evidence and superseded only for their final
runtime coverage by the fresh full SDK and final six-file CLI gates:
CLI TLS/self-command 66 pass / 245 expects; full SDK 58 pass / 918
expects; isolated historical SDK trio 13 pass / 475 expects; four fresh
public Promise/Effect host cases; Util/CLI/Server/SDK typechecks. The
historical failed isolated S4-B1 attempt remains historical superseded
evidence and is not used.

**Full Core baseline comparison.** The exact three documented failures
remain:

1. `packages/core/test/tool-shell.test.ts:617`, "ShellTool conditional
   process substitution > conditional substitutions respect once":
   `/bin/bash: wait: pid 7537 is not a child of this shell`, exit 127.
2. Same file and line, "conditional substitutions respect always":
   `/bin/bash: wait: pid 7539 is not a child of this shell`, exit 127.
3. `packages/core/test/shell-scan/compound-parity.test.ts:125`,
   "real-shell compound syntax > bash": Bash 3.2 parse error near
   `newline` in `probe() case value in value`.

Host environment: Darwin arm64, `/bin/bash` GNU bash 3.2.57(1)-release.
The two test files and all of `packages/core` are byte-identical to the
T001 baseline. Final pass/skip/fail/test counts match T001 exactly
(7,664 / 38 / 3 / 7,705); the measured assertion-call total is 98,804
versus the T001 record of 98,950, with no additional failing test and no
changed failure reason. These are the accepted out-of-scope macOS Bash
baseline failures; no in-scope App/TLS/CLI/SDK/Core regression remains,
and no maintainer exception is requested.

**Provenance and no-change confirmation.** Both retained artifact hashes
at the end of this pass remained:

| Artifact | SHA-256 |
|---|---|
| Bun `packages/cli/dist/cli-darwin-arm64/bin/opencode` | `9f4353e21affd77864aed31f18aa3d727f5d6994c4f49d89a87c625415287b85` |
| Node SEA `packages/cli/dist/node/cli-node-darwin-arm64/bin/opencode2-node` | `73e8e5d81ad040854d6a098aa5a4ca7488dd32fd334f85aa0c26df5050c914c9` |

The manifest still names the Bun executable and hash above. This pass
ran no build, Vite, native smoke, six-file CLI rerun, unrelated App e2e
suite, Git index/history write, staging, commit, reset, stash or
destructive restoration. The only worktree change is this `tasks.md`
record; no production, test, package configuration or build input
changed. T013 and T015 are complete. T016 remains unchecked and was not
executed.
