import { expect, test } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { FallbackTelemetry, type FallbackTelemetrySnapshot } from "@/session/llm/fallback-telemetry"

const text = (id: string, chunk: string): LLMEvent => LLMEvent.textDelta({ id, text: chunk })
const reasoning = (id: string, chunk: string): LLMEvent => LLMEvent.reasoningDelta({ id, text: chunk })
const toolArg = (id: string, chunk: string): LLMEvent => LLMEvent.toolInputDelta({ id, name: "shell", text: chunk })
const toolArgStart = (id: string): LLMEvent => LLMEvent.toolInputStart({ id, name: "shell" })
const toolCall = (id: string): LLMEvent => LLMEvent.toolCall({ id, name: "shell", input: {} })
const toolResult = (id: string, result: string): LLMEvent =>
  ({ type: "tool-result", id, name: "shell", result }) as unknown as LLMEvent
const stepFinish = (index: number, tokens?: number): LLMEvent =>
  LLMEvent.stepFinish({ index, reason: "stop", ...(tokens === undefined ? {} : { usage: { outputTokens: tokens } }) })
const finish = (tokens?: number): LLMEvent =>
  LLMEvent.finish({ reason: "stop", ...(tokens === undefined ? {} : { usage: { outputTokens: tokens } }) })

const chars = (count: number) => "a".repeat(count)

function harness() {
  let nowValue = 0
  const snapshots: FallbackTelemetrySnapshot[] = []
  let suppressed = false
  const attempt = FallbackTelemetry.createFallbackTelemetry({
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: (snapshot) => snapshots.push(snapshot),
    suppressed: () => suppressed,
    now: () => nowValue,
  })
  return {
    snapshots,
    attempt,
    advance: (ms: number) => (nowValue += ms),
    suppress: () => (suppressed = true),
    provider: () => snapshots.filter((item) => item.phase === "decode"),
  }
}

test("registration emits a presentation reset before any measurement", () => {
  const h = harness()
  expect(h.snapshots[0]).toEqual({ phase: "prefill", done: false })
  h.attempt.finalize()
  expect(h.snapshots.length).toBe(1)
})

test("live estimate excludes TTFT and finalize publishes done", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(text("t", chars(200)))
  h.advance(2500)
  h.attempt.push(text("t", chars(200)))
  const live = h.snapshots.at(-1)!
  expect(live.phase).toBe("decode")
  // 400 chars / 4 = ~100 tokens over the 2500 ms decode interval only.
  expect(live.tokensPerSecond).toBeCloseTo((100 / 2500) * 1000, 5)
  expect(live.approximate).toBe(true)
  h.attempt.finalize()
  const done = h.snapshots.at(-1)!
  expect(done.done).toBe(true)
  expect(done.approximate).toBe(true)
})

test("step usage corrects the estimate with an exact rate", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(text("t", chars(400)))
  h.advance(3000)
  h.attempt.push(stepFinish(0, 140))
  const corrected = h.snapshots.at(-1)!
  // Provider total (140) over the 3000 ms active interval, not the estimate.
  expect(corrected.tokensPerSecond).toBeCloseTo((140 / 3000) * 1000, 5)
  expect(corrected.approximate).toBeUndefined()
  h.attempt.finalize()
  expect(h.snapshots.at(-1)).toEqual({ ...corrected, done: true })
})

test("tool execution between intervals never enters the denominator", () => {
  const h = harness()
  h.advance(100)
  h.attempt.push(text("t", chars(400)))
  h.advance(1000)
  h.attempt.push(stepFinish(0, 100))
  // Long gap: tool execution / permission waits / retry delay.
  h.advance(4000)
  h.attempt.push(text("t2", chars(400)))
  h.advance(1000)
  h.attempt.push(stepFinish(1, 100))
  const corrected = h.snapshots.at(-1)!
  // 200 exact tokens over 1000 + 1000 ms active decode, not 6000 ms wall.
  expect(corrected.tokensPerSecond).toBeCloseTo((200 / 2000) * 1000, 5)
  expect(corrected.approximate).toBeUndefined()
  h.attempt.finalize()
  expect(h.snapshots.at(-1)!.done).toBe(true)
  expect(h.snapshots.at(-1)!.tokensPerSecond).toBeCloseTo(100, 5)
})

