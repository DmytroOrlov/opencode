import { expect, test } from "bun:test"
import { reduce, resetForConnectionEpoch, type State } from "./telemetry"
import type { SessionTelemetry } from "@opencode/client/promise"

const event = (overrides: Partial<SessionTelemetry["data"]> = {}): SessionTelemetry["data"] => ({
  sessionID: "ses_1" as SessionTelemetry["data"]["sessionID"],
  assistantMessageID: "msg_1" as SessionTelemetry["data"]["assistantMessageID"],
  attemptID: "evt_attempt" as SessionTelemetry["data"]["attemptID"],
  attemptSequence: 1,
  phase: "decode",
  measurements: [
    {
      metric: "decode-rate",
      tokensPerSecond: 44.2,
      source: "estimated",
      approximate: true,
    },
  ],
  ...overrides,
})

test("accepts events only from the current physical attempt for a message", () => {
  const first = event({ phase: "start", measurements: [] })
  const second = event({
    attemptID: "evt_second" as SessionTelemetry["data"]["attemptID"],
    attemptSequence: 2,
    phase: "start",
    measurements: [],
  })
  const current = reduce(reduce({}, first), second)
  const stale = reduce(
    current,
    event({ phase: "complete", measurements: [{ metric: "decode-rate", tokensPerSecond: 1, source: "provider-native", approximate: false }] }),
  )

  expect(stale).toBe(current)
  expect((stale as State)["msg_1"]?.attemptID).toBe("evt_second")
})

test("keeps the newest attempt when older start and terminal events arrive late", () => {
  const previous = event({
    attemptID: "evt_previous" as SessionTelemetry["data"]["attemptID"],
    attemptSequence: 8,
    phase: "start",
    measurements: [],
  })
  const current = event({
    attemptID: "evt_current" as SessionTelemetry["data"]["attemptID"],
    attemptSequence: 9,
    phase: "start",
    measurements: [],
  })
  const started = reduce({}, current)
  const delayedPrevious = reduce(started, previous)
  const staleDecode = reduce(
    delayedPrevious,
    event({ attemptID: previous.attemptID, attemptSequence: previous.attemptSequence, phase: "decode" }),
  )
  const staleComplete = reduce(
    staleDecode,
    event({ attemptID: previous.attemptID, attemptSequence: previous.attemptSequence, phase: "complete" }),
  )
  const decoded = reduce(
    staleComplete,
    event({ attemptID: current.attemptID, attemptSequence: current.attemptSequence, phase: "decode" }),
  )
  const completed = reduce(
    decoded,
    event({ attemptID: current.attemptID, attemptSequence: current.attemptSequence, phase: "complete" }),
  )

  expect(delayedPrevious).toBe(started)
  expect(staleDecode).toBe(started)
  expect(staleComplete).toBe(started)
  expect(completed["msg_1"]).toMatchObject({ attemptID: current.attemptID, phase: "complete" })
})

test("a new connection epoch permits a lower sequence while same-epoch stale starts remain rejected", () => {
  const previousEpoch = event({ attemptSequence: 100, phase: "start", measurements: [] })
  let state = reduce({}, previousEpoch)
  const delayedOlder = event({ attemptID: "evt_stale" as SessionTelemetry["data"]["attemptID"], attemptSequence: 99, phase: "start", measurements: [] })
  expect(reduce(state, delayedOlder)).toBe(state)
  state = resetForConnectionEpoch()

  const resumed = event({ attemptID: "evt_resumed" as SessionTelemetry["data"]["attemptID"], attemptSequence: 1, phase: "start", measurements: [] })
  state = reduce(state, resumed)

  expect(state["msg_1"]).toMatchObject({ attemptID: resumed.attemptID, attemptSequence: 1, phase: "start" })
})

test("keeps completed measurements and an ordering tombstone for discarded attempts", () => {
  const started = reduce({}, event({ attemptSequence: 2, phase: "start", measurements: [] }))
  const completed = reduce(started, event({ attemptSequence: 2, phase: "complete" }))
  expect(completed["msg_1"]).toMatchObject({ phase: "complete", measurements: [{ tokensPerSecond: 44.2 }] })
  const discarded = reduce(completed, event({ attemptSequence: 2, phase: "discard", measurements: [] }))
  expect(discarded["msg_1"]).toMatchObject({ phase: "discard", attemptSequence: 2, measurements: [] })
  expect(
    reduce(
      discarded,
      event({
        attemptID: "evt_older" as SessionTelemetry["data"]["attemptID"],
        attemptSequence: 1,
        phase: "start",
        measurements: [],
      }),
    ),
  ).toBe(discarded)
})
