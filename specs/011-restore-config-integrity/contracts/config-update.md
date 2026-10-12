# Config update contract

`PATCH /api/experimental/config` retains sparse semantics and HTTP 204 without a body after coherent publication and mandatory completion. Selection, explicit null and omitted fallback remain distinct; legacy absence resolves to `mlx/qwen3.8-27b` with `xhigh`.

| Actual state | Outcome |
| --- | --- |
| Rename has not succeeded | Ordinary failure; old document remains committed; neither committed-state code. |
| Rename succeeded; coherent publication has not | HTTP 500 `CONFIG_COMMITTED_BUT_UNPUBLISHED`; new document remains committed; protected readers are blocked or explicitly degraded until forward reconciliation. |
| Coherent publication succeeded; a real mandatory completion operation fails and prevents success | HTTP 500 `CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE`; new document remains committed and published. This identity is authorized only for a real boundary, not an invented failure path. |
| Coherent publication and mandatory completion succeeded; optional housekeeping fails | Record a diagnostic and return 204; do not strand required resources or admission leases. |

Both committed failures use a declared PATCH-specific 500 preserving `_tag: "UnknownError"`, `message`, optional `ref`, and the applicable literal `code`. Ordinary generic 500 bodies must decode without either code. The classification follows actual publication and completion state, not whether a reload, notification or cleanup threw. Required reader refresh is part of coherent publication; exact roles of event notification, deferred reload and individual cleanup operations require the narrow owner-boundary verification described in `research.md`. Resource and lease release is required; a failure cannot be dismissed as housekeeping if it strands them.

Both generated Promise and Effect clients expose each applicable identity structurally, without message or log parsing. Deterministic tests must reach each real boundary, prove exclusive codes and generic-error decoding, and retain 204. Record actual before/after Promise rejection and Effect failure types; exact old error-shape compatibility is not assumed. Other endpoints and generic defect mapping remain unchanged. Callers preserve composer compensation and settings behavior while recognizing that either coded failure describes a committed document, and the second also describes successful publication.

Core runtime intent is accepted only after validation and staged before exclusive admission. Commit ordering follows owner entry, each sparse patch uses the latest commit, and retries choose the latest eligible effective fallback immediately before physical dispatch. Once dispatched, model and variant attribution are immutable; uncertain tool effects are not replayed. See [data model](../data-model.md) and authoritative 009/010 contracts.
