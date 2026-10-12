# Feature Specification: TLS CA Policy and Badge Parity

**Feature Directory**: `specs/013-fix-tls-ca-badge`

**Created**: 2026-11-24

**Status**: Draft

**Input**: User description: "Fix TLS CA badge ownership in the V2 application. The badge must report the verified effective TLS CA mode of the actual connected server, independently of Git branch, build channel, database, project, session or development/compiled runtime. Observed regression: a compiled standalone server on port 4097 returns HTTP 200 with `tlsCaMode: "bundled"` from its authenticated `/api/info`, while the application displays red `CA:UNKNOWN`. The verified current implementation in `packages/app/src/shell/titlebar/titlebar.tsx` resolves CA mode exclusively through `currentTab()?.server`. Consequently, Home and other routes without an active session tab cannot display the verified server CA mode."

The badge is a trust indicator, not a decoration. It tells the user which certificate authority set the server actually verified at startup. A correct badge therefore has two obligations: it must describe the server that owns the user's current context, and it must never borrow another server's answer. The current implementation satisfies the second obligation only because it usually has no server to describe; on Home and other tabless routes it cannot satisfy the first. This correction restores that ownership and the historical TLS policy selection and process-isolation contracts identified by the independent V1→V2 parity review. The existing effective trust-set attestation, authenticated reporting and health ownership remain authoritative.

## Clarifications

### Session 2026-11-24

- Q: Should the correction restore V1's server-context ownership or V2's tab-only ownership, and should CA visibility return to a dev-only channel? → A: Restore V1's current-server ownership through V2's authoritative route, draft, Home, Settings and server-identity owners. Keep V2's healthy-only selector and authenticated server-information contract. Do not restore V1's dev-only visibility gate or channel-indicator behavior; the badge remains under the existing titlebar visibility guard in every build channel.
- Q: How should an initially checking server differ from an unchanged server refreshing after a previously accepted healthy answer? → A: A server with no accepted answer for its current identity displays `CA:UNKNOWN`. A refresh of the same unchanged identity retains the last accepted verified mode until a newer accepted answer replaces it; an accepted answer that is unhealthy changes the badge to `CA:UNKNOWN`.
- Q: When Settings' source context, selected server and visible page differ, whose CA mode should the badge show? → A: The server whose data the visible Settings surface represents. A server-scoped page follows its selected server; a page that does not show one server's data follows the source-context server. A retained selected server does not override the visible page, and returning to the app restores the route's server.
- Q: Which changes invalidate an accepted CA mode, and how are stale health answers treated? → A: A changed server identity, endpoint address or credentials invalidates the accepted answer immediately and returns the badge to unknown until that identity answers. A result from a superseded, aborted or unlisted probe attempt is ignored and can never replace or restore a mode.
- Q: Which acceptance gates and evidence should apply when documented environment failures coexist with the required development and compiled runtime coverage? → A: Required gates are the affected health-selection, health-transition, badge-presentation, route/Home/Settings context and multi-server checks in both development and compiled application modes, plus typechecks for affected packages. Previously documented unrelated environment failures are recorded with exact files, reasons, counts and baseline comparison; they are neither reported as passing nor counted as this change's regressions, and they cannot waive an in-scope gate. A compiled standalone server smoke check supplements, but does not replace, deterministic coverage.

### Scope amendment — historical TLS parity

The maintainer requests a single feature 013 covering both truthful badge ownership and the six TLS migration regressions established by the independent review of V1 `aab82e879b8f9ef7ef3c34d6d1f5861e7ec3e16c`, V2 `cbc8226979ae80daf9603f32db2d2002e7e5bc8d` and current HEAD `e21900d938f805d3ab3f1e65e2568966eff8bc1a`. This supersedes only the earlier exclusion of TLS policy selection and launch isolation. Existing badge, health, protocol, presentation and authentication decisions remain accepted. Effective-set attestation, rather than V1's exact runtime-flag predicate, remains the acceptance authority. No legacy health endpoints, V1 DebugBar or dev-only channel behavior are restored. Source-derived reachability must be reproduced by a decisive regression test where applicable; it is not reported as a reproduced runtime failure before execution.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A verified CA badge on tabless routes (Priority: P1)

As a user on Home, Settings or a draft session, I can see the verified CA mode of the server I am actually using, even when no session tab is open and the server has no projects or sessions yet.

