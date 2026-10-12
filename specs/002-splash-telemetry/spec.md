# Feature Specification: Splash Generation Telemetry

**Feature Branch**: `[002-splash-telemetry]`

**Created**: 2026-09-28

**Status**: Draft

**Input**: User description: Add opt-in, request-scoped Splash generation telemetry to the existing OpenCode telemetry experience while preserving MLX and generic fallback behavior.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View Splash request progress and final rate (Priority: P1)

An OpenCode user has selected a model served by Splash and explicitly enabled Splash telemetry for that provider. During generation, the existing generation telemetry display shows available request-local prefill progress and an authoritative live decode rate if Splash supplies one. After completion, an authoritative Splash final decode rate replaces an approximate live fallback rate.

**Why this priority**: This is the primary user value: users can observe meaningful telemetry for Splash in the same place as telemetry for other providers, with source quality reflected honestly.

**Independent Test**: Stream a Splash response that includes request-local progress and final timing, and verify the existing message telemetry display updates during generation and shows Splash's authoritative final rate after completion.

**Acceptance Scenarios**:

1. **Given** Splash telemetry is explicitly enabled and a generation stream exposes request-local prompt progress, **When** prompt progress arrives, **Then** the existing telemetry display shows prefill phase and the available processed and total prompt counts for that AssistantMessage.
2. **Given** Splash telemetry is explicitly enabled and a valid authoritative request-local live decode rate is available, **When** it arrives, **Then** the existing display shows that rate as provider-native telemetry for the current attempt.
3. **Given** a generation has displayed approximate OpenCode fallback throughput and Splash supplies a valid authoritative request-scoped final decode timing, **When** the generation completes, **Then** the terminal displayed rate uses Splash's final provider-native value and the message remains correctly attributed.
4. **Given** an enabled Splash generation exposes only prefill progress or final timing, **When** those partial values arrive, **Then** each usable value appears while missing fields remain absent or continue to use valid fallback behavior; the feature does not require every telemetry field to be available.

### User Story 2 - Keep telemetry truthful and generation resilient (Priority: P1)

An OpenCode user receives generation output even if Splash telemetry is missing, malformed, unavailable, or cannot be tied to the current request. In those cases the existing OpenCode fallback remains available and telemetry problems do not delay or fail generation.

**Why this priority**: Attribution correctness and generation reliability are core contracts of the existing telemetry experience.

**Independent Test**: Exercise absent, malformed, partial, and aggregate-only Splash measurements and verify generation succeeds, request-ambiguous values are omitted, and fallback throughput remains available until a usable authoritative provider decode rate is accepted.

**Acceptance Scenarios**:

1. **Given** Splash provides no native telemetry or sends malformed telemetry, **When** generation proceeds, **Then** OpenCode's existing fallback telemetry remains active and no invalid native value is displayed.
2. **Given** a Splash response is too short to produce an authoritative live decode rate, **When** it completes, **Then** any available valid final rate may be used, otherwise the existing fallback result remains and missing provider rates are not displayed as zero.
3. **Given** only process-wide, batch-wide, or otherwise ambiguous Splash measurements are available, **When** a request is displayed, **Then** those measurements are not attributed to that AssistantMessage.
4. **Given** telemetry connection, parsing, or publication fails, **When** generation continues, **Then** generation behavior and its normal completion or failure outcome are unaffected by telemetry.

### User Story 3 - Preserve existing provider behavior and attempt lifecycle (Priority: P1)

An OpenCode user can retry, abort, or encounter a failed stream for a Splash request and still sees telemetry associated only with the current AssistantMessage attempt. Users of MLX and providers without native telemetry continue to see the existing telemetry behavior.

**Why this priority**: Splash is an additive source in a shared experience; existing lifecycle and compatibility behavior must remain reliable.

**Independent Test**: Run lifecycle cases for Splash beside existing MLX and generic-provider regression cases; compare event and displayed telemetry behavior before and after adding Splash support.

**Acceptance Scenarios**:

