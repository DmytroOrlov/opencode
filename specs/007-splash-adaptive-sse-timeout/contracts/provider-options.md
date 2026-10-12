# Provider Option Contract

## `splashAdaptiveSseTimeout`

| Property | Contract |
|---|---|
| Location | Provider `options` configuration |
| Type | Boolean; only `true` opts in |
| Default | Disabled |
| Scope | SSE responses for an explicitly declared local Splash provider whose effective dispatch endpoint uses HTTP(S) and a loopback host |
| SDK/wire visibility | OpenCode-local; must not be passed to SDK constructor arguments or request payloads |
| Cache behavior | Must participate in SDK cache-key identity so opt-in and opt-out provider configurations remain separate |
| Timeout precedence | Applies only when `chunkTimeout` is unspecified; numeric `chunkTimeout` remains fixed, and `false` disables chunk idle timing |
| Header/request timeout | Existing `headerTimeout` and explicit request `timeout` behavior is unchanged |
| Default promotion | Remains opt-in until separate full-context and post-compaction validation passes |

When opted in and eligible, calibration is request-local. The existing default chunk timeout remains active until five qualifying reads are observed. Qualifying samples must be successful, nonempty reads that waited at least 100 ms. The adaptive threshold uses the rolling last-five estimator and applies only to future reads. No total-generation timeout is added.
