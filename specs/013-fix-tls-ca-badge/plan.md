# Implementation Plan: TLS CA Policy and Badge Parity

**Branch**: `011-restore-config-integrity` | **Date**: 2026-11-24 | **Spec**: [spec.md](./spec.md)

**Feature directory**: `specs/013-fix-tls-ca-badge`

**Input**: Feature specification from `/specs/013-fix-tls-ca-badge/spec.md`

## Summary

Four bounded architecture-owned implementation slices form one feature and one dedicated commit. S1 corrects the existing health owner's observation identity, exact stale-result suppression, cache lifetime and deterministic state-machine/driver coverage. S2 restores the badge's authoritative route/Home/Settings ownership, integrates the titlebar, and proves deterministic development/built-app acceptance. S3 restores CLI bootstrap runtime isolation; S4 atomically restores the bundled default and verified self-launch inheritance, then native-artifact coverage. The final embedded smoke runs once after S4.

The titlebar reads:
- a session route's server directly;
- a draft tab's server;
- the visible Home owner’s actual focused connection, published through one route-lifetime Layout key-accessor binding by either `HomeOverview` or `EmptyProjects`;
- Settings' project-route server, server-scoped root selection or captured source-context server.

S1 adds a listing-incarnation guard and exact-attempt probe acceptance. Attempts remain increasing while a slot stays listed, including credential transitions, so retry waiters are not stranded. No new store, poller, route resolver, CA inference or network request is added.

## Technical Context

**Language/Version**: TypeScript in the existing repository toolchain; SolidJS application code.

**Primary Dependencies**: Existing `solid-js` application contexts, `@opencode/client` health reporting, existing persisted layout/server stores. No new dependency.

**Storage**: Existing layout/server persistence and the existing health cache/state. The Layout binding stores only a key-accessor reference owned by Home; it stores no selection value. No schema migration.

**Testing**: Bun unit tests, the existing production-app fixture architecture for controlled Home hydration and three-identity navigation, Playwright development and `PLAYWRIGHT_BUILD=1` e2e, and an isolated compiled-binary smoke.

**Target Platform**: OpenCode V2 desktop and web titlebar; Chromium e2e projects.

**Project Type**: Monorepo desktop/web application (SolidJS renderer plus server packages).

**Performance Goals**: No extra polling or requests; O(N) visible-server lookup only while resolving project-navigation Home; accessor reads are reactive and bounded.

**Constraints**: Exact identity isolation; healthy-only CA selection; no V1 revival; no second store/poller/route resolver; preserve features 011/012; one dedicated feature commit.

**Scale/Scope**: One titlebar per window; the existing listed servers including 4096, 4097 and the Desktop sidecar; existing health poll interval.

## Constitution Check

*GATE: S1/S2 previously accepted. Expanded TLS scope requires one independent delta Analyze before implementation.*

| Gate | Status | Evidence |
|---|---|---|
| I. Preserve existing user-visible behavior | PASS | Badge presentation, tooltip, role, titlebar guard, health/auth, effective TLS trust attestation, Home behavior and Settings redirects remain. |
| II. Upstream- and architecture-first reuse | PASS | Reuses Layout, Home's existing `server.focused`, project-start, Settings surface/route, registry and health owner. No competing resolver. |
| III. One authoritative owner per mutation/persistence | PASS | Home's selection machine/controller stays authoritative; Layout stores only its accessor reference. Settings keeps its surface/navigation owner. Health remains the sole health owner. |
| IV. Ordered updates and stale-result suppression | PASS | Adds a listing incarnation and exact-attempt probe acceptance to the existing health guard; rejected completions cannot update health or notify listeners. |
| V. Domain invariants across boundaries | PASS | Exact `ServerConnection.Key` flows to health; project Settings uses exact `view.server`. |
| VI. Data honesty and provenance | PASS | `CA:UNKNOWN` only when no accepted healthy answer exists; no inference from port/build/database. |
| VII. Bounded change scope | PASS | Four architecture-owned slices under one feature; bounded historical TLS defects only, no health redesign, store or polling change. |
| VIII. Deterministic tests for changed behavior | PASS | Pure selector/binding/state-machine tests, controlled-promise driver tests and production-wiring fixtures. |
| IX. Preservation of existing test assertions | PASS | Existing assertions remain; new coverage extends current owners. Baseline capture distinguishes pre-existing failures. |
| X. Evidence-driven change | PASS | Verified Home owner, Settings project resolution and health remove/relist defect drive the edits. |
| XI. Accessibility, responsiveness and UI stability | PASS | Existing `role="status"`, tooltip, labels, colours and `!props.verticalTabs` guard remain. |

