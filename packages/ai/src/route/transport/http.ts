import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Pull,
  Scope,
  Stream,
} from "effect"
import { Headers, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Auth } from "../auth.js"
import { render as renderEndpoint } from "../endpoint.js"
import { Framing } from "../framing.js"
import type { HttpMiddleware, Transport, TransportPrepareInput } from "./index.js"
import * as ProviderShared from "../../protocols/shared.js"
import {
  AIError,
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
  mergeJsonRecords,
  timeoutConfig,
  TransportError,
  type HttpContext,
  type HttpTimeout,
  type LLMRequest,
} from "../../schema/index.js"
import { RequestExecutor } from "../executor.js"

export type JsonRequestInput<Body> = TransportPrepareInput<Body>

export interface JsonRequestParts<Body = unknown> {
  readonly url: string
  readonly jsonBody: Body | Record<string, unknown>
  readonly bodyText: string
  readonly headers: Headers.Headers
}

export interface HttpPrepared<Frame> {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly framing: Framing.Definition<Frame>
  readonly middleware?: HttpMiddleware
}

type TerminalOutcome =
  | "completed"
  | "timeout"
  | "abort"
  | "consumer_cancel"
  | "other_error"

type ReadDeadlineSource =
  | "fixed_default"
  | "explicit"
  | "disabled"
  | "adaptive_initial"
  | "adaptive_calibrated"

type TimeoutSource = "read_idle" | "whole_request"

interface ReadDeadline {
  readonly source: ReadDeadlineSource
  readonly milliseconds?: number
  readonly basisWaitMs?: number
}

export interface SseTransportSummary {
  readonly terminalOutcome: TerminalOutcome
  readonly responseHeaderWaitMs: number
  readonly sseStreamDurationMs: number
  readonly firstReadWaitMs?: number
  readonly maxSuccessfulReadWaitMs?: number
  readonly successfulReadCount: number
  readonly chunkCount: number
  readonly splashAdaptiveSseTimeoutEligible: boolean
  readonly adaptiveSampleCount: number
  readonly readDeadlineSource?: ReadDeadlineSource
  readonly readDeadlineMs?: number
  readonly adaptiveBasisWaitMs?: number
  readonly timeoutReadWaitMs?: number
  readonly timeoutSource?: TimeoutSource
}

type SseDiagnosticSink = (
  summary: SseTransportSummary,
) => Effect.Effect<unknown, unknown>

/** Internal observational seam; not a new request option or telemetry event. */
export const CurrentSseDiagnosticSink =
  Context.Reference<SseDiagnosticSink>(
    "@opencode/AI/CurrentSseDiagnosticSink",
    {
      defaultValue: () => (summary) =>
        Effect.logDebug("provider SSE transport summary", summary),
    },
  )

/** Request-level cancellation evidence, never inferred from a byte-pull interruption. */
export const CurrentSseRequest = Context.Reference<{
  readonly signal?: AbortSignal
  readonly consumerReturned?: () => boolean
}>("@opencode/AI/CurrentSseRequest", {
  defaultValue: () => ({}),
})

const elapsedMs = (started: number, ended: number) =>
  Math.max(0, ended - started)

interface LocalTimeout {
  readonly source: TimeoutSource
  readonly observedAt: number
  readonly readWaitMs?: number
}

