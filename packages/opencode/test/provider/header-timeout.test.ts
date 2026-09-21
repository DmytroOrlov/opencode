import { afterEach, expect } from "bun:test"
import { createServer, type Server } from "node:http"
import { streamText } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Logger, References } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

it.live("headerTimeout does not abort delayed SSE body after headers arrive", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(1_000)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("late")
        }),
      { config: providerConfig(server.url, { headerTimeout: 500 }) },
    )
  }),
)

for (const timeout of ["chunkTimeout", "headerTimeout"] as const) {
  it.live(`default ${timeout} is applied at fetch without changing provider options`, () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => delayedBodyServer(250)),
        (server) => Effect.sync(() => server.server.close()),
      )

      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
            const signals: (AbortSignal | null | undefined)[] = []
            configured.options.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
              signals.push(init?.signal)
              return fetch(input, init)
            }
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const language = yield* provider.getLanguage(model)
            yield* Effect.acquireRelease(
              Effect.promise(() =>
                language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
              ),
              (result) => Effect.promise(() => result.stream.cancel()),
            )

            expect(signals).toHaveLength(1)
            expect(signals[0]).toBeInstanceOf(AbortSignal)
            expect(configured.options[timeout]).toBeUndefined()
          }),
        {
          config: providerConfig(server.url, {
            [timeout === "chunkTimeout" ? "headerTimeout" : "chunkTimeout"]: false,
          }),
        },
      )
    }),
  )
}

it.live("configured chunkTimeout raises a retryable response stream error when SSE body stalls", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    const summaries: Record<string, unknown>[] = []
    yield* captureTransportSummaries(
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const result = streamText({
              model: yield* provider.getLanguage(model),
              onError() {},
              messages: [{ role: "user", content: "hello" }],
            })

            const error = yield* Effect.promise(async () => {
              try {
                for await (const part of result.fullStream) {
                  if (part.type === "error") return part.error
                }
              } catch (error) {
                return error
              }
            })
            expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
            expect(
              SessionRetry.retryable(MessageV2.fromError(error, { providerID: model.providerID }), model.providerID),
            ).toEqual({ message: "SSE read timed out" })
          }),
        { config: providerConfig(server.url, { chunkTimeout: 50, splashAdaptiveSseTimeout: true }) },
      ),
      summaries,
    )
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      configuredChunkTimeout: 50,
      terminalOutcome: "timeout",
      splashAdaptiveSseTimeoutEligible: false,
      adaptiveSampleCount: 0,
      adaptiveTimingUsed: false,
    })
    expect(summaries[0]).not.toHaveProperty("adaptiveThresholdMs")
    expect(summaries[0]).not.toHaveProperty("adaptiveBasisWaitMs")
    expect(summaries[0].timeoutReadWaitMs).toEqual(expect.any(Number))
  }),
)

it.live("timed SSE completion emits one transport summary with read wait measurements", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(20, 2)),
      (server) => Effect.sync(() => server.server.close()),
    )
    const summaries: Record<string, unknown>[] = []

    yield* captureTransportSummaries(
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const result = streamText({
              model: yield* provider.getLanguage(model),
              messages: [{ role: "user", content: "hello" }],
            })

            expect(yield* Effect.promise(() => result.text)).toBe("chunk-1chunk-2")
          }),
        { config: providerConfig(server.url, { chunkTimeout: 500 }) },
      ),
      summaries,
    )

    expect(summaries).toHaveLength(1)
    const summary = summaries[0]
    expect(summary).toMatchObject({
      requestHost: new URL(server.url).host,
      configuredChunkTimeout: 500,
      terminalOutcome: "completed",
    })
    for (const field of [
      "responseHeaderWaitMs",
      "firstReadWaitMs",
      "maxSuccessfulReadWaitMs",
      "sseStreamDurationMs",
    ]) {
      expect(summary[field]).toEqual(expect.any(Number))
      expect(summary[field] as number).toBeGreaterThanOrEqual(0)
    }
    expect(summary.successfulReadCount).toBeGreaterThan(1)
    expect(summary.chunkCount).toBeGreaterThan(0)
    expect(summary.chunkCount).toBeLessThan(summary.successfulReadCount as number)
    expect(summary).not.toHaveProperty("timeoutReadWaitMs")
  }),
)

it.live("chunkTimeout continues to allow SSE streams whose individual reads stay within the boundary", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(70, 3)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("chunk-1chunk-2chunk-3")
        }),
      { config: providerConfig(server.url, { chunkTimeout: 500 }) },
    )
  }),
)

it.live("chunkTimeout false returns the original response without a body proxy", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(10)),
      (server) => Effect.sync(() => server.server.close()),
    )
    const NativeResponse = globalThis.Response
    let responseConstructions = 0
    globalThis.Response = class extends NativeResponse {
      static override [Symbol.hasInstance](value: unknown) {
        return value instanceof NativeResponse
      }

      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init)
        responseConstructions += 1
      }
    }

    try {
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const result = streamText({
              model: yield* provider.getLanguage(model),
              messages: [{ role: "user", content: "hello" }],
            })
            responseConstructions = 0

            expect(yield* Effect.promise(() => result.text)).toBe("late")
          }),
        { config: providerConfig(server.url, { chunkTimeout: false, splashAdaptiveSseTimeout: true }) },
      )
      expect(responseConstructions).toBe(0)
    } finally {
      globalThis.Response = NativeResponse
    }
  }),
)

it.live("chunkTimeout can be disabled with false", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
          expect(configured.options.chunkTimeout).toBe(false)
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("late")
        }),
      { config: providerConfig(server.url, { chunkTimeout: false }) },
    )
  }),
)

