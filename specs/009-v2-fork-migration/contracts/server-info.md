# ServerInfo: verified TLS CA mode

## Owner

The public shape belongs in `packages/schema`/`packages/protocol/src/groups/server.ts`. `packages/server/src/handlers/server.ts` and `server-info.ts` expose it through the existing `/api/info` `server.info` operation. A shared low-level effective-CA verifier/attestation module under `packages/util`, exported through `@opencode/util`, is importable by both CLI and Server. The CLI bootstrap invokes it before loading the command graph; `packages/server/src/process.ts::start` requires verified process-local attestation before it binds/listens. A direct supported server host must perform actual verification through the same module or fail before bind. The app reads the value through `packages/app/src/runtime/server/health.ts` and renders it in the current shell titlebar.

## Contract

- Add optional `tlsCaMode` to ServerInfo with values `bundled` or `system`.
- Only verification of the actual effective trust set may establish process-local attestation. Selecting or copying a mode label is not verification. A `ServerOptions` mode string is never trusted evidence and cannot satisfy the `ServerProcess.start` precondition.
- The server includes the field only when the current process completed TLS policy verification before network work. It must not accept this value from an HTTP caller or infer it from a URL, executable, runtime name, or unverified options field.
- The existing `/api/info` response remains otherwise compatible. A client connected to an older server or an unverified server receives no mode field; the app represents that as `unknown` and does not claim verification.
- `bundled` remains the default selected mode. Both modes require certificate verification. Selection, effective trust-set verification, and child propagation occur before the command graph can initiate network activity.
- The field is health metadata, not a replacement endpoint and not a separate polling mechanism. Use the health record already keyed to the active server connection.
- After changing the public Protocol/Server HttpApi, run `bun run generate` from `packages/client`. Generated files are outputs and must not be edited directly.

## Failure behavior

Invalid/conflicting explicit options, disabled certificate verification, an effective trust set that does not match the selected mode, or an inability to prove the effective set fail the supported startup before outbound TLS work or listening for requests. Missing, forged, or unverified process-local attestation must make `ServerProcess.start` fail before bind/listen, even if `ServerOptions` contains `tlsCaMode: "bundled"` or `"system"`. The server test fixture must perform real trust verification or enter through CLI bootstrap. Health does not convert such a startup failure into `unknown` for a process that has already started; `unknown` is for absent/older/unverified reporting by a reachable server.

## Compatibility checks

Test `/api/info` for both verified modes and absent legacy metadata; server startup tests cover valid attestation and missing/forged/unverified startup rejection before listen. Adapt `packages/server/test/fixture/server.ts` to perform actual trust verification or use CLI bootstrap. App health must retain existing auth/retry/cache behavior while mapping absence to unknown. Titlebar tests cover all three display states and accessible text. Process tests verify the reported mode corresponds to an actual controlled-certificate request and its child process.
