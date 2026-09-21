import { describe, expect, test } from "bun:test"
import {
  completedGenerationRates,
  formatGenerationRate,
  formatThinkingTelemetry,
  selectGenerationRateTargets,
  selectGenerationTelemetry,
  type GenerationRateEntry,
} from "./generation-telemetry"

describe("formatThinkingTelemetry", () => {
  test("returns plain base without a snapshot", () => {
    expect(formatThinkingTelemetry("Thinking", undefined)).toBe("Thinking")
  })

  test("returns plain base when done", () => {
    expect(
      formatThinkingTelemetry("Thinking", { phase: "decode", tokensPerSecond: 31.5, done: true }),
    ).toBe("Thinking")
  })

  test("formats prefill progress as a floored percentage", () => {
    expect(formatThinkingTelemetry("Thinking", { phase: "prefill", processed: 379, total: 1000 })).toBe(
      "Thinking · context 37%",
    )
  })

  test("clamps prefill percentage to 0..100", () => {
    expect(formatThinkingTelemetry("Thinking", { phase: "prefill", processed: 1500, total: 1000 })).toBe(
      "Thinking · context 100%",
    )
    expect(formatThinkingTelemetry("Thinking", { phase: "prefill", processed: 0, total: 1000 })).toBe(
      "Thinking · context 0%",
    )
  })

  test("formats decode rate with one decimal", () => {
    expect(formatThinkingTelemetry("Thinking", { phase: "decode", tokensPerSecond: 21.84 })).toBe(
      "Thinking · 21.8 tok/s",
    )
  })

  test("formats decode rate with the given locale", () => {
    expect(formatThinkingTelemetry("Thinking", { phase: "decode", tokensPerSecond: 1234.56 }, "de-DE")).toBe(
      "Thinking · 1.234,6 tok/s",
    )
  })

  test("marks approximate fallback decode rates with ~", () => {
    expect(
      formatThinkingTelemetry("Thinking", { phase: "decode", tokensPerSecond: 21.84, approximate: true, source: "fallback" }),
    ).toBe("Thinking · ~21.8 tok/s")
  })

  test("fallback reset markers render as the plain base", () => {
    expect(formatThinkingTelemetry("Thinking", { phase: "prefill", done: false, source: "fallback" })).toBe("Thinking")
  })

  test("returns plain base for invalid prefill values", () => {
    expect(formatThinkingTelemetry("Thinking", { phase: "prefill", processed: 10 })).toBe("Thinking")
    expect(formatThinkingTelemetry("Thinking", { phase: "prefill", processed: 10, total: 0 })).toBe("Thinking")
    expect(
      formatThinkingTelemetry("Thinking", {
        phase: "prefill",
        processed: Number.NaN,
        total: 1000,
      }),
    ).toBe("Thinking")
  })

  test("returns plain base for invalid decode rates", () => {
    expect(formatThinkingTelemetry("Thinking", { phase: "decode" })).toBe("Thinking")
    expect(formatThinkingTelemetry("Thinking", { phase: "decode", tokensPerSecond: 0 })).toBe("Thinking")
    expect(formatThinkingTelemetry("Thinking", { phase: "decode", tokensPerSecond: -3 })).toBe("Thinking")
    expect(formatThinkingTelemetry("Thinking", { phase: "decode", tokensPerSecond: Number.POSITIVE_INFINITY })).toBe(
      "Thinking",
    )
  })
})

describe("selectGenerationTelemetry", () => {
  const msg = (id: string) => ({ id })

  test("uses only the newest assistant message telemetry", () => {
    const telemetry = { msg_a: { phase: "decode" as const, tokensPerSecond: 21.84 } }
    expect(selectGenerationTelemetry([msg("msg_a")], telemetry)).toEqual(telemetry.msg_a)
    expect(selectGenerationTelemetry([msg("msg_a"), msg("msg_b")], telemetry)).toBeUndefined()
  })

  test("returns undefined without assistant messages", () => {
    expect(selectGenerationTelemetry([], { msg_a: { phase: "decode", tokensPerSecond: 1 } })).toBeUndefined()
    expect(selectGenerationTelemetry([msg("msg_a")], undefined)).toBeUndefined()
  })
})

