# Research: TLS CA Policy and Badge Parity

**Feature directory**: `specs/013-fix-tls-ca-badge`
**Actual checkout branch**: `011-restore-config-integrity`
**Date**: 2026-11-24

This bounded correction reuses the independently verified evidence at HEAD `812d18bb74ffd993038a34d5dd6a09b4f3a30ef2`. It does not repeat repository exploration. S1 health observation identity and S2 route/Home/Settings context remain accepted; S3 CLI bootstrap and S4 self-launch/artifact parity extend the scope based on the independent review.

## R1. Historical contract

**Decision**: Restore V1's current-server ownership through V2 owners. Keep V2's healthy-only selector and authenticated server information. Do not restore V1 infrastructure or its dev-only gate.

**Evidence**:

- V1 `aab82e879b8f9ef7ef3c34d6d1f5861e7ec3e16c`: `ChannelIndicator` read `global.servers.health[server.key]?.tlsCaMode`; independent of tabs, but rendered only for the dev channel.
- V2 `cbc8226979ae80daf9603f32db2d2002e7e5bc8d`: badge ownership narrowed to `currentTab()?.server`, causing the Home/4097 regression; the dev-only gate was removed.
- Existing `selectServerTlsCaMode` returns a mode only for a healthy answer.

**Alternatives rejected**: V1 revival, V2 tab-only lookup, a second CA store.

## R2. Home: bind the existing owner accessor

**Decision**: The Layout owner exposes a route-lifetime read-only binding to a key projection of the actual Home controller's `server.focused` accessor. It stores only the key accessor reference, not a selection value. `HomeOverview` binds it and cleans up on unmount. The titlebar consumes `layout.home.focusedServer()` on normal Home.

**Verified evidence**:

- `home/model.ts` creates the authoritative selection memo, exposes `server.focused`, and derives it from `selectHomeSelection(machine())`. Its type is `ServerConnection.Any | undefined`.
- `home/route.tsx` creates that controller locally in `HomeOverview`.
- `home/machine.ts` resolves `state.override ?? state.stored`; hydration override wins before persistence.
- The existing Home test protects the override behavior.

**Why the prior reconstruction was wrong**: `layout.home.selection()` plus readiness flags duplicates Home's resolution and suppresses a server Home has already resolved. It is removed from all artifacts.

**Binding contract**:

- `HomeOverview` binds the read-only key projection `() => { const connection = home.server.focused(); return connection ? ServerConnection.key(connection) : undefined }`; the undefined guard is part of the projection.
- `layout.home.focusedServer()` returns the bound key accessor's current key or `undefined`.
- `bindFocusedServer(accessor)` accepts the key accessor and returns cleanup that clears only its own accessor; it never clears a newer binding.
- No Home selection machine, persistence, worktree effect or controller lifetime changes.

**Project-navigation Home**: `Home()` renders `ProjectLanding` rather than `HomeOverview` when project navigation is enabled. `ProjectLanding` restores a tab or mounts `EmptyProjects`; its actual displayed connection comes from `const action = useProjectStart()` and `action.target().connection` (`landing.tsx:38,61`). `start.ts:37-46,70` resolves the visible-server fallback and may return `loading` with a connection. Bind the same reactive Layout accessor from `EmptyProjects`; both Titlebar and Settings use that binding for both Home layouts. No provider cycle and no duplicate server-resolution logic. The existing `useProjectStart` remains unchanged. Layout already imports `createSignal` and `Accessor`; the binding itself must be reactive, not just its returned key. See exact helper in plan and test reader-before-binding/old-cleanup behavior.

## R3. Session routes

**Decision**: Use the `server` carried by `layout.route()` for session routes. Do not consult a tab.

**Evidence**: `layout.tsx` parses `/server/:serverKey/session/:id` into the session route with its server; `route-sync.ts` resolves tabs later. A pending/loading/parent session therefore already has the correct identity.

## R4. Draft routes

**Decision**: Use the matching draft tab's `server`; a missing/unresolved draft is `undefined`.

**Evidence**: `layout.tsx` parses `draftID`; `new-session/route.tsx` renders only for an existing draft tab and otherwise returns Home when ready. The titlebar uses a non-throwing lookup for the transient missing case.

## R5. Settings: exact project identity and source ownership

**Decision**: Settings context resolution is:

- project view → exact `view.server`; never `surface.server()`'s inventory fallback;
- server-scoped root page → `surface.server()?.key`;
- general, Servers, About and other non-server-scoped pages → captured source-context server.

Keep the five server-scoped root tabs (`projects`, `workspaces`, `providers`, `models`, `extensions`) in one canonical definition consumed by the Settings page owner and context selector.

**Verified evidence**:

- `settings/surface.tsx` `server()` falls back through the inventory: `view().server ?? sourceServer()`, then local/first.
- `settings/shell.tsx` resolves project routes separately through `connection(view.server)` and `serverPagesConnection`.
- A project route must therefore bypass the fallback and use its exact identity.
- `settings/surface.tsx` owns `show(view)`, which calls `navigate()` with the existing `settings` navigation state; all surface and search navigation delegate to `show`.