const makeSseObservation = (
  clock: Clock.Clock,
  started: number,
  established: number,
  adaptive: boolean,
) => {
  const now = () => clock.currentTimeMillisUnsafe()

  let firstReadWaitMs: number | undefined
  let maxSuccessfulReadWaitMs: number | undefined
  let successfulReadCount = 0
  let chunkCount = 0
  let adaptiveSampleCount = 0

  let activeReadStarted: number | undefined
  let interruptedRead:
    | {
        readonly observedAt: number
        readonly readWaitMs: number
      }
    | undefined
  let selected: ReadDeadline | undefined
  let eofAt: number | undefined
  let completedAt: number | undefined
  let classified = false

  let winningTimeout: LocalTimeout | undefined
  const localTimeouts = new Map<AIError, LocalTimeout>()

  const beginRead = (
    readStarted: number,
    deadline: ReadDeadline,
  ) => {
    activeReadStarted = readStarted
    interruptedRead = undefined
    selected = deadline
  }

  const finishRead = (
    exit: Exit.Exit<readonly Uint8Array[], unknown>,
  ) => {
    if (activeReadStarted === undefined) return

    const ended = now()
    const wait = elapsedMs(activeReadStarted, ended)

    firstReadWaitMs ??= wait
    activeReadStarted = undefined

    // Pending-pull interruption records the end of that read,
    // not the terminal outcome of the owning request.
    // Preserve its timing before potentially delayed reader cleanup.
    if (
      Exit.isFailure(exit) &&
      Cause.hasInterruptsOnly(exit.cause)
    ) {
      interruptedRead = {
        observedAt: ended,
        readWaitMs: wait,
      }
      return
    }

    const eof =
      Exit.isFailure(exit) &&
      Pull.isDoneCause(exit.cause)

    if (!Exit.isSuccess(exit) && !eof) return

    successfulReadCount++
    maxSuccessfulReadWaitMs =
      maxSuccessfulReadWaitMs === undefined
        ? wait
        : Math.max(maxSuccessfulReadWaitMs, wait)

    if (Exit.isSuccess(exit)) {
      chunkCount += exit.value.length
    } else {
      eofAt ??= ended
    }
  }

  const timeoutError = (
    error: AIError,
    source: TimeoutSource,
  ) => {
    // Fixed Stream.timeoutOrElse constructs its fallback error
    // after closing the interrupted source scope. Use the
    // observed interrupted-read boundary, not cleanup latency.
    const interrupted =
      source === "read_idle"
        ? interruptedRead
        : undefined

    const observedAt = interrupted?.observedAt ?? now()

    localTimeouts.set(error, {
      source,
      observedAt,
      readWaitMs:
        interrupted?.readWaitMs ??
        (activeReadStarted === undefined
          ? undefined
          : elapsedMs(activeReadStarted, observedAt)),
    })

    return error
  }

  const observeFailure = (error: AIError) => {
    // A timer that fires but loses the stream race is not the
    // winning timeout. Match the actual propagated error instance.
    winningTimeout ??= localTimeouts.get(error)
    return error
  }

  const complete = Effect.sync(() => {
    completedAt ??= now()
  })

  const classify = (
    exit: Exit.Exit<unknown, unknown>,
    request: {
      readonly signal?: AbortSignal
      readonly consumerReturned?: () => boolean
    },
  ): SseTransportSummary | undefined => {
    if (classified) return undefined
    classified = true

    const classifiedAt = now()
    const failure = Exit.isFailure(exit)
    const returned = request.consumerReturned?.() === true

    let outcome: TerminalOutcome

    if (request.signal?.aborted === true) {
      outcome = "abort"
    } else if (winningTimeout !== undefined) {
      outcome = "timeout"
    } else if (
      failure &&
      Cause.hasInterrupts(exit.cause) &&
      !returned
    ) {
      outcome = "abort"
    } else if (
      failure &&
      !Cause.hasInterruptsOnly(exit.cause)
    ) {
      outcome = "other_error"
    } else if (
      completedAt !== undefined ||
      eofAt !== undefined
    ) {
      outcome = "completed"
    } else {
      outcome = "consumer_cancel"
    }

    const terminalAt =
      outcome === "timeout"
        ? winningTimeout!.observedAt
        : outcome === "completed"
          ? completedAt ?? eofAt ?? classifiedAt
          : classifiedAt

    const firstWait =
      firstReadWaitMs ??
      (activeReadStarted === undefined
        ? undefined
        : elapsedMs(activeReadStarted, terminalAt))

    return Object.freeze({
      terminalOutcome: outcome,
      responseHeaderWaitMs: elapsedMs(started, established),
      sseStreamDurationMs: elapsedMs(established, terminalAt),
      firstReadWaitMs: firstWait,
      maxSuccessfulReadWaitMs,
      successfulReadCount,
      chunkCount,
      splashAdaptiveSseTimeoutEligible: adaptive,
      adaptiveSampleCount,
      readDeadlineSource: selected?.source,
      readDeadlineMs: selected?.milliseconds,
      adaptiveBasisWaitMs: selected?.basisWaitMs,
      timeoutReadWaitMs: winningTimeout?.readWaitMs,
      timeoutSource: winningTimeout?.source,
    })
  }

  return {
    beginRead,
    finishRead,
    timeoutError,
    observeFailure,
    complete,
    classify,
    sampleCount: (count: number) => {
      adaptiveSampleCount = count
    },
  }
}