it.live("Splash adaptive timeout eligibility requires explicit opt-in and an HTTP(S) loopback endpoint", () =>
  Effect.gen(function* () {
    const cases = [
      { name: "default disabled", url: "http://127.0.0.1/v1", options: {}, eligible: false },
      {
        name: "explicit false remains disabled",
        url: "http://127.0.0.1/v1",
        options: { splashAdaptiveSseTimeout: false },
        eligible: false,
      },
      {
        name: "localhost opt-in",
        url: "http://localhost/v1",
        options: { splashAdaptiveSseTimeout: true },
        eligible: true,
      },
      {
        name: "IPv4 127/8 opt-in",
        url: "http://127.24.8.1/v1",
        options: { splashAdaptiveSseTimeout: true },
        eligible: true,
      },
      {
        name: "IPv6 loopback opt-in",
        url: "https://[::1]/v1",
        options: { splashAdaptiveSseTimeout: true },
        eligible: true,
      },
      {
        name: "remote opt-in",
        url: "https://api.example.com/v1",
        options: { splashAdaptiveSseTimeout: true },
        eligible: false,
      },
      {
        name: "private non-loopback opt-in",
        url: "http://192.168.1.20/v1",
        options: { splashAdaptiveSseTimeout: true },
        eligible: false,
      },
    ] as const

    for (const scenario of cases) {
      const summaries: Record<string, unknown>[] = []
      yield* captureTransportSummaries(
        provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const provider = yield* Provider.Service
              const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
              configured.options.fetch = () => Promise.resolve(sseResponse())
              const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
              const result = streamText({
                model: yield* provider.getLanguage(model),
                messages: [{ role: "user", content: scenario.name }],
              })
              expect(yield* Effect.promise(() => result.text)).toBe("ok")
            }),
          { config: providerConfig(scenario.url, scenario.options) },
        ),
        summaries,
      )

      expect(summaries).toHaveLength(1)
      expect(summaries[0].splashAdaptiveSseTimeoutEligible).toBe(scenario.eligible)
    }
  }),
)

it.live("Splash adaptive timeout stays out of SDK requests and separates cached SDKs", () =>
  Effect.gen(function* () {
    const summaries: Record<string, unknown>[] = []
    const requests: { url: string; headers: string; body: string }[] = []
    yield* captureTransportSummaries(
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
            configured.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
              const request = new Request(input, init)
              requests.push({ url: request.url, headers: [...request.headers].join("\n"), body: await request.text() })
              return sseResponse()
            }

            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const run = Effect.fn("test.splashAdaptiveSdkRequest")(function* (model) {
              const result = streamText({
                model: yield* provider.getLanguage(model),
                messages: [{ role: "user", content: "hello" }],
              })
              expect(yield* Effect.promise(() => result.text)).toBe("ok")
            })

            yield* run(model)
            configured.options.splashAdaptiveSseTimeout = false
            yield* run({ ...model, id: ModelV2.ID.make("test-model-disabled") })
          }),
        {
          config: providerConfig("http://127.0.0.1/v1", { splashAdaptiveSseTimeout: true }),
        },
      ),
      summaries,
    )

    expect(summaries.map((summary) => summary.splashAdaptiveSseTimeoutEligible)).toEqual([true, false])
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests)).not.toContain("splashAdaptiveSseTimeout")
  }),
)

it.live("Splash adaptive calibration counts only qualifying waits before five samples", () =>
  Effect.gen(function* () {
    const { summaries, deadlines } = yield* controlledSseRun({ splashAdaptiveSseTimeout: true }, (harness) =>
      Effect.gen(function* () {
        const { result, drive } = yield* startControlledGeneration(harness)
        const driving = drive([
          { waitMs: 150, content: "a" },
          { waitMs: 99, content: "b" },
          { waitMs: 1_000, empty: true },
          { waitMs: 100, content: "c" },
          { waitMs: 150, content: "d" },
          { waitMs: 150, content: "e" },
        ])
        expect(yield* Effect.promise(() => result.text)).toBe("abcde")
        yield* Effect.promise(() => driving)
      }),
    )

    expect(deadlines).toEqual([300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      terminalOutcome: "completed",
      splashAdaptiveSseTimeoutEligible: true,
      adaptiveSampleCount: 4,
      adaptiveTimingUsed: false,
      chunkCount: 6,
      successfulReadCount: 7,
    })
    expect(summaries[0]).not.toHaveProperty("adaptiveThresholdMs")
  }),
)

it.live("Splash adaptive threshold excludes the longest sample and scales the rest by ten", () =>
  Effect.gen(function* () {
    const { summaries, deadlines } = yield* controlledSseRun({ splashAdaptiveSseTimeout: true }, (harness) =>
      Effect.gen(function* () {
        const { result, drive } = yield* startControlledGeneration(harness)
        const driving = drive([
          { waitMs: 4_200, content: "a" },
          { waitMs: 4_200, content: "b" },
          { waitMs: 4_200, content: "c" },
          { waitMs: 4_200, content: "d" },
          { waitMs: 9_900, content: "e" },
        ])
        expect(yield* Effect.promise(() => result.text)).toBe("abcde")
        yield* Effect.promise(() => driving)
      }),
    )

    expect(deadlines).toEqual([300_000, 300_000, 300_000, 300_000, 300_000, 42_000])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      terminalOutcome: "completed",
      adaptiveSampleCount: 5,
      adaptiveTimingUsed: true,
      adaptiveThresholdMs: 42_000,
      adaptiveBasisWaitMs: 4_200,
    })
  }),
)

it.live("Splash adaptive threshold clamps to thirty seconds and the provider timeout ceiling", () =>
  Effect.gen(function* () {
    const { summaries, deadlines } = yield* controlledSseRun(
      { splashAdaptiveSseTimeout: true },
      (harness) =>
        Effect.gen(function* () {
          const floor = yield* startControlledGeneration(harness)
          const floorDrive = floor.drive([
            { waitMs: 150, content: "a" },
            { waitMs: 150, content: "b" },
            { waitMs: 150, content: "c" },
            { waitMs: 150, content: "d" },
            { waitMs: 150, content: "e" },
          ])
          expect(yield* Effect.promise(() => floor.result.text)).toBe("abcde")
          yield* Effect.promise(() => floorDrive)

          const ceiling = yield* startControlledGeneration(harness, { stream: 1 })
          const ceilingDrive = ceiling.drive([
            { waitMs: 150, content: "f" },
            { waitMs: 150, content: "g" },
            { waitMs: 150, content: "h" },
            { waitMs: 30_001, content: "i" },
            { waitMs: 30_001, content: "j" },
          ])
          expect(yield* Effect.promise(() => ceiling.result.text)).toBe("fghij")
          yield* Effect.promise(() => ceilingDrive)
        }),
      { streams: 2 },
    )

    expect(deadlines).toEqual([
      300_000,
      300_000,
      300_000,
      300_000,
      300_000,
      30_000,
      300_000,
      300_000,
      300_000,
      300_000,
      300_000,
      300_000,
    ])
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({
      terminalOutcome: "completed",
      adaptiveSampleCount: 5,
      adaptiveTimingUsed: true,
      adaptiveThresholdMs: 30_000,
    })
    expect(summaries[1]).toMatchObject({
      terminalOutcome: "completed",
      adaptiveSampleCount: 5,
      adaptiveTimingUsed: true,
      adaptiveThresholdMs: 300_000,
    })
  }),
)

