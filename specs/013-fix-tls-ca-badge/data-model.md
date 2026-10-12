# Data Model: TLS CA Policy and Badge Parity

**Feature directory**: `specs/013-fix-tls-ca-badge`
**Actual checkout branch**: `011-restore-config-integrity`

This feature adds no persisted schema. It defines in-memory context/health semantics and a route-lifetime accessor binding.

## Entities

### Server identity

| Field | Type | Source | Rules |
|---|---|---|---|
| `key` | `ServerConnection.Key` | `ServerConnection.key(conn)` | Exact identity. `sidecar`, `http://127.0.0.1:4096` and `http://127.0.0.1:4097` are distinct. |
| `connection` | `ServerConnection.Any` | registry | Display name, hostname and port are not identity. |
| `health` | `ServerHealth \| undefined` | `global.servers.health[key]` | Existing per-identity observation; absence means unknown. |

### Current server context

| Context | Owner | Resolved server | Unavailable result |
|---|---|---|---|
| Session route | `useLayout().route()` | `route.server` | `undefined` if key is unlisted or no verified mode. Tab existence irrelevant. |
| Draft route | `useTabs().store` via `route.draftID` | draft tab's `server` | `undefined` when draft missing/unresolved/unlisted. |
| Home, normal | Layout accessor bound to a key projection of Home's `home.server.focused` | actual Home resolved connection, including hydration override, converted through `ServerConnection.key` | `undefined` while no controller accessor is bound, the focused connection is undefined, or Home resolves none. No readiness suppression. |
| Home, project navigation | same Layout accessor bound by `EmptyProjects` to its existing `action.target().connection` | target connection key whenever resolved, including `type === "loading"` | `undefined` when no owner is bound or no connection is resolved. |
| Settings, project route | exact `view.server` | exact project-route server | `undefined` if absent; never inventory fallback. |
| Settings, server-scoped root | `surface.server()?.key` | selected server (existing owner fallback) | `undefined` only when no server resolves. |
| Settings, general/servers/about/other | captured source-context server | server Settings opened from | `undefined` when source absent. |
| Connect/components/unknown | none | none | `undefined`. |

**Invariant C1**: Route-scoped contexts never substitute another listed server.

**Invariant C2**: A project Settings route uses its exact `view.server`, not the inventory fallback.

**Invariant C3**: Settings source server is the actual Home/session/draft source captured by `SettingsSurface.show(view)` at open time, preserved across subsequent Settings replacements, not reconstructed from a recent tab.

**Invariant C4**: An explicitly unresolved captured source yields `undefined`. Missing legacy navigation state is a different case and uses existing source resolution; it is not treated as an explicit unknown.

### Home focused accessor binding

| Field | Type | Rules |
|---|---|---|
| `focusedConnection` | `Accessor<ServerConnection.Any \| undefined>` | The mounted Home owner’s existing `home.server.focused()` or `EmptyProjects`’ `action.target().connection`; remains authoritative. Not stored by Layout. |
| `focusedServer` binding | `Accessor<ServerConnection.Key \| undefined> \| undefined` | Key projection bound by `HomeOverview` or `EmptyProjects`; Layout stores only the reactive accessor reference, never a selection value. |
| `bindFocusedServer(accessor)` | method | Accepts the projected key accessor. Each binding has a unique wrapper. Returns cleanup that clears only its own binding; never a newer binding, including rebinding the same accessor. |
| `layout.home.focusedServer()` | accessor | Reads the bound key accessor; `undefined` when unbound. |

**Lifecycle**:

```text
HomeOverview or EmptyProjects mounts
  -> project its existing focused/target connection through ServerConnection.key with an undefined guard
  -> bindFocusedServer(projectedKeyAccessor)
  -> titlebar reads the real resolved server key

Home selection override during hydration
  -> focusedConnection already returns the override connection
  -> key projection returns the override key
  -> badge follows it; no persistence required

Home owner unmounts
  -> own cleanup removes only its binding
  -> newer binding, if any, is untouched
```

No Home selection machine, persistence, worktree effect or controller lifetime change.

### Settings view context

| Field | Type | Rules |
|---|---|---|
| `view` | `SettingsView` | `root` or `project`. |
| `selectedRoot` | `ServerConnection.Key \| undefined` | `surface.server()?.key` for server-scoped root pages. |
| `project` | `ServerConnection.Key \| undefined` | Exact `view.server` for project views. |
| `source` | `ServerConnection.Key \| undefined` plus explicit-unresolved marker | Captured source-context server. `SettingsSurface.show(view)` captures it before navigation can unmount Home and preserves it across subsequent Settings replacements. Navigation field `sourceKey?: ServerConnection.Key | null`: explicit `null` means unresolved, missing field means legacy. Both Home layouts use the shared binding. |

**Canonical server root tabs**: `projects`, `workspaces`, `providers`, `models`, `extensions`. One definition consumed by the Settings page owner and context selector.

**Selector**: project → exact `view.server`; server-scoped root → `selectedRoot`; other pages → `source`.

### Verified server answer and incarnation

| Field | Type | Rules |
|---|---|---|
| `type` | health discriminant | `healthy`, `checking`, `refreshing`, `starting`, `auth`, `stopped`, `unauthorized`, `unreachable`, `incompatible`. |
| `tlsCaMode` | `"bundled" \| "system" \| undefined` | Present only on a healthy answer that reported it. |
| `incarnation` | number | Listing lifetime, unique within one health-owner lifetime. A newly listed slot, remove/relist, changed URL/password, or staged→ready transition gets a new current incarnation. Entering staged invalidates the old endpoint. Pure owner-state counter allocates unique incarnations. |
| `attempt` | number | Per-key probe attempt. Increases monotonically while the slot remains listed, including endpoint/credential transitions. Resets to 1 only when remove/relist recreates the slot. |
| `endpoint` | `{ url, password, managed }` | Credential identity is `${url}\n${password ?? ""}`. |
| `result` | `ServerProbeResult` | Last accepted result, retained while refreshing. |

