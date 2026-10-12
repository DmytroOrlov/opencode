# `prompt_async` HTTP Contract

This feature preserves the existing external contract for `POST /session/{sessionID}/prompt_async`:

- The request is accepted with `204 No Content` without waiting for generation to finish.
- The accepted prompt continues as a background operation after the request completes.
- Shared generation admission remains mandatory. While an exclusive writer is active, provider work does not start; the accepted prompt proceeds once admission becomes available.
- The client submits no second request to resume the accepted prompt.
- Existing request payload, response status, and error event behavior are unchanged.