it.live("Splash adaptive calibration rolls over the oldest sample and recalibrates later reads", () =>
  Effect.gen(function* () {
    const { summaries, deadlines } = yield* controlledSseRun({ splashAdaptiveSseTimeout: true }, (harness) =>
      Effect.gen(function* () {
        const { result, drive } = yield* startControlledGeneration(harness)
        const driving = drive([
          { waitMs: 4_000, content: "a" },
          { waitMs: 4_000, content: "b" },
          { waitMs: 4_000, content: "c" },
          { waitMs: 4_000, content: "d" },
          { waitMs: 5_000, content: "e" },
          { waitMs: 10_000, content: "f" },
          { waitMs: 10_000, content: "g" },
        ])
        expect(yield* Effect.promise(() => result.text)).toBe("abcdefg")
        yield* Effect.promise(() => driving)
      }),
    )

    expect(deadlines).toEqual([300_000, 300_000, 300_000, 300_000, 300_000, 40_000, 50_000, 100_000])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      terminalOutcome: "completed",
      adaptiveSampleCount: 5,
      adaptiveTimingUsed: true,
      adaptiveThresholdMs: 100_000,
      adaptiveBasisWaitMs: 10_000,
      chunkCount: 7,
    })
  }),
)

it.live("Splash adaptive calibration stays disabled without explicit opt-in", () =>
  Effect.gen(function* () {
    const { summaries, deadlines } = yield* controlledSseRun({}, (harness) =>
      Effect.gen(function* () {
        const { result, drive } = yield* startControlledGeneration(harness)
        const driving = drive([
          { waitMs: 4_200, content: "a" },
          { waitMs: 4_200, content: "b" },
          { waitMs: 4_200, content: "c" },
          { waitMs: 4_200, content: "d" },
          { waitMs: 4_200, content: "e" },
        ])
        expect(yield* Effect.promise(() => result.text)).toBe("abcde")
        yield* Effect.promise(() => driving)
      }),
    )

    expect(deadlines).toEqual([300_000, 300_000, 300_000, 300_000, 300_000, 300_000])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      terminalOutcome: "completed",
      splashAdaptiveSseTimeoutEligible: false,
      adaptiveSampleCount: 0,
      adaptiveTimingUsed: false,
    })
    expect(summaries[0]).not.toHaveProperty("adaptiveThresholdMs")
    expect(summaries[0]).not.toHaveProperty("adaptiveBasisWaitMs")
  }),
)

it.live("a stalled calibrated read keeps its selected deadline and the next request starts fresh", () =>
  Effect.gen(function* () {
    const { summaries, deadlines } = yield* controlledSseRun(
      { splashAdaptiveSseTimeout: true },
      (harness) =>
        Effect.gen(function* () {
          const controller = new AbortController()
          const stalled = yield* startControlledGeneration(harness, {
            abortSignal: controller.signal,
            swallowErrors: true,
          })
          const stalling = stalled.drive(
            [
              { waitMs: 4_000 },
              { waitMs: 4_000 },
              { waitMs: 4_000 },
              { waitMs: 4_000 },
              { waitMs: 5_000 },
            ],
            { close: false },
          )
          yield* Effect.promise(() => stalling)
          expect(harness.deadlines).toEqual([300_000, 300_000, 300_000, 300_000, 300_000, 40_000])

          controller.abort()
          yield* pollWithTimeout(
            Effect.sync(() => (harness.summaries.length === 1 ? true : undefined)),
            "transport summary was never emitted for the aborted request",
          )

          const retry = yield* startControlledGeneration(harness, { stream: 1 })
          const retryDrive = retry.drive([
            { waitMs: 150, content: "r" },
            { waitMs: 150, content: "s" },
          ])
          expect(yield* Effect.promise(() => retry.result.text)).toBe("rs")
          yield* Effect.promise(() => retryDrive)
        }),
      { streams: 2 },
    )

    expect(deadlines).toEqual([300_000, 300_000, 300_000, 300_000, 300_000, 40_000, 300_000, 300_000, 300_000])
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({
      terminalOutcome: "abort",
      adaptiveSampleCount: 5,
      adaptiveTimingUsed: true,
      adaptiveThresholdMs: 40_000,
      adaptiveBasisWaitMs: 4_000,
    })
    expect(summaries[1]).toMatchObject({
      terminalOutcome: "completed",
      splashAdaptiveSseTimeoutEligible: true,
      adaptiveSampleCount: 2,
      adaptiveTimingUsed: false,
    })
    expect(summaries[1]).not.toHaveProperty("adaptiveThresholdMs")
  }),
)

