import { expect, test } from "bun:test"
import { SplashTelemetry, type TelemetrySnapshot } from "@/session/llm/splash-telemetry"

const chunk = (value: Record<string, unknown>) => ({
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: {}, finish_reason: null }],
  ...value,
})

const progress = (processed: number, overrides: Record<string, unknown> = {}) =>
  chunk({
    prompt_progress: { total: 10, cache: 2, processed, time_ms: processed, ...overrides },
  })

const terminal = (predicted_per_second: unknown = 1500) =>
  chunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    timings: { predicted_per_second },
  })

function collector(start = 1000, throttleMs?: number) {
  const snapshots: TelemetrySnapshot[] = []
  let time = start
  const attempt = SplashTelemetry.create({
    publish: (snapshot) => snapshots.push(snapshot),
    now: () => time,
    ...(throttleMs === undefined ? {} : { throttleMs }),
  })
  return { attempt, snapshots, setTime: (value: number) => (time = value) }
}

test("publishes only normalized valid prompt progress", () => {
  const { attempt, snapshots } = collector()
  attempt.observeRaw(progress(4))
  expect(snapshots).toEqual([{ phase: "prefill", processed: 4, total: 10 }])
})

test("ignores repeated, regressing, inconsistent, and malformed progress", () => {
  const { attempt, snapshots } = collector()
  attempt.observeRaw(progress(4))
  for (const raw of [
    progress(4),
    progress(3),
    progress(5, { total: 11 }),
    progress(5, { cache: 3 }),
    progress(5, { total: Number.POSITIVE_INFINITY }),
    progress(5, { cache: Number.NaN }),
    progress(5, { cache: -1 }),
    progress(-1),
    progress(11),
    progress(Number.POSITIVE_INFINITY),
    progress(5, { time_ms: -1 }),
    progress(5, { time_ms: Number.NaN }),
    chunk({ prompt_progress: { total: 0, cache: 0, processed: 1, time_ms: 0 } }),
  ]) attempt.observeRaw(raw)
  expect(snapshots).toEqual([{ phase: "prefill", processed: 4, total: 10 }])
})

test("coalesces advancing progress and flushes the newest pending value at a step boundary", () => {
  const { attempt, snapshots, setTime } = collector()
  attempt.observeRaw(progress(1))
  setTime(1100)
  attempt.observeRaw(progress(2))
  setTime(1200)
  attempt.observeRaw(progress(3))
  expect(snapshots).toEqual([{ phase: "prefill", processed: 1, total: 10 }])

  attempt.startStep()
  expect(snapshots).toEqual([
    { phase: "prefill", processed: 1, total: 10 },
    { phase: "prefill", processed: 3, total: 10 },
  ])

  setTime(1250)
  attempt.observeRaw(progress(1, { total: 8, cache: 0 }))
  expect(snapshots.at(-1)).toEqual({ phase: "prefill", processed: 3, total: 10 })
  attempt.finalize()
  expect(snapshots.at(-1)).toEqual({ phase: "prefill", processed: 1, total: 8 })
})

test("publishes live progress no more often than the configured cadence", () => {
  const { attempt, snapshots, setTime } = collector(1000, 250)
  attempt.observeRaw(progress(1))
  setTime(1100)
  attempt.observeRaw(progress(2))
  setTime(1249)
  attempt.observeRaw(progress(3))
  expect(snapshots).toHaveLength(1)
  setTime(1250)
  attempt.observeRaw(progress(4))
  expect(snapshots).toHaveLength(2)
  expect(snapshots.at(-1)).toEqual({ phase: "prefill", processed: 4, total: 10 })
})

test("does not publish prefill when prompt progress is absent", () => {
  const { attempt, snapshots } = collector()
  attempt.observeRaw(chunk({ choices: [] }))
  attempt.observeRaw({ type: "raw", prompt_progress: { total: 1, cache: 0, processed: 1, time_ms: 0 } })
  expect(snapshots).toEqual([])
})

