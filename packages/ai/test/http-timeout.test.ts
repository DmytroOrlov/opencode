import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ai, LLMEvent } from "../src/effect.js"
import { LLMClient, mergeTransport, Endpoint, Protocol, Route, type Framing } from "../src/route.js"
import {
  adaptiveTimeout,
  CurrentSseDiagnosticSink,
  sameLoopbackOrigin,
  type SseTransportSummary,
} from "../src/route/transport/http.js"
import { configure } from "../src/providers/openai.js"
import { LanguageModel } from "../src/schema/index.js"
import { dynamicResponse, systemError, truncatedStream } from "./lib/http.js"
import { deltaChunk, finishChunk } from "./lib/openai-chunks.js"
import { sseEvents, sseRaw } from "./lib/sse.js"
import { it } from "./lib/effect.js"

const model = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4.1-mini")
// Adaptive calibration only applies to same-origin loopback endpoints, so adaptive requests need one.
const loopbackModel = configure({ baseURL: "http://127.0.0.1:3000/v1/", apiKey: "test" }).chat("gpt-4.1-mini")
const adaptiveHttp = { splashAdaptiveSseTimeout: true, splashAdaptiveEndpoint: "http://127.0.0.1:3000/v1" }
const SSE = { headers: { "content-type": "text/event-stream" } }

const DocumentEvent = Schema.Struct({ text: Schema.String })
type DocumentEvent = Schema.Schema.Type<typeof DocumentEvent>

const documentFraming: Framing.Definition<DocumentEvent> = {
  id: "document-json",
  frame: (bytes) =>
    Stream.fromEffect(
      bytes.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DocumentEvent))),
        Effect.orDie,
      ),
    ),
}

const documentProtocol = Protocol.make<{ readonly body: string }, DocumentEvent, DocumentEvent, void>({
  id: "document-fake",
  body: {
    schema: Schema.Struct({ body: Schema.String }),
    from: () => Effect.succeed({ body: "document" }),
  },
  stream: {
    event: DocumentEvent,
    initial: () => undefined,
    step: (state, event) =>
      Effect.succeed([
        state,
        [
          { type: "text-delta", id: "text-0", text: event.text },
          { type: "finish", reason: { normalized: "stop" } },
        ],
      ] as const),
  },
})

const documentRoute = Route.make({
  id: "document-fake",
  protocol: documentProtocol,
  endpoint: Endpoint.path("/document"),
  framing: documentFraming,
}).with({ endpoint: { baseURL: "https://document.test" } })

const documentModel = LanguageModel.make({
  id: "document-model",
  provider: "document-provider",
  route: documentRoute,
})

const diagnosticRecorder = Effect.gen(function* () {
  const delivered = yield* Deferred.make<SseTransportSummary>()
  const summaries: SseTransportSummary[] = []
  const sink = (summary: SseTransportSummary) =>
    Effect.gen(function* () {
      summaries.push(summary)
      yield* Deferred.succeed(delivered, summary)
    })
  return { sink, summaries, delivered }
})

const respondSse = (body: ReadableStream<Uint8Array>) =>
  dynamicResponse((input) => Effect.succeed(input.respond(body, SSE)))

const oneChunkSse = (payload: string) => {
  const encoder = new TextEncoder()
  let pulled = 0
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled++ === 0) {
          controller.enqueue(encoder.encode(payload))
          return
        }
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
}

const heldSseBody = (payload: string) =>
  Effect.gen(function* () {
    const readStarted = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    let releaseHeld = () => {}
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    const encoder = new TextEncoder()
    let pulled = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled++ === 0) {
            controller.enqueue(encoder.encode(payload))
            return
          }
          Deferred.doneUnsafe(readStarted, Effect.void)
          return held
        },
        cancel() {
          releaseHeld()
          Deferred.doneUnsafe(cancelled, Effect.void)
        },
      },
      { highWaterMark: 0 },
    )
    return { body, readStarted, cancelled }
  })

const silentServer = dynamicResponse(() => Effect.never)

const slowHeadersServer = dynamicResponse((input) =>
  Effect.sleep("10 minutes").pipe(
    Effect.as(input.respond(sseEvents(deltaChunk({ role: "assistant", content: "Hi" }), finishChunk("stop")), SSE)),
  ),
)