describe("formatGenerationRate", () => {
  test("formats a done decode snapshot with one decimal", () => {
    expect(formatGenerationRate({ phase: "decode", tokensPerSecond: 21.84, done: true })).toBe("21.8 tok/s")
  })

  test("returns undefined unless the snapshot is done", () => {
    expect(formatGenerationRate({ phase: "decode", tokensPerSecond: 21.84 })).toBeUndefined()
    expect(formatGenerationRate(undefined)).toBeUndefined()
  })

  test("returns undefined for a done prefill snapshot", () => {
    expect(formatGenerationRate({ phase: "prefill", processed: 100, total: 100, done: true })).toBeUndefined()
  })

  test("returns undefined for invalid or nonpositive rates", () => {
    expect(formatGenerationRate({ phase: "decode", done: true })).toBeUndefined()
    expect(formatGenerationRate({ phase: "decode", tokensPerSecond: 0, done: true })).toBeUndefined()
    expect(formatGenerationRate({ phase: "decode", tokensPerSecond: -5, done: true })).toBeUndefined()
    expect(formatGenerationRate({ phase: "decode", tokensPerSecond: Number.NaN, done: true })).toBeUndefined()
    expect(
      formatGenerationRate({ phase: "decode", tokensPerSecond: Number.POSITIVE_INFINITY, done: true }),
    ).toBeUndefined()
  })

  test("formats with the given locale", () => {
    expect(formatGenerationRate({ phase: "decode", tokensPerSecond: 1234.56, done: true }, "de-DE")).toBe(
      "1.234,6 tok/s",
    )
  })

  test("preserves the ~ marker only for approximate frozen rates", () => {
    expect(
      formatGenerationRate({ phase: "decode", tokensPerSecond: 41.66, done: true, approximate: true, source: "fallback" }),
    ).toBe("~41.7 tok/s")
    expect(
      formatGenerationRate({ phase: "decode", tokensPerSecond: 40.4, done: true, source: "fallback" }),
    ).toBe("40.4 tok/s")
    expect(
      formatGenerationRate({ phase: "decode", tokensPerSecond: 38.5, done: true, source: "provider" }),
    ).toBe("38.5 tok/s")
  })
})

describe("completedGenerationRates", () => {
  const msg = (id: string, overrides: { finish?: string; error?: unknown } = {}) => ({
    id,
    sessionID: "ses_1",
    time: { created: 1 },
    ...(overrides.finish !== undefined ? { finish: overrides.finish } : {}),
    ...(overrides.error ? { error: overrides.error } : {}),
  })
  const telemetry = {
    ses_1: {
      msg_a: { phase: "decode" as const, tokensPerSecond: 21.8, done: true },
      msg_b: { phase: "decode" as const, tokensPerSecond: 10, done: true },
    },
  }

  test("uses only the stored provider-derived rate", () => {
    expect(completedGenerationRates([msg("msg_a", { finish: "stop" })], telemetry).get("msg_a")).toBe("21.8 tok/s")
  })

  test("accepts a normal stop request without time.completed", () => {
    expect(completedGenerationRates([msg("msg_a", { finish: "stop" })], telemetry).get("msg_a")).toBe("21.8 tok/s")
  })

  test("accepts a tool-calls finish without time.completed", () => {
    expect(completedGenerationRates([msg("msg_b", { finish: "tool-calls" })], telemetry).get("msg_b")).toBe(
      "10.0 tok/s",
    )
  })

  test("skips messages without a finish reason", () => {
    expect(completedGenerationRates([msg("msg_a")], telemetry).size).toBe(0)
    expect(completedGenerationRates([msg("msg_a", { finish: "" })], telemetry).size).toBe(0)
  })

  test("skips errored messages", () => {
    expect(
      completedGenerationRates([msg("msg_a", { finish: "stop", error: { name: "UnknownError" } })], telemetry).size,
    ).toBe(0)
  })

  test("skips messages without a done decode snapshot", () => {
    expect(completedGenerationRates([msg("msg_c", { finish: "stop" })], telemetry).size).toBe(0)
    expect(completedGenerationRates([msg("msg_a", { finish: "stop" })], undefined).size).toBe(0)
  })
})

describe("selectGenerationRateTargets", () => {
  const rates = new Map([
    ["msg_a", "21.9 tok/s"],
    ["msg_b", "20.3 tok/s"],
  ])
  const entry = (key: string, messageID: string, kind: "tool" | "text"): GenerationRateEntry => ({
    key,
    messageID,
    kind,
  })

  test("selects only the last visible tool representation of a message", () => {
    const targets = selectGenerationRateTargets(
      [entry("shell", "msg_a", "tool"), entry("edit", "msg_a", "tool"), entry("text", "msg_a", "text")],
      rates,
    )
    expect([...targets]).toEqual([["edit", "21.9 tok/s"]])
  })

  test("treats a context group as one tool representation", () => {
    const targets = selectGenerationRateTargets(
      [entry("context:prt_1", "msg_a", "tool"), entry("text", "msg_a", "text")],
      rates,
    )
    expect([...targets]).toEqual([["context:prt_1", "21.9 tok/s"]])
  })

  test("selects the last text entry when the message has no tools", () => {
    const targets = selectGenerationRateTargets(
      [entry("text:1", "msg_a", "text"), entry("text:2", "msg_a", "text")],
      rates,
    )
    expect([...targets]).toEqual([["text:2", "21.9 tok/s"]])
  })

  test("ignores entries for ineligible messages", () => {
    const targets = selectGenerationRateTargets([entry("text", "msg_z", "text")], rates)
    expect(targets.size).toBe(0)
  })

  test("assigns each model request its own rate in one user turn", () => {
    const targets = selectGenerationRateTargets(
      [
        entry("context:a", "msg_a", "tool"),
        entry("text:a", "msg_a", "text"),
        entry("shell:b", "msg_b", "tool"),
        entry("text:b", "msg_b", "text"),
      ],
      rates,
    )
    expect([...targets]).toEqual([
      ["context:a", "21.9 tok/s"],
      ["shell:b", "20.3 tok/s"],
    ])
  })
})