test("missing usage freezes the last approximate rate, marked approximate", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(text("t", chars(800)))
  h.advance(2500)
  h.attempt.push(stepFinish(0))
  h.attempt.push(finish())
  h.attempt.finalize()
  const done = h.snapshots.at(-1)!
  expect(done.done).toBe(true)
  expect(done.approximate).toBe(true)
  expect(done.tokensPerSecond).toBeCloseTo((200 / 2500) * 1000, 5)
})

test("reasoning and tool-input deltas count; tool results never do", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(reasoning("r", chars(400)))
  h.attempt.push(toolArg("c", chars(400)))
  h.advance(2500)
  h.attempt.push(toolResult("c", chars(100000)))
  h.attempt.push(stepFinish(0))
  const corrected = h.snapshots.at(-1)!
  // Generated content only: 800 chars / 4 = 200 estimated tokens.
  expect(corrected.tokensPerSecond).toBeCloseTo((200 / 2500) * 1000, 5)
  expect(corrected.approximate).toBe(true)
})

test("tool-call closes decode timing: seconds of tool execution have zero effect on the rate", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(toolArgStart("c"))
  h.attempt.push(toolArg("c", chars(400)))
  h.advance(1000)
  h.attempt.push(toolCall("c"))
  // Several seconds of real external tool execution.
  h.advance(5000)
  h.attempt.push(toolResult("c", chars(100000)))
  h.attempt.push(stepFinish(0, 120))
  const corrected = h.snapshots.at(-1)!
  // 120 provider tokens over the 1000 ms generation interval only: the tool
  // delay must have zero effect on the denominator.
  expect(corrected.tokensPerSecond).toBeCloseTo((120 / 1000) * 1000, 5)
  expect(corrected.approximate).toBeUndefined()
  h.attempt.finalize()
  const done = h.snapshots.at(-1)!
  expect(done.done).toBe(true)
  expect(done.tokensPerSecond).toBeCloseTo((120 / 1000) * 1000, 5)
})

test("missing starts are tolerated: decode timing opens on the earliest delta", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(text("t", chars(400)))
  h.advance(1000)
  h.attempt.push(text("t", chars(400)))
  const live = h.snapshots.at(-1)!
  expect(live.tokensPerSecond).toBeCloseTo((200 / 1000) * 1000, 5)
})

test("content start opens decode timing before the first delta arrives", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(LLMEvent.textStart({ id: "t" }))
  h.advance(1000)
  h.attempt.push(text("t", chars(400)))
  const live = h.snapshots.at(-1)!
  // The interval runs from text-start: 100 estimated tokens over 1000 ms.
  expect(live.tokensPerSecond).toBeCloseTo((100 / 1000) * 1000, 5)
})

test("a pure non-streamed tool call with no measurable decode fabricates no interval", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(toolArgStart("c"))
  h.attempt.push(toolCall("c"))
  h.advance(5000)
  h.attempt.push(toolResult("c", "done"))
  h.attempt.push(stepFinish(0))
  h.attempt.finalize()
  expect(h.provider().length).toBe(0)
})

test("zero outputTokens on step-finish preserves the positive local estimate", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(text("t", chars(800)))
  h.advance(2000)
  h.attempt.push(stepFinish(0, 0))
  const corrected = h.snapshots.at(-1)!
  // Provider claimed zero output despite visible deltas: the ~200 token
  // estimate over 2000 ms survives and stays marked approximate.
  expect(corrected.tokensPerSecond).toBeCloseTo((200 / 2000) * 1000, 5)
  expect(corrected.approximate).toBe(true)
  h.attempt.finalize()
  const done = h.snapshots.at(-1)!
  expect(done.done).toBe(true)
  expect(done.tokensPerSecond).toBeCloseTo(100, 5)
  expect(done.approximate).toBe(true)
})

test("zero cumulative finish tokens never erase a provider-corrected rate", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(text("t", chars(400)))
  h.advance(2000)
  h.attempt.push(stepFinish(0, 120))
  h.attempt.push(finish(0))
  h.attempt.finalize()
  const done = h.snapshots.at(-1)!
  // The exact 120-token step correction stands; the bogus zero finish total
  // changes nothing, and the surviving source is exact, not approximate.
  expect(done.done).toBe(true)
  expect(done.tokensPerSecond).toBeCloseTo((120 / 2000) * 1000, 5)
  expect(done.approximate).toBeUndefined()
})