**Why this priority**: This is the reported regression. The authenticated server reports `bundled`, yet the app shows red `CA:UNKNOWN` on the most common entry screen. A trust badge that is permanently unknown when no session is open is not a trust badge.

**Independent Test**: Run the application against one deterministic server whose authenticated server information reports a verified mode. Without opening any session tab, visit Home, Settings and a draft session, and assert the badge label, colour, tooltip and status role each time. Repeat with a server that reports the other verified mode and with a server whose database is empty.

**Acceptance Scenarios**:

1. **Given** the only listed server reports verified `bundled` and no session tab is open, **When** Home is shown, **Then** the badge displays green `CA:BUNDLED` with the bundled description, and the value is announced as a status.
2. **Given** the same server and no session tab, **When** Settings is shown, **Then** the badge continues to display the same verified mode rather than `CA:UNKNOWN`.
3. **Given** the same server and no session tab, **When** a draft session on that server is shown, **Then** the badge displays that server's verified mode.
4. **Given** a server with no projects and no sessions, **When** any of those routes is shown, **Then** the badge still displays the server's verified mode; an empty database cannot suppress it.
5. **Given** a server reports verified `system`, **When** any supported route is shown, **Then** the badge uses the existing `CA:SYSTEM` label, warning presentation and description.
6. **Given** a reachable server's information omits a verified mode, **When** the badge renders, **Then** it displays `CA:UNKNOWN`; no mode is guessed from the address, port, runtime, branch or build channel.
7. **Given** a draft route whose draft cannot yet be resolved to a server, **When** the route is shown, **Then** the badge does not borrow another server's mode; it updates to the correct mode as soon as the draft resolves.

---

### User Story 2 - One badge, one server, no cross-server leakage (Priority: P1)

As a user connected to several servers, I can navigate between Home, sessions, drafts and Settings and always see the CA mode of the server that owns that context, never a previously active or co-listed server's mode.

**Why this priority**: A displayed `CA:BUNDLED` that belongs to a different server is worse than `CA:UNKNOWN`; it presents false assurance about the connection the user is actually using.

**Independent Test**: Configure three distinct servers with different verified modes and health states: a development server on port 4096, a compiled standalone server on port 4097, and the Desktop background service identity. Seed Home selection and tabs so each context resolves to a different server, then navigate between them and assert the badge follows the context.

**Acceptance Scenarios**:

1. **Given** server A on port 4096 reports `system` and server B on port 4097 reports `bundled`, **When** Home selects A and is shown, **Then** the badge displays `CA:SYSTEM`; **When** a session on B opens, **Then** the badge displays `CA:BUNDLED`; **When** Home is shown again, **Then** it displays `CA:SYSTEM`.
2. **Given** the compiled standalone server on port 4097 reports `bundled`, **When** Home or a session resolves to port 4097, **Then** the badge displays `CA:BUNDLED` regardless of what the development server on port 4096 reports.
3. **Given** a development server on port 4096 reports `system` or is unreachable, **When** the current context resolves to port 4097, **Then** the badge never reflects port 4096's state.
4. **Given** the Desktop background service has its own server identity, **When** the current context resolves to that identity, **Then** the badge displays that identity's verified answer and never an HTTP alias's answer, even when both ultimately address the same process.
5. **Given** the current context switches to another server whose first health answer has not arrived, **When** the badge renders, **Then** it displays `CA:UNKNOWN` rather than the previous server's mode; **When** the new server's answer arrives, **Then** the badge updates to the new verified mode.
6. **Given** a session route references a server that has been removed or is no longer listed, **When** the badge renders, **Then** it displays `CA:UNKNOWN` and does not fall back to the first listed server.
7. **Given** Settings was opened from a session on server B and its per-server page lets the user select server A, **When** A is selected, **Then** the badge displays A's verified mode; **When** the user returns to the session, **Then** it displays B's mode again.
8. **Given** two servers report the same verified mode, **When** the user switches between them, **Then** the badge remains correct and must still be backed by the destination server's answer, not by the unchanged label.

---

### User Story 3 - Truthful updates across health loss, recovery and build modes (Priority: P2)

As a user diagnosing server trust, I can trust the badge when a connection becomes unhealthy or recovers, in both development and compiled runtimes, without the badge causing extra network probing.

**Why this priority**: A stale green badge after losing the server is misleading. The correction must preserve the existing health lifecycle instead of freezing or inventing CA state.

**Independent Test**: Drive the existing per-server health observation deterministically through healthy, refreshing, unreachable, unauthorized and recovered states while the badge is visible on a tabless route and on a session route. Repeat the acceptance run with the application served in development mode and as a compiled build.

