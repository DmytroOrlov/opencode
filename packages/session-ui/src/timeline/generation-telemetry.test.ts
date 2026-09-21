import { expect, test } from "bun:test"
import {
  formatGenerationRate,
  formatThinkingTelemetry,
  selectGenerationRateTarget,
  type Measurement,
} from "./generation-telemetry"

test("shows active prefill and decode progress while preserving estimated provenance", () => {
  const prefill: Measurement = {
    metric: "prefill-progress",
    processed: 379,
    total: 1000,
    source: "provider-native",
    approximate: false,
  }
  const estimate: Measurement = {
    metric: "decode-rate",
    tokensPerSecond: 21.84,
    source: "estimated",
    approximate: true,
  }
  const native: Measurement = {
    metric: "decode-rate",
    tokensPerSecond: 21.84,
    source: "provider-native",
    approximate: false,
  }

  expect(formatThinkingTelemetry("Working", prefill)).toBe("Working · context 37%")
  expect(formatThinkingTelemetry("Working", estimate)).toBe("Working · ~21.8 tok/s")
  expect(formatThinkingTelemetry("Working", native)).toBe("Working · 21.8 tok/s")
})

test("renders only a finite positive completed decode rate", () => {
  expect(
    formatGenerationRate({
      metric: "decode-rate",
      tokensPerSecond: 1234.56,
      source: "estimated",
      approximate: true,
    }, "de-DE"),
  ).toBe("~1.234,6 tok/s")
  expect(
    formatGenerationRate({
      metric: "decode-rate",
      tokensPerSecond: 38.5,
      source: "provider-native",
      approximate: false,
    }),
  ).toBe("38.5 tok/s")
  expect(
    formatGenerationRate({
      metric: "decode-rate",
      tokensPerSecond: Number.POSITIVE_INFINITY,
      source: "provider-native",
      approximate: false,
    }),
  ).toBeUndefined()
  expect(
    formatGenerationRate({
      metric: "prefill-progress",
      processed: 1,
      total: 10,
      source: "provider-native",
      approximate: false,
    }),
  ).toBeUndefined()
})

test("attaches each completed rate to the last tool output, otherwise the last text output", () => {
  expect(
    selectGenerationRateTarget([
      { id: "first-text", kind: "text" },
      { id: "first-tool", kind: "tool" },
      { id: "last-tool", kind: "tool" },
      { id: "last-text", kind: "text" },
    ]),
  ).toBe("last-tool")
  expect(selectGenerationRateTarget([{ id: "first-text", kind: "text" }, { id: "last-text", kind: "text" }])).toBe(
    "last-text",
  )
})