**Post-design re-check**: S1/S2 accepted before scope amendment. For S3/S4, reuse the existing verifier, CLI bootstrap and child owners; preserve I–XI, apply XII governance, and preserve XIII–XX telemetry contracts by leaving generation paths unchanged. Confirm the delta before production edits.

## Project Structure

### Documentation (this feature)

```text
specs/013-fix-tls-ca-badge/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/ca-badge-server-context.md
├── checklists/requirements.md
└── spec.md
```

### Source Code (repository root)

```text
packages/app/src/
├── shell/state/layout.tsx            # route-lifetime Home key-accessor binding
├── shell/titlebar/titlebar.tsx       # consumes context owners and existing health record
├── shell/titlebar/titlebar-ca-badge.ts
├── home/route.tsx                    # HomeOverview binds its focused connection
├── home/projects/landing.tsx          # EmptyProjects binds its existing action.target connection
├── settings/route.ts                 # canonical server tabs + context selector
├── settings/shell.tsx                # consumes the canonical server-tab definition
├── settings/surface.tsx              # project/root/source context server; show() source capture
└── runtime/server/
    ├── health-machine.ts             # listing incarnation + exact-attempt acceptance
    └── health.ts                     # incarnation-aware driver/cache identity
```

Tests/evidence:

```text
packages/app/src/shell/titlebar/titlebar-ca-badge.test.ts
packages/app/src/shell/state/layout.test.ts
packages/app/src/runtime/server/health-machine.test.ts
packages/app/src/runtime/server/health.test.ts
packages/app/test-browser/ssh-health.test.ts
packages/app/src/settings/route.test.ts
packages/app/e2e/utils/tls-ca-badge.fixture.tsx
packages/app/e2e/utils/tls-ca-badge.html
packages/app/vite.config.ts
packages/app/e2e/regression/tls-ca-badge.spec.ts
packages/app/e2e/utils/mock-server.ts
```

**Structure Decision**: Keep the correction inside the existing Layout, Home, Settings, titlebar and health owners. The Layout addition stores only a reactive reference to the currently mounted Home owner’s projected key accessor. No server, protocol, database or titlebar CSS/layout changes are planned. `settings/command.tsx` is not an owner of this correction.

## Implementation Slices

### S1 — Health observation identity

| File | Change |
|---|---|
| `packages/app/src/runtime/server/health-machine.ts` | Add listing-incarnation identity to slots and carry it through probe effects/settled events. Probe acceptance requires exact current key, slot type, incarnation and current attempt equality. Preserve increasing attempts while a slot remains listed, including endpoint/credential transitions; reset attempts only when remove/relist recreates the slot. Reject non-exact completions before state/listener updates. Keep `answeredSince` as the retry-waiter predicate. Preserve refresh retention, polling and retry waiters. |
| `packages/app/src/runtime/server/health.ts` | Carry incarnation through the real driver into `probe.settled`. Give the existing 750 ms cache an identity of health-owner lifetime token + exact server key + incarnation + endpoint identity, so discarded promises and different owners/keys cannot collide. Keep entries bounded by TTL and cleared on owner disposal; preserve endpoint-keyed coalescing for existing non-owner consumers. |

### S2 — Authoritative context and runtime acceptance