**Invariant H1**: Only an accepted healthy answer exposes a CA mode.

**Invariant H2**: A changed URL/password starts a new current incarnation and the next higher attempt; the old answer is not carried.

**Invariant H3**: Probe acceptance requires the exact current key, slot type, incarnation and current attempt equality. `answeredSince` is only the retry-waiter completion predicate, not the probe acceptance predicate. A non-exact completion is ignored before state/listener updates.

**Invariant H4**: Remove/relist creates a new incarnation and a recreated slot whose attempt starts at 1. A stale attempt 1 from the discarded incarnation is rejected by the incarnation mismatch even though the numbers are equal.

**Invariant H5**: An unchanged identity refreshing keeps its last accepted answer until a newer accepted answer replaces it.

**Invariant H6**: The owner-local cache instance is the health-owner lifetime token; its tuple key is `[key, incarnation, endpointCredentials(http)]`. It coalesces only within one valid endpoint lifetime (750 ms), never adopts a discarded incarnation’s promise, does not collide across owner lifetimes or keys, expires owner entries and clears them/timers on disposal. Late completion cannot reinsert an expired/replaced/disposed entry. Existing non-owner consumers keep endpoint-keyed coalescing and the one-argument API. See exact driver/checker seam in internal contract §5.

**Invariant H7**: A pending retry waiter targeting attempt N while a slot remains listed settles through `answeredSince` when the current slot's accepted attempt is `>= N`. Credential replacement must not reset the attempt sequence to 1 and strand that waiter; probe acceptance still requires exact current attempt equality, and the superseded incarnation's answer remains rejected.

### CA badge presentation

| Mode | Label | Presentation |
|---|---|---|
| `bundled` | `CA:BUNDLED` | existing green success classes |
| `system` | `CA:SYSTEM` | existing warning classes |
| unavailable | `CA:UNKNOWN` | existing danger classes |

Label, colour, tooltip and `role="status"` remain unchanged. The badge remains under the existing `!props.verticalTabs` guard; no channel condition.

## State Transitions

### Health slot with incarnation

```text
list endpoint
  -> new incarnation, attempt 1, checking
  -> settled(healthy|unauthorized|unreachable)
  -> refreshing (same incarnation, last result retained)
  -> settled(current attempt)

remove key
  -> slot removed
relist same key
  -> new incarnation, recreated slot, attempt 1, checking
  -> old incarnation's completion ignored
  -> current completion accepted only

changed URL/password
  -> same listed slot, new incarnation, next higher attempt, checking
  -> prior incarnation's answer ignored
  -> pending retry waiter for an earlier attempt still settles on the current accepted answer

Settings navigation
  -> surface.show(view) captures source key, or explicit-unresolved marker, before navigation
  -> subsequent Settings replacements preserve the captured source
  -> legacy navigation state without a source field uses existing source resolution
```

### CA presentation

```text
checking / no entry / unlisted / unauthorized / unreachable / incompatible / starting / auth / stopped
  -> CA:UNKNOWN

healthy bundled -> CA:BUNDLED
healthy system  -> CA:SYSTEM
healthy absent  -> CA:UNKNOWN
```

### Context switch

```text
context A -> context B
  -> exact B key -> B health only
  -> B healthy mode -> B label
  -> B unknown -> CA:UNKNOWN
  -> never retain A's label/colour/tooltip
```

## Validation Rules

- Exact key indexes `global.servers.health`; no alias/port/display-name substitution.
- Session route server is valid before tab/session/project/database data.
- Empty database cannot suppress a verified mode.
- Unlisted/removed identity yields unknown even if another server is healthy.
- Home accessor binding exposes Home's actual resolved connection key without persisting or duplicating selection; an undefined focused connection projects to undefined.
- Project Settings route uses exact `view.server`.
- Settings source is captured by the existing `SettingsSurface.show(view)` owner; explicit unresolved and missing legacy state remain distinguishable.
- Health attempts remain increasing while a slot is listed; incarnation independently identifies the listing lifetime.
- Health cache identity is owner-, key- and incarnation-scoped, bounded by its TTL and cleared on owner disposal.
- Health owner remains the sole answer source; titlebar performs no fetch/timer/inference.
- No persisted field is added or migrated.

## CLI launch parity (in-memory only)

| Entity.field | Meaning / constraint |
|---|---|
| `TLS launch.selectedMode` | Existing `TlsCaMode` (`bundled` or `system`); fresh no-selector defaults bundled; self-launch and recovery carry the selected mode explicitly. |
| `TLS launch.verifiedMode` | Existing process-local attested mode; only a successfully verified effective trust set can publish it. | The embedded-only ServerInfo projection may omit the value when no process attestation exists; listening-server construction still requires a verified value.
| `TLS launch.applicationArgs` | Exact user argument sequence, retaining `--` semantics; native synthetic executable/entrypoint slots are excluded on recovery. |
| `TLS launch.environment` | Sanitized launch/callback environment; bundled has no certificate override keys (including empty); no disallowed runtime options/recovery state/disabled verification; system permits intended CA inputs. Saved service env cannot override verified policy. |

No persisted selection, new policy state or wire field. The existing CLI bootstrap and self-launch owners implement these invariants; the existing verifier and authenticated metadata remain the sole authority for the effective mode.