it.live("an expired calibrated deadline cancels the reader and preserves retryable timeout classification", () =>
  Effect.gen(function* () {
    const { summaries, deadlines } = yield* controlledSseRun({ splashAdaptiveSseTimeout: true }, (harness) =>
      Effect.gen(function* () {
        const stalled = yield* startControlledGeneration(harness, { swallowErrors: true })
        const readError = firstStreamError(stalled.result.fullStream)
        const driving = stalled.drive(
          [
            { waitMs: 4_000 },
            { waitMs: 4_000 },
            { waitMs: 4_000 },
            { waitMs: 4_000 },
            { waitMs: 5_000 },
          ],
          { close: false },
        )
        yield* Effect.promise(() => driving)
        expect(harness.deadlines).toEqual([300_000, 300_000, 300_000, 300_000, 300_000, 40_000])

        harness.advance(40_000)
        harness.fireDeadline(5)
        const error = yield* Effect.promise(() => readError)
        expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
        expect((error as Error).message).toBe("SSE read timed out")
        expect(
          SessionRetry.retryable(
            MessageV2.fromError(error, { providerID: stalled.model.providerID }),
            stalled.model.providerID,
          ),
        ).toEqual({ message: "SSE read timed out" })
        yield* pollWithTimeout(
          Effect.sync(() => (harness.stream().isCancelled() ? true : undefined)),
          "timed-out SSE reader was not cancelled",
        )
        yield* pollWithTimeout(
          Effect.sync(() => (harness.summaries.length === 1 ? true : undefined)),
          "transport timeout summary was never emitted",
        )
        expect(harness.summaries[0]).toMatchObject({
          terminalOutcome: "timeout",
          timeoutReadWaitMs: 40_000,
          adaptiveSampleCount: 5,
          adaptiveTimingUsed: true,
          adaptiveThresholdMs: 40_000,
          adaptiveBasisWaitMs: 4_000,
        })
      }),
    )

    expect(deadlines).toEqual([300_000, 300_000, 300_000, 300_000, 300_000, 40_000])
    expect(summaries).toHaveLength(1)
  }),
)

it.live("a long healthy generation exceeds the maximum idle timeout without a total generation timeout", () =>
  Effect.gen(function* () {
    const { summaries, deadlines } = yield* controlledSseRun({ splashAdaptiveSseTimeout: true }, (harness) =>
      Effect.gen(function* () {
        const { result, drive } = yield* startControlledGeneration(harness)
        const progress = Array.from({ length: 18 }, (_, index) => ({
          waitMs: index < 5 ? 3_100 : 30_000,
          content: String.fromCharCode(97 + index),
        }))
        const driving = drive(
          progress,
        )
        yield* Effect.promise(() => driving)
        expect(yield* Effect.promise(() => result.text)).toBe("abcdefghijklmnopqr")
      }),
    )

    expect(deadlines).toEqual([
      300_000,
      300_000,
      300_000,
      300_000,
      300_000,
      31_000,
      31_000,
      ...Array.from({ length: 12 }, () => 300_000),
    ])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      terminalOutcome: "completed",
      adaptiveSampleCount: 5,
      adaptiveTimingUsed: true,
      chunkCount: 18,
    })
    expect(summaries[0].sseStreamDurationMs as number).toBeGreaterThan(300_000)
    expect(Object.values(summaries[0]).some((value) => Array.isArray(value))).toBe(false)
  }),
)

it.live("the controlled SSE harness restores globals and clears only its pending timers", () => {
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const originalPerformancePrototype = Object.getPrototypeOf(performance)
    const originalNowDescriptor = Object.getOwnPropertyDescriptor(performance, "now")
    const originalNow = performance.now
    const outerCleanups: Array<{
      setTimeout: boolean
      clearTimeout: boolean
      performancePrototype: boolean
      performanceNow: PropertyDescriptor | undefined
    }> = []
    const restorations: Array<{
      setTimeout: boolean
      clearTimeout: boolean
      performanceNow: PropertyDescriptor | undefined
    }> = []
    let pending: ReturnType<typeof setTimeout> | undefined
    let unrelated: ReturnType<typeof setTimeout> | undefined
    let outerPending: ReturnType<typeof setTimeout> | undefined
    let pendingFired = false
    let unrelatedFired = false
    let outerPendingFired = false
    const restoreGlobals = Effect.sync(() => {
      for (const timer of [pending, unrelated, outerPending]) {
        if (timer) Reflect.apply(originalClearTimeout, globalThis, [timer])
      }
      Object.setPrototypeOf(performance, originalPerformancePrototype)
      if (originalNowDescriptor) Object.defineProperty(performance, "now", originalNowDescriptor)
      else Reflect.deleteProperty(performance, "now")
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      outerCleanups.push({
        setTimeout: globalThis.setTimeout === originalSetTimeout,
        clearTimeout: globalThis.clearTimeout === originalClearTimeout,
        performancePrototype: Object.getPrototypeOf(performance) === originalPerformancePrototype,
        performanceNow: Object.getOwnPropertyDescriptor(performance, "now"),
      })
    })
    const onRestore = (snapshot: {
      setTimeout: typeof globalThis.setTimeout
      clearTimeout: typeof globalThis.clearTimeout
    }) =>
      restorations.push({
        setTimeout: globalThis.setTimeout === snapshot.setTimeout,
        clearTimeout: globalThis.clearTimeout === snapshot.clearTimeout,
        performanceNow: Object.getOwnPropertyDescriptor(performance, "now"),
      })

    return Effect.ensuring(
      Effect.gen(function* () {
        yield* controlledSseRun({}, () => Effect.void, { onRestore })
        expect(restorations[0]).toEqual({
          setTimeout: true,
          clearTimeout: true,
          performanceNow: originalNowDescriptor,
        })

        const inheritedPrototype = Object.create(originalPerformancePrototype)
        Object.defineProperty(
          inheritedPrototype,
          "now",
          originalNowDescriptor ?? {
            value: originalNow,
            writable: true,
            enumerable: true,
            configurable: true,
          },
        )
        Object.setPrototypeOf(performance, inheritedPrototype)
        if (originalNowDescriptor) expect(Reflect.deleteProperty(performance, "now")).toBe(true)
        expect(Object.getOwnPropertyDescriptor(performance, "now")).toBeUndefined()
        expect(performance.now).toBe(originalNow)

        yield* controlledSseRun({}, () => Effect.void, { onRestore })
        expect(restorations[1]).toEqual({ setTimeout: true, clearTimeout: true, performanceNow: undefined })
        expect(performance.now).toBe(originalNow)

        unrelated = Reflect.apply(originalSetTimeout, globalThis, [() => (unrelatedFired = true), 300_000]) as ReturnType<
          typeof setTimeout
        >
        const failure = new Error("controlled run failure")
        const failed = yield* Effect.result(
          controlledSseRun(
            {},
            () =>
              Effect.gen(function* () {
                pending = setTimeout(() => (pendingFired = true), 300_000)
                return yield* Effect.fail(failure)
              }),
            { onRestore },
          ),
        )

        expect(failed).toMatchObject({ _tag: "Failure", failure })
        expect(restorations[2]).toEqual({ setTimeout: true, clearTimeout: true, performanceNow: undefined })
        expect(performance.now).toBe(originalNow)
        expect(pending).toBeDefined()
        expect((pending as unknown as { hasRef: () => boolean }).hasRef()).toBe(false)
        expect(pendingFired).toBe(false)
        expect((unrelated as unknown as { hasRef: () => boolean }).hasRef()).toBe(true)
        expect(unrelatedFired).toBe(false)

        const failurePrototype = Object.create(originalPerformancePrototype)
        Object.defineProperty(
          failurePrototype,
          "now",
          originalNowDescriptor ?? {
            value: originalNow,
            writable: true,
            enumerable: true,
            configurable: true,
          },
        )
        const outerFailure = new Error("outer cleanup failure")
        const failedOuterEffect = yield* Effect.result(
          Effect.ensuring(
            Effect.gen(function* () {
              Object.setPrototypeOf(performance, failurePrototype)
              if (Object.getOwnPropertyDescriptor(performance, "now")) Reflect.deleteProperty(performance, "now")
              outerPending = setTimeout(() => (outerPendingFired = true), 300_000)
              return yield* Effect.fail(outerFailure)
            }),
            restoreGlobals,
          ),
        )

        expect(failedOuterEffect).toMatchObject({ _tag: "Failure", failure: outerFailure })
        expect(outerCleanups.at(-1)).toEqual({
          setTimeout: true,
          clearTimeout: true,
          performancePrototype: true,
          performanceNow: originalNowDescriptor,
        })
        expect(outerPending).toBeDefined()
        expect((outerPending as unknown as { hasRef: () => boolean }).hasRef()).toBe(false)
        expect(outerPendingFired).toBe(false)

        const interruptPrototype = Object.create(originalPerformancePrototype)
        Object.defineProperty(
          interruptPrototype,
          "now",
          originalNowDescriptor ?? {
            value: originalNow,
            writable: true,
            enumerable: true,
            configurable: true,
          },
        )
        const interruptedOuterEffect = yield* Effect.exit(
          Effect.ensuring(
            Effect.gen(function* () {
              Object.setPrototypeOf(performance, interruptPrototype)
              if (Object.getOwnPropertyDescriptor(performance, "now")) Reflect.deleteProperty(performance, "now")
              outerPending = setTimeout(() => (outerPendingFired = true), 300_000)
              return yield* Effect.interrupt
            }),
            restoreGlobals,
          ),
        )

        expect(interruptedOuterEffect._tag).toBe("Failure")
        expect(outerCleanups.at(-1)).toEqual({
          setTimeout: true,
          clearTimeout: true,
          performancePrototype: true,
          performanceNow: originalNowDescriptor,
        })
        expect(outerPending).toBeDefined()
        expect((outerPending as unknown as { hasRef: () => boolean }).hasRef()).toBe(false)
        expect(outerPendingFired).toBe(false)
      }),
      restoreGlobals,
    )
  })