type SseObservation = ReturnType<typeof makeSseObservation>

const bodyWithOverlay = <Body>(body: Body, request: LLMRequest, encodeBody: (body: Body) => string) =>
  Effect.gen(function* () {
    if (request.http?.body === undefined) return { jsonBody: body, bodyText: encodeBody(body) }
    if (ProviderShared.isRecord(body)) {
      const overlaid = mergeJsonRecords(body, request.http.body) ?? {}
      return { jsonBody: overlaid, bodyText: ProviderShared.encodeJson(overlaid) }
    }
    return yield* ProviderShared.invalidRequest("http.body can only overlay JSON object request bodies")
  })

export const jsonRequestParts = <Body>(input: JsonRequestInput<Body>) =>
  Effect.gen(function* () {
    const endpoint = renderEndpoint(input.endpoint, { request: input.request, body: input.body })
    if (input.request.http?.query) {
      Object.entries(input.request.http.query).forEach(([key, value]) => endpoint.searchParams.set(key, value))
    }
    const url = endpoint.toString()
    const body = yield* bodyWithOverlay(input.body, input.request, input.encodeBody)
    const headers = yield* Auth.toEffect(input.auth)({
      request: input.request,
      method: "POST",
      url,
      body: body.bodyText,
      headers: Headers.fromInput({
        ...input.headers?.({ request: input.request }),
        ...input.request.headers,
      }),
    })
    return { url, jsonBody: body.jsonBody, bodyText: body.bodyText, headers }
  })

export interface HttpJsonInput<_Body, Frame> {
  readonly framing: Framing.Definition<Frame>
}

export type HttpJsonPatch<Body, Frame> = Partial<HttpJsonInput<Body, Frame>>

export interface HttpJsonTransport<Body, Frame> extends Transport<Body, HttpPrepared<Frame>, Frame> {
  readonly with: (patch: HttpJsonPatch<Body, Frame>) => HttpJsonTransport<Body, Frame>
}