1. **Given** an AssistantMessage has terminal telemetry from an earlier attempt, **When** the same message is retried through Splash, **Then** stale terminal telemetry is reset and only current-attempt telemetry can become terminal.
2. **Given** a Splash attempt is aborted or its stream fails, **When** the attempt closes, **Then** its telemetry is discarded or finalized according to existing attempt semantics and cannot appear as a successful terminal measurement later.
3. **Given** Splash provider setup fails before a generation stream is established, **When** the setup attempt is discarded, **Then** no Splash terminal telemetry is published and existing attempt behavior is preserved.
4. **Given** two Splash requests are active concurrently, **When** each receives progress or completion data, **Then** each displayed measurement belongs only to its corresponding AssistantMessage and attempt.
5. **Given** an MLX provider has `mlxTelemetry: true`, **When** it generates, **Then** existing MLX `/events` telemetry, fallback arbitration, attribution, lifecycle, and presentation remain unchanged.
6. **Given** a provider without native telemetry generates, **When** output streams and completes, **Then** existing generic OpenCode fallback telemetry continues unchanged.
7. **Given** Splash telemetry is not explicitly enabled, **When** a Splash provider generates, **Then** Splash-native telemetry collection remains disabled and existing generic fallback behavior is used.

### User Story 4 - Opt in without changing provider requests (Priority: P2)

An OpenCode user explicitly opts into Splash telemetry through provider configuration. The opt-in is honored by OpenCode while remaining private to OpenCode's telemetry control and absent from provider SDK constructor settings and inference request data.

**Why this priority**: An explicit control gives users a predictable boundary for provider telemetry collection and protects compatibility with provider integrations.

**Independent Test**: Configure the opt-in, capture the provider SDK options and inference request, and verify the opt-in control is absent while the telemetry behavior is enabled for Splash.

**Acceptance Scenarios**:

1. **Given** a Splash provider is configured with explicit telemetry opt-in, **When** OpenCode prepares generation, **Then** the opt-in controls telemetry collection without appearing in provider SDK constructor options or model inference parameters.
2. **Given** another OpenAI-compatible provider uses an otherwise similar configuration, **When** it generates, **Then** its options and behavior are unchanged and it continues using generic fallback telemetry.

### Edge Cases

- Splash progress is absent, arrives after output begins, repeats without advancing, or contains invalid, negative, non-finite, or inconsistent counts.
- A final Splash timing is absent, malformed, zero because no authoritative rate is available, or uses a measurement interval that does not represent decode throughput.
- A short generation completes before any authoritative live decode rate appears.
- A retry uses the same AssistantMessage identifier after an earlier attempt finalized or failed.
- A provider setup failure occurs before the stream begins, or the stream fails after live telemetry was shown.
- A telemetry source completes after an attempt has been aborted, discarded, or replaced by a retry.
- Multiple requests overlap, or Splash reports only a shared batch/process measurement.
- Splash telemetry opt-in is enabled on a provider endpoint that does not actually serve Splash.
- MLX telemetry is enabled at the same time as a Splash-like configuration value; existing source selection and MLX behavior remain unchanged.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: OpenCode MUST add an explicit opt-in for Splash-native generation telemetry, following existing provider configuration conventions. The configuration key and exact configuration shape are intentionally left for planning after checkout inspection.
- **FR-002**: When Splash telemetry is not explicitly enabled, OpenCode MUST retain generic fallback telemetry behavior for Splash-served models.
- **FR-003**: When enabled, OpenCode MUST use Splash-provided request-local prefill progress when the active generation stream exposes it, and MUST present available progress in the existing normalized telemetry experience.
- **FR-004**: OpenCode MUST use a Splash live decode rate as provider-native only when it is valid, authoritative, and attributable to the active generation attempt. If no such value exists, OpenCode's live fallback throughput MUST remain available.
- **FR-005**: When Splash provides valid, authoritative, request-scoped final decode timing, OpenCode MUST use its exact final decode rate in preference to an approximate fallback rate for the same attempt.
- **FR-006**: OpenCode MUST NOT derive request-scoped telemetry from process-wide or batch-wide Splash measurements when ownership of the current generation cannot be proven.
- **FR-007**: OpenCode MUST keep Splash telemetry attached to the correct AssistantMessage and attempt through registration, stale terminal reset, retry, abort, provider setup failure, stream failure, finalize, and discard.
- **FR-008**: A provider decode measurement MUST suppress fallback throughput only after a usable authoritative request-scoped provider decode rate has been accepted. Prefill progress, missing rates, malformed values, and rate-less phase transitions MUST NOT suppress fallback throughput.
- **FR-009**: Splash telemetry MUST use the existing normalized `session.telemetry` event flow, attempt lifecycle, telemetry store and presentation. It MUST NOT add a Splash-only event type, store, lifecycle, or UI.
- **FR-010**: OpenCode MUST NOT let telemetry parsing, unavailable telemetry, or telemetry transport failures block or fail generation. Invalid native telemetry MUST be omitted while valid fallback behavior continues.
- **FR-011**: OpenCode-only telemetry controls MUST NOT appear in provider SDK constructor options or inference wire requests. Provider-defined Splash protocol fields deliberately sent to request telemetry, such as `return_progress`, are not OpenCode-only controls and MAY be sent when required by the selected design.
- **FR-012**: Existing `mlxTelemetry: true` behavior, including MLX `/events` telemetry and its existing tests, MUST remain functional without behavior changes.
- **FR-013**: Providers without supported native telemetry and non-Splash OpenAI-compatible providers MUST retain existing generic fallback behavior.
- **FR-014**: Concurrent Splash generations MUST NOT contaminate each other's telemetry; measurements without provable per-request ownership MUST be omitted.
- **FR-015**: Splash telemetry support MUST be additive to the existing MLX provider adapter and shared attempt owner. Any shared abstraction remains a planning decision and MUST only be considered where both adapters genuinely need it.