it.live("the controlled SSE harness restores globals when synchronous setup fails", () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalNowDescriptor = Object.getOwnPropertyDescriptor(performance, "now")
  const originalNow = performance.now
  const setupFailure = new Error("controlled setup failure")

  return Effect.ensuring(
    Effect.gen(function* () {
      const failed = yield* Effect.exit(
        controlledSseRun({}, () => Effect.void, {
          afterInstrumentation() {
            throw setupFailure
          },
        }),
      )

      expect(failed._tag).toBe("Failure")
      expect(globalThis.setTimeout).toBe(originalSetTimeout)
      expect(globalThis.clearTimeout).toBe(originalClearTimeout)
      expect(Object.getOwnPropertyDescriptor(performance, "now")).toEqual(originalNowDescriptor)
      expect(performance.now).toBe(originalNow)
    }),
    Effect.sync(() => {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      if (originalNowDescriptor) Object.defineProperty(performance, "now", originalNowDescriptor)
      else Reflect.deleteProperty(performance, "now")
    }),
  )
})

it.live("an explicit request timeout still aborts an opted-in Splash request", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )
    const signals: (AbortSignal | null | undefined)[] = []

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
          configured.options.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
            signals.push(init?.signal)
            return fetch(input, init)
          }
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => firstStreamError(result.fullStream))).toBeDefined()
          expect(signals).toHaveLength(1)
          expect(signals[0]).toBeInstanceOf(AbortSignal)
          expect(signals[0]!.aborted).toBe(true)
          expect(String(signals[0]!.reason)).toMatch(/TimeoutError|timeout/i)
        }),
      { config: providerConfig(server.url, { splashAdaptiveSseTimeout: true, timeout: 100 }) },
    )
  }),
)

it.live("an explicit request abort is attributed as abort", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => pendingBodyServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    const summaries: Record<string, unknown>[] = []
    yield* captureTransportSummaries(
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const controller = new AbortController()
            const result = streamText({
              model: yield* provider.getLanguage(model),
              abortSignal: controller.signal,
              onError() {},
              messages: [{ role: "user", content: "hello" }],
            })
            const iterator = result.fullStream[Symbol.asyncIterator]()

            yield* Effect.promise(() => server.opened)
            let part = yield* Effect.promise(() => iterator.next())
            while (!part.done && part.value.type !== "text-delta") {
              part = yield* Effect.promise(() => iterator.next())
            }
            expect(part.done).toBe(false)
            const pendingRead = iterator.next()
            controller.abort()
            yield* Effect.promise(() => pendingRead.then(() => undefined, () => undefined))
          }),
        { config: providerConfig(server.url, { chunkTimeout: 1_000 }) },
      ),
      summaries,
    )
    expect(summaries).toHaveLength(1)
    expect(summaries).toMatchObject([{ terminalOutcome: "abort" }])
  }),
)

