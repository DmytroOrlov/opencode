# Data Model: Prompt Async Scope Lifetime

This fix changes resource ownership, not persisted data or domain schemas.

## Accepted asynchronous prompt

- **Identity**: The prompt submission accepted by one `POST /session/{sessionID}/prompt_async` request.
- **Fields**: Existing session ID and prompt payload; no new fields.
- **Relationship**: One accepted prompt starts one background operation and is expected to complete at most one generation.
- **Lifecycle**: Accepted with `204`; waits for shared admission if an exclusive writer is active; then generates; its operation-local resources close when it completes, fails, or is interrupted. Server/layer shutdown remains a valid supervisor termination.

## Background operation lifetime

- Owns resources acquired by this accepted prompt, including any admission reservation until ownership transfers to active generation.
- Outlives the HTTP request that accepted the prompt.
- Retains inherited `InstanceRef`, `WorkspaceRef`, and other runtime context.
- Does not change GenerationGate reservation-to-generation transfer or active generation ownership.

No storage migration, new entity, or public payload change is required.
