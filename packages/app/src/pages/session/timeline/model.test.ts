import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import {
  isTimelineReady,
  loadOlderTimeline,
  selectTurnFallbackModel,
  selectUserMessages,
  selectVisibleUserMessages,
} from "./model"

const user = (id: string) => ({ id, role: "user" }) as UserMessage
const assistant = (id: string) => ({ id, role: "assistant" }) as AssistantMessage
const modelUser = (model: UserMessage["model"], agent = "build") =>
  ({ id: "user", role: "user", agent, model }) as UserMessage
const modelAssistant = (
  id: string,
  model: Pick<AssistantMessage, "providerID" | "modelID" | "variant">,
  agent = "build",
) => ({ id, role: "assistant", agent, ...model }) as AssistantMessage

describe("timeline model", () => {
  test("does not mark an unchanged model as fallback", () => {
    expect(
      selectTurnFallbackModel(modelUser({ providerID: "openai", modelID: "gpt-x", variant: "xhigh" }), [
        modelAssistant("assistant", { providerID: "openai", modelID: "gpt-x", variant: "xhigh" }),
      ]),
    ).toBeUndefined()
  })

  test("selects the actual fallback model", () => {
    expect(
      selectTurnFallbackModel(modelUser({ providerID: "some-remote", modelID: "primary" }), [
        modelAssistant("assistant", { providerID: "mlx", modelID: "qwen3.8-27b", variant: "xhigh" }),
      ]),
    ).toEqual({ providerID: "mlx", modelID: "qwen3.8-27b", variant: "xhigh" })
  })

  test("uses the latest assistant for a sticky multi-step turn", () => {
    expect(
      selectTurnFallbackModel(modelUser({ providerID: "some-remote", modelID: "primary" }), [
        modelAssistant("assistant_primary", { providerID: "some-remote", modelID: "primary" }),
        modelAssistant("assistant_fallback", { providerID: "mlx", modelID: "qwen3.8-27b", variant: "xhigh" }),
        modelAssistant("assistant_subtask", { providerID: "some-other", modelID: "subtask-model" }, "explore"),
      ]),
    ).toEqual({ providerID: "mlx", modelID: "qwen3.8-27b", variant: "xhigh" })
  })

  test("ignores a different-agent subtask assistant", () => {
    expect(
      selectTurnFallbackModel(modelUser({ providerID: "remote", modelID: "primary" }), [
        modelAssistant("assistant_primary", { providerID: "remote", modelID: "primary" }),
        modelAssistant("assistant_subtask", { providerID: "some-other", modelID: "subtask-model" }, "explore"),
      ]),
    ).toBeUndefined()
  })

  test("does not select a fallback without an assistant", () => {
    expect(selectTurnFallbackModel(modelUser({ providerID: "some-remote", modelID: "primary" }), [])).toBeUndefined()
  })

  test("selects users and applies the revert boundary", () => {
    const messages: Message[] = [user("msg_z"), assistant("msg_a"), user("msg_b"), user("msg_c")]
    const users = selectUserMessages(messages)

    expect(users.map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_c"])
    expect(selectVisibleUserMessages(users, "msg_b").map((message) => message.id)).toEqual(["msg_z"])
    expect(selectVisibleUserMessages(users)).toBe(users)
  })

  test("waits for an assistant-only load to hydrate its user root", () => {
    expect(isTimelineReady([assistant("msg_2")], true)).toBe(false)
    expect(isTimelineReady([user("msg_1"), assistant("msg_2")], true)).toBe(true)
    expect(isTimelineReady([], false)).toBe(true)
  })

  test("loads exactly one opaque cursor page", async () => {
    let calls = 0
    const anchors: Array<string | boolean> = []

    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
      before: () => anchors.push("before"),
      after: (done) => anchors.push("after", done),
    })

    expect(calls).toBe(1)
    expect(anchors).toEqual(["before", "after", true])
  })

  test("stops when a page adds no raw messages", async () => {
    let calls = 0
    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
    })

    expect(calls).toBe(1)
  })

  test("does not restore an anchor after the session changes", async () => {
    let sessionID = "ses_old"
    let restore = 0

    await loadOlderTimeline({
      sessionID: () => sessionID,
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        sessionID = "ses_new"
      },
      after: () => {
        restore += 1
      },
    })

    expect(restore).toBe(0)
  })

  test("releases the anchor when loading history fails", async () => {
    let restore = 0

    await expect(
      loadOlderTimeline({
        sessionID: () => "ses_test",
        more: () => true,
        loading: () => false,
        loadMore: async () => {
          throw new Error("history failed")
        },
        after: () => {
          restore += 1
        },
      }),
    ).rejects.toThrow("history failed")

    expect(restore).toBe(1)
  })
})
