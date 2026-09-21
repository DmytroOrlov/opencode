import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpOptions, LLM, mergeHttpOptions } from "../src/index.js"
import { LLMClient } from "../src/route.js"
import { adaptiveTimeout, sameLoopbackOrigin } from "../src/route/transport/http.js"
import { configure } from "../src/providers/openai.js"
import { dynamicResponse } from "./lib/http.js"
import { deltaChunk, finishChunk } from "./lib/openai-chunks.js"
import { sseEvents, sseRaw } from "./lib/sse.js"
import { it } from "./lib/effect.js"

const model = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4.1-mini")
const SSE = { headers: { "content-type": "text/event-stream" } }

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

  it.effect("allows a healthy generation to exceed the default idle timeout when each read is timely", () =>
    Effect.gen(function* () {
      const server = yield* longHealthyServer
      const fiber = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(server.layer),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.first)
      yield* TestClock.adjust("2 minutes")
      server.releaseFirst()
      yield* Deferred.await(server.second)
      yield* TestClock.adjust("2 minutes")
      server.releaseSecond()
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hello")
    }),
  )

  it.effect("fails when response headers take longer than five minutes", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
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

  it.effect("fails when the response body stalls for five minutes", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(server.layer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("5 minutes")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", transport: "http", operation: "read", code: "Timeout" })
      expect(error.reason.http).toMatchObject({ status: 200 })
    }),
  )

  it.effect("applies a configured header timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Hello", http: { headerTimeout: 1_000 } }),
      ).pipe(Effect.provide(silentServer), Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "request", code: "Timeout" })
    }),
  )

  it.effect("disables the header timeout with false", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Hello", http: { headerTimeout: false } }),
      ).pipe(Effect.provide(slowHeadersServer), Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("10 minutes")
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("disables the chunk timeout with false", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Hello", http: { chunkTimeout: false } }),
      ).pipe(Effect.provide(server.layer), Effect.forkChild({ startImmediately: true }))
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
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Hello", http: { timeout: 60_000, chunkTimeout: false } }),
      ).pipe(Effect.provide(server.layer), Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 minute")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "read", code: "Timeout" })
    }),
  )

  it.effect("bounds the header wait by a shorter whole-request timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Hello", http: { timeout: 1_000, headerTimeout: false } }),
      ).pipe(Effect.provide(silentServer), Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "request", code: "Timeout" })
    }),
  )

  it.effect("merges timeouts with later values winning", () =>
    Effect.sync(() => {
      const merged = mergeHttpOptions(
        new HttpOptions({ timeout: 5_000, headerTimeout: 1_000, chunkTimeout: 2_000 }),
        new HttpOptions({ headers: { a: "b" } }),
        new HttpOptions({ chunkTimeout: false }),
      )

      expect(merged).toMatchObject({ headers: { a: "b" }, timeout: 5_000, headerTimeout: 1_000, chunkTimeout: false })
      expect(mergeHttpOptions(new HttpOptions({}), undefined)).toBeUndefined()
    }),
  )
})