**Source preservation**: `show(view)` captures the current source-context key, or an explicit-unresolved marker, before navigation can unmount Home, and preserves it across subsequent Settings replacements. An explicit-unresolved capture yields `undefined`; missing legacy navigation state is a distinct case that uses existing source resolution. `sourceServer` consumes that captured source and must not reconstruct it from a recent tab. Capture `sourceKey?: ServerConnection.Key | null`: `null` explicit unresolved, absent legacy. `show` reads the shared Layout Home accessor before navigation (both Home layouts), session route or resolved draft; existing Settings replacements preserve capture. Thus T008 depends on T007. Do not add a second navigation owner in `settings/command.tsx`, and do not call `useProjectStart` from `SettingsSurface` because `useProjectStart` already consumes `useSettingsSurface`. No second Settings store; existing navigation lifecycle/redirects remain.

## R6. Health: verified remove/relist stale-attempt defect

**Decision**: Correct the existing health owner with a listing incarnation in addition to the per-slot attempt.

**Verified defect**:

- A newly listed endpoint currently uses `attempt: (slot?.attempt ?? 0) + 1`.
- Unlisting removes the slot; relisting the same key creates attempt 1 again.
- `answered()` currently checks key, slot type and attempt; `answeredSince` is the retry-waiter completion predicate.
- List A/pending, remove A, relist A/starts another attempt 1, original A/1 answers: the original matches the new slot unless an independent listing-lifetime guard exists.
- `health.ts` dispatches completions with only key and attempt; no independent listing-lifetime guard exists.
- The 750 ms `useCheckServerHealth` cache is endpoint-keyed and can return a discarded incarnation's promise to a new listing.

**Required correction**:

- Add a listing incarnation to slots; carry it through probe effects and `probe.settled`.
- Probe acceptance requires exact current key, slot type, incarnation and current attempt equality. `answeredSince` remains exclusively the retry-waiter completion predicate.
- Keep the existing increasing per-key attempt sequence while a slot remains listed, including endpoint/credential transitions. Reset attempts to 1 only when remove/relist recreates the slot.
- A pending retry waiter targeting attempt N must settle through `answeredSince` when the current slot's accepted attempt is `>= N` after credential replacement; the superseded incarnation's answer is rejected.
- Verified real seam: `health.ts:150-169` has a module-global endpoint cache in `useCheckServerHealth()`, `useServerHealth()` passes that one-argument function to `createServerHealth()`, which calls `check(effect.http)` at line 193; `servers/connect/controller.ts:38,50,114,181,186` consumes the same one-argument API outside the health owner. Use an owner-local checker factory (owner instance is lifetime token), tuple key and scope argument, with explicit disposal and guarded expiry as defined in contract §5. Keep non-owner API and coalescing. A staged plugin can become ready with the same credentials: allocate a new endpoint incarnation and reject the previous cached promise. `health-machine.ts` explicitly reconstructs state in `polled`, `retried` and `settle`; preserve the pure incarnation counter in each. No need to change `ServerProbe` payload or `runtime.tsx` listener.
- Existing driver fixtures are not in `health.test.ts`: `packages/app/test-browser/ssh-health.test.ts` imports `createServerHealth`, uses Solid roots, controlled promises and has four existing regression tests (stage, endpoint replacement, retry, disposal). Extend that owner and gate it under browser conditions; keep existing HTTP/auth tests in `health.test.ts`. Existing `checkServerHealth` retries/timeouts and auth header behavior remain.
- Preserve refresh retention, poll interval, retry waiters and authentication.
- No new store, poller or badge-owned request.

**Required evidence**: state-machine remove/relist with stale successful `bundled` answer, stale unauthorized answer, zero stale notifications, current answer accepted; exact-attempt mismatch rejected; credential replacement with a pending retry waiter settling on the current accepted answer; real driver with controlled promises; cache non-adoption across incarnations, no collision across owner lifetimes/server keys, bounded expiry, and legitimate same-incarnation coalescing.

## R7. Titlebar wiring

**Decision**: Add pure `selectCaBadgeServer` to `titlebar-ca-badge.ts`. It chooses session route, draft server, Layout-bound Home server or Settings context server; otherwise `undefined`. It has no readiness/fallback logic and performs no I/O.

The titlebar performs one exact lookup: `selectServerTlsCaMode(global.servers.health[key])`, then the existing `caBadgeMapping`. Markup, `role="status"`, tooltip, colours and `!props.verticalTabs` guard remain unchanged.

## R8. Acceptance evidence

**Decision**: Add a production-wiring fixture using `AppInterface`’s `servers` prop and custom router, following `e2e/utils/app-direction.fixture.tsx`; controlled desktop/storage hydration follows `settings-wsl.fixture.tsx`. Existing HTML entries import their `mount` function in a module script. Add `e2e/utils/tls-ca-badge.html` and list it in `vite.config.ts`’s existing fixture-only `rolldownOptions.input` (lines 37–46); `playwright.config.ts` already sets `VITE_OPENCODE_TEST_FIXTURES: "1"` for its webServer. Without HTML/input the built run cannot load the fixture. `mock-server.ts:58-62,818-829` defines `MockServerConfig` and existing `/api/info`; add mode support there, and controlled held/changed/auth answers in the keeper. Use actual sidecar registry connection, not a selector string.