| File | Change |
|---|---|
| `packages/app/src/shell/state/layout.tsx` | Expose `layout.home.focusedServer()` and a binding method accepting `Accessor<ServerConnection.Key \| undefined>`. Store only the accessor reference. Return cleanup that clears it only if it still equals the bound accessor, never a newer binding. |
| `packages/app/src/home/route.tsx` | In `HomeOverview`, bind a read-only projection of `home.server.focused()` through `ServerConnection.key` with an undefined guard; register cleanup with `onCleanup`. Do not change selection, persistence or worktree effects. |
| `packages/app/src/home/projects/landing.tsx` | In `EmptyProjects`, immediately after `const action = useProjectStart()`, bind the same Layout API to the key of `action.target().connection` (including a resolved `loading` target), with undefined guard and `onCleanup`. Do not change tab restoration or project-start actions. |
| `packages/app/src/shell/titlebar/titlebar.tsx` | Use `layout.home.focusedServer()` for both Home layouts; read the Settings visible-surface context on Settings; reuse `selectServerTlsCaMode(global.servers.health[key])`. Keep markup and guard unchanged. |
| `packages/app/src/shell/titlebar/titlebar-ca-badge.ts` | Add pure `selectCaBadgeServer`: session route server, draft server, layout-bound Home server, Settings context server; otherwise `undefined`. No fallback, no Home readiness flag. |
| `packages/app/src/settings/route.ts` | Keep the five server-scoped root tabs in one canonical runtime definition; export `isSettingsServerView` / `selectSettingsContextServer`. Project views are server-scoped and use their exact route server. |
| `packages/app/src/settings/shell.tsx` | Consume the canonical server-tab definition for the Settings page owner; preserve redirects and page availability behavior. |
| `packages/app/src/settings/surface.tsx` | Expose `contextServer`: project view → exact `view.server`; server-scoped root → `server()?.key`; other pages → captured source-context server. `show(view)` captures the current source key or explicit-unresolved marker into the existing `settings` navigation state before `navigate()`, preserves it across subsequent Settings replacements, and distinguishes it from missing legacy navigation state. Preserve existing `server()`, `sourceServer()`, redirects and availability. |

S1/S2 make no edits to `packages/server`, `packages/protocol`, TLS verifier, authentication, database or titlebar layout; S3/S4 touch the bounded CLI/TLS owners below and their tests. `settings/command.tsx` is not changed. `health.ts`/`health-machine.ts` changes are the bounded correctness repair required by FR-009, not a redesign.

### S3 — TLS bootstrap and verifier regression coverage

| Existing owner | Bounded change |
|---|---|
| `packages/cli/src/bootstrap.ts` | Keep the existing ordinary default until S4 so self-launch propagation cannot regress between slices. Carry the chosen mode explicitly across recovery before user arguments/`--`; preserve exact user arguments for Bun source, Node source, compiled Bun and SEA (both packaged forms omit synthetic entrypoint). Keep a verified clean fast path; sanitize or reject dirty startup options before production imports. Guard single recovery; preserve supported marked debugging without replaying inspector/hooks. Apply actual live deletions before callback, not only `Object.assign`. | Check env and argv startup options before fast-path acceptance; recovery uses the stripped `parsed.argv` after the explicit selected flag and before any original `--`; marker limits recovery, never bypasses attestation or cleanup. Preserve `SSL_CERT_DIR` and other permitted system inputs and `NODE_TLS_REJECT_UNAUTHORIZED=1`; remove `0`.
| `packages/util/src/tls-ca.ts` | Reuse the existing parser, certificate environment sanitizer and effective-set verifier. Restore default/negative guarantees without reintroducing V1's exact runtime selector as the attestation authority. Retain permitted system additions and verified-only reporting. |
| `packages/cli/src/util/process.ts` | Reuse the existing Node `nodeFlags` allowlist for source recovery where appropriate (move or share the pure helper if needed to avoid cycles); retain required Node FFI/conditions/warning flags and the intended Bun browser condition. No unrestricted `process.execArgv` replay. |
| `packages/cli/test/tls-ca-mode.test.ts`, `tls-ca-mode.integration.test.ts`, existing `test/fixture/tls-ca-mode/` | Restore strict process-level parsing, guarded entrypoints and unverified command negatives, injected attestation failures/nonpublication, environment immutability/live cleanup, dirty fast path versus recovery, exact arguments and one inspector. Exercise actual production entrypoints and callbacks; prove TLS-attempt reachability and zero HTTP handler calls. |

