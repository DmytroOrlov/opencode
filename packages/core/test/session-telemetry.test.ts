import { expect, test } from "bun:test"
import { ai, LLMEvent, LanguageModel } from "@opencode/ai/effect"
import { Auth, RequestExecutor } from "@opencode/ai/route"
import { OpenAIChat } from "@opencode/ai/protocols"
import { attachMlxObserver } from "@opencode/ai/telemetry/mlx"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { AppNodeBuilder } from "../src/effect/app-node-builder.js"
import { requestExecutor } from "../src/effect/app-node-platform.js"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { createFallback, closeTelemetry } from "../src/session/runner/telemetry.js"
import { selectTelemetryAdapter } from "../src/session/runner/step.js"

test("estimates only active generated output and accepts usage corrections", () => {
  let time = 0
  const observations: unknown[] = []
  const fallback = createFallback({
    observe: (value) => observations.push(value),
    suppressed: () => false,
    now: () => time,
  })

  time = 1000
  fallback.push(LLMEvent.textStart({ id: "text" }))
  time = 2000
  fallback.push(LLMEvent.textDelta({ id: "text", text: "x".repeat(400) }))
  time = 3000
  fallback.push(LLMEvent.toolCall({ id: "tool", name: "shell", input: {} }))
  time = 8000
  fallback.push(LLMEvent.stepFinish({ index: 0, reason: { normalized: "tool-calls" }, usage: { outputTokens: 120 } }))
  const measured = observations.at(-1)

  expect(measured).toEqual({ phase: "decode", tokensPerSecond: 60 })
  fallback.finalize()
  expect(observations.at(-1)).toEqual(measured)
})

test("isolates estimator failures and respects native authority", () => {
  let time = 0
  let suppressed = false
  const observations: unknown[] = []
  const fallback = createFallback({
    observe: (value) => observations.push(value),
    suppressed: () => suppressed,
    now: () => time,
  })
  time = 1000
  fallback.push(LLMEvent.textStart({ id: "text" }))
  time = 2000
  fallback.push(LLMEvent.textDelta({ id: "text", text: "x".repeat(400) }))
  suppressed = true
  time = 3000
  fallback.push(LLMEvent.textDelta({ id: "text", text: "more" }))
  fallback.finalize()
  expect(observations).toEqual([{ phase: "decode", tokensPerSecond: 100 }])

  const broken = createFallback({
    observe: () => {
      throw new Error("event publisher unavailable")
    },
    suppressed: () => false,
    now: () => {
      throw new Error("clock unavailable")
    },
  })
  expect(() => broken.push(LLMEvent.textDelta({ id: "text", text: "x" }))).not.toThrow()
  expect(() => broken.finalize()).not.toThrow()
})

test("prefers MLX telemetry over Splash when both provider observers are opted in", () => {
  expect(selectTelemetryAdapter({ mlxTelemetry: true, splashTelemetry: true })).toBe("mlx")
  expect(selectTelemetryAdapter({ mlxTelemetry: false, splashTelemetry: true })).toBe("splash")
  expect(selectTelemetryAdapter({ mlxTelemetry: false, splashTelemetry: false })).toBeUndefined()
})

test("finalizes the newest pending MLX sample before aborting a successful attempt", async () => {
  const encoder = new TextEncoder()
  const controller = new AbortController()
  let feed: ReadableStreamDefaultController<Uint8Array> | undefined
  const observations: unknown[] = []
  let terminalRate: number | undefined
  const request = ai.request({
    model: LanguageModel.make({ id: "mlx-test", provider: "mlx", route: OpenAIChat.route }),
    prompt: "hello",
  })
  const fetch: typeof globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          feed = stream
          stream.enqueue(encoder.encode("event: stats\ndata: {}\n\n"))
        },
        cancel() {},
      })
      init?.signal?.addEventListener("abort", () => {
        try {
          feed?.error(new Error("feed aborted"))
        } catch {}
      })
      return new Response(body)
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const observer = await Effect.runPromise(
    attachMlxObserver({
      endpoint: "http://127.0.0.1:43132/v1",
      auth: Auth.none,
      request,
      signal: controller.signal,
      fetch,
      observe: (value) => {
        observations.push(value)
        if (value.phase === "decode") terminalRate = value.tokensPerSecond
      },
    }).pipe(Effect.provide(RequestExecutor.fetchLayer)),
  )
  feed?.enqueue(encoder.encode('data: {"req":"attempt-1","i":1,"committed":2,"ms":100}\n\n'))
  feed?.enqueue(encoder.encode('data: {"req":"attempt-1","i":2,"committed":8,"ms":100}\n\n'))
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  closeTelemetry({
    completed: true,
    finalize: () => observer?.finalize(),
    discard: () => observer?.discard(),
    abort: () => controller.abort(),
  })

  expect(observations.at(-1)).toEqual({ phase: "decode", tokensPerSecond: 50 })
  expect({
    phase: "complete",
    measurements:
      terminalRate === undefined
        ? []
        : [{ metric: "decode-rate", tokensPerSecond: terminalRate, source: "provider-native", approximate: false }],
  }).toMatchObject({
    phase: "complete",
    measurements: [{ metric: "decode-rate", tokensPerSecond: 50, source: "provider-native", approximate: false }],
  })
})

test("production executor preserves redirect policy while disabling Bun's request timeout", async () => {
  const seen: RequestInit[] = []
  const mock = HttpClient.make((request) =>
    Effect.gen(function* () {
      seen.push(
        Option.getOrElse(
          yield* Effect.serviceOption(FetchHttpClient.RequestInit),
          () => ({}),
        ),
      )
      return HttpClientResponse.fromWeb(request, new Response("ok"))
    }),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      yield* executor.execute(
        HttpClientRequest.get("https://example.invalid/events"),
      ).pipe(RequestExecutor.withoutRedirects)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(requestExecutor, [
          LayerNodePlatform.httpClient.replace(Layer.succeed(HttpClient.HttpClient, mock)),
        ]),
      ),
    ),
  )

  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ redirect: "error", timeout: false })
})
