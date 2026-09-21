# Data model: Splash telemetry within an OpenCode attempt

This describes ephemeral state and existing event fields, not a new persistent model. See [research.md](research.md) for source and protocol evidence and [contract](contracts/splash-telemetry.md) for wire shapes. splashTelemetry is observation-only state: it never adds return_progress to the request and never selects the generation runtime.

## Entities and relationships

| Entity | Fields and ownership | Validation | Lifetime |
|---|---|---|---|
| AssistantMessage telemetry slot | sessionID, assistantMessageID → existing normalized snapshot | IDs come from active OpenCode stream input; never infer from Splash process metrics | Existing app store slot, reset at next attempt for same message |
| Generation attempt | Existing beginAttemptTelemetry owner; providerDecodeAccepted boolean; provider and fallback source handles | Only a finite positive provider decode rate may flip acceptance | Created before provider setup; finalized on stream success or discarded on failure/abort/retry |
| Splash request collector | One per enabled Splash attempt; closed flag; current AI SDK step; last progress; last publication time; final timing and terminal-timing observation count for the attempt | No cross-attempt/global state; ignore raw callbacks after closed; bound to same fullStream; never modifies the request or selects a runtime | Attached as provider source; cleaned at finalize/discard |
| Prefill observation | total, cache, processed, time_ms from prompt_progress when such chunks are present in the normal stream | Finite nonnegative counts; positive total; cache ≤ total; processed ≤ total; reject repeats/regressions and inconsistent totals; no fabricated ETA; absence of prompt_progress is harmless | Step-local, latest observation only; resets on new step |
| Terminal timing | prompt_n, cache_n, predicted_n, prompt_ms, predicted_ms, prompt_per_second, predicted_per_second | Counted on recognition, before rate validation. Zero terminal timings: native terminal rate unavailable, fallback remains eligible. Exactly one terminal timing: validate predicted_per_second; a finite positive value is usable for a single successful request, otherwise unavailable. More than one terminal timing observed in one attempt is ambiguous regardless of whether one, several, or none hold a valid rate and publishes no provider-native rate; usage metrics are not parsed for aggregation | Cached until successful attempt finalize, discarded on stream failure |
| Fallback sample | Existing client-observed active decode interval and token estimate/usage correction | Existing minimum interval and positive token eligibility; no sample means no rate | Existing fallback source; active until accepted native decode |

## Existing normalized snapshot

The existing SessionV1.Event.Telemetry event carries sessionID, assistantMessageID, phase (prefill or decode), optional processed/total, optional tokensPerSecond, optional done, source (provider or fallback), and optional approximate. Provider-native final decode uses source provider and no approximate marker. Fallback keeps its existing approximate or usage-corrected semantics. No new event fields are required.

## State transitions

1. **register**: attempt publishes the existing reset snapshot before provider setup. Provider acceptance is false; fallback exists.
2. **observe prefill**: when prompt_progress chunks are present, a valid Splash progress frame publishes a coalesced provider prefill snapshot. When they are absent, nothing is published and behavior is unchanged. Acceptance stays false; fallback remains eligible.
3. **observe decode**: no Splash 1.1.0 request-local live rate exists; fallback samples and publishes as before when eligible.
4. **observe finish timing**: increment the terminal timing count for every recognized Splash terminal timing observation, before validating predicted_per_second. Do not publish terminal success yet.
5. **successful finalize**: if exactly one terminal timing was observed and its predicted_per_second is finite and positive, set acceptance and publish provider decode done through EffectBridge; then fallback finalization is suppressed. If zero terminal timings were observed, or exactly one was observed with a zero/missing/non-finite/malformed rate, the native terminal rate is unavailable. If more than one terminal timing was observed, the native rate is ambiguous regardless of whether one, several, or none held a valid rate. In all unavailable or ambiguous cases fallback finalizes if it has a measurable sample. Neither source fabricates a zero rate.
6. **discard**: abort, setup failure, stream failure, or retry closes provider and fallback sources; cached timing is dropped and late raw parts are ignored. The next attempt for the same AssistantMessage starts with reset.

## Single-terminal invariant

Current ai 6.0.168 + OpenCode streamText defaults to one successful AI SDK step per llm.stream call, so at most one successful provider terminal timing appears in one OpenCode telemetry attempt. The collector remains step-aware: prefill describes only the current request and resets on start-step. Terminal arbitration is fail-closed on observed terminal timing count rather than on how many rates pass validation: zero terminal timings leaves fallback eligible, exactly one terminal timing publishes a finite positive predicted_per_second after successful attempt finalization (and otherwise leaves fallback eligible), and more than one terminal timing makes the whole-attempt native terminal rate ambiguous regardless of whether one, several, or none hold a valid rate, so no provider-native terminal rate is published and existing fallback behavior is retained. Never aggregate a multi-step formula, average rates, take only the last step, or parse usage metrics to support such aggregation. When exact inputs are incomplete or ambiguous, fallback remains the terminal source.