The SDK correction belongs to S3 at the same attestation boundary, not a fifth slice. `packages/util/src/tls-ca.ts` has process-local `verifiedMode: TlsCaMode | undefined`; expose a narrow read-only optional accessor for embedded metadata, keeping `getVerifiedTlsCaMode()` and `assertTlsCaVerified()` strict. `packages/server/src/routes.ts` already separates `createRoutes` (embedded=false) from `createEmbeddedRoutes` (embedded=true) in `makeRoutes`; only the latter may use an embedded ServerInfo layer in `packages/server/src/server-info.ts` with optional mode. Non-embedded construction must still call the strict getter and `packages/server/src/process.ts` must still check it before `listen`. Reuse the existing optional protocol field; verify omission on serialization and retain exact verified reporting when attested. Do not bootstrap the SDK, change trust sets or add an option to bypass listener verification. `packages/sdk/src/internal/host.ts` is the public embedded call path; keep its config/resource coordination and lifecycle unchanged. Add isolated fresh-process public Promise and Effect SDK coverage in the existing SDK tests/fixtures; retain the existing verified SDK and unverified-listener assertions. The ten baseline SDK failures are in scope.

### S4 — Fresh default, self-launch policy inheritance and artifact coverage

| Existing owner | Bounded change |
|---|---|
| `packages/cli/src/bootstrap.ts` and `packages/util/src/tls-ca.ts` | Restore ordinary no-selector bundled default without ambient fallback in the same slice as explicit self-launch propagation. Existing explicit recovery from S3 stays intact. |
| `packages/cli/src/util/process.ts` | Make the normal `selfCommand` path carry the verified selection explicitly for source and native CLI invocations. Verify all callers and keep CLI options before any `--`. Preserve the runtime-specific flag allowlist. |
| `packages/cli/src/services/service-config.ts` | Apply TLS launch policy at the CLI-owned `options()`/`processEnv` boundary after considering saved env. Filter forbidden saved overrides so the downstream generic `service-contender` merge cannot restore them. Keep allowed system inputs and unrelated settings, persisted config and XDG state handling intact. | For forbidden inherited keys not guaranteed absent, use explicit undefined deletion entries in the overlay rather than omission; assert the effective downstream spawn environment.
| `packages/cli/src/services/standalone.ts` | Preserve normal `selfCommand`, lease credential, stdio and cleanup contracts. Change only if the verified child policy requires it; explicit test command injection remains supported and is not accepted as proof of normal self-launch. |
| `packages/cli/test/self-command.test.ts`, `service.test.ts`, `standalone.test.ts`, existing TLS fixtures | Verify normal managed/standalone child selection in both modes, hostile saved env, unchanged unrelated env/auth/lease, exact argument propagation and actual authenticated info. |
| `packages/cli/script/build.ts`, `build-node.ts`, `service-smoke.ts` and existing CLI artifact tests | Reuse host-artifact build/smoke owners. Restore native default/explicit bundled/explicit system startup and mode assertions; exercise normal child owners and ordinary HTTPS on both native artifacts and source runtimes with the controlled CA. Real SEA recovery verifies exact args and required FFI behavior. T021 alone builds the embedded Bun artifact once on the final tree for both artifact tests and T013; it retains the tested binary and its absolute path/SHA-256 manifest. T013 consumes that exact artifact without rebuilding. |