it.live("consumer cancellation is attributed separately from request abort", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => pendingBodyServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    const summaries: Record<string, unknown>[] = []
    yield* captureTransportSummaries(
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const language = yield* provider.getLanguage(model)
            const { stream } = yield* Effect.promise(() =>
              language.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
              }),
            )
            const reader = stream.getReader()

            yield* Effect.promise(() => server.opened)
            let part = yield* Effect.promise(() => reader.read())
            while (!part.done && part.value.type !== "text-delta") {
              part = yield* Effect.promise(() => reader.read())
            }
            expect(part.done).toBe(false)
            yield* Effect.promise(() => reader.cancel())
          }),
        { config: providerConfig(server.url, { chunkTimeout: 1_000 }) },
      ),
      summaries,
    )
    expect(summaries).toHaveLength(1)
    expect(summaries).toMatchObject([{ terminalOutcome: "consumer_cancel" }])
  }),
)

it.live("timed SSE read failures are attributed as other_error", () =>
  Effect.gen(function* () {
    const summaries: Record<string, unknown>[] = []
    yield* captureTransportSummaries(
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
            configured.options.fetch = async () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.error(new Error("synthetic read failure"))
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              )
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const result = streamText({
              model: yield* provider.getLanguage(model),
              onError() {},
              messages: [{ role: "user", content: "hello" }],
            })

            expect(yield* Effect.promise(() => firstStreamError(result.fullStream))).toBeDefined()
          }),
        { config: providerConfig("http://127.0.0.1", { chunkTimeout: 1_000 }) },
      ),
      summaries,
    )
    expect(summaries).toHaveLength(1)
    expect(summaries).toMatchObject([{ terminalOutcome: "other_error", configuredChunkTimeout: 1_000 }])
  }),
)

it.live("summary logger failure does not fail a healthy timed SSE generation", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(10)),
      (server) => Effect.sync(() => server.server.close()),
    )
    let failures = 0

    const summaries: Record<string, unknown>[] = []
    yield* captureTransportSummaries(
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const result = streamText({
              model: yield* provider.getLanguage(model),
              messages: [{ role: "user", content: "hello" }],
            })

            expect(yield* Effect.promise(() => result.text)).toBe("late")
          }),
        { config: providerConfig(server.url, { chunkTimeout: 500 }) },
      ),
      summaries,
      () => {
        failures += 1
        throw new Error("synthetic logger failure")
      },
    )
    expect(failures).toBe(1)
    expect(summaries).toHaveLength(1)
  }),
)

it.live("headerTimeout aborts when response headers do not arrive", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const errors = yield* Effect.promise(async () => {
            const errors: string[] = []
            for await (const part of result.fullStream) {
              if (part.type === "error") errors.push(String(part.error))
            }
            return errors
          })
          expect(errors.join("\n")).toContain("response headers timed out")
        }),
      { config: providerConfig(server.url, { headerTimeout: 50 }) },
    )
  }),
)

it.live("headerTimeout can be disabled with false for non-OpenAI providers", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(100)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("ok")
        }),
      { config: providerConfig(server.url, { headerTimeout: false }) },
    )
  }),
)

it.live("OpenAI Codex header and chunk timeout defaults can be disabled by config", () =>
  Effect.gen(function* () {
    yield* withAuthContent(
      Effect.gen(function* () {
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const provider = yield* Provider.Service
              const openai = yield* provider.getProvider(ProviderV2.ID.openai)
              expect(openai.options.headerTimeout).toBe(false)
              expect(openai.options.chunkTimeout).toBe(false)
            }),
          { config: { provider: { openai: { options: { headerTimeout: false, chunkTimeout: false } } } } },
        )
      }),
    )
  }),
)

it.live("OpenAI API auth gets default headerTimeout", () =>
  Effect.gen(function* () {
    yield* withAuthContent(
      Effect.gen(function* () {
        yield* provideTmpdirInstance(() =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const openai = yield* provider.getProvider(ProviderV2.ID.openai)
            expect(openai.options.headerTimeout).toBe(300_000)
          }),
        )
      }),
      { openai: { type: "api", key: "sk-test" } },
    )
  }),
)

it.live("opencode-go chunkTimeout defaults to 150 seconds and preserves configured overrides", () =>
  Effect.gen(function* () {
    const values: unknown[] = []
    for (const options of [{}, { chunkTimeout: 12_345 }, { chunkTimeout: false }]) {
      const value = yield* withAuthContent(
        provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const provider = yield* Provider.Service
              const configured = yield* provider.getProvider(ProviderV2.ID.make("opencode-go"))
              return configured.options.chunkTimeout
            }),
          { config: opencodeGoConfig(options) },
        ),
        { "opencode-go": { type: "api", key: "test-key" } },
      )
      values.push(value)
    }

    expect(values).toEqual([150_000, 12_345, false])
  }),
)

const gatewayModels = {
  "native passthrough": "anthropic/claude-sonnet-4-6",
  "REST catalog": "google/gemini-2.5-flash",
}

for (const [route, modelID] of Object.entries(gatewayModels)) {
  it.live(`cloudflare-ai-gateway ${route} applies chunkTimeout when the SSE body stalls`, () =>
    Effect.gen(function* () {
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const urls = yield* setupGateway(() =>
              Promise.resolve(new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })),
            )
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(
              ProviderV2.ID.make("cloudflare-ai-gateway"),
              ModelV2.ID.make(modelID),
            )
            const result = streamText({
              model: yield* provider.getLanguage(model),
              onError() {},
              messages: [{ role: "user", content: "hello" }],
            })

            const error = yield* Effect.promise(() => firstStreamError(result.fullStream))
            expect(urls).toHaveLength(1)
            expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
          }),
        { config: gatewayConfig({ chunkTimeout: 50 }) },
      )
    }),
  )
}

it.live("cloudflare-ai-gateway applies headerTimeout when response headers do not arrive", () =>
  Effect.gen(function* () {
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const urls = yield* setupGateway(
            (init) =>
              new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
          )
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(
            ProviderV2.ID.make("cloudflare-ai-gateway"),
            ModelV2.ID.make(gatewayModels["native passthrough"]),
          )
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const error = yield* Effect.promise(() => firstStreamError(result.fullStream))
          expect(urls).toEqual(["https://gateway.ai.cloudflare.com/v1/test-account/test-gateway"])
          expect(String(error)).toContain("response headers timed out")
        }),
      { config: gatewayConfig({ headerTimeout: 50 }) },
    )
  }),
)