test("caches one terminal rate until successful finalize; discard and late input publish nothing", () => {
  const completed = collector()
  completed.attempt.observeRaw(progress(1))
  completed.setTime(1100)
  completed.attempt.observeRaw(progress(2))
  completed.attempt.observeRaw(terminal())
  expect(completed.snapshots).toEqual([
    { phase: "prefill", processed: 1, total: 10 },
    { phase: "prefill", processed: 2, total: 10 },
  ])
  completed.attempt.finalize()
  expect(completed.snapshots).toEqual([
    { phase: "prefill", processed: 1, total: 10 },
    { phase: "prefill", processed: 2, total: 10 },
    { phase: "decode", tokensPerSecond: 1500, done: true },
  ])
  completed.attempt.observeRaw(terminal(3000))
  completed.attempt.startStep()
  completed.attempt.finalize()
  expect(completed.snapshots.at(-1)).toEqual({ phase: "decode", tokensPerSecond: 1500, done: true })

  const discarded = collector()
  discarded.attempt.observeRaw(terminal())
  discarded.attempt.discard()
  discarded.attempt.observeRaw(terminal())
  discarded.attempt.finalize()
  expect(discarded.snapshots).toEqual([])
})

test("publishes a provider terminal only for exactly one finite positive timing at finalize", () => {
  const unavailable: Array<[string, unknown]> = [
    ["zero", 0],
    ["negative", -1],
    ["missing", undefined],
    ["string", "1500"],
    ["object", { value: 1500 }],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ]

  const zero = collector()
  zero.attempt.finalize()
  expect(zero.snapshots).toEqual([])

  for (const [name, rate] of [["valid", 1500], ...unavailable] as Array<[string, unknown]>) {
    const { attempt, snapshots } = collector()
    attempt.observeRaw(
      name === "missing"
        ? chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], timings: {} })
        : terminal(rate),
    )
    expect(snapshots, `${name} must not publish before finalize`).toEqual([])
    attempt.finalize()
    if (name === "valid") {
      expect(snapshots).toEqual([{ phase: "decode", tokensPerSecond: 1500, done: true }])
      continue
    }
    expect(snapshots, `${name} must remain unavailable`).toEqual([])
  }
})

test("fails closed when multiple recognized terminal timings are observed", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["valid then valid", 1500, 2500],
    ["invalid then valid", 0, 1500],
    ["valid then invalid", 1500, 0],
    ["invalid then invalid", "invalid", Number.NaN],
  ]

  for (const [name, first, second] of cases) {
    const { attempt, snapshots } = collector()
    attempt.observeRaw(terminal(first))
    attempt.observeRaw(terminal(second))
    expect(snapshots, `${name} must not publish before finalize`).toEqual([])
    attempt.finalize()
    expect(snapshots, `${name} must be ambiguous`).toEqual([])
  }
})

test("recognizes only terminal Splash Chat timings and ignores input after closure", () => {
  const { attempt, snapshots } = collector()
  attempt.observeRaw({ unrelated: true, timings: { predicted_per_second: 1500 } })
  attempt.observeRaw({ object: "other.completion.chunk", choices: [{ finish_reason: "stop" }], timings: { predicted_per_second: 1500 } })
  attempt.observeRaw(chunk({ choices: [], usage: { completion_tokens: 3 }, metrics: { decode: { tokens: 3 } } }))
  attempt.observeRaw({ type: "raw", rawValue: terminal(1500) })
  attempt.observeRaw(
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      timings: { predicted_per_second: 1500 },
    }),
  )
  attempt.observeRaw(terminal("malformed"))
  attempt.finalize()
  expect(snapshots).toEqual([])
  attempt.observeRaw(terminal(1500))
  attempt.startStep()
  attempt.finalize()
  expect(snapshots).toEqual([])

  const discarded = collector()
  discarded.attempt.observeRaw(terminal(1500))
  discarded.attempt.discard()
  discarded.attempt.observeRaw(terminal(2500))
  discarded.attempt.startStep()
  discarded.attempt.finalize()
  expect(discarded.snapshots).toEqual([])
})

test("isolates synchronous publication exceptions from raw observation and finalization", () => {
  const attempt = SplashTelemetry.create({
    publish() {
      throw new Error("telemetry publisher unavailable")
    },
  })
  expect(() => attempt.observeRaw(progress(1))).not.toThrow()
  expect(() => attempt.observeRaw(terminal(1500))).not.toThrow()
  expect(() => attempt.finalize()).not.toThrow()
})