// Sends one chunk, then stalls until `resume` releases the rest of the body.
const stalledServer = Effect.gen(function* () {
  const stalled = yield* Deferred.make<void>()
  let resume = () => {}
  const released = new Promise<void>((resolve) => {
    resume = resolve
  })
  const encoder = new TextEncoder()
  const layer = dynamicResponse((input) =>
    Effect.sync(() =>
      input.respond(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sseRaw(`data: ${JSON.stringify(deltaChunk({ content: "Hi" }))}`)))
          },
          async pull(controller) {
            Deferred.doneUnsafe(stalled, Effect.void)
            await released
            controller.enqueue(encoder.encode(sseEvents(finishChunk("stop"))))
            controller.close()
          },
        }),
        SSE,
      ),
    ),
  )
  return { layer, stalled, resume: () => resume() }
})

const longHealthyServer = Effect.gen(function* () {
  const first = yield* Deferred.make<void>()
  const second = yield* Deferred.make<void>()
  let releaseFirst = () => {}
  let releaseSecond = () => {}
  const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve))
  const secondReleased = new Promise<void>((resolve) => (releaseSecond = resolve))
  let index = 0
  const encoder = new TextEncoder()
  const layer = dynamicResponse((input) =>
    Effect.sync(() =>
      input.respond(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (index === 0) {
              index++
              Deferred.doneUnsafe(first, Effect.void)
              await firstReleased
              controller.enqueue(encoder.encode(sseRaw(`data: ${JSON.stringify(deltaChunk({ content: "Hello" }))}`)))
              return
            }
            Deferred.doneUnsafe(second, Effect.void)
            await secondReleased
            controller.enqueue(encoder.encode(sseEvents(finishChunk("stop"))))
            controller.close()
          },
        }),
        SSE,
      ),
    ),
  )
  return { layer, first, second, releaseFirst: () => releaseFirst(), releaseSecond: () => releaseSecond() }
})

// Six stalls: five 200ms reads become qualifying samples, so the sixth read faces the calibrated
// 30 second deadline instead of the initial 300 second one.
const calibratingServer = Effect.gen(function* () {
  const reads = yield* Effect.all(Array.from({ length: 6 }, () => Deferred.make<void>()))
  const releases: Array<() => void> = []
  const released = Array.from({ length: 6 }, () =>
    new Promise<void>((resolve) => {
      releases.push(() => resolve())
    }),
  )
  const encoder = new TextEncoder()
  let index = 0
  const layer = dynamicResponse((input) =>
    Effect.sync(() =>
      input.respond(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const current = index
            index++
            Deferred.doneUnsafe(reads[current]!, Effect.void)
            await released[current]!
            if (current === 5) {
              controller.enqueue(encoder.encode(sseEvents(finishChunk("stop"))))
              controller.close()
              return
            }
            controller.enqueue(
              encoder.encode(sseRaw(`data: ${JSON.stringify(deltaChunk({ content: `tick ${current}` }))}`)),
            )
          },
        }),
        SSE,
      ),
    ),
  )
  return { layer, reads, releases }
})