test("fractional chars/4 estimates survive instead of collapsing to 0 tokens", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(LLMEvent.textStart({ id: "t" }))
  h.advance(100)
  h.attempt.push(text("t", "4"))
  h.attempt.push(stepFinish(0))
  const corrected = h.snapshots.at(-1)!
  // A single generated character is 0.25 estimated tokens over the 100 ms
  // active interval: ~2.5 tok/s, not rounded down to 0 tokens (which would
  // drop the whole measurable generation) and never 0 tok/s.
  expect(corrected.tokensPerSecond).toBeCloseTo(2.5, 5)
  expect(corrected.approximate).toBe(true)
  h.attempt.finalize()
  const done = h.snapshots.at(-1)!
  expect(done.done).toBe(true)
  expect(done.tokensPerSecond).toBeCloseTo(2.5, 5)
})

test("a zero step usage cannot erase a fractional live estimate", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(LLMEvent.textStart({ id: "t" }))
  h.advance(200)
  h.attempt.push(text("t", "ab"))
  h.attempt.push(stepFinish(0, 0))
  const corrected = h.snapshots.at(-1)!
  // 2 chars / 4 = 0.5 estimated tokens over 200 ms -> 2.5 tok/s, still
  // approximate because the zero usage was rejected as an unusable correction.
  expect(corrected.tokensPerSecond).toBeCloseTo(2.5, 5)
  expect(corrected.approximate).toBe(true)
})

test("usage outputTokens already includes reasoning and is not summed twice", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(reasoning("r", chars(400)))
  h.attempt.push(text("t", chars(400)))
  h.advance(3000)
  h.attempt.push(
    LLMEvent.stepFinish({
      index: 0,
      reason: "stop",
      usage: { outputTokens: 300, reasoningTokens: 180 },
    }),
  )
  const corrected = h.snapshots.at(-1)!
  // 300 inclusive generated tokens over 3000 ms, not 300 + 180.
  expect(corrected.tokensPerSecond).toBeCloseTo((300 / 3000) * 1000, 5)
  expect(corrected.approximate).toBeUndefined()
})

test("live updates are coalesced to roughly one per throttle window", () => {
  const h = harness()
  h.advance(1000)
  for (let i = 0; i < 40; i++) {
    h.attempt.push(text("t", "ab"))
    h.advance(10)
  }
  // 400 ms of deltas from t=1000: publishes at 1000/1250/1500-ish, not 40x.
  expect(h.provider().length).toBeLessThanOrEqual(3)
  expect(h.provider().length).toBeGreaterThanOrEqual(1)
})

test("fallback stays quiet before any decode is measurable and never emits 0 tok/s", () => {
  const h = harness()
  h.advance(10)
  h.attempt.push(text("t", "hi"))
  expect(h.provider().length).toBe(0)
  h.attempt.finalize()
  expect(h.provider().every((item) => (item.tokensPerSecond ?? 0) > 0)).toBe(true)
})

test("authoritative provider acceptance permanently suppresses fallback measurements", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(text("t", chars(400)))
  h.advance(2500)
  h.attempt.push(text("t", chars(400)))
  const before = h.snapshots.length
  expect(h.provider().length).toBeGreaterThan(0)
  h.suppress()
  h.attempt.push(text("t", chars(400)))
  h.advance(5000)
  h.attempt.push(text("t", chars(400)))
  h.attempt.push(stepFinish(0, 1000))
  h.attempt.finalize()
  expect(h.snapshots.length).toBe(before)
})

test("finalize is idempotent", () => {
  const h = harness()
  h.advance(1000)
  h.attempt.push(text("t", chars(400)))
  h.advance(2500)
  h.attempt.push(stepFinish(0, 100))
  h.attempt.finalize()
  h.attempt.finalize()
  h.attempt.push(text("t", chars(400)))
  const decode = h.provider()
  expect(decode.filter((item) => item.done === true).length).toBe(1)
})
