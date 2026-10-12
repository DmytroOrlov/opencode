# Internal Contract: CA Badge Server Context

**Feature directory**: `specs/013-fix-tls-ca-badge`
**Actual checkout branch**: `011-restore-config-integrity`

Internal application contract; not a wire/public API.

## 1. Context selector

```ts
type CaBadgeServerInput = {
  route: LayoutRoute
  draftServer?: ServerConnection.Key
  homeServer?: ServerConnection.Key
  settingsServer?: ServerConnection.Key
}

function selectCaBadgeServer(input: CaBadgeServerInput): ServerConnection.Key | undefined
```

| Route | Result |
|---|---|
| `session` | `route.server` |
| `draft` | `draftServer` |
| `home` | `homeServer` |
| `settings` | `settingsServer` |
| other | `undefined` |

No readiness flag, fallback, signal, timer or I/O. Callers pass the owner value or `undefined`.

## 2. Home focused accessor binding

```ts
// Layout owner
function focusedServer(): ServerConnection.Key | undefined
function bindFocusedServer(
  accessor: Accessor<ServerConnection.Key | undefined>,
): () => void
```

- `HomeOverview`’s `home.server.focused()` returns `ServerConnection.Any | undefined`.
- `HomeOverview` binds a read-only projection `() => { const connection = home.server.focused(); return connection ? ServerConnection.key(connection) : undefined }`.
- Layout stores only a reactive projected accessor reference (`createSignal<Accessor<ServerConnection.Key | undefined>>()`, function setter wrapper), never a selection value. Give each binding its own wrapper so stale cleanup cannot clear a later binding, even if the same accessor is rebound.
- `focusedServer()` reads the current bound accessor.
- Cleanup clears only its own accessor; it never clears a newer binding.
- `HomeOverview` registers cleanup with `onCleanup`.
- No Home selection machine, persistence, worktree effect or controller lifetime change.

`EmptyProjects` (in `home/projects/landing.tsx`) binds the same Layout API to its existing `action.target().connection`, projected to a key with an undefined guard; cleanup uses `onCleanup`. A `loading` target may contain a resolved connection. Both Home layouts pass `layout.home.focusedServer()` as `homeServer` to the pure selector; neither the titlebar nor Settings recomputes Home selection. No extra selector input is needed.

## 3. Settings context contract

```ts
function isSettingsServerView(view: SettingsView): boolean
function selectSettingsContextServer(input: {
  view: SettingsView
  selectedRoot: ServerConnection.Key | undefined
  project: ServerConnection.Key | undefined
  source: ServerConnection.Key | undefined
}): ServerConnection.Key | undefined
```

- Project view → exact `project` (`view.server`); never `surface.server()` inventory fallback.
- Server-scoped root (`projects`, `workspaces`, `providers`, `models`, `extensions`) → `selectedRoot` (`surface.server()?.key`).
- General/Servers/About/other → `source`.
- One canonical server-tab definition is consumed by `settings/shell.tsx` and `settings/route.ts`.
- `SettingsSurface.show(view)` is the existing navigation owner. It captures the current source-context key, or an explicit-unresolved marker, into the existing `settings` navigation state before `navigate()`, and preserves it across subsequent Settings replacements. All surface navigation methods and search navigation continue to delegate to `show`.
- Navigation state extends its existing `settings` object with `sourceKey?: ServerConnection.Key | null`. On first opening, capture session route server, matching draft-tab server, or the shared Layout Home binding (both layouts); other contexts resolve undefined. Store `null` for explicit unresolved. On replacements preserve captured value, including `null`; missing legacy state uses existing source resolution. `sourceServer()` reads captured value before old fallbacks while open. No fallback on explicit unresolved.
- No second navigation owner is added in `settings/command.tsx`. `SettingsSurface` must not call `useProjectStart`, which already consumes `useSettingsSurface`; source capture reads the shared Home binding supplied by T007. T008 must follow T007.
- Existing redirects, availability and navigation lifecycle remain.

## 4. Health lookup contract

```ts
const key = selectCaBadgeServer(input)
const health = key ? global.servers.health[key] : undefined
const mode = selectServerTlsCaMode(health)
const badge = caBadgeMapping(mode)
```

- Exactly one key lookup; no fallback key.
- Healthy-only selector unchanged.
- No request, timer, retry or CA inference in the titlebar.
- `undefined` → existing `CA:UNKNOWN`.

## 5. Health incarnation contract