**Acceptance Scenarios**:

1. **Given** the relevant server last reported `bundled`, **When** an accepted health answer for that server becomes unreachable or unauthorized, **Then** the badge displays `CA:UNKNOWN`; it does not retain the previous green state.
2. **Given** the relevant server is unavailable, **When** a later accepted answer reports `system`, **Then** the badge displays `CA:SYSTEM`; a later `bundled` answer displays `CA:BUNDLED`.
3. **Given** a refresh is in flight for the same unchanged server identity, **When** the badge renders, **Then** the last accepted verified answer for that identity remains displayed; **Given** that identity has no accepted answer yet, **Then** the badge is `CA:UNKNOWN`; **Given** the identity or its endpoint credentials change, **Then** the previous answer is not carried across and the badge is unknown until the new identity answers.
4. **Given** the current context does not change, **When** the badge renders on Home, Settings, drafts and sessions, **Then** rendering it starts no additional health probe and adds no polling beyond the single existing per-server health observation.
5. **Given** the badge is shown for a server that rejects the app's credentials, **When** the health result is unauthorized, **Then** the badge is `CA:UNKNOWN` and the existing authentication and retry behavior is unchanged.
6. **Given** the application runs from the development server or from the compiled standalone build, **When** the same server and route conditions are replayed, **Then** the label, colour, tooltip and transition behaviour are identical.
7. **Given** the process starts on a route with no session, **When** the first server answer arrives, **Then** the badge updates without requiring a session tab, navigation or reload.

---

### User Story 4 - Predictable verified trust across process launches (Priority: P1)

As a user running the CLI, a standalone server or a managed server, I can rely on the selected TLS CA policy being verified, independent of ambient selectors, hostile startup options and service environment overrides.

**Independent Test**: Use controlled process environments and a private CA HTTPS fixture with positive and negative controls. Exercise Bun source, Node source, compiled Bun and Node SEA, including their ordinary launch and recovery paths and the normal standalone/managed child owners.

**Acceptance Scenarios**:

1. **Given** a fresh invocation has no explicit CA selector, **When** ambient `OPENCODE_TLS_CA_MODE` is `system`, invalid or absent, **Then** it selects bundled. Both explicit supported selector forms still work, strict invalid/conflicting/camelCase errors precede command output, and arguments after `--` remain untouched.
2. **Given** a parent has verified either mode, **When** it launches its own standalone or managed server, **Then** the child verifies the parent's selected mode even if saved service environment attempts to override it. Unrelated environment settings, credentials and service lifecycle remain intact; legitimate system-mode CA additions remain supported.
3. **Given** a launch has disallowed runtime options already applied or needs CA recovery, **When** the production command runs, **Then** it runs only after a sanitized launch and verified trust, or fails before production command execution. Unrelated preload/loader hooks and inspector flags are not replayed; an explicitly supported marked debugger launch starts no second inspector. Clean verified launches may retain the fast path. Required runtime flags are preserved.
4. **Given** bundled mode is selected, **When** the verified command runs, **Then** all four certificate override keys are absent even if previously empty, runtime-option variables and recovery state are cleared, and certificate verification is enabled. System mode retains permitted CA inputs. Unrelated environment is preserved.
5. **Given** a packaged or source runtime requires recovery, **When** the CLI is relaunched, **Then** exactly the original application arguments are preserved (including `--` semantics); no synthetic executable argument appears in SEA. No recovery loop or unverified command execution is allowed.
6. **Given** attestation fails, **When** a command or server attempts to use that result, **Then** no verified mode is published, no requested command output is produced and an unattested server cannot listen. Empty/mismatched trust sets and disallowed bundled roots are rejected; exact bundled equality or exact system union is preserved.
7. **Given** the native artifacts and source runtimes run in both modes, **When** the controlled HTTPS fixture is contacted, **Then** ordinary verified system fetch trusts the permitted extra CA, bundled rejects it before any HTTP handler invocation, and authenticated `/api/info` reports the actual verified policy. A successful control proves the fixture and requested TLS attempt were exercised.

8. **Given** a fresh public Promise or Effect SDK `OpenCode.create()` in an unattested host process, **When** it builds its in-process routes without opening a listener, **Then** creation and normal requests succeed and optional server-info TLS metadata is absent, never inferred. An already attested embedded host reports only its actual verified mode. The listening-server entrypoint still rejects an unattested process before binding a socket.

