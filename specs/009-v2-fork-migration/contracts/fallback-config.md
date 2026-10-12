# Global fallback configuration and runtime intent

## Owner

The durable setting belongs to the existing global config document and `ConfigModel.Selection`. Public configuration is owned by `packages/schema/src/config.ts`, the existing experimental patch endpoint in `packages/protocol/src/groups/config.ts`, and `packages/server/src/handlers/config.ts`. Core config update and recovery share process-global coordination. The app's current `runtime/server/sync.tsx` update path must use the generated V2 client API instead of its current unavailable-config stub.

## Legacy undefined versus explicit null

Preserve the original resolver contract from `packages/core/src/model-fallback.ts` in commit `af9515d01a`: an absent/`undefined` fallback resolves to `LEGACY_MODEL_FALLBACK`, exactly `{ model: "mlx/qwen3.8-27b", variant: "xhigh" }`; explicit `null` means no fallback. Do not silently convert a legacy missing field to `null`, substitute a different default, or erase the legacy default during read/serialization. In the update payload, an omitted `fallback` property means no change; `fallback: null` is an explicit clear. Thus an omitted patch against a legacy config with no stored field leaves its `undefined` value and legacy default intact, while an explicit null disables fallback.

## Public shape

- Add optional nullable `fallback` to `Config.Info` so it can represent all three raw states: absent/`undefined` (legacy default applies), `null` (fallback disabled), and a configured `ConfigModel.Selection`.
- Add optional `fallback` to `Config.Patch`, with null allowed. Omitted means “leave unchanged”; a selection replaces it; explicit null clears it.
- Preserve the existing PATCH `/api/experimental/config` operation and no-content success response unless repository contract generation establishes a required compatible envelope. The handler reports persistence failure as failure; it must not return success for only an in-memory intent.
- Apply a fallback-only patch as a partial update to the existing config document. If `shell` is omitted from the patch, preserve the configured shell exactly; do not replace unrelated config with the sparse patch body.
- Existing clients that omit `fallback` retain existing behavior. The app refreshes/uses committed config through the V2 client and must not store a second durable fallback pair in session/workspace selection.

## Update and recovery semantics

1. Validate model/variant selection at the backend config boundary. After the backend accepts a fallback update, the backend-owned, process-local `FallbackRuntimeIntent` stages a revisioned intent before waiting for exclusive configuration admission. Active backend recovery reads this intent. The app does not stage or own backend runtime intent.
2. Retry scheduling only records delay and reason. After the delay and immediately before dispatch, Core reads the latest accepted fallback intent and applies existing validity, same-model, already-used-model, retry-cap, variant, and tool safety rules.
3. An attempt already dispatched retains its resolved model and variant. Later fallback updates affect only a later recovery decision.
4. A shared admission coordinator prevents destructive global config replacement while protected generation is active, including calls through distinct Config runtime graphs. Once protected leases drain, validate and atomically persist the target document, refresh relevant config readers, and commit the matching revision.
5. If persistence fails, the operation fails visibly and does not represent the candidate as committed. Backend cleanup may remove or revert only the exact still-current failed runtime-intent revision, never a newer intent. After process restart, only the last committed config is loaded.
6. Config mutation must not dispose or rebuild shared session/runtime state while its generation lease is held. Acquire and release are interruptible/exactly-once; cancellation before commit leaves the persisted document unchanged; once a protected atomic commit has started, cleanup completes forward.

## Pair selection and client ordering

Composer state owns primary selection and variants under the existing V2 session/workspace rules; global fallback is read from config. Selecting fallback as primary swaps the pair and model-associated supported variants in one user intent. Unsupported variants are cleared and null fallback variant retains provider-default semantics. New session draft promotion does not clear or copy fallback into per-session state. The app owns a separate optimistic UI revision only: client acknowledgement/failure ordering must prevent a stale rollback from replacing a newer client intent or unrelated composer state. This UI revision is distinct from (a) the backend's accepted process-local runtime-intent revision and (b) successfully persisted config.

## Required contract tests

- Schema round-trip for omitted, selected, and explicit-null fallback.
- PATCH read-after-success and clear behavior through the generated client.
- Failed save is not reported as durable success; later process uses last committed config.
- Retry-backoff fallback update prevents the next primary dispatch; a post-dispatch update does not retarget the running attempt.
- Two independent Config runtime graphs coordinate through one shared admission service.
- Older delayed UI failure cannot roll back a newer selection; existing session, draft, and dedicated new-session flows resolve the same effective pair.