T021 native drivers: real `service start` (`commands/handlers/service/start.ts` → `ServiceConfig.options()` → normal `selfCommand`), real standalone CLI command through `services/server-connection.ts::resolve` → `Standalone.start()` in isolated state (hold command/lease alive for authenticated child info), and a controlled fixture plugin installed through the existing service-smoke plugin path to perform ordinary `fetch` in the artifact process. Record attempt marker, PID and TLS outcome; positive control and zero HTTP invocations plus certificate-rejection evidence distinguish a TLS failure from early exit or transport failure. Force SEA recovery with `NODE_TLS_REJECT_UNAUTHORIZED=0`, assert exact application arguments and exercise required FFI in the recovered native process. Include ambient `system` and invalid selectors in the native no-flag matrix. No production test probe, injected self-command or bypass.

The independent review established these owner paths and source defects; runtime reproductions are still required. No new wire endpoint, generic spawn policy, persistence schema or TLS attestation authority. Exact current CLI APIs and fixtures must be captured in a targeted bundle before S3/S4 implementation (not a new planning exploration). S1/S2 accepted owner contracts are unchanged. See FR-018–023 and SC-008–010.

### Context resolution matrix

| Visible context | Authoritative input | Result |
|---|---|---|
| Session route | `useLayout().route()` | Exact route server, before tab/session hydration. |
| Draft route | matching draft tab in `useTabs().store` | Draft server; missing/unresolved is `undefined`. |
| Home, normal | `layout.home.focusedServer()` bound to a key projection of `home.server.focused` | The exact server Home already resolved, including a hydration override. No readiness suppression. |
| Home, project navigation | Same `layout.home.focusedServer()` bound by `EmptyProjects` to its `action.target().connection` | Exact resolved key, including `type === "loading"` with a connection. |
| Settings, project route | exact `view.server` from the Settings project route | Exact project server; no inventory fallback. |
| Settings, server-scoped root | `surface.server()?.key` | Selected server (existing owner fallback). |
| Settings, general/servers/about/other | captured source-context server | Actual Home/session/draft source, never an unrelated recent tab. |
| Connect/components/unknown | no context | `undefined` → `CA:UNKNOWN`. |
| Unlisted/removed identity | exact key lookup missing | `CA:UNKNOWN`, never a substitute. |

### Home binding contract

- `HomeOverview` and `EmptyProjects` are mutually exclusive mounted owners. Bind their existing connection accessors; neither Titlebar nor Settings independently resolves Home.
- Layout stores only a reactive accessor reference. In `layout.tsx` use a local helper (also the unit-test seam):

```ts
export function createHomeServerBinding() {
  const [bound, setBound] = createSignal<Accessor<ServerConnection.Key | undefined>>()
  return {
    focusedServer: () => bound()?.(),
    bindFocusedServer(accessor: Accessor<ServerConnection.Key | undefined>) {
      // A fresh wrapper identifies this binding even if the same accessor is bound twice.
      const binding = () => accessor()
      setBound(() => binding)
      return () => setBound((current) => current === binding ? undefined : current)
    },
  }
}
```

- Instantiate once in Layout init; spread its returned methods into the existing `home` object (near `selection: createMemo(() => store.home.selection)`). `createSignal`, `Accessor` and `ServerConnection` are already imported. A plain variable is not sufficient: Titlebar can read before either owner mounts.
- `HomeOverview` already has `const layout = useLayout()` and `const home = createHomeController()`. Bind `() => { const conn = home.server.focused(); return conn ? ServerConnection.key(conn) : undefined }`; add `onCleanup` and runtime `ServerConnection` imports.
- `EmptyProjects` in `home/projects/landing.tsx` already has `const action = useProjectStart()`. Add `useLayout`, runtime `ServerConnection`, and `onCleanup` imports; bind `() => { const conn = action.target().connection; return conn ? ServerConnection.key(conn) : undefined }`. Register each returned cleanup with `onCleanup`. Keep ProjectLanding's restore/navigation behavior unchanged.
- In both cases bind the accessor, not its value. Layout's `focusedServer()` is shared by Titlebar and Settings capture. No persisted selection, extra resolver, readiness gate or new Home store.
- Test a reader created before binding, subsequent reactive key changes, undefined key, same-accessor rebinding, old cleanup after new binding, and owner unmount. Production fixture covers real initial Home, hydration override, persistence, project-navigation loading target, and Settings opened from both variants.