**Three identities**: 4096, 4097 and the actual sidecar connection `{ type: "sidecar", variant: "base", http: { url: endpoint } }`. `ServerConnection.key()` returns `"sidecar"` independently of URL. The fixture exercises the real titlebar, registry and health path, not just a selector string.

**Required cases**: initial resolved Home selection; hydration-time override; persistence completion; owner cleanup; both Home layouts opening general Settings with captured actual context; healthy answer without mode; unresolved draft→resolved; Home A→session B→Home A; destination checking→accepted answer; Settings selected A→return B; same-endpoint sidecar/HTTP alias with independently controlled observations; two servers with the same mode then invalidate/change only the destination and prove the badge follows it; removed-route identity; Settings project-route exact identity; request accounting. Keep the development and `PLAYWRIGHT_BUILD=1` normal CA keeper runs.

## R9. Compiled acceptance lifecycle and baseline discipline

**Decision**: T021 alone builds the CLI with the embedded web UI (`bun run --cwd packages/cli build --single --skip-install`) and retains the tested binary with path/SHA-256 manifest. T013 consumes this exact artifact without rebuilding, then runs the binary in an isolated temporary environment with fresh DB and explicit loopback 4097 using the verified CLI argument `--hostname 127.0.0.1`. Verify authenticated `/api/info` reports `bundled`, then pair/open the actual application served by that same binary at 4097 and verify Home without a session tab.

The smoke uses one Python process (quickstart §5) owning its child and temporary root across startup, authenticated info, paired fresh Playwright browser validation, and cleanup on failure or success. Verify listener PID; no Vite, no shell exit, no unrelated process termination. Preserve validation status.

**Baseline**:

- Run existing applicable gates before production edits.
- Do not require a new test file to exist on HEAD.
- Add new regression tests and show decisive failures against old behavior where applicable.
- Run complete accepted gates after correction; record exact exit codes, counts and assertion preservation.
- Never mask exit status through a pipeline.
- Previous SDK/Core failures are baseline evidence, not passes or waivers. The SDK attestation failures are in-scope embedded-host boundary failures; S3 must correct them without weakening listener attestation.

## Resolved uncertainty

The prior Home hydration HOLD is closed by the Layout key-accessor binding: the badge follows the actual Home resolved server, including an override before persistence, without duplicating resolution. The attempt/waiter and cache-lifetime contract is now explicit: probe acceptance is exact-incarnation/exact-attempt; `answeredSince` is waiter-only; cache identity is owner-, key- and incarnation-scoped and bounded. No concrete unresolved contradiction remains.

## R10. Historical policy parity — bounded expansion

Independent read-only review at HEAD `e21900d938f805d3ab3f1e65e2568966eff8bc1a` established six production differences: (1) ordinary bootstrap passes ambient `OPENCODE_TLS_CA_MODE` to the parser fallback; (2) saved service env is merged after inherited env at `service-contender` and can override a verified parent's selection; (3) verify-first can retain startup effects already applied before deleting env keys; (4) recovery replays arbitrary `execArgv` via `replaceTlsCaFlags`; (5) SEA recovery forwards `argv.slice(1)` despite a synthetic executable slot; (6) `Object.assign` cannot delete empty certificate overrides omitted from the sanitized copy. Ambient selector behavior has an existing subprocess assertion; other runtime consequences require the decisive reproductions defined by FR-023. Effective-set attestation, guarded V2 entrypoints, authenticated optional metadata, ordinary HTTPS negative/positive controls and the V2 protocol are retained. No V1 legacy endpoints or DebugBar restoration.

Decision: one feature, one final convergence; retain accepted S1/S2 and add S3/S4 by launch owner. Reuse `nodeFlags`, `selfCommand`, existing service configuration and artifact smoke owners; no independent mode store. The existing V1/V2 commits and reviewed source snapshots supply the implementation map; capture current exact CLI seams only when preparing those implementation slices. Lost negative test families and native/runtime gaps are mandatory in FR-023, not a separate historical investigation.

## R11. Historical reviewer closure — SDK and native production drivers

The public in-process SDK route graph reaches the same strict `ServerInfo.layer` as a listening server, although `createEmbeddedRoutes` already distinguishes the embedded boundary. The existing protocol field is optional. S3 permits absence only in this embedded projection when no attested mode exists; the strict getter and pre-listen guard remain required. Fresh-process public Promise/Effect coverage and all ten historical SDK failures are mandatory. T021 uses real managed `service start`, normal standalone resolution and an artifact-process fixture plugin for controlled HTTPS, including actual SEA recovery and ambient no-flag variants. These are acceptance-driver clarifications and one bounded embedded-host correction, not new slices or a second native build. Runtime execution remains outstanding.
