import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Event } from "../src/event.js"
import { DurableEventManifest } from "../src/durable-event-manifest.js"
import { SessionEvent } from "../src/session-event.js"

describe("SessionEvent.Compaction.Published", () => {
  test("is durable and binds publication to an exact candidate and summary pair", () => {
    const payload = {
      id: Event.ID.create(),
      created: 1,
      type: "session.compaction.published",
      durable: { aggregateID: "ses_test", seq: 1, version: 1 },
      data: { sessionID: "ses_test", candidateID: "msg_candidate", summaryID: "msg_summary" },
    }
    const decoded = Schema.decodeUnknownSync(SessionEvent.Durable)(payload)

    expect(decoded).toMatchObject(payload)
    expect(SessionEvent.Compaction.Published.durability).toBe("durable")
    expect(DurableEventManifest.Durable.get("session.compaction.published.1")).toBe(
      SessionEvent.Compaction.Published,
    )
  })
})