// Routes the gateway provider's requests to `respond` through the configured custom fetch, which
// the timeout wrapper calls instead of the global fetch. Returns the requested URLs.
function setupGateway(respond: (init?: RequestInit) => Promise<Response>) {
  return Effect.gen(function* () {
    yield* Env.use.set("CLOUDFLARE_ACCOUNT_ID", "test-account")
    yield* Env.use.set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
    yield* Env.use.set("CLOUDFLARE_API_TOKEN", "test-token")
    const provider = yield* Provider.Service
    const configured = yield* provider.getProvider(ProviderV2.ID.make("cloudflare-ai-gateway"))
    const urls: string[] = []
    configured.options.fetch = (input: string, init?: RequestInit) => {
      urls.push(input)
      return respond(init)
    }
    return urls
  })
}

function gatewayConfig(options: Record<string, unknown>) {
  return {
    provider: {
      "cloudflare-ai-gateway": {
        options,
        models: {
          // The gateway loader builds its own client; a bundled npm keeps resolveSDK off the network.
          [gatewayModels["REST catalog"]]: { name: "Gemini 2.5 Flash", provider: { npm: "@ai-sdk/openai-compatible" } },
        },
      },
    },
  }
}

async function firstStreamError(stream: AsyncIterable<{ type: string; error?: unknown }>) {
  try {
    for await (const part of stream) {
      if (part.type === "error") return part.error
    }
  } catch (error) {
    return error
  }
}

function captureTransportSummaries<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  summaries: Array<Record<string, unknown>>,
  onSummary?: (summary: Record<string, unknown>) => void,
) {
  const logger = Logger.make<unknown, void>(({ message }) => {
    if (!Array.isArray(message) || message[0] !== "provider SSE transport summary") return
    const summary = message[1]
    if (!summary || typeof summary !== "object") return
    const record = summary as Record<string, unknown>
    summaries.push(record)
    onSummary?.(record)
  })
  return effect.pipe(
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.withLogger(logger),
  )
}

function providerConfig(url: string, options: Record<string, unknown> = {}) {
  const config = testProviderConfig(url)
  return {
    ...config,
    provider: {
      test: {
        ...config.provider.test,
        options: { ...config.provider.test.options, ...options },
      },
    },
  }
}

function opencodeGoConfig(options: Record<string, unknown>) {
  const config = testProviderConfig("http://127.0.0.1/v1")
  return {
    ...config,
    provider: {
      "opencode-go": {
        ...config.provider.test,
        id: "opencode-go",
        options: { ...config.provider.test.options, ...options },
      },
    },
  }
}

function sseResponse() {
  return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
    headers: { "content-type": "text/event-stream" },
  })
}

type SseReadStep = { waitMs?: number; content?: string; empty?: boolean }
type SseDriveOptions = { eofWaitMs?: number; close?: boolean }

type ControlledSse = {
  response: () => Response
  waitForRead: () => Promise<void>
  push: (content: string) => void
  pushBytes: (bytes: Uint8Array) => void
  close: () => void
  error: (reason: unknown) => void
  isCancelled: () => boolean
}