- Identity is the registry key. `sidecar`, 4096 and 4097 are distinct.
- A newly listed slot, remove/relist, changed URL/password, or return from a staged plugin to a ready endpoint gets a new incarnation. Entering staged invalidates the former endpoint. A pure monotonically increasing counter in `ServerHealthState` supplies incarnation IDs; carry it through every state constructor. No generation allocation from time, randomness or module-global mutable state.
- While a slot remains listed, attempts increase monotonically, including endpoint/credential transitions. Attempts reset to 1 only when remove/relist recreates the slot.
- Slots carry `incarnation`; probe effects and `probe.settled` carry it.
- Probe acceptance requires exact current key, slot type, incarnation and current attempt equality. `answeredSince` is only the retry-waiter completion predicate.
- Remove/relist creates a new incarnation; a stale attempt 1 from the discarded incarnation is rejected by the incarnation mismatch.
- A pending retry waiter targeting attempt N settles through `answeredSince` when the current slot's accepted attempt is `>= N`; credential replacement must not reset the sequence to 1.
- Rejected completions must not update health or notify listeners.
- An unchanged identity's refresh retains its last accepted result/mode.
- Exact driver/cache seam (existing `health.ts`, around `useCheckServerHealth`, `useServerHealth` and `createServerHealth`):

```ts
export type HealthProbeScope = {
  readonly key: ServerConnection.Key
  readonly incarnation: number
}
type HealthChecker = (
  http: ServerConnection.HttpBase,
  scope: HealthProbeScope,
) => Promise<ServerProbeResult>
// Proposed owner-local factory, independently testable:
export function createServerHealthChecker(fetcher: typeof globalThis.fetch): {
  check: HealthChecker
  dispose: () => void
}
```

- `createServerHealth(servers, check: HealthChecker, onProbe?)` invokes `check(effect.http, { key: effect.key, incarnation: effect.incarnation })`; capture effect key/incarnation/attempt in each completion. `ServerProbe` notification payload remains unchanged. Existing one-argument check fakes remain compatible.
- `useServerHealth` obtains `platform.fetch ?? globalThis.fetch` as today, creates one `createServerHealthChecker` instance, registers its `dispose` with `onCleanup`, and passes `checker.check` into `createServerHealth`. `useCheckServerHealth()` retains its current one-argument API and endpoint-keyed non-owner coalescing for `servers/connect/controller.ts`.
- Instance-local cache identity is the owner lifetime token; inner key is `JSON.stringify([scope.key, scope.incarnation, endpointCredentials(http)])`. Reuse existing cache hit/settlement mechanics in this owner rather than introduce a health data store. Keep 750 ms sharing of in-flight/current settled entries within a valid identity; evict owner entries at expiry (cancel/reschedule only their own expiry timer), guard settlement by the current entry and owner lifetime, and clear all owner entries/timers on disposal. An expired/replaced/disposed promise cannot refresh or reinsert its entry. No new periodic timer or probe; expiry is cleanup only. Preserve the non-owner cache API and its existing endpoint coalescing semantics.
- Cache must not adopt an old endpoint observation after stage→ready even at the same URL/password. Separate keys/owners cannot share one observation; removal of previously cross-key coalescing is an intentional identity correctness repair, not a badge request path. Test unchanged scope coalescing, old/new incarnation and staged transition, cross-key/owner isolation, TTL, disposal/late completion, and non-owner compatibility. Real reactive driver regressions belong in the existing `packages/app/test-browser/ssh-health.test.ts` (`createRoot`, `createSignal`, `Promise.withResolvers`); HTTP/cache tests in `health.test.ts`. Retain all old assertions.
- Authentication, poll interval and existing retry semantics remain.

## 6. Presentation contract

- `bundled` → green `CA:BUNDLED`; `system` → existing `CA:SYSTEM`; unavailable → red `CA:UNKNOWN`.
- Existing label, colour, tooltip and `role="status"` remain.
- Badge stays in the right-hand titlebar items container under `!props.verticalTabs`.
- No build-channel condition, dev-only gate, `BETA` replacement or V1 channel indicator.

## 7. Non-goals

- No new health store, poller, server-info request path, route resolver or database field. The badge/health contract never selects TLS policy; the separate CLI launch parity contract in this same feature owns FR-018–023.
- No changes to authentication, effective trust-set attestation, server isolation or features 011/012. The explicitly scoped CLI launch corrections do not alter this context contract.
- No titlebar layout/visibility expansion.