### Key Entities

- **Generation attempt**: One run that produces or updates an AssistantMessage, with its own telemetry source ownership and terminal outcome.
- **AssistantMessage**: The conversation message that owns displayed telemetry across a generation attempt and any retry.
- **Telemetry snapshot**: A normalized observation of generation phase, progress, throughput, completion, and source quality shown in the existing UI.
- **Provider-native measurement**: Splash-reported information with valid semantics and provable ownership of the current request.
- **Fallback measurement**: OpenCode-observed telemetry used when no usable authoritative provider decode rate is available.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In all validation cases where Splash supplies valid request-local prefill progress, the existing telemetry display shows the corresponding progress during that generation.
- **SC-002**: In all validation cases where Splash supplies a valid authoritative final request-scoped decode rate, the completed message displays that rate instead of an approximate fallback rate.
- **SC-003**: Across concurrent request validation, zero Splash measurements are shown for an AssistantMessage other than the request that produced them.
- **SC-004**: Across malformed, unavailable, and short-generation validation cases, generation completes or fails according to model-stream behavior. When no usable provider decode rate is accepted, existing generic fallback behavior remains eligible and unchanged; if the fallback has no measurable sample, no rate is fabricated. Unavailable measurements are never displayed as 0 tok/s.
- **SC-005**: Existing MLX telemetry and generic-provider fallback regression scenarios produce the same normalized telemetry behavior as before the feature.
- **SC-006**: Captured provider SDK constructor options and inference requests contain zero OpenCode-only Splash telemetry controls.

## Assumptions

- Splash means the `incoai/splash` local inference engine that serves OpenAI-compatible Chat Completions, not the OpenCode logo or splash screen.
- The installed Splash version may not provide every documented streaming field. Missing or version-incompatible fields are treated as unavailable and do not invalidate generation.
- The user-facing scope is the existing normalized generation telemetry experience; no new metric families or provider dashboard are required.
- The existing AssistantMessage and attempt lifecycle remains the owner of registration, retries, terminal state, abort, and discard.
- For this first increment, process-wide memory, scheduler and aggregate throughput metrics, draft acceptance, Prometheus integration, provider dashboards, and a telemetry UI redesign are out of scope.

## Protocol and Checkout Context

The current Splash development documentation describes optional request-local `prompt_progress` stream events for streaming requests that request progress. These include prompt total, initial cached tokens, processed tokens, and elapsed time; they are progress observations, not an estimated completion time. It also documents final Chat Completions `timings` in the finish-reason chunk, including a request-scoped `predicted_per_second`; this rate excludes the first emission, which may contain multiple speculative tokens, and unavailable rates are represented as zero. Splash `/status` `metrics.decode_tokens_per_second` is aggregate and MUST NOT be attributed to one generation. These protocol semantics are subject to confirmation against the Splash version in use during planning. See [Splash API and streaming details](https://github.com/incoai/splash/blob/main/DEVELOPMENT.md#code-and-api-boundaries).

In this checkout, the generation stream adapter preserves normalized usage and provider metadata, and the installed AI SDK can expose raw provider chunks when requested. The current adapter does not convert arbitrary raw chunk fields into the shared LLM event model. Existing shared behavior is represented by the attempt telemetry owner, MLX adapter, generic fallback, normalized `session.telemetry` event, generation telemetry store/reducer, and timeline/message telemetry rendering. This context records what planning must account for; it does not select new abstractions or an implementation design.
