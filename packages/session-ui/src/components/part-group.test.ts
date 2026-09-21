import { describe, expect, test } from "bun:test"
import { groupParts } from "./part-group"

const read = (id: string) => ({ id, type: "tool" as const, tool: "read" })
const grep = (id: string) => ({ id, type: "tool" as const, tool: "grep" })
const shell = (id: string) => ({ id, type: "tool" as const, tool: "bash" })
const text = (id: string) => ({ id, type: "text" as const })

describe("groupParts", () => {
  test("groups adjacent context tools within one message", () => {
    const groups = groupParts([
      { messageID: "msg_a", part: read("prt_1") } as never,
      { messageID: "msg_a", part: grep("prt_2") } as never,
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.type).toBe("context")
    if (groups[0]?.type === "context") {
      expect(groups[0].refs.map((ref) => ref.partID)).toEqual(["prt_1", "prt_2"])
    }
  })

  test("never groups context tools across assistant message ids", () => {
    const groups = groupParts([
      { messageID: "msg_a", part: read("prt_1") } as never,
      { messageID: "msg_a", part: grep("prt_2") } as never,
      { messageID: "msg_b", part: read("prt_3") } as never,
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every((group) => group.type === "context")).toBe(true)
    const [first, second] = groups
    if (first?.type !== "context" || second?.type !== "context") throw new Error("expected context groups")
    expect(first.refs.map((ref) => ref.partID)).toEqual(["prt_1", "prt_2"])
    expect(first.refs.every((ref) => ref.messageID === "msg_a")).toBe(true)
    expect(second.refs.map((ref) => ref.partID)).toEqual(["prt_3"])
    expect(second.refs.every((ref) => ref.messageID === "msg_b")).toBe(true)
  })

  test("keeps non-context parts as standalone groups", () => {
    const groups = groupParts([
      { messageID: "msg_a", part: read("prt_1") } as never,
      { messageID: "msg_a", part: shell("prt_2") } as never,
      { messageID: "msg_a", part: text("prt_3") } as never,
    ])
    expect(groups.map((group) => group.type)).toEqual(["context", "part", "part"])
  })
})
