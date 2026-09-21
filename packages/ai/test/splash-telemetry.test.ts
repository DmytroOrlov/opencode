import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent } from "../src/index.js"
import { OpenAI } from "../src/providers.js"
import { fixedResponse } from "./lib/http.js"
import { sseEvents } from "./lib/sse.js"
import { createSplashObserver } from "../src/telemetry/splash.js"

const chunk = (value: Record<string, unknown>) => ({
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: {}, finish_reason: null }],
  ...value,
})

const progress = (processed: number, overrides: Record<string, unknown> = {}) =>
  chunk({
    prompt_progress: { total: 10, cache: 2, processed, time_ms: processed, ...overrides },
  })

const terminal = (rate: unknown = 1500) =>
  chunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    timings: { predicted_per_second: rate },
  })

test("observes valid Splash prompt progress and withholds terminal rates until success", () => {
  const observations: unknown[] = []
  const observer = createSplashObserver({ observe: (value) => observations.push(value) })

  observer.observeFrame("openai-chat", progress(3))
  observer.observeFrame("openai-chat", progress(3))
  observer.observeFrame("openai-chat", progress(2))
  observer.observeFrame("other", progress(4))
  observer.observeFrame("openai-chat", terminal(42.5))

  expect(observations).toEqual([{ phase: "prefill", processed: 3, total: 10 }])
  observer.finalize()
  expect(observations).toEqual([
    { phase: "prefill", processed: 3, total: 10 },
    { phase: "decode", tokensPerSecond: 42.5 },
  ])
  observer.observeFrame("openai-chat", terminal(80))
  expect(observations).toHaveLength(2)
})

test("rejects ambiguous, malformed, and nonpositive terminal rates", () => {
  for (const rates of [[0], [-1], [Number.NaN], ["42"], [42, 80]] as const) {
    const observations: unknown[] = []
    const observer = createSplashObserver({ observe: (value) => observations.push(value) })
    rates.forEach((rate) => observer.observeFrame("openai-chat", terminal(rate)))
    observer.finalize()
    expect(observations).toEqual([])
  }
})

test("observer failures and discard never escape into inference", () => {
  const observer = createSplashObserver({
    observe: () => {
      throw new Error("observer unavailable")
    },
  })

  expect(() => observer.observeFrame("openai-chat", progress(3))).not.toThrow()
  expect(() => observer.observeFrame("openai-chat", terminal())).not.toThrow()
  expect(() => observer.finalize()).not.toThrow()

  const observations: unknown[] = []
  const discarded = createSplashObserver({ observe: (value) => observations.push(value) })
  discarded.observeFrame("openai-chat", terminal())
  discarded.discard()
  discarded.finalize()
  expect(observations).toEqual([])
})

test("the OpenAI Chat route exposes raw Splash frames without letting observer failures stop generation", async () => {
  const model = OpenAI.configure({ apiKey: "test", baseURL: "https://openai.test/v1" }).chat("gpt-4o-mini")
  const request = LLM.request({ model, prompt: "hello" })
  const observations: unknown[] = []
  const splash = createSplashObserver({ observe: (value) => observations.push(value) })
  const frames: unknown[] = []
  const events = await Effect.runPromise(
    LLM.stream(request, {
      observeFrame: (protocol, frame) => {
        frames.push(frame)
        splash.observeFrame(protocol, frame)
        throw new Error("observer failure")
      },
    }).pipe(
      Stream.runCollect,
      Effect.provide(
        fixedResponse(
          sseEvents(
            {
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
              prompt_progress: { total: 10, cache: 2, processed: 5, time_ms: 1 },
            },
            {
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              timings: { predicted_per_second: 42.5 },
            },
          ),
        ),
      ),
    ),
  )

  splash.finalize()
  expect(
    frames.filter(
      (frame): frame is Record<string, unknown> =>
        typeof frame === "object" && frame !== null && "object" in frame && frame.object === "chat.completion.chunk",
    ),
  ).toHaveLength(2)
  expect(observations).toEqual([
    { phase: "prefill", processed: 5, total: 10 },
    { phase: "decode", tokensPerSecond: 42.5 },
  ])
  expect(Array.from(events).some(LLMEvent.is.finish)).toBe(true)
})