### Settings ownership contract

- Canonical server-scoped root tabs: `projects`, `workspaces`, `providers`, `models`, `extensions`; one definition is consumed by `settings/shell.tsx` and `settings/route.ts`.
- Project view: exact `view.server`; `surface.server()` inventory fallback must not replace it.
- Server-scoped root: `surface.server()?.key`.
- Non-server page: source-context server captured by the existing `SettingsSurface.show(view)` owner before navigation can unmount Home and preserved across subsequent replacements. Extend the existing location state with `sourceKey?: ServerConnection.Key | null`. When closed, capture `route.server` for session, matching draft tab key for draft, `layout.home.focusedServer()` for either Home, otherwise `undefined`; serialize unresolved as `null`. When already open, keep the existing captured value (including `null`); only missing legacy state uses the old source-resolution logic, then capture that result. In `sourceServer`, consult captured `sourceKey` before the existing project-navigation/tab fallback when open; `null` is explicit unknown. Preserve existing `server()` inventory fallback and redirects. No `useProjectStart` call inside Settings.
- An explicitly unresolved captured source yields `undefined`; missing legacy navigation state uses existing source resolution and is not treated as explicit unknown.
- Do not add a second navigation owner in `settings/command.tsx`. `useProjectStart` already consumes `useSettingsSurface`; the Home binding avoids this circular dependency. No second Settings store; existing redirects and availability remain. T008 depends on T007.

### Health incarnation contract

- Probe acceptance requires exact current key, slot type, incarnation and current attempt equality.
- `answeredSince` is exclusively the retry-waiter completion predicate, not probe acceptance.
- A newly listed slot or remove/relist gets a new incarnation. A changed URL/password or a transition from staged plugin to ready endpoint starts a new endpoint incarnation; a return to staged invalidates the old endpoint. Preserve attempt progression while listed.
- Attempts increase monotonically while a slot remains listed, including endpoint/credential transitions. Attempts reset to 1 only when remove/relist recreates the slot.
- A pending retry waiter targeting attempt N settles through `answeredSince` when the current slot's accepted attempt is `>= N`; credential replacement must not reset attempts to 1 and strand it. The superseded incarnation's answer is rejected.
- Rejected completions cannot update health or notify listeners.
- Exact driver/cache seam: see the internal contract §5. `createServerHealth` passes a required `HealthProbeScope` second argument to its checker; existing one-argument injected fakes remain assignable. `useServerHealth` creates one owner-local checker/cache and disposes it on Solid owner cleanup. `useCheckServerHealth()` retains its existing one-argument endpoint-keyed non-owner API used by `servers/connect/controller.ts`. Reuse cache lookup/settlement mechanics; no new health owner. Within the owner cache, JSON tuple key `[key, incarnation, endpointCredentials(http)]` plus the cache instance's identity isolates lifetimes. Guard TTL expiry and settlement by current entry identity; expired/disposed entries cannot reappear. A stage→ready transition at the same URL/password must not reuse the previous endpoint's promise. Preserve unchanged-identity coalescing within TTL. Cross-key cache hits must no longer substitute another identity's observation; this may remove prior cross-key physical-request coalescing, not add a second polling path. Request accounting compares the same valid owner probe schedule with/without route switches, including authorization/retry counts; distinct identities have their own observation.
- Refresh retention, poll interval, authentication and existing retry semantics remain.

## Deterministic Regression Coverage

### Unit tests

