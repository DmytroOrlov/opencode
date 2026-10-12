# Data Model: Safe Global Configuration Updates

This feature adds process-local coordination and ownership records. It does not add persisted queue state or a new configuration schema.

## Process gate acquisition and graph replacement

`GenerationGate.node` is backed by one stable, dependency-free layer object. A process-acquisition operation builds that exact layer against the module process `memoMap` with a caller-owned `Scope`, returning the resulting `GenerationGate.Service`. The process memo map deduplicates only this stable gate layer for acquisitions using that map; it does not make all server graph memo maps identical.

Each `Server.listen()` retains its own scope and fresh root memo map. Before its route layer is built, it acquires the process gate using that listener scope and supplies one `Layer.succeed(GenerationGate.Service, acquiredGate)` replacement to both the main app/V1/global-handler branch and the separately compiled SessionV2 branch. Both branches use the same acquired object. Other listener-owned services continue to build locally in the fresh memo map.

Each live Default/AppRuntime/listener graph observing the process gate contributes a scoped layer observer. Ending one observer cannot dispose the gate while another remains. When all observers are gone and no process work is active, a later acquisition may construct a new empty gate; there is no durable queue state. Listener route resources are built after gate acquisition and finalize before that listener's gate observer is released.

## Generation gate

| Field | Type / meaning | Invariant |
|---|---|---|
| `activeReaders` | Non-negative count of granted shared leases | Equals the number of unreleased shared leases. |
| `exclusiveActive` | Boolean writer ownership | Mutually exclusive with `activeReaders > 0`. |
| `waiters` | FIFO sequence of reservation records | Contains only ungranted, uncancelled reservations in admission order. |

### Reservation

| Field | Type / meaning | Invariant |
|---|---|---|
| `mode` | `shared` or `exclusive` | Determines grant ownership. |
| `grant` | Deferred signal / lease result | Completes at most once as part of the atomic outcome transition. |
| `outcome` | `queued`, `cancelled`, or `granted(lease)` | Exactly one atomic transition leaves `queued`; `cancelled` and `granted(lease)` are mutually exclusive terminal outcomes. |
| `leaseOwner` | `reservation`, `work`, or `released` after grant | Exactly one atomic transfer changes `reservation -> work`; one owner can claim release. |
| `cancel` | Effect competing with grant | If queued, atomically sets `cancelled`, removes the waiter, and reruns head admission. If granted, it cannot report queue removal; pre-transfer finalization releases the reservation-owned lease. |

A shared reservation that is granted produces a **shared lease** initially owned by its reservation/requester. Before transfer, interruption releases it exactly once. Transfer to actual work is explicit and atomic; after transfer the original requester cannot release it, and the RunHandle, ShellHandle, V2 coordinator entry, or protected config application owns release. Release remains idempotent as a defensive guard, not as a substitute for transfer ownership. Exclusive admission follows the same outcome race: queued cancellation means no mutation; a winning grant transfers directly to the protected application so no granted writer can be abandoned.

## V1 work ownership

Runner state is one of `Idle`, `Running`, `Shell`, or `ShellThenRun`. `Running` and `Shell` handles own transferred shared leases through terminal cleanup. `ShellThenRun` pending work owns an ordered admission in one of three states: queued reservation, granted-but-not-transferred lease, or transferred active RunHandle. Cancellation removes a queued reservation; releases a granted lease before transfer; or leaves release to the active handle after transfer. Existing Running and ShellThenRun joiners share existing completion and do not create reservations.

## V2 coordinator ownership

Each active coordinator entry owns the transferred lease associated with its drain. Joiners do not own duplicate leases. A recorded pending wake owns its own admission state, separate from the current drain: queued reservation or granted-but-not-started lease. `settle()` releases the current lease and starts the successor only after its reservation is granted and ownership transfers to the successor entry. Before start, interruption cancels/removes the queued reservation or releases the granted lease; an active successor releases through its coordinator-owned lifecycle.

## Global config update

| State | Meaning | Allowed next state |
|---|---|---|
| `queued` | Exclusive reservation entered FIFO order and awaits grant | `cancelled`, `granted(writer-token)` |
| `cancelled` | Cancellation won before exclusive grant; no config mutation occurred | terminal |
| `granted(writer-token)` | Grant won; token transfers atomically to protected application | `applying` |
| `applying` | Writer granted; update is inside protected critical section | `failed-before-commit`, `committed`, `consistent` |
| `failed-before-commit` | Parse/write/temp/rename failed before persistence commit; old config remains authoritative | `released` with explicit failure |
| `committed` | Atomic rename succeeded; new config is authoritative | `consistent` |
| `consistent` | Config cache invalidated; selected old instance entries evicted; cleanup attempted for each | `released` with success (cleanup defects logged) |
| `released` | Exclusive ownership ended | Queue head may be admitted |

The rename/replace operation is the persistence commit point. No transition rolls configuration back after `committed`.

## InstanceStore entry

An entry maps a resolved directory to a load `Deferred` and eventual `InstanceContext`. Global disposal snapshots selected `(directory, entry)` identity pairs. It waits for each load result, attempts all registered disposal callbacks and context cleanup, and removes the entry only if the map still points to the same entry. A new load must not reuse an entry selected by the completed global invalidation.

## Effective configuration

The effective global configuration is the contents of the committed target file after successful decode, with the global config cache invalidated. The next writer reads/merges against this serialized result only after acquiring exclusive ownership. An unchanged serialized result causes no process-wide disposal.