type ControlledSseHarness = {
  advance: (ms: number) => void
  deadlines: number[]
  summaries: Array<Record<string, unknown>>
  stream: (index?: number) => ControlledSse
  fireDeadline: (index: number) => void
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

// Hand-driven SSE body: each `pull` marks one pending provider read, so a test can
// pin a synthetic wait between that read's start and its completion without sleeping.
function controlledSse(): ControlledSse {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  let pulls = 0
  let observed = 0
  const waiters: Array<() => void> = []
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c
      },
      pull() {
        pulls += 1
        waiters.shift()?.()
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  const waitForRead = () => {
    if (pulls > observed) {
      observed += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        observed += 1
        resolve()
      })
    })
  }
  return {
    response: () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    waitForRead,
    push: (content) =>
      controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`)),
    pushBytes: (bytes) => controller.enqueue(bytes),
    close: () => controller.close(),
    error: (reason) => controller.error(reason),
    isCancelled: () => cancelled,
  }
}

function driveSse(
  sse: ControlledSse,
  advance: (ms: number) => void,
  steps: SseReadStep[],
  options: SseDriveOptions = {},
) {
  return (async () => {
    for (const step of steps) {
      await sse.waitForRead()
      if (step.waitMs) advance(step.waitMs)
      if (step.empty) sse.pushBytes(new Uint8Array(0))
      else sse.push(step.content ?? "chunk")
    }
    await sse.waitForRead()
    if (options.eofWaitMs) advance(options.eofWaitMs)
    if (options.close !== false) sse.close()
  })()
}

// Replaces `performance.now()` with a test-controlled clock so read waits are
// exact without real sleeps. Restores the original descriptor afterwards.
function injectReadWaits() {
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now")
  let now = 0
  Object.defineProperty(performance, "now", {
    value: () => now,
    writable: true,
    enumerable: true,
    configurable: true,
  })
  return {
    advance: (ms: number) => (now += ms),
    restore: () => {
      if (descriptor) Object.defineProperty(performance, "now", descriptor)
      else Reflect.deleteProperty(performance, "now")
    },
  }
}

// Records the per-read idle deadlines armed by the transport, which are the only
// timers long enough to be read deadlines rather than scheduling noise.
function captureReadDeadlines() {
  const original = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const timers: Array<{ id: ReturnType<typeof setTimeout>; handler: () => void; dueAt: number; active: boolean }> = []
  const delays: number[] = []
  let now = 0
  const wrappedSetTimeout = ((handler: any, delay?: any, ...args: any[]) => {
    const id = Reflect.apply(original, globalThis, [handler, delay, ...args]) as ReturnType<typeof setTimeout>
    if (typeof delay === "number" && delay >= 30_000 && delay <= 300_000) {
      delays.push(delay)
      timers.push({ id, handler: () => handler(...args), dueAt: now + delay, active: true })
    }
    return id
  }) as typeof globalThis.setTimeout
  const wrappedClearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    const timer = timers.find((entry) => entry.id === id)
    if (timer) timer.active = false
    return Reflect.apply(originalClear, globalThis, [id])
  }) as typeof globalThis.clearTimeout
  const captured = {
    delays,
    advance: (ms: number) => {
      now += ms
      for (;;) {
        const timer = timers.find((entry) => entry.active && entry.dueAt <= now)
        if (!timer) break
        timer.active = false
        Reflect.apply(originalClear, globalThis, [timer.id])
        timer.handler()
      }
    },
    fire: (index: number) => {
      const timer = timers[index]
      if (!timer) throw new Error(`No captured read deadline at index ${index}`)
      if (!timer.active) return
      timer.active = false
      Reflect.apply(originalClear, globalThis, [timer.id])
      timer.handler()
    },
    restore: () => {
      const cleanup: Array<() => void> = []
      for (const timer of timers) {
        if (!timer.active) continue
        timer.active = false
        cleanup.push(() => Reflect.apply(originalClear, globalThis, [timer.id]))
      }
      cleanup.push(
        () => {
          globalThis.setTimeout = original
        },
        () => {
          globalThis.clearTimeout = originalClear
        },
      )
      runCleanupActions(cleanup)
    },
  }
  try {
    globalThis.setTimeout = wrappedSetTimeout
    globalThis.clearTimeout = wrappedClearTimeout
  } catch (error) {
    try {
      runCleanupActions([
        () => {
          globalThis.setTimeout = original
        },
        () => {
          globalThis.clearTimeout = originalClear
        },
      ])
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Failed to install and restore controlled SSE timers")
    }
    throw error
  }
  return captured
}

function runCleanupActions(actions: Array<() => void>) {
  const failures: unknown[] = []
  for (const action of actions) {
    try {
      action()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Controlled SSE cleanup failed")
}

function controlledSseRun<A, E, R>(
  config: Record<string, unknown>,
  run: (harness: ControlledSseHarness) => Effect.Effect<A, E, R>,
  options: {
    streams?: number
    afterInstrumentation?: () => void
    onRestore?: (snapshot: {
      setTimeout: typeof globalThis.setTimeout
      clearTimeout: typeof globalThis.clearTimeout
    }) => void
  } = {},
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const originalSetTimeout = globalThis.setTimeout
      const originalClearTimeout = globalThis.clearTimeout
      const waits = injectReadWaits()
      let deadlines: ReturnType<typeof captureReadDeadlines> | undefined
      try {
        deadlines = captureReadDeadlines()
        options.afterInstrumentation?.()
        const sources = Array.from({ length: options.streams ?? 1 }, () => controlledSse())
        const summaries: Array<Record<string, unknown>> = []
        let request = 0
        const harness: ControlledSseHarness = {
          advance: (ms) => {
            waits.advance(ms)
            deadlines!.advance(ms)
          },
          deadlines: deadlines.delays,
          summaries,
          stream: (index = 0) => sources[index],
          fireDeadline: deadlines.fire,
          fetch: (_input, init) => {
            const source = sources[request++]
            init?.signal?.addEventListener(
              "abort",
              () => {
                if (!(init.signal?.reason instanceof ProviderError.ResponseStreamError)) source.error(init.signal?.reason)
              },
              { once: true },
            )
            return Promise.resolve(source.response())
          },
        }
        const effect = captureTransportSummaries(
          provideTmpdirInstance(() => run(harness), {
            config: providerConfig("http://127.0.0.1/v1", { headerTimeout: false, ...config }),
          }),
          summaries,
        )
        const restore = () => {
          const cleanup: Array<() => void> = [deadlines!.restore, waits.restore]
          if (options.onRestore) {
            cleanup.push(() =>
              options.onRestore?.({ setTimeout: originalSetTimeout, clearTimeout: originalClearTimeout }),
            )
          }
          runCleanupActions(cleanup)
        }
        return { deadlines, effect, restore, summaries }
      } catch (error) {
        const cleanup: Array<() => void> = []
        if (deadlines) cleanup.push(deadlines.restore)
        cleanup.push(waits.restore)
        try {
          runCleanupActions(cleanup)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Controlled SSE setup and rollback failed")
        }
        throw error
      }
    }),
    (setup) => setup.effect.pipe(Effect.as({ summaries: setup.summaries, deadlines: setup.deadlines.delays })),
    (setup) => Effect.sync(setup.restore),
  )
}

function startControlledGeneration(
  harness: ControlledSseHarness,
  options: { stream?: number; abortSignal?: AbortSignal; swallowErrors?: boolean } = {},
) {
  return Effect.gen(function* () {
    const streamIndex = options.stream ?? 0
    const provider = yield* Provider.Service
    const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
    configured.options.fetch = harness.fetch
    const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
    const result = streamText({
      model: yield* provider.getLanguage(model),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.swallowErrors ? { onError() {} } : {}),
      messages: [{ role: "user", content: "hello" }],
    })
    const drive = (steps: SseReadStep[], driveOptions?: SseDriveOptions) => {
      const promise = driveSse(harness.stream(streamIndex), harness.advance, steps, driveOptions)
      void promise.catch(() => {})
      return promise
    }
    return { result, drive, model }
  })
}

async function delayedHeaderServer(delay: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function delayedBodyServer(delay: number, chunks = 1): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    if (chunks === 1) {
      setTimeout(() => {
        res.end('data: {"choices":[{"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n')
      }, delay)
      return
    }

    let index = 0
    const send = () => {
      index += 1
      res.write(`data: {"choices":[{"delta":{"content":"chunk-${index}"}}]}\n\n`)
      if (index === chunks) {
        res.end("data: [DONE]\n\n")
        return
      }
      setTimeout(send, delay)
    }
    setTimeout(send, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function pendingBodyServer(): Promise<{ server: Server; url: string; opened: Promise<void> }> {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n')
    open()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}`, opened }
}

function withAuthContent<A, E, R>(self: Effect.Effect<A, E, R>, value: Record<string, unknown> = defaultAuthContent()) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(value)
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previous
      }),
  )
}

function defaultAuthContent() {
  return {
    openai: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
  }
}