| Test owner | Cases |
|---|---|
| `titlebar-ca-badge.test.ts` | Existing mapping; route matrix; normal Home uses bound value; project Home loading with resolved connection; Settings project/root/source; unlisted/removed undefined; exact 4096/4097/sidecar keys. |
| `layout.test.ts` | Reactive binding helper, reader before binding, later changes, undefined, same-accessor rebind, owner-specific cleanup; real Home projection and hydration covered by e2e. |
| `health-machine.test.ts` | Initial checking; accepted bundled/system; refresh retention; credential/endpoint change; remove/relist stale successful bundled answer; stale unauthorized; exact-attempt mismatch rejected; zero stale notifications; current answer accepted; credential replacement with pending retry waiter settling on current accepted answer. |
| `health.test.ts` and `test-browser/ssh-health.test.ts` | Cache/HTTP unit tests in the first; controlled-promise real driver tests under existing browser conditions in the second: old incarnation completion ignored before listener; exact-attempt completion accepted; cache does not coalesce across incarnations, owner lifetimes or keys; bounded expiry/owner disposal; coalesces within one lifetime; non-owner consumer remains endpoint-keyed; auth remains. |
| `settings/route.test.ts` | Project exact server; server root selected; general/servers/about source; retained selected server on general does not override; missing values undefined. |

### Production-wiring fixtures/e2e

- Reuse the `AppInterface` servers/router fixture architecture demonstrated by `e2e/utils/app-direction.fixture.tsx` and `settings-wsl.fixture.tsx`; add `tls-ca-badge.fixture.tsx` and `tls-ca-badge.html` with the real titlebar, registry and health path. Add `"e2e/utils/tls-ca-badge.html"` to the existing `VITE_OPENCODE_TEST_FIXTURES === "1"` `rolldownOptions.input` array in `packages/app/vite.config.ts`. `playwright.config.ts` already sets that env flag for its own dev/built web server; use `/e2e/utils/tls-ca-badge.html` in both runs. No production build fixture exposure.
- Extend `MockServerConfig` and the existing `info: () => Effect.succeed({...})` in `mock-server.ts` to support optional mode values, including deliberate omission (the capability itself is mandatory). Use a controlled `/api/info` route override for held/changed/unauthorized answers, reusing protocol-faithful mock fields and CORS behavior. Per-identity request counts and auth headers must be observed; use distinct test credentials if a sidecar and HTTP alias share a URL so controlled observations are independently attributable.
- Three identities: 4096, 4097 and the actual sidecar shape `{ type: "sidecar", variant: "base", http: { url: endpoint } }`; `ServerConnection.key()` is `"sidecar"` independent of URL.
- Controlled Home hydration: initial resolved selection, hydration-time override, persistence completion and owner cleanup; project-navigation Home source captured on Settings open, including resolved loading target and fallback; both Home layouts return correct source on general Settings.
- Two servers with the same mode: switch to destination, then invalidate/change only destination's answer; badge must follow destination despite an unchanged label before the change.
- Removed-route identity: navigating to a removed server's session route shows unknown, never another server.
- Settings project-route negative: project view uses exact `view.server`, not the inventory fallback.
- Request accounting: no additional `/api/info` requests, polling cycles or auth/retry attempts due to badge/context changes; compare equal controlled intervals. Explicitly cover healthy missing mode, unresolved draft→resolved, A Home→B session→A Home, destination checking→accepted answer, Settings selected A→return B, sidecar/HTTP alias with no substitution, and loss/unauthorized/recovery/credential invalidation on tabless and session routes. Assert existing label, CSS state, tooltip and status role in both builds.
- Keep the existing development and `PLAYWRIGHT_BUILD=1` runs of the new CA badge keeper and the existing multi-server keeper.

## Development and Compiled Acceptance Commands

### Baseline before production edits

Run existing applicable gates only; do not run a new test file on HEAD:

```bash
bun run --cwd packages/app test:harness
bun run --cwd packages/app typecheck
bun run --cwd packages/app typecheck:e2e
bun run --cwd packages/app test:unit
bun run --cwd packages/app test:e2e -- --project=chromium regression/multi-server.spec.ts
(cd packages/app && bun test --conditions=browser --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./test-browser/ssh-health.test.ts)
```

