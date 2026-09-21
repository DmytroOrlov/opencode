import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Event } from "../src/event.js"
import { EventLog } from "../src/event-log.js"
import { SessionEvent } from "../src/session-event.js"
import { DurableEventManifest } from "../src/durable-event-manifest.js"
import { EventManifest } from "../src/event-manifest.js"

describe("public event schemas", () => {
  test("definition is pure", () => {
    const definitions = Event.inventory()
    Event.ephemeral({ type: "test.pure", schema: { value: Schema.String } })
    expect(definitions).toEqual([])
  })

  test("latest selection is independent of declaration order", () => {
    const historical = Event.durable({
      type: "test.versioned",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })
    const current = Event.durable({
      type: "test.versioned",
      durable: { aggregate: "id", version: 2 },
      schema: { id: Schema.String, value: Schema.String },
    })

    expect(Event.latest([historical, current]).get(current.type)).toBe(current)
    expect(Event.latest([current, historical]).get(current.type)).toBe(current)
  })

  test("durable definitions are indexed by type and version", () => {
    const definition = Event.durable({
      type: "test.durable",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })

    expect(Event.durableMap([definition]).get("test.durable.1")).toBe(definition)
  })

  test("synced marker encodes the captured watermark", () => {
    expect(
      Schema.encodeSync(EventLog.Synced)({
        type: "log.synced",
        aggregateID: "ses_test",
        seq: Event.Seq.make(1),
      }),
    ).toEqual({ type: "log.synced", aggregateID: "ses_test", seq: 1 })
    expect(Schema.encodeSync(EventLog.Synced)({ type: "log.synced", aggregateID: "ses_test" })).toEqual({
      type: "log.synced",
      aggregateID: "ses_test",
    })
  })

  test("session telemetry is public and ephemeral", () => {
    const payload = {
      id: Event.ID.create(),
      created: 1,
      type: "session.telemetry",
      data: {
        sessionID: "ses_test",
        assistantMessageID: "msg_test",
        attemptID: Event.ID.create(),
        attemptSequence: 1,
        phase: "decode",
        measurements: [
          {
            metric: "decode-rate" as const,
            tokensPerSecond: 12.5,
            source: "provider-native" as const,
            approximate: false,
          },
        ],
      },
    }
    const decoded = Schema.decodeUnknownSync(SessionEvent.Telemetry)(payload)

    expect(decoded.data.measurements).toEqual(payload.data.measurements)
    expect(SessionEvent.Telemetry.durability).toBe("ephemeral")
    expect(EventManifest.Server.get("session.telemetry")).toBe(SessionEvent.Telemetry)
    expect(DurableEventManifest.Durable.get("session.telemetry.1")).toBeUndefined()
  })
})