### Edge Cases

- Home is shown before server, tab or layout state finishes hydrating. Until a server is genuinely resolvable, the badge is `CA:UNKNOWN`; once Home's own resolution settles, the badge must follow the server Home shows, including Home's documented fallback when its stored selection is not listed.
- A server is unlisted while its session route remains displayed. The badge is unknown; it must not silently become the first or last listed server's badge.
- A draft tab is removed or a draft route is restored before its tab exists. The transient is unknown, and the corrected mode appears when the draft resolves; the badge never uses the previously active tab's server.
- A server reports a healthy answer without `tlsCaMode`, as an older server may. This is genuinely unavailable and remains `CA:UNKNOWN`.
- A plugin-provided Desktop server is still starting, authenticating, stopped or failed. These are not verified healthy answers and remain `CA:UNKNOWN`.
- The same process is reachable through more than one identity (for example, the Desktop background service and an HTTP alias). Each identity has its own health answer; the badge follows the identity of the current context.
- Two listed servers have the same label, hostname or port number in different contexts. Identity, not display text or port, selects the health answer.
- The current server recovers after being unreachable. The badge returns to the recovered mode on the next accepted answer for that same identity.
- A server with no accepted answer is initially checking and displays `CA:UNKNOWN`. A server refreshing the same unchanged identity keeps its last accepted verified mode; those two states must not collapse into one unconditional unknown or one unconditional cached value.
- Settings is open while its source context, selected server and visible page name different servers. The badge follows the server the visible page represents, not the source context hidden behind it and not a co-listed server.
- The application is compiled rather than served by the development server. No build-time branch or channel may alter which mode is displayed.
- The build is a development, Beta or production channel. The CA badge keeps its existing titlebar visibility guard and is not replaced by a channel indicator such as `BETA`; channel membership neither hides the badge nor changes its mode.
- A server's endpoint address or credentials change while its route remains open. The accepted answer is invalidated even when the server keeps the same display label, and stale answers from the previous endpoint or credentials are ignored.
- The badge is rendered while the titlebar uses a vertical-tab or mobile arrangement. Existing visibility and accessibility behavior is preserved; this correction only changes which server the badge describes.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The CA badge MUST describe the server that owns the user's current visible context on every supported route, including Home, Settings, draft sessions, active sessions, an empty database and a route whose session data has not loaded yet. A session tab MUST NOT be required for a verified mode to appear. This restores the historical current-server ownership property through V2's existing context owners; it MUST NOT revive V1 runtime infrastructure, V1's dev-only visibility gate or V1 channel-indicator behavior.
- **FR-002**: Current-context resolution MUST reuse the existing authoritative owners that already decide which server a route or screen displays: the session route's server, the draft's server, Home's resolved server, and the server the Settings surface is showing. The badge MUST NOT introduce a second interpretation of route, tab, project or server selection.
- **FR-003**: A session route MUST take its server from the route itself, even before its tab, session record or message data exists. A draft MUST take its server from the resolved draft tab. Home MUST follow the server Home itself resolves, including its documented fallback when no valid selection is stored. Settings MUST follow the server whose data the visible surface represents: the selected server on a server-scoped page, and the source-context server on a page that does not show one server's data. A selected server retained in Settings state MUST NOT override the visible page; returning to the app restores the route's server.
- **FR-004**: The badge MUST resolve health by the exact identity of the current server. Display labels, host names, ports, loopback aliases, connection URLs and "first listed" order MUST NOT be used to substitute one server's answer for another.
- **FR-005**: Route-scoped contexts MUST NOT fall back to another listed server when their identified server is unlisted, removed or unresolved. Such a context displays `CA:UNKNOWN`. Home and general Settings may use the server their own owner displays, but only through that owner's established resolution.
- **FR-006**: The badge MUST display the existing green `CA:BUNDLED` presentation when, and only when, the relevant server's accepted health answer is healthy and reports verified `bundled`. It MUST display the existing `CA:SYSTEM` presentation when, and only when, that answer is healthy and reports verified `system`.
- **FR-007**: The badge MUST display `CA:UNKNOWN` with its existing danger presentation when the relevant server's verified mode is genuinely unavailable: no server context, unresolved context, a server that is not listed, or a health answer that is checking, starting, authenticating, stopped, unauthorized, incompatible, unreachable, or healthy without a reported mode.
- **FR-008**: The badge MUST update when the current context changes, when a new accepted health answer arrives, when the server recovers, or when server health is lost. On a context switch, it MUST NOT retain the previous server's label, colour or tooltip while the destination is unresolved.
- **FR-009**: An initially checking server with no accepted answer for its current identity MUST display `CA:UNKNOWN`. While a refresh is in flight for the same unchanged identity, its last accepted verified answer MUST remain displayed until a newer accepted answer replaces it; that retained answer is not a stale result. A changed server identity, endpoint address or credentials MUST start from unknown and MUST NOT inherit the previous identity's answer. Answers from superseded, aborted or unlisted probes MUST be ignored.
- **FR-010**: The correction MUST consume the existing per-server health observation and its existing verified `tlsCaMode` report. It MUST NOT add a second health store, a parallel probe, duplicate polling, a new server-info request path, or any client-side inference of CA mode from configuration, address, port, build channel or environment.
- **FR-011**: The existing effective trust-set attestation, authenticated server-information handling, credential handling, health polling ownership, retry behavior and server/database isolation MUST remain unchanged except for the explicitly specified selection, launch and cleanup corrections in FR-018 through FR-023. The badge remains observational and MUST NOT delay, weaken or alter connection, authentication or health behavior. The public SDK embedded host is not a CLI-owned listening server: permit omission of optional TLS metadata only for its in-process route layer when process attestation is absent. Do not implicitly select or verify a mode, mutate host TLS settings, or weaken the listening-server guard or verified reporting.
- **FR-012**: The displayed mode MUST be independent of Git branch, build channel, development versus compiled runtime, database contents, project contents, session availability and whether the server was started as a development or compiled standalone process. The badge's visibility MUST remain governed by the existing titlebar guard and MUST NOT become conditional on build channel or be replaced by a channel indicator.
- **FR-013**: Deterministic regression coverage MUST include: a multi-server matrix proving no cross-server mode is ever displayed across Home, sessions, drafts and Settings; an empty database and tabless-route case; a stale-health case covering loss, recovery and identity change; a server removed while its route is shown; and a request-accounting check proving no additional health probing. Each regression case MUST fail against the verified pre-correction behaviour where applicable.
- **FR-014**: Acceptance evidence MUST be produced in both development and compiled application runtimes, including a compiled standalone server reporting `bundled`. Development and compiled evidence MUST use deterministic controlled server identities and health answers; a real compiled standalone-server smoke check MUST exercise the authenticated server information path and MAY supplement, but MUST NOT replace, deterministic coverage. The same scenarios MUST produce the same badge outcome in both runtimes.
- **FR-015**: Existing assertions for TLS verification, server health, authentication and the CA presentation mapping MUST NOT be deleted, weakened, skipped or silently rewritten. New behavioural contracts MUST be covered at the strongest existing owner, and all in-scope existing tests and affected-package typechecks must pass. Documented environment failures outside the changed area MUST be reported with their exact baseline and reason rather than counted as passes or used to waive an in-scope gate.
- **FR-016**: The correction MUST preserve accepted features 011 (config integrity and fallback ordering) and 012 (session resilience parity). It MUST NOT alter configuration admission, commit or publication, fallback intent, SSE diagnostics, session retry or fallback safety, telemetry ownership or session-runner behaviour.
- **FR-017**: The correction MUST remain one independently reviewable feature suitable for one dedicated feature commit, containing only the badge server-context and health-identity corrections, TLS launch-policy parity corrections and their required regression coverage. The bounded SDK/ServerInfo embedded-host correction in FR-011 and its regression tests are included.