describe("HTTP transport timeouts", () => {
  test("uses the Splash 30–300 second policy after excluding the slowest qualifying read", () => {
    expect(adaptiveTimeout([1_000, 2_000, 3_000, 4_200, 30_000])).toBe(42_000)
    expect(adaptiveTimeout([100, 200, 300, 400, 500])).toBe(30_000)
    expect(adaptiveTimeout([40_000, 41_000, 42_000, 50_000, 90_000])).toBe(300_000)
  })

  test("requires the same HTTP(S) loopback origin for Splash calibration", () => {
    expect(sameLoopbackOrigin("http://127.0.0.1:3000/v1", "http://127.0.0.1:3000/chat/completions")).toBe(true)
    expect(sameLoopbackOrigin("http://localhost:3000/v1", "http://localhost:3001/chat/completions")).toBe(false)
    expect(sameLoopbackOrigin("http://127.0.0.1:3000/v1", "https://127.0.0.1:3000/chat/completions")).toBe(false)
    expect(sameLoopbackOrigin("https://api.example.test/v1", "https://api.example.test/v1/chat/completions")).toBe(
      false,
    )
    expect(sameLoopbackOrigin("http://127.999.0.1/v1", "http://127.999.0.1/v1/chat/completions")).toBe(false)
  })

  it.effect("lets an adaptive generation outlive the initial idle budget when each read stays timely", () =>
    Effect.gen(function* () {
      const server = yield* longHealthyServer
      const fiber = yield* LLMClient.generate(
        ai.request({ model: loopbackModel, prompt: "Hello", http: adaptiveHttp }),
      ).pipe(Effect.provide(server.layer), Effect.forkChild({ startImmediately: true }))
      // Each 3 minute stall is inside the 5 minute pending-read deadline, but the 6 minute total exceeds it.
      yield* Deferred.await(server.first)
      yield* Effect.yieldNow
      yield* TestClock.adjust("3 minutes")
      server.releaseFirst()
      yield* Deferred.await(server.second)
      yield* Effect.yieldNow
      yield* TestClock.adjust("3 minutes")
      server.releaseSecond()
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hello")
    }),
  )

  it.effect("fails an adaptive stream once the pending-read deadline expires", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        ai.request({ model: loopbackModel, prompt: "Hello", http: adaptiveHttp }),
      ).pipe(Effect.provide(server.layer), Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      // The adaptive initial deadline is 300 seconds, not the ordinary 900 second chunk default.
      yield* TestClock.adjust("5 minutes")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", transport: "http", operation: "read", code: "Timeout" })
      expect(error.reason.http).toMatchObject({ status: 200 })
    }),
  )

  it.effect("calibrates per pending read and keeps samples isolated to each response", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const server = yield* calibratingServer
      const fiber = yield* LLMClient.generate(
        ai.request({ model: loopbackModel, prompt: "Hello", http: adaptiveHttp }),
      ).pipe(
        Effect.provide(server.layer),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      for (let sample = 0; sample < 5; sample++) {
        yield* Deferred.await(server.reads[sample]!)
        yield* Effect.yieldNow
        yield* TestClock.adjust("200 millis")
        server.releases[sample]!()
      }
      // Five 200ms samples put the basis at 200ms, so the deadline floors at 30 seconds: a 1 minute stall fails
      // even though the initial 300 second deadline would have allowed it.
      yield* Deferred.await(server.reads[5]!)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 minute")
      const error = yield* Fiber.join(fiber)
      expect(error.reason).toMatchObject({ _tag: "Transport", transport: "http", operation: "read", code: "Timeout" })

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toEqual({
        terminalOutcome: "timeout",
        responseHeaderWaitMs: 0,
        sseStreamDurationMs: 31_000,
        firstReadWaitMs: 200,
        maxSuccessfulReadWaitMs: 200,
        successfulReadCount: 5,
        chunkCount: 5,
        splashAdaptiveSseTimeoutEligible: true,
        adaptiveSampleCount: 5,
        readDeadlineSource: "adaptive_calibrated",
        readDeadlineMs: 30_000,
        adaptiveBasisWaitMs: 200,
        timeoutReadWaitMs: 30_000,
        timeoutSource: "read_idle",
      })
      expect(Object.isFrozen(summary)).toBe(true)

      // A second response starts from the initial deadline again, so a 4 minute stall survives.
      const retryRecorder = yield* diagnosticRecorder
      const second = yield* stalledServer
      const retry = yield* LLMClient.generate(
        ai.request({ model: loopbackModel, prompt: "Hello", http: adaptiveHttp }),
      ).pipe(
        Effect.provide(second.layer),
        Effect.provideService(CurrentSseDiagnosticSink, retryRecorder.sink),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(second.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("4 minutes")
      second.resume()
      const response = yield* Fiber.join(retry)
      expect(response.text).toBe("Hi")

      const retrySummary = yield* Deferred.await(retryRecorder.delivered)
      expect(retrySummary).toMatchObject({
        terminalOutcome: "completed",
        adaptiveSampleCount: 1,
        readDeadlineSource: "adaptive_initial",
        readDeadlineMs: 300_000,
        adaptiveBasisWaitMs: undefined,
        timeoutReadWaitMs: undefined,
        timeoutSource: undefined,
        successfulReadCount: 2,
        chunkCount: 2,
        firstReadWaitMs: 0,
        maxSuccessfulReadWaitMs: 240_000,
      })
      expect(retrySummary.readDeadlineMs).not.toBe(30_000)
    }),
  )

  it.effect("keeps the fifth qualifying read on the adaptive initial deadline when nothing else is pulled", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const reads = yield* Effect.all(Array.from({ length: 5 }, () => Deferred.make<void>()))
      const releases: Array<() => void> = []
      const released = Array.from({ length: 5 }, () =>
        new Promise<void>((resolve) => {
          releases.push(() => resolve())
        }),
      )
      const encoder = new TextEncoder()
      let index = 0
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const current = index
            index++
            Deferred.doneUnsafe(reads[current]!, Effect.void)
            await released[current]!
            controller.enqueue(
              encoder.encode(
                current === 4 ? sseEvents(finishChunk("stop")) : sseRaw(`data: ${JSON.stringify(deltaChunk({ content: `tick ${current}` }))}`),
              ),
            )
            if (current === 4) controller.close()
          },
        },
        { highWaterMark: 0 },
      )
      const fiber = yield* LLMClient.generate(
        ai.request({ model: loopbackModel, prompt: "Hello", http: adaptiveHttp }),
      ).pipe(
        Effect.provide(respondSse(body)),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.forkChild({ startImmediately: true }),
      )
      for (let sample = 0; sample < 5; sample++) {
        yield* Deferred.await(reads[sample]!)
        yield* Effect.yieldNow
        yield* TestClock.adjust("200 millis")
        releases[sample]!()
      }
      const response = yield* Fiber.join(fiber)
      expect(response.text).toBe("tick 0tick 1tick 2tick 3")
      expect(body.locked).toBe(false)

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "completed",
        successfulReadCount: 5,
        chunkCount: 5,
        firstReadWaitMs: 200,
        maxSuccessfulReadWaitMs: 200,
        splashAdaptiveSseTimeoutEligible: true,
        adaptiveSampleCount: 5,
        readDeadlineSource: "adaptive_initial",
        readDeadlineMs: 300_000,
        adaptiveBasisWaitMs: undefined,
        timeoutReadWaitMs: undefined,
        timeoutSource: undefined,
      })
    }),
  )

  it.effect("an explicit chunk timeout overrides adaptive calibration", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        ai.request({ model: loopbackModel, prompt: "Hello", http: adaptiveHttp, timeout: { chunk: 1_000 } }),
      ).pipe(
        Effect.provide(server.layer),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", transport: "http", operation: "read", code: "Timeout" })

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toEqual({
        terminalOutcome: "timeout",
        responseHeaderWaitMs: 0,
        sseStreamDurationMs: 1_000,
        firstReadWaitMs: 0,
        maxSuccessfulReadWaitMs: 0,
        successfulReadCount: 1,
        chunkCount: 1,
        splashAdaptiveSseTimeoutEligible: false,
        adaptiveSampleCount: 0,
        readDeadlineSource: "explicit",
        readDeadlineMs: 1_000,
        adaptiveBasisWaitMs: undefined,
        timeoutReadWaitMs: 1_000,
        timeoutSource: "read_idle",
      })
    }),
  )

  it.effect("chunk timeout false disables the idle limit even with adaptive enabled", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        ai.request({ model: loopbackModel, prompt: "Hello", http: adaptiveHttp, timeout: { chunk: false } }),
      ).pipe(
        Effect.provide(server.layer),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      // Past the 300 second adaptive initial deadline; only an explicit false keeps the read alive.
      yield* TestClock.adjust("10 minutes")
      server.resume()
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hi")

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "completed",
        successfulReadCount: 2,
        chunkCount: 2,
        splashAdaptiveSseTimeoutEligible: false,
        adaptiveSampleCount: 0,
        readDeadlineSource: "disabled",
        readDeadlineMs: undefined,
        adaptiveBasisWaitMs: undefined,
        timeoutReadWaitMs: undefined,
        timeoutSource: undefined,
      })
      expect(summary.readDeadlineMs).toBeUndefined()
    }),
  )

  it.effect("a disabled adaptive flag keeps the ordinary 900 second chunk default", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        ai.request({
          model: loopbackModel,
          prompt: "Hello",
          http: { splashAdaptiveSseTimeout: false, splashAdaptiveEndpoint: "http://127.0.0.1:3000/v1" },
        }),
      ).pipe(
        Effect.provide(server.layer),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      // 14 minutes passes; the loopback origin must not enable calibration on its own.
      yield* TestClock.adjust("14 minutes")
      server.resume()
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hi")

      const summary = yield* Deferred.await(recorder.delivered)
      expect(summary).toMatchObject({
        terminalOutcome: "completed",
        splashAdaptiveSseTimeoutEligible: false,
        adaptiveSampleCount: 0,
        readDeadlineSource: "fixed_default",
        readDeadlineMs: 900_000,
        adaptiveBasisWaitMs: undefined,
        timeoutReadWaitMs: undefined,
        timeoutSource: undefined,
      })
    }),
  )

  it.effect("fails when response headers take longer than five minutes", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(silentServer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust("5 minutes")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({
        _tag: "Transport",
        transport: "http",
        operation: "request",
        code: "Timeout",
      })
    }),
  )

  it.effect("fails when the response body stalls for fifteen minutes", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(server.layer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("15 minutes")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", transport: "http", operation: "read", code: "Timeout" })
      expect(error.reason.http).toMatchObject({ status: 200 })
    }),
  )

  it.effect("applies a configured header timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello", timeout: { headers: 1_000 } })).pipe(
        Effect.provide(silentServer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "request", code: "Timeout" })
    }),
  )

  it.effect("disables the header timeout with false", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello", timeout: { headers: false } })).pipe(
        Effect.provide(slowHeadersServer),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust("10 minutes")
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hi")

      const summary = yield* Deferred.await(recorder.delivered)
      expect(summary.responseHeaderWaitMs).toBe(600_000)
      expect(summary.sseStreamDurationMs).toBe(0)
      expect(summary.terminalOutcome).toBe("completed")
    }),
  )

  it.effect("disables the chunk timeout with false", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello", timeout: { chunk: false } })).pipe(
        Effect.provide(server.layer),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 minutes")
      server.resume()
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("applies a whole-request timeout while the body is still streaming", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        ai.request({ model, prompt: "Hello", timeout: { total: 60_000, chunk: false } }),
      ).pipe(
        Effect.provide(server.layer),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 minute")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "read", code: "Timeout" })

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "timeout",
        successfulReadCount: 1,
        chunkCount: 1,
        splashAdaptiveSseTimeoutEligible: false,
        adaptiveSampleCount: 0,
        readDeadlineSource: "disabled",
        readDeadlineMs: undefined,
        adaptiveBasisWaitMs: undefined,
        timeoutSource: "whole_request",
      })
      expect(summary.timeoutReadWaitMs).toBe(60_000)
      expect(summary.readDeadlineMs).toBeUndefined()
    }),
  )

  it.effect("reports a winning whole-request timer separately from a larger selected idle threshold", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        ai.request({ model, prompt: "Hello", timeout: { total: 60_000, chunk: 300_000 } }),
      ).pipe(
        Effect.provide(server.layer),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 minute")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "read", code: "Timeout" })

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "timeout",
        readDeadlineSource: "explicit",
        readDeadlineMs: 300_000,
        adaptiveBasisWaitMs: undefined,
        timeoutSource: "whole_request",
      })
      expect(summary.timeoutReadWaitMs).toBe(60_000)
    }),
  )

  it.effect("excludes delayed reader cleanup from fixed idle timeout timing", () => {
    let releaseRead = () => {}
    let releaseCleanup = () => {}

    return Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const readStarted = yield* Deferred.make<void>()
      const cancelStarted = yield* Deferred.make<void>()

      const readHeld = new Promise<void>((resolve) => {
        releaseRead = resolve
      })

      const cleanupHeld = new Promise<void>((resolve) => {
        releaseCleanup = resolve
      })

      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            Deferred.doneUnsafe(readStarted, Effect.void)
            return readHeld
          },
          cancel() {
            releaseRead()
            Deferred.doneUnsafe(cancelStarted, Effect.void)
            return cleanupHeld
          },
        },
        { highWaterMark: 0 },
      )

      const fiber = yield* LLMClient.generate(
        ai.request({
          model,
          prompt: "Hello",
          timeout: { chunk: 1_000 },
        }),
      ).pipe(
        Effect.provide(respondSse(body)),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )

      yield* Deferred.await(readStarted)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(cancelStarted)

      // The read deadline has expired, but reader cleanup
      // has not completed.
      expect(body.locked).toBe(true)

      yield* TestClock.adjust("5 seconds")

      releaseCleanup()

      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({
        _tag: "Transport",
        transport: "http",
        operation: "read",
        code: "Timeout",
      })

      expect(body.locked).toBe(false)

      const summary = yield* Deferred.await(recorder.delivered)

      expect(recorder.summaries).toHaveLength(1)

      expect(summary).toEqual({
        terminalOutcome: "timeout",
        responseHeaderWaitMs: 0,
        sseStreamDurationMs: 1_000,
        firstReadWaitMs: 1_000,
        maxSuccessfulReadWaitMs: undefined,
        successfulReadCount: 0,
        chunkCount: 0,
        splashAdaptiveSseTimeoutEligible: false,
        adaptiveSampleCount: 0,
        readDeadlineSource: "explicit",
        readDeadlineMs: 1_000,
        adaptiveBasisWaitMs: undefined,
        timeoutReadWaitMs: 1_000,
        timeoutSource: "read_idle",
      })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseRead()
          releaseCleanup()
        }),
      ),
    )
  })

  it.effect("completes after natural byte EOF and counts EOF as a successful read without a chunk", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const body = oneChunkSse(
        sseRaw(
          `data: ${JSON.stringify(deltaChunk({ content: "Hello" }))}`,
          `data: ${JSON.stringify(finishChunk("stop"))}`,
        ),
      )
      const response = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(respondSse(body)),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
      )

      expect(response.text).toBe("Hello")
      expect(body.locked).toBe(false)

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toEqual({
        terminalOutcome: "completed",
        responseHeaderWaitMs: 0,
        sseStreamDurationMs: 0,
        firstReadWaitMs: 0,
        maxSuccessfulReadWaitMs: 0,
        successfulReadCount: 2,
        chunkCount: 1,
        splashAdaptiveSseTimeoutEligible: false,
        adaptiveSampleCount: 0,
        readDeadlineSource: "fixed_default",
        readDeadlineMs: 900_000,
        adaptiveBasisWaitMs: undefined,
        timeoutReadWaitMs: undefined,
        timeoutSource: undefined,
      })
      expect(Object.isFrozen(summary)).toBe(true)
    }),
  )

  it.effect("acknowledges protocol completion before byte EOF", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const held = yield* heldSseBody(sseEvents(deltaChunk({ content: "Hello" }), finishChunk("stop")))
      const response = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(respondSse(held.body)),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
      )

      expect(response.text).toBe("Hello")
      expect(held.body.locked).toBe(false)

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "completed",
        successfulReadCount: 1,
        chunkCount: 1,
        readDeadlineSource: "fixed_default",
        readDeadlineMs: 900_000,
        timeoutReadWaitMs: undefined,
        timeoutSource: undefined,
      })
    }),
  )

  it.effect("classifies owning Effect interruption as abort rather than a cancelled pull", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const held = yield* heldSseBody(sseRaw(`data: ${JSON.stringify(deltaChunk({ content: "Hello" }))}`))
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(respondSse(held.body)),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.forkChild({ startImmediately: true }),
      )

      yield* Deferred.await(held.readStarted)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(held.body.locked).toBe(false)

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "abort",
        successfulReadCount: 1,
        chunkCount: 1,
        timeoutReadWaitMs: undefined,
        timeoutSource: undefined,
      })
    }),
  )

  it.effect("classifies an unfinished downstream short-circuit as consumer cancellation", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const held = yield* heldSseBody(sseRaw(`data: ${JSON.stringify(deltaChunk({ content: "Hello" }))}`))
      const events = yield* LLMClient.stream(ai.request({ model, prompt: "Hello" })).pipe(
        Stream.filter(LLMEvent.is.textDelta),
        Stream.take(1),
        Stream.runCollect,
        Effect.provide(respondSse(held.body)),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
      )

      expect(Array.from(events).map((event) => event.text)).toEqual(["Hello"])
      expect(held.body.locked).toBe(false)

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "consumer_cancel",
        successfulReadCount: 1,
        chunkCount: 1,
        timeoutReadWaitMs: undefined,
        timeoutSource: undefined,
      })
    }),
  )

  it.effect("classifies a response body failure as other_error and preserves the transport error", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const error = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(truncatedStream([sseRaw(`data: ${JSON.stringify(deltaChunk({ content: "Hello" }))}`)])),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "Transport", transport: "http", operation: "read" })

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "other_error",
        successfulReadCount: 1,
        chunkCount: 1,
        timeoutSource: undefined,
      })
    }),
  )

  it.effect("does not infer local timeout provenance from a native Timeout code", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const error = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(
          truncatedStream(
            [sseRaw(`data: ${JSON.stringify(deltaChunk({ content: "Hello" }))}`)],
            systemError("Timeout", "Upstream read failed"),
          ),
        ),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({
        _tag: "Transport",
        transport: "http",
        operation: "read",
        code: "Timeout",
        message: expect.stringContaining("Upstream read failed"),
      })

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "other_error",
        timeoutSource: undefined,
        timeoutReadWaitMs: undefined,
      })
    }),
  )

  it.effect("classifies protocol failure after raw EOF as other_error, not completed", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const body = oneChunkSse(sseRaw(`data: ${JSON.stringify(deltaChunk({ content: "Hello" }))}`))
      const error = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(respondSse(body)),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput", classification: "incomplete-stream" })
      expect(body.locked).toBe(false)

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "other_error",
        successfulReadCount: 2,
        chunkCount: 1,
        timeoutSource: undefined,
      })
    }),
  )

  it.effect("classifies malformed protocol decoding as other_error after SSE establishment", () =>
    Effect.gen(function* () {
      const recorder = yield* diagnosticRecorder
      const body = oneChunkSse(sseRaw("data: {not-json"))
      const error = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(respondSse(body)),
        Effect.provideService(CurrentSseDiagnosticSink, recorder.sink),
        Effect.flip,
      )

      expect(error.reason).toBeDefined()
      expect(body.locked).toBe(false)

      const summary = yield* Deferred.await(recorder.delivered)
      expect(recorder.summaries).toHaveLength(1)
      expect(summary).toMatchObject({
        terminalOutcome: "other_error",
        successfulReadCount: 1,
        chunkCount: 1,
        timeoutSource: undefined,
      })
    }),
  )

  it.effect("does not invoke the SSE sink before establishment or for non-SSE framing", () =>
    Effect.gen(function* () {
      const headersRecorder = yield* diagnosticRecorder
      const headerFiber = yield* LLMClient.generate(
        ai.request({ model, prompt: "Hello", timeout: { headers: 1_000 } }),
      ).pipe(
        Effect.provide(silentServer),
        Effect.provideService(CurrentSseDiagnosticSink, headersRecorder.sink),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust("1 second")
      const headerError = yield* Fiber.join(headerFiber)
      expect(headerError.reason).toMatchObject({ _tag: "Transport", operation: "request", code: "Timeout" })
      yield* Effect.yieldNow
      expect(headersRecorder.summaries).toHaveLength(0)

      const rejectedRecorder = yield* diagnosticRecorder
      const rejectedError = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.succeed(
              input.respond(sseEvents(deltaChunk({ content: "Hello" }), finishChunk("stop")), {
                status: 500,
                headers: SSE.headers,
              }),
            ),
          ),
        ),
        Effect.provideService(CurrentSseDiagnosticSink, rejectedRecorder.sink),
        Effect.flip,
      )
      expect(rejectedError.reason.http?.status).toBe(500)
      yield* Effect.yieldNow
      expect(rejectedRecorder.summaries).toHaveLength(0)

      const documentRecorder = yield* diagnosticRecorder
      const response = yield* LLMClient.generate(ai.request({ model: documentModel, prompt: "Hello" })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.succeed(
              input.respond(JSON.stringify({ text: "Document" }), {
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        ),
        Effect.provideService(CurrentSseDiagnosticSink, documentRecorder.sink),
      )
      expect(response.text).toBe("Document")
      yield* Effect.yieldNow
      expect(documentRecorder.summaries).toHaveLength(0)
    }),
  )

  it.effect("isolates a sink that throws while constructing its Effect", () =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>()
      let attempts = 0
      const sink = (_summary: SseTransportSummary) => {
        attempts++
        Deferred.doneUnsafe(attempted, Effect.void)
        throw new Error("diagnostic sync failure")
      }
      const body = oneChunkSse(
        sseRaw(
          `data: ${JSON.stringify(deltaChunk({ content: "Hello" }))}`,
          `data: ${JSON.stringify(finishChunk("stop"))}`,
        ),
      )
      const response = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(respondSse(body)),
        Effect.provideService(CurrentSseDiagnosticSink, sink),
      )

      yield* Deferred.await(attempted)
      yield* Effect.yieldNow
      expect(response.text).toBe("Hello")
      expect(attempts).toBe(1)
      expect(body.locked).toBe(false)
    }),
  )

  it.effect("isolates a sink Effect that fails or defects after invocation", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>()
      const defected = yield* Deferred.make<void>()
      let failAttempts = 0
      let defectAttempts = 0

      const failing = () => {
        failAttempts++
        Deferred.doneUnsafe(failed, Effect.void)
        return Effect.fail(new Error("diagnostic effect failure"))
      }
      const defecting = () => {
        defectAttempts++
        Deferred.doneUnsafe(defected, Effect.void)
        return Effect.die(new Error("diagnostic defect"))
      }

      const firstBody = oneChunkSse(
        sseRaw(
          `data: ${JSON.stringify(deltaChunk({ content: "Hello" }))}`,
          `data: ${JSON.stringify(finishChunk("stop"))}`,
        ),
      )
      const first = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(respondSse(firstBody)),
        Effect.provideService(CurrentSseDiagnosticSink, failing),
      )
      yield* Deferred.await(failed)
      yield* Effect.yieldNow
      expect(first.text).toBe("Hello")
      expect(failAttempts).toBe(1)
      expect(firstBody.locked).toBe(false)

      const secondBody = oneChunkSse(
        sseRaw(
          `data: ${JSON.stringify(deltaChunk({ content: "Bye" }))}`,
          `data: ${JSON.stringify(finishChunk("stop"))}`,
        ),
      )
      const second = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(respondSse(secondBody)),
        Effect.provideService(CurrentSseDiagnosticSink, defecting),
      )
      yield* Deferred.await(defected)
      yield* Effect.yieldNow
      expect(second.text).toBe("Bye")
      expect(defectAttempts).toBe(1)
      expect(secondBody.locked).toBe(false)
    }),
  )

  it.effect("does not delay transport teardown behind a held sink", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let attempts = 0
      const sink = (_summary: SseTransportSummary) =>
        Effect.gen(function* () {
          attempts++
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        })
      const body = oneChunkSse(
        sseRaw(
          `data: ${JSON.stringify(deltaChunk({ content: "Hello" }))}`,
          `data: ${JSON.stringify(finishChunk("stop"))}`,
        ),
      )
      const response = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(respondSse(body)),
        Effect.provideService(CurrentSseDiagnosticSink, sink),
      )

      yield* Deferred.await(entered)
      expect(response.text).toBe("Hello")
      expect(body.locked).toBe(false)
      expect(attempts).toBe(1)

      yield* Deferred.succeed(release, undefined)
      yield* Effect.yieldNow
      expect(attempts).toBe(1)
    }),
  )

  it.effect("bounds the header wait by a shorter whole-request timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(
        ai.request({ model, prompt: "Hello", timeout: { total: 1_000, headers: false } }),
      ).pipe(Effect.provide(silentServer), Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "request", code: "Timeout" })
    }),
  )

  it.effect("merges timeouts with later values winning", () =>
    Effect.sync(() => {
      const merged = mergeTransport(
        { timeout: { total: 5_000, headers: 1_000, chunk: 2_000 } },
        { headers: { a: "b" } },
        { timeout: { chunk: false } },
        { timeout: 3_000 },
      )

      expect(merged).toMatchObject({ headers: { a: "b" }, timeout: { total: 3_000, headers: 1_000, chunk: false } })
      expect(mergeTransport({}, undefined)).toEqual({})
    }),
  )

  it.effect("keeps adaptive controls and other HTTP options through transport merges", () =>
    Effect.sync(() => {
      const merged = mergeTransport(
        {
          headers: { a: "b" },
          http: {
            query: { q: "1" },
            body: { x: 1 },
            encoding: "gzip",
            tls: { cert: "c", key: "k" },
            splashAdaptiveSseTimeout: false,
            splashAdaptiveEndpoint: "http://127.0.0.1:3000/v1",
          },
        },
        { http: { splashAdaptiveSseTimeout: true } },
      )

      expect(merged).toMatchObject({
        headers: { a: "b" },
        http: {
          query: { q: "1" },
          body: { x: 1 },
          encoding: "gzip",
          tls: { cert: "c", key: "k" },
          splashAdaptiveSseTimeout: true,
          splashAdaptiveEndpoint: "http://127.0.0.1:3000/v1",
        },
      })
      expect(mergeTransport({ http: {} }, undefined)).toEqual({})
    }),
  )
})