Record exact exit codes and counts. The documented feature-012 final full-suite baseline is SDK `bun run --cwd packages/sdk test` exit 1, 44 pass / 10 fail, all `TLS CA mode has not been verified` at `packages/util/src/tls-ca.ts:104` in `test/instances.test.ts`, `test/request-retention.test.ts` and `test/instances-effect.test.ts`; Core `bun run --cwd packages/core test` exit 1, 7636 pass / 38 skip / 3 fail: `test/tool-shell.test.ts` ×2 ("conditional substitutions respect once/always", `/bin/bash: wait: pid N is not a child of this shell`, exit 127) and `test/shell-scan/compound-parity.test.ts` ×1 (Bash 3.2 compound syntax parse error). Re-capture these at the current baseline; never report them as passing or use them to waive an in-scope gate.

### After correction

```bash
bun run --cwd packages/app test:harness
bun run --cwd packages/app typecheck
bun run --cwd packages/app typecheck:e2e
bun run --cwd packages/app test:unit
bun run --cwd packages/app test:e2e -- --project=chromium regression/tls-ca-badge.spec.ts
bun run --cwd packages/app test:e2e -- --project=chromium regression/multi-server.spec.ts
PLAYWRIGHT_BUILD=1 PLAYWRIGHT_WORKERS=1 \
  bun run --cwd packages/app test:e2e -- --project=chromium regression/tls-ca-badge.spec.ts
```

New regression tests must demonstrate decisive failures against the old behavior where applicable. Record exact exit codes, counts and assertion preservation. Never mask exit status through a pipeline.

### Compiled standalone acceptance

Use the single-process Python/Playwright smoke in `quickstart.md` §5 using the retained T021 artifact and its verified path/SHA-256 manifest, without rebuilding. If the artifact is missing, mismatched or its build inputs changed, return to T021 and repeat the affected T021/T022 evidence before T013. It owns its child and isolated environment from startup through authenticated `/api/info`, pairing and tabless Home verification; cleanup runs on failure as well as success. No Vite, no shell `exit`, no unrelated process termination. Record original status and separate info/browser observations.

## Gates and Baseline Failures

Required gates after correction: targeted unit tests (including new binding/health/driver tests), app harness, app typecheck, e2e typecheck, full app unit suite, production-wiring fixture/e2e three-identity matrix, new CA badge keeper in development and compiled modes, existing multi-server keeper, and the isolated compiled-binary Home check, plus S3/S4 targeted CLI/util/server/client regression tests, affected-package typechecks and the two native artifact matrices. Any in-scope failure blocks completion.

Baseline discipline:

- Existing gates run before edits; new tests are not required to exist on HEAD.
- New regression cases fail decisively against old behavior where applicable and pass after correction.
- The documented SDK and Core failures above are baseline evidence; SDK attestation failures are an in-scope embedded-host boundary defect to correct in S3, and unrelated Core shell failures remain separate with exact files, reasons and counts; they are never reported as passing or used to waive a gate, and must be re-captured at baseline.
- Record exact commands, exit codes, counts and preserved assertions; do not mask statuses through pipelines.

## Complexity Tracking

No Constitution Check violations. No new project, store, polling driver, route resolver, dependency, schema, migration or titlebar layout is added.

### Expanded-scope gate discipline

Reuse completed baseline logs for identical inputs; the newly affected CLI/TLS owners require their existing targeted baseline (see T001 and quickstart §8). An incomplete Core run is not PASS. The observed e2e typecheck and multi-server failures require bounded attribution and correction if in scope, or explicit maintainer-approved treatment otherwise; do not classify them as environment failures merely because they precede edits. Final gates remain mandatory; do not repeat an identical build or gate whose full inputs are demonstrably unchanged. Rerun changed dependency closures, including SDK/Core if the TLS changes can affect them. This is evidence reuse, not a waiver. All original health and badge tests remain required.