- **FR-018**: Restore the unconditional bundled default for fresh CLI invocations without an explicit selector, regardless of ambient `OPENCODE_TLS_CA_MODE`. Preserve strict existing parsing, explicit system/bundled selection, separator handling and failure before command output. Recovery and verified self-launches MUST carry the selected mode explicitly; ambient or saved environment is not a policy authority.
- **FR-019**: Standalone and managed CLI-owned self-launches MUST preserve the parent's verified selected mode. Saved service environment MUST NOT override that selection or reintroduce disallowed runtime options, bootstrap state, disabled verification or bundled certificate overrides. Preserve permitted system trust inputs, unrelated settings and existing authentication, persistence, registration, lease and process lifecycle behavior. No change to the generic client spawn contract solely to implement CLI TLS policy.
- **FR-020**: Before production graph execution, ensure disallowed runtime options do not remain applied to the executing process. Clean verified launches may use the existing fast path; dirty launches must enter a sanitized child or reject before executing production code. Recovery MUST replay only runtime-specific required flags, not unrelated preload/loader/inspector hooks. Preserve required Node FFI/conditions/warning flags, the intended Bun condition and the explicitly supported marked debugging case. Deleting an environment key after startup alone is not proof that its startup effect was removed.
- **FR-021**: Verified callbacks and self-launched processes MUST have the correct live environment: bundled removes all four certificate override keys even when empty, both modes clear disallowed runtime options and recovery state, disabled verification cannot survive, and permitted system CA inputs and unrelated environment remain supported.
- **FR-022**: Source and native recovery MUST preserve exact user argument semantics, excluding executable/entrypoint slots appropriately; SEA recovery MUST NOT inject its synthetic executable slot. No repeated recovery loop, duplicated inspector launch or unverified command/server execution.
- **FR-023**: Restore substantive V1 negative coverage for process-level invalid selectors, protected entrypoint/import boundaries, unverified command execution, failed-attestation nonpublication, empty/mismatched trust sets, bundled extra/system-only roots, hostile environment, input immutability, cleanup and marked single-inspector behavior. Cover normal and recovery paths separately, including real Node SEA argument preservation and required runtime flags. Both native artifacts MUST exercise clean default, explicit bundled and explicit system; both source and native runtimes MUST prove ordinary HTTPS trust with a controlled CA and zero rejected HTTP invocations, and normal managed/standalone child launches in both modes MUST attest and report their selected policy. Reuse current runtime, process and artifact owners; preserve every existing assertion and distinguish process-level tests from artifact tests. Restore fresh-process Promise and Effect SDK creation with no CLI bootstrap or verification preload; assert successful normal requests, absent mode when unattested and exact verified mode when attested, and preserve the forged/unverified listening-server negative. All ten reproduced SDK attestation baseline failures are in scope and must be resolved without weakening assertions.