export const httpJson = <Body, Frame>(input: HttpJsonInput<Body, Frame>): HttpJsonTransport<Body, Frame> => ({
  id: "http-json",
  with: (patch) => httpJson({ ...input, ...patch }),
  prepare: (prepareInput) =>
    Effect.gen(function* () {
      const parts = yield* jsonRequestParts({ ...prepareInput })
      const request = ProviderShared.jsonPost({
        url: parts.url,
        body: parts.bodyText,
        headers: parts.headers,
        encoding: prepareInput.request.http?.encoding,
      })
      return {
        request,
        framing: input.framing,
        middleware: prepareInput.middleware,
      }
    }),
  execute: (prepared, request, runtime) =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const timeout = (operation: "request" | "read", message: string, http?: HttpContext) =>
        new AIError({
          reason: new TransportError({
            message,
            transport: "http",
            operation,
            code: "Timeout",
            url: prepared.request.url,
            http,
          }),
        })
      const started = yield* Clock.currentTimeMillis
      const limits = timeoutConfig(request.timeout)
      // Unlike the header and chunk limits, the whole-request budget has no default.
      const total = limits.total ? Duration.millis(limits.total) : Duration.infinity
      const acquire = RequestExecutor.withTls(runtime.http.execute, request.http?.tls)(
        prepared.request,
        prepared.middleware,
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.min(timeoutDuration(limits.headers), total),
          orElse: () => timeout("request", "Timed out waiting for response headers"),
        }),
      )
      // Adaptive calibration only replaces the per-read idle limit when it was explicitly enabled for a same-origin
      // loopback endpoint and no explicit chunk limit was supplied; explicit limits always win.
      const adaptive =
        request.http?.splashAdaptiveSseTimeout === true &&
        limits.chunk === undefined &&
        sameLoopbackOrigin(request.http?.splashAdaptiveEndpoint, prepared.request.url)
      const establish = (response: HttpClientResponse.HttpClientResponse) =>
        Effect.gen(function* () {
          const established = yield* Clock.currentTimeMillis
          const http = RequestExecutor.responseHttp(response)
          const remaining = Duration.subtract(total, Duration.millis(established - started))

          let observation: SseObservation | undefined

          if (prepared.framing.id === "sse") {
            observation = makeSseObservation(
              clock,
              started,
              established,
              adaptive,
            )

            const requestEvidence = yield* CurrentSseRequest
            const sink = yield* CurrentSseDiagnosticSink

            const diagnosticContext = (
              yield* Effect.context<never>()
            ).pipe(
              Context.omit(
                Scope.Scope,
                CurrentSseRequest,
                CurrentSseDiagnosticSink,
              ),
            )

            yield* Effect.addFinalizer((exit) =>
              Effect.gen(function* () {
                const summary = observation!.classify(
                  exit,
                  requestEvidence,
                )
                if (summary === undefined) return

                yield* Effect.suspend(() => sink(summary)).pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.forkDetach({
                    startImmediately: false,
                  }),
                  Effect.provideContext(diagnosticContext),
                )
              }),
            )
          }

          return { response, http, remaining, observation }
        })

      // For SSE, keep setup uninterruptible after the response is acquired so the
      // execution-scope finalizer is registered before an interruption can escape.
      // Header acquisition itself remains interruptible.
      const established =
        prepared.framing.id === "sse"
          ? yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const response = yield* restore(acquire)
                return yield* establish(response)
              }),
            )
          : yield* acquire.pipe(Effect.flatMap(establish))

      const { response, http, remaining, observation } = established
      const source = RequestExecutor.responseStream(response)

      const idleTimeout = () => {
        const error = timeout(
          "read",
          "Timed out waiting for response data",
          http,
        )
        return observation?.timeoutError(
          error,
          "read_idle",
        ) ?? error
      }

      const stream = adaptive
        ? adaptiveReadTimeout(
            source,
            ADAPTIVE_READ_TIMEOUT_MS,
            () => idleTimeout(),
            observation,
          )
        : (
            observation === undefined
              ? source
              : observeFixedReads(
                  source,
                  observation,
                  limits.chunk,
                )
          ).pipe(
            Stream.timeoutOrElse({
              duration: timeoutDuration(
                limits.chunk,
                DEFAULT_CHUNK_TIMEOUT_MS,
              ),
              orElse: () => Stream.fail(idleTimeout()),
            }),
          )

      const totalTimeout = Effect.sleep(remaining).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const error = timeout(
              "read",
              "Timed out waiting for the response to complete",
              http,
            )
            return Effect.fail(
              observation?.timeoutError(
                error,
                "whole_request",
              ) ?? error,
            )
          }),
        ),
      )

      const frames = prepared.framing.frame(
        stream.pipe(Stream.interruptWhen(totalTimeout)),
      )

      return {
        frames:
          observation === undefined
            ? frames
            : frames.pipe(
                Stream.mapError(observation.observeFailure),
              ),
        http,
        body: prepared.framing.body,
        raw: prepared.framing.raw,
        complete: observation?.complete,
      }
    }),
})