### Key Entities *(include if feature involves data)*

- **Server identity** — The stable identity under which the application lists a server and keys its health, credentials and isolation. Distinct identities include the development server on port 4096, the compiled standalone server on port 4097, and the Desktop background service.
- **Current server context** — The server that the visible route or screen already resolves as its subject: a session route's server, a draft's server, Home's resolved server, or the server a Settings view is showing.
- **Verified server answer** — The existing per-identity health observation of that server's authenticated startup information, whose optional CA mode is authoritative only when the answer is healthy and the mode is present.
- **CA badge presentation** — The visible label, colour, description and status semantics for verified bundled, verified system, or genuinely unknown.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every supported context (Home, Settings, draft, session, empty database), the badge matches the verified mode reported by the server that context displays. In a run where the server reports `bundled`, zero supported contexts show `CA:UNKNOWN` after the first accepted health answer.
- **SC-002**: In a deterministic three-server matrix covering ports 4096 and 4097 plus the Desktop background service identity, every navigation step shows only the destination identity's answer. The measured cross-server display count is zero, including switches between servers that report the same mode.
- **SC-003**: Across loss, recovery, refresh and identity-change sequences, every visible badge state is justified by an accepted answer for the current identity. An initially checking identity shows `CA:UNKNOWN`; a refreshing unchanged identity retains its last accepted answer; a changed identity resets to unknown. No sequence retains a previous server's green or warning state after the destination identity starts unresolved.
- **SC-004**: The same acceptance scenarios produce identical labels, colours, tooltips and transitions in deterministic development and compiled application e2e modes, including a real compiled standalone server on port 4097 that reports `bundled` through its authenticated server information path.
- **SC-005**: Rendering the badge on any route adds zero health requests and zero polling cycles beyond the existing per-server observation over the same interval. Existing authentication and retry counts are unchanged.
- **SC-006**: All targeted regression tests are deterministic, independent of wall-clock sleeps and live external services, and each multi-server, empty-state and stale-health case can fail against the pre-correction implementation.
- **SC-007**: Every in-scope acceptance gate passes: badge presentation, health selection and transitions, route/Home/Settings context, multi-server isolation, the same scenarios in development and compiled application modes, and affected-package typechecks. Previously documented unrelated environment failures are recorded with exact files, reasons, counts and baseline comparison and are neither reported as passing nor counted as this change's regressions; no in-scope gate is waived and any in-scope failure blocks completion. The final change remains one dedicated feature commit.

- **SC-008**: Across the supported source/native runtime matrix, no-flag invocations select bundled even with ambient selector overrides; explicit selections are correct; ordinary managed and standalone child reports match the verified parent's selected mode. No forbidden saved option becomes effective in a child.
- **SC-009**: Recovery and verified callbacks demonstrate exact application arguments, no duplicate hook/inspector execution in the recovered command process, absent prohibited environment keys and no unverified command output, publication or listener. Every negative case has a decisive assertion at its actual owner. Fresh unattested SDK hosts succeed without publishing a mode or changing trust policy; unattested listening servers cannot bind.
- **SC-010**: Both native artifacts pass the three-case default/system/bundled matrix and authenticated service reporting, and the controlled HTTPS matrix demonstrates permitted system success and zero HTTP invocations under bundled rejection. The final embedded UI smoke uses the clean no-flag default, verified listener PID, authenticated bundled information and tabless bundled badge. Real platform-specific evidence must be recorded; unavailable artifact coverage is not silently waived.

## Assumptions

- The existing authenticated server information response remains the sole authority for an effective TLS CA mode. The server reports only a mode it was able to verify at startup; the application does not re-verify or infer it.
- V1 commit `aab82e879b8f9ef7ef3c34d6d1f5861e7ec3e16c` is the behavioural reference for current-server ownership; V2 commit `cbc8226979ae80daf9603f32db2d2002e7e5bc8d` is the baseline for the healthy-only selector and the titlebar badge placement. V1 infrastructure and its dev-only channel indicator are not restored.
- The existing per-server health observation already owns polling, authentication, retries, stale-attempt rejection and per-identity storage. This correction consumes that observation rather than replacing or duplicating it.
- The application already has authoritative owners for route, draft-tab, Home and Settings server selection. Planning will identify the smallest shared resolution needed for the badge and must not create a competing selection model.
- The visible Settings page is authoritative when its source context and selected server differ: a server-scoped page follows its selected server, and a page that does not show one server's data follows the source context.
- "Desktop background service" means the application's built-in sidecar identity, which is distinct from an HTTP server entry even when both address the same process.
- A healthy server may legitimately omit `tlsCaMode`, for example an older server. In that case unknown is the honest result and no default mode is assumed.
- Existing presentation for verified `bundled` and `system` is accepted and must be preserved; this feature does not redesign the badge.
- Both development and compiled application runtimes are supported targets. A compiled standalone server on port 4097 is the reported regression environment, not a distinct behavioural mode.
- The previously documented baseline environment failures recorded by feature 012 are the SDK `TLS CA mode has not been verified` failures in `packages/sdk/test/instances.test.ts`, `packages/sdk/test/request-retention.test.ts` and `packages/sdk/test/instances-effect.test.ts`, and the Core Bash 3.2 shell-parity failures in `packages/core/test/tool-shell.test.ts` and `packages/core/test/shell-scan/compound-parity.test.ts`. They are historical baseline observations, neither waivers nor passes. The ten SDK attestation failures are an in-scope embedded-host boundary defect, to be corrected in S3; unrelated Core shell failures must be matched to the baseline, not repaired opportunistically.
- Specification amendments do not edit production code; only the human changes the Git index or history.

## Scope and Cross-Feature Contract

### In scope

- Restoring V1's current-server ownership property through V2's authoritative route, draft, Home, Settings and server-identity owners, without reviving V1 components or restoring its dev-only gate.
- Selecting the server whose verified CA mode the titlebar badge describes, for every supported route and server context, including the Settings visible-page rule.
- Distinguishing an initially checking identity from an unchanged identity refreshing its last accepted answer, and invalidating an answer on identity, endpoint or credential change.
- Preserving the existing bundled, system and unknown presentation.
- Keeping the badge reactive across context switches, health updates, reconnect, recovery and removal.
- Deterministic regression coverage for multi-server isolation, tabless and empty states, and stale health, plus development and compiled runtime evidence.

- The six independently reviewed TLS policy-selection, child propagation, runtime-isolation, recovery-argument and cleanup regressions, plus the associated negative and artifact regression coverage in FR-018–023.

### Out of scope