const timeoutDuration = (value: HttpTimeout | undefined, fallback = DEFAULT_HTTP_TIMEOUT_MS) =>
  value === false ? Duration.infinity : Duration.millis(value ?? fallback)

// Initial per-read idle limit for adaptive calibration. Distinct from the fixed chunk default: it only seeds
// the first read until samples calibrate a tighter deadline.
const ADAPTIVE_READ_TIMEOUT_MS = 300_000

const observeFixedReads = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
  observation: SseObservation,
  limit: HttpTimeout | undefined,
) =>
  Stream.transformPull(source, (pull) =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const deadline: ReadDeadline =
        limit === false
          ? { source: "disabled" }
          : {
              source:
                limit === undefined
                  ? "fixed_default"
                  : "explicit",
              milliseconds:
                limit ?? DEFAULT_CHUNK_TIMEOUT_MS,
            }

      return Effect.suspend(() => {
        observation.beginRead(
          clock.currentTimeMillisUnsafe(),
          deadline,
        )

        return pull.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => observation.finishRead(exit)),
          ),
        )
      })
    }),
  )

/**
 * Replaces the fixed per-read idle limit with a calibrated one. Qualifying nonempty reads of at least 100ms are
 * sampled (most recent five); the slowest sample is excluded from the basis, and the deadline becomes ten times
 * that basis, clamped to 30-300 seconds. State is created per stream, so retries and fallback attempts calibrate
 * independently, and the deadline selected for a read stays fixed while that read is pending.
 */
const adaptiveReadTimeout = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
  initial: number,
  onTimeout: (duration: number) => AIError,
  observation?: SseObservation,
) =>
  Stream.transformPull(source, (pull) =>
    Effect.sync(() => {
      const samples: Array<number> = []
      let current = initial
      return Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        const selected = current

        observation?.beginRead(started, {
          source:
            samples.length === 5
              ? "adaptive_calibrated"
              : "adaptive_initial",
          milliseconds: selected,
          basisWaitMs:
            samples.length === 5
              ? adaptiveBasis(samples)
              : undefined,
        })

        const chunk = yield* pull.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(selected),
            orElse: () =>
              Effect.fail(onTimeout(selected)),
          }),
          Effect.onExit((exit) =>
            Effect.sync(() => observation?.finishRead(exit)),
          ),
        )

        const elapsed =
          (yield* Clock.currentTimeMillis) - started

        if (
          elapsed >= 100 &&
          chunk.some((bytes) => bytes.byteLength > 0)
        ) {
          samples.push(elapsed)
          if (samples.length > 5) samples.shift()
          if (samples.length === 5)
            current = adaptiveTimeout(samples)

          observation?.sampleCount(samples.length)
        }

        return chunk
      })
    }),
  )

/** Adaptive calibration only applies when the actual request URL shares the configured endpoint's loopback origin. */
export const sameLoopbackOrigin = (configured: string | undefined, actual: string) => {
  if (configured === undefined) return false
  try {
    const expected = new URL(configured)
    const request = new URL(actual)
    return (
      (expected.protocol === "http:" || expected.protocol === "https:") &&
      expected.origin === request.origin &&
      loopback(expected.hostname) &&
      loopback(request.hostname)
    )
  } catch {
    return false
  }
}

const loopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  (hostname.startsWith("127.") &&
    hostname.split(".").length === 4 &&
    hostname.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255))

export const adaptiveTimeout = (samples: readonly number[]) =>
  Math.min(
    300_000,
    Math.max(30_000, adaptiveBasis(samples) * 10),
  )

const adaptiveBasis = (samples: readonly number[]) => {
  const ordered = [...samples].sort(
    (left, right) => left - right,
  )
  return ordered.at(-2) ?? 0
}

export const sseJson = {
  id: "http-json/sse",
  with: <Body>() => httpJson<Body, string>({ framing: Framing.sse }),
} as const