- Reviving V1 runtime infrastructure, the V1 titlebar component, the V1 `ChannelIndicator`, its dev-only CA visibility restriction or any replacement channel badge.
- Weakening effective trust-set verification, changing authenticated server-information protocol, restoring V1 runtime internals or introducing a second policy owner. Only the explicit selection, child launch, recovery and environment corrections in FR-018–023 are authorized.
- Changing authentication, credentials, pairing, server health polling, retry policy, server health storage or database isolation.
- Adding a CA status endpoint, a client-side probe, a second health store, or inference from ports, branches, builds, projects or sessions.
- Redesigning titlebar layout, the existing `!props.verticalTabs` visibility guard, badge copy, colours, tooltips or accessibility semantics beyond preserving them.
- Any part of accepted features 011 and 012: configuration admission and publication, fallback intent and ordering, SSE terminal diagnostics, adaptive read timeouts, session retry, fallback dispatch safety, telemetry and runner behaviour.
- Repository-wide cleanup, unrelated refactors, Git index changes or Git history changes. This clarification pass changes specification artifacts only; it does not edit production code or tests.

### Delivery and review boundary

The change MUST be reviewable as one dedicated feature commit. It MUST contain only the TLS policy and badge parity corrections and their regression coverage described above. If planning discovers that the authoritative current-server context cannot be obtained without changing an existing owner, the plan MUST name that owner, justify the change as the smallest necessary correction, and show that server isolation, health ownership and features 011 and 012 remain intact.

### Source traceability

Current and historical evidence in this checkout:

- V1 commit `aab82e879b8f9ef7ef3c34d6d1f5861e7ec3e16c` (`feat(opencode): add verified TLS CA policy`) resolved the mode from the current server identity through `useGlobal()` and `useServer()`, independent of an open session tab, but restricted the CA indicator to the dev channel; Beta showed `BETA` and other channels showed nothing. That visibility restriction is explicitly not restored.
- V2 commit `cbc8226979ae80daf9603f32db2d2002e7e5bc8d` (`feat(opencode): enforce verified TLS CA policy across V2 runtimes`) preserved the healthy-only selector and server isolation but narrowed ownership to `currentTab()?.server`, which is the verified regression source for tabless routes. It removed the dev-channel condition and retained the badge in the right-hand titlebar items container under the existing `!props.verticalTabs` guard.
- `packages/app/src/shell/titlebar/titlebar.tsx` resolves the badge from `currentTab()?.server`, so routes without a matching tab and contexts before tab resolution have no server.
- `packages/app/src/runtime/server/health-machine.ts` defines the per-server health record and the selector that returns a CA mode only for a healthy answer; it also rejects stale probe attempts.
- `packages/app/src/runtime/server/health.ts` owns the single authenticated `/api/info` probe, its credentials, retries, cache and polling driver.
- `packages/app/src/shell/titlebar/titlebar-ca-badge.ts` owns the existing bundled, system and unknown mapping.
- `packages/app/src/shell/state/layout.tsx` defines the route forms and Home selection; `packages/app/src/home/model.ts` owns Home's resolved server; `packages/app/src/settings/surface.tsx` owns the settings source and selected server; `packages/app/src/shell/tabs/tabs.tsx` owns draft/session tabs.
- `packages/app/src/runtime/server/registry.tsx` owns server identities, including the distinct Desktop sidecar identity.
- Existing evidence owners include `packages/app/src/shell/titlebar/titlebar-ca-badge.test.ts`, `packages/app/src/runtime/server/health.test.ts`, `packages/app/src/runtime/server/health-machine.test.ts`, the multi-server e2e keeper in `packages/app/e2e/regression/multi-server.spec.ts`, and the development/compiled e2e modes in `packages/app/playwright.config.ts`.

The reported regression is behavioural: an authenticated compiled standalone server on port 4097 reports `tlsCaMode: "bundled"`, while a tabless route renders `CA:UNKNOWN`. The specification treats that as a server-context ownership defect, not as evidence that TLS verification or the server's report is wrong. The historical V1 dev-only visibility rule is not part of the intended behaviour; the V1 current-server ownership property is.

Additional historical evidence: V2 `packages/cli/src/bootstrap.ts` reads ambient mode as a parser fallback, keeps a verify-first path, assigns a sanitized copy to the live environment, replays `process.execArgv` except CA flags, and uses `slice(1)` for SEA recovery. `packages/cli/src/services/service-config.ts` supplies saved env to the generic `packages/client/src/service-contender.ts` spawn, which merges it after the inherited process env. `packages/cli/src/util/process.ts` owns `selfCommand` and the existing Node service flag allowlist. `packages/cli/src/services/standalone.ts` owns the leased standalone launch. `packages/util/src/tls-ca.ts` retains effective-set attestation. The independent review also identified lost V1 process-level and artifact assertions, detailed in FR-023. These are the bounded new owners; no unrelated migration audit is required.
