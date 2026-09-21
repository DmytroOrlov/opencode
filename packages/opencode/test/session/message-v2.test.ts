import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { createXai } from "@ai-sdk/xai"
import { APICallError, generateText } from "ai"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Question } from "../../src/question"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): SessionV1.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelV2.ID.make("test") },
    tools: {},
    mode: "",
  } as unknown as SessionV1.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: SessionV1.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): SessionV1.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as SessionV1.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", async () => {
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters out user messages with only empty text parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters empty user text parts while keeping non-empty parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "hello",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("includes synthetic text parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/file parts and injects compaction/subtask prompts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "What did we do so far?" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("preserves jpeg tool-result media for anthropic models", async () => {
    const anthropicModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("anthropic/claude-opus-4-7"),
      providerID: ProviderV2.ID.make("anthropic"),
      api: {
        id: "claude-opus-4-7-20250805",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString(
      "base64",
    )
    const userID = "m-user-anthropic"
    const assistantID = "m-assistant-anthropic"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-anthropic"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-anthropic"),
            type: "tool",
            callID: "call-anthropic-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/rails-demo.png" },
              output: "Image read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-anthropic-1"),
                  type: "file",
                  mime: "image/jpeg",
                  filename: "rails-demo.png",
                  url: `data:image/jpeg;base64,${jpeg}`,
                },
              ],
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const result = ProviderTransform.message(await MessageV2.toModelMessages(input, anthropicModel), anthropicModel, {})
    expect(result).toHaveLength(3)
    expect(result[2].role).toBe("tool")
    expect(result[2].content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-anthropic-1",
      toolName: "read",
      output: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "media", mediaType: "image/jpeg", data: jpeg },
        ],
      },
    })
  })

  test("sends tool-result images to xai responses as input_image", async () => {
    const xaiModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("grok-4.7"),
      providerID: ProviderV2.ID.make("xai"),
      api: {
        id: "grok-4.7",
        url: "https://api.x.ai/v1",
        npm: "@ai-sdk/xai",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
        },
      },
    }
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
    const userID = "m-user-xai"
    const assistantID = "m-assistant-xai"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-xai"),
            type: "text",
            text: "describe the diagram",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-xai"),
            type: "tool",
            callID: "call-xai-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/diagram.png" },
              output: "Image read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-xai-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "diagram.png",
                  url: `data:image/png;base64,${png}`,
                },
              ],
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const bodies: Record<string, unknown>[] = []
    const xai = createXai({
      apiKey: "test",
      fetch: Object.assign(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(await new Request(url, init).json())
          return new Response("{}", { status: 400 })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    })
    await generateText({
      model: xai.responses(xaiModel.api.id),
      messages: ProviderTransform.message(await MessageV2.toModelMessages(input, xaiModel), xaiModel, {}),
      providerOptions: { xai: { promptCacheKey: "session", reasoningEffort: "xhigh" } },
      maxRetries: 0,
    }).catch(() => undefined)

    expect(bodies).toHaveLength(1)
    expect(bodies[0].prompt_cache_key).toBe("session")
    expect(bodies[0].reasoning).toEqual({ effort: "xhigh" })
    expect(bodies[0].input).toContainEqual({
      type: "function_call_output",
      call_id: "call-xai-1",
      output: [
        { type: "input_text", text: "Image read successfully" },
        { type: "input_image", image_url: `data:image/png;base64,${png}` },
      ],
    })
  })

  test("drops tool-result images xai rejects but keeps png and webp", async () => {
    const xaiModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("grok-4.7"),
      providerID: ProviderV2.ID.make("xai"),
      api: {
        id: "grok-4.7",
        url: "https://api.x.ai/v1",
        npm: "@ai-sdk/xai",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
        },
      },
    }
    const images = [
      { mime: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") },
      { mime: "image/gif", data: Buffer.from("GIF89a").toString("base64") },
      { mime: "image/webp", data: Buffer.from("RIFFWEBP").toString("base64") },
    ]
    const userID = "m-user-xai-gif"
    const assistantID = "m-assistant-xai-gif"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-xai-gif"),
            type: "text",
            text: "describe the images",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-xai-gif"),
            type: "tool",
            callID: "call-xai-gif",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/images" },
              output: "Images read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: images.map((image, index) => ({
                ...basePart(assistantID, `file-xai-gif-${index}`),
                type: "file" as const,
                mime: image.mime,
                filename: `image-${index}`,
                url: `data:${image.mime};base64,${image.data}`,
              })),
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const bodies: Record<string, unknown>[] = []
    const xai = createXai({
      apiKey: "test",
      fetch: Object.assign(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(await new Request(url, init).json())
          return new Response("{}", { status: 400 })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    })
    await generateText({
      model: xai.responses(xaiModel.api.id),
      messages: ProviderTransform.message(await MessageV2.toModelMessages(input, xaiModel), xaiModel, {}),
      maxRetries: 0,
    }).catch(() => undefined)

    expect(bodies).toHaveLength(1)
    expect(bodies[0].input).toContainEqual({
      type: "function_call_output",
      call_id: "call-xai-gif",
      output: [
        { type: "input_text", text: "Images read successfully" },
        { type: "input_image", image_url: `data:image/png;base64,${images[0].data}` },
        { type: "input_image", image_url: `data:image/webp;base64,${images[2].data}` },
      ],
    })
    expect(JSON.stringify(bodies[0])).not.toContain("image/gif")
  })

  test("moves bedrock pdf tool-result media into a separate user message", async () => {
    const bedrockModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("amazon-bedrock/anthropic.claude-sonnet-4-6"),
      providerID: ProviderV2.ID.make("amazon-bedrock"),
      api: {
        id: "anthropic.claude-sonnet-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64")
    const userID = "m-user-bedrock-pdf"
    const assistantID = "m-assistant-bedrock-pdf"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-bedrock-pdf"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-bedrock-pdf"),
            type: "tool",
            callID: "call-bedrock-pdf-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/example.pdf" },
              output: "PDF read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-bedrock-pdf-1"),
                  type: "file",
                  mime: "application/pdf",
                  filename: "example.pdf",
                  url: `data:application/pdf;base64,${pdf}`,
                },
              ],
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, bedrockModel)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            input: { filePath: "/tmp/example.pdf" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            output: { type: "text", value: "PDF read successfully" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached media from tool result:" },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "example.pdf",
            data: `data:application/pdf;base64,${pdf}`,
          },
        ],
      },
    ])
  })

  test("omits provider metadata when assistant model differs", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "reasoning",
            text: "thinking",
            metadata: { openai: { reasoning: "meta" } },
            time: { start: 0 },
          },
          {
            ...basePart(assistantID, "a3"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" }, providerExecuted: true },
          },
        ] as SessionV1.Part[],
      },
    ]

    const serialized = await MessageV2.toModelMessages(input, model)
    expect(serialized).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          { type: "text", text: "thinking" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
    const serializedText = JSON.stringify(serialized)
    expect(serializedText).toContain('"providerExecuted":true')
    expect(serializedText).toContain('"input":{"cmd":"ls"}')
    expect(serializedText).toContain('"value":"ok"')
    expect(serializedText).not.toContain('"providerOptions":{"openai":{"tool":"meta"}}')
  })

  test("replaces compacted tool output with placeholder", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("truncates tool output when requested", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "abcdefghij",
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model, { toolOutputMaxChars: 4 })).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "text",
              value: "abcd\n[Tool output truncated for compaction: omitted 6 chars]",
            },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("forwards partial bash output for aborted tool calls", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const output = [
      "31403",
      "12179",
      "4575",
      "",
      "<shell_metadata>",
      "User aborted the command",
      "</shell_metadata>",
    ].join("\n")

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
              error: "Tool execution aborted",
              metadata: { interrupted: true, output },
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: output },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", async () => {
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new SessionV1.APIError({ message: "boom", isRetryable: true }).toObject() as SessionV1.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", async () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new SessionV1.AbortedError({
      message: "aborted",
    }).toObject() as SessionV1.Assistant["error"]

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("preserves OpenRouter reasoning details through provider transform", async () => {
    const assistantID = "m-assistant"
    const openrouterModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("deepseek/deepseek-v4-pro"),
      providerID: ProviderV2.ID.make("openrouter"),
      api: {
        id: "deepseek/deepseek-v4-pro",
        url: "https://openrouter.ai/api/v1",
        npm: "@openrouter/ai-sdk-provider",
      },
      capabilities: {
        ...model.capabilities,
        reasoning: true,
        interleaved: { field: "reasoning_details" },
      },
    }
    const reasoningDetails = [
      {
        type: "reasoning.text",
        text: "thinking",
        format: "unknown",
        index: 0,
      },
    ]
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent", undefined, {
          providerID: openrouterModel.providerID,
          modelID: openrouterModel.id,
        }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
            metadata: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "text",
            text: "answer",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(
      ProviderTransform.message(await MessageV2.toModelMessages(input, openrouterModel), openrouterModel, {}),
    ).toStrictEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          { type: "text", text: "answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", async () => {
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", async () => {
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })

  test("substitutes space for empty text between signed reasoning blocks", async () => {
    // Reproduces the bug pattern: [reasoning(sig), text(""), reasoning(sig), text(full)]
    const assistantID = "m-assistant"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "step-start" },
          {
            ...basePart(assistantID, "p2"),
            type: "reasoning",
            text: "thinking-one",
            metadata: { anthropic: { signature: "sig1" } },
          },
          { ...basePart(assistantID, "p3"), type: "text", text: "" },
          { ...basePart(assistantID, "p4"), type: "step-start" },
          {
            ...basePart(assistantID, "p5"),
            type: "reasoning",
            text: "thinking-two",
            metadata: { anthropic: { signature: "sig2" } },
          },
          { ...basePart(assistantID, "p6"), type: "text", text: "the answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    // step-start splits into two assistant messages; SDK's groupIntoBlocks merges them later
    expect(result).toHaveLength(2)
    expect((result[0].content as any[]).find((p) => p.type === "text").text).toBe(" ")
    expect((result[1].content as any[]).find((p) => p.type === "text").text).toBe("the answer")
  })

  test("leaves empty text alone when reasoning signature is under 'bedrock' namespace", async () => {
    // Bedrock signed reasoning is preserved as reasoning metadata, but unlike the
    // direct Anthropic path we do not preserve empty text separators for Bedrock.
    const assistantID = "m-assistant-bedrock"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "reasoning",
            text: "thinking-bedrock",
            metadata: { bedrock: { signature: "bedrock-sig" } },
          },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone when reasoning has no Anthropic signature", async () => {
    // Non-Anthropic providers' reasoning doesn't position-validate, so empty text
    // should be filtered normally rather than substituted.
    const assistantID = "m-assistant-unsigned"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "reasoning", text: "thinking" },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone in assistant messages without reasoning", async () => {
    const assistantID = "m-assistant-no-reasoning"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "text", text: "" },
          { ...basePart(assistantID, "p2"), type: "text", text: "hello" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "hello"])
  })
})

describe("session.message-v2.fromError", () => {
  test("serializes context_length_exceeded as ContextOverflowError", () => {
    const input = {
      type: "error",
      error: {
        code: "context_length_exceeded",
      },
    }
    const result = MessageV2.fromError(input, { providerID })

    expect(result).toStrictEqual({
      name: "ContextOverflowError",
      data: {
        message: "Input exceeds context window of this model",
        responseBody: JSON.stringify(input),
      },
    })
  })

  test("serializes response error codes", () => {
    const cases = [
      {
        code: "insufficient_quota",
        message: "Quota exceeded. Check your plan and billing details.",
      },
      {
        code: "usage_not_included",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      },
      {
        code: "invalid_prompt",
        message: "Invalid prompt from test",
      },
    ]

    cases.forEach((item) => {
      const input = {
        type: "error",
        error: {
          code: item.code,
          message: item.code === "invalid_prompt" ? item.message : undefined,
        },
      }
      const result = MessageV2.fromError(input, { providerID })

      expect(result).toStrictEqual({
        name: "APIError",
        data: {
          message: item.message,
          isRetryable: false,
          responseBody: JSON.stringify(input),
        },
      })
    })
  })

  test("serializes OpenAI response server_error stream chunks as retryable APIError", () => {
    const body = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "server_error",
        code: "server_error",
        message:
          "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_77eccd008d984bf6bf82d1b2c2b68715 in your message.",
        param: null,
      },
    }
    const result = MessageV2.fromError({ message: JSON.stringify(body) }, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.error.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
      },
    })
  })

  test("detects context overflow from APICallError provider messages", () => {
    const cases = [
      "prompt is too long: 213462 tokens > 200000 maximum",
      "Your input exceeds the context window of this model",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
      "tokens in request more than max tokens allowed",
      "Please reduce the length of the messages or completion",
      "400 status code (no body)",
      "413 status code (no body)",
    ]

    cases.forEach((message) => {
      const error = new APICallError({
        message,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 400,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      })
      const result = MessageV2.fromError(error, { providerID })
      expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(true)
    })
  })

  test("detects context overflow from context_length_exceeded code in response body", () => {
    const error = new APICallError({
      message: "Request failed",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 422,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        error: {
          message: "Some message",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("does not classify 429 no body as context overflow", () => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "429 status code (no body)",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      }),
      { providerID },
    )
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(false)
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
  })

  test("serializes unknown inputs", () => {
    const result = MessageV2.fromError(123, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "123",
      },
    })
  })

  test("serializes tagged errors with their message", () => {
    const result = MessageV2.fromError(new Question.RejectedError(), { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "The user dismissed this question",
      },
    })
  })

  test("classifies ZlibError from fetch as retryable APIError", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0
    ;(zlibError as any).path = ""

    const result = MessageV2.fromError(zlibError, { providerID })

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    expect((result as SessionV1.APIError).data.isRetryable).toBe(true)
    expect((result as SessionV1.APIError).data.message).toInclude("decompression")
  })

  test("classifies ZlibError as AbortedError when abort context is provided", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0

    const result = MessageV2.fromError(zlibError, { providerID, aborted: true })

    expect(result.name).toBe("MessageAbortedError")
  })
})

describe("session.message-v2.latest", () => {
  const TAIL_USER = MessageID.make("msg_001")
  const OVERFLOW_ASSISTANT = MessageID.make("msg_002")
  const COMPACTION_USER = MessageID.make("msg_003")
  const SUMMARY_ASSISTANT = MessageID.make("msg_004")
  const CONTINUE_USER = MessageID.make("msg_005")
  const NEW_COMPACTION_USER = MessageID.make("msg_006")

  const tailUser: SessionV1.WithParts = {
    info: userInfo(TAIL_USER),
    parts: [{ ...basePart(TAIL_USER, "p1"), type: "text", text: "original prompt" }] as SessionV1.Part[],
  }

  const overflowAssistant: SessionV1.WithParts = {
    info: {
      ...assistantInfo(OVERFLOW_ASSISTANT, TAIL_USER),
      finish: "tool-calls",
      tokens: { input: 280_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 }, total: 280_200 },
    } as SessionV1.Assistant,
    parts: [],
  }

  const compactionUser: SessionV1.WithParts = {
    info: userInfo(COMPACTION_USER),
    parts: [
      {
        ...basePart(COMPACTION_USER, "p1"),
        type: "compaction",
        auto: true,
        tail_start_id: TAIL_USER,
      },
    ] as SessionV1.Part[],
  }

  const summaryAssistant: SessionV1.WithParts = {
    info: {
      ...assistantInfo(SUMMARY_ASSISTANT, COMPACTION_USER),
      summary: true,
      finish: "stop",
      tokens: { input: 150_000, output: 1_500, reasoning: 0, cache: { read: 0, write: 0 }, total: 151_500 },
    } as SessionV1.Assistant,
    parts: [],
  }

  const continueUser: SessionV1.WithParts = {
    info: userInfo(CONTINUE_USER),
    parts: [
      {
        ...basePart(CONTINUE_USER, "p1"),
        type: "text",
        text: "Continue if you have next steps...",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    ] as SessionV1.Part[],
  }

  test("selects latest messages by creation time when IDs are nonmonotonic", () => {
    const oldUser = { ...userInfo("msg_z_user"), time: { created: 100 } }
    const newUser = { ...userInfo("msg_a_user"), time: { created: 200 } }
    const oldAssistant = {
      ...assistantInfo("msg_z_assistant", oldUser.id),
      time: { created: 300 },
      finish: "stop",
    } as SessionV1.Assistant
    const newAssistant = {
      ...assistantInfo("msg_a_assistant", newUser.id),
      time: { created: 400 },
      finish: "stop",
    } as SessionV1.Assistant

    const state = MessageV2.latest([
      { info: newAssistant, parts: [] },
      { info: oldUser, parts: [] },
      { info: oldAssistant, parts: [] },
      { info: newUser, parts: [] },
    ])

    expect(state.user?.id).toBe(newUser.id)
    expect(state.assistant?.id).toBe(newAssistant.id)
    expect(state.finished?.id).toBe(newAssistant.id)
  })

  test("uses ID as a deterministic tie-breaker for equal creation times", () => {
    const lower = { ...userInfo("msg_a_user"), time: { created: 100 } }
    const higher = { ...userInfo("msg_z_user"), time: { created: 100 } }

    const state = MessageV2.latest([
      { info: higher, parts: [] },
      { info: lower, parts: [] },
    ])

    expect(state.user?.id).toBe(higher.id)
  })

  // Regression for double auto-compaction. The reorder in filterCompacted
  // (#27145) returns [compaction-user, summary, ...tail..., continue-user],
  // so picking lastFinished by array position landed on the pre-compaction
  // overflow assistant and bypassed the `summary !== true` overflow guard
  // in SessionPrompt.runLoop, firing a second compaction.create immediately.
  test("finished is the chronologically-latest finished assistant, not the array-latest", () => {
    const filtered = MessageV2.filterCompacted([
      continueUser,
      summaryAssistant,
      compactionUser,
      overflowAssistant,
      tailUser,
    ])

    const state = MessageV2.latest(filtered)

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.finished?.summary).toBe(true)
    expect(state.user?.id).toBe(CONTINUE_USER)
    expect(state.tasks).toEqual([])
  })

  test("a fresh compaction-user newer than the latest summary surfaces in tasks", () => {
    const newCompactionUser: SessionV1.WithParts = {
      info: userInfo(NEW_COMPACTION_USER),
      parts: [
        {
          ...basePart(NEW_COMPACTION_USER, "p1"),
          type: "compaction",
          auto: true,
        },
      ] as SessionV1.Part[],
    }

    const state = MessageV2.latest([
      tailUser,
      overflowAssistant,
      compactionUser,
      summaryAssistant,
      continueUser,
      newCompactionUser,
    ])

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.user?.id).toBe(NEW_COMPACTION_USER)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ type: "compaction", auto: true })
  })

  test("selects compaction and subtask work after the finished boundary by creation time", () => {
    const finished = {
      ...assistantInfo("msg_z_finished", "msg_parent"),
      time: { created: 200 },
      finish: "stop",
    } as SessionV1.Assistant
    const oldTask: SessionV1.WithParts = {
      info: { ...userInfo("msg_z_old"), time: { created: 100 } },
      parts: [{ ...basePart("msg_z_old", "old"), type: "compaction", auto: true }] as SessionV1.Part[],
    }
    const newTask: SessionV1.WithParts = {
      info: { ...userInfo("msg_a_new"), time: { created: 300 } },
      parts: [
        {
          ...basePart("msg_a_new", "new"),
          type: "subtask",
          prompt: "inspect",
          description: "inspect ordering",
          agent: "general",
        },
      ] as SessionV1.Part[],
    }

    const state = MessageV2.latest([newTask, { info: finished, parts: [] }, oldTask])

    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ type: "subtask", prompt: "inspect" })
  })
})

type PairFixture = {
  user: SessionV1.WithParts
  part: SessionV1.CompactionPart
  summary?: SessionV1.WithParts
}

function pairFixture(input: {
  ownerID?: string
  origin?: string
  publication?: SessionV1.CompactionPart["publication"]
  tailStartID?: string
  partOwnerID?: string
  partSessionID?: SessionID
  summaryID?: string
  summaryParentID?: string
  summary?:
    | false
    | {
        finish?: string
        unfinished?: boolean
        error?: SessionV1.Assistant["error"]
        text?: string | null
        sessionID?: SessionID
      }
}): PairFixture {
  const ownerID = input.ownerID ?? "msg_pair_owner"
  const summaryID = input.summaryID ?? "msg_pair_summary"
  const user: SessionV1.WithParts = {
    info: {
      ...userInfo(ownerID),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    },
    parts: [],
  }
  const part: SessionV1.CompactionPart = {
    ...basePart(input.partOwnerID ?? ownerID, "p_compaction"),
    ...(input.partSessionID !== undefined ? { sessionID: input.partSessionID } : {}),
    type: "compaction",
    auto: false,
    ...(input.tailStartID !== undefined ? { tail_start_id: MessageID.make(input.tailStartID) } : {}),
    ...(input.publication !== undefined ? { publication: input.publication } : {}),
  }
  user.parts = [part] as SessionV1.Part[]

  if (input.summary === false) return { user, part }
  const config = input.summary ?? {}
  const text = config.text === undefined ? "summary body" : config.text
  const summary: SessionV1.WithParts = {
    info: {
      ...assistantInfo(summaryID, input.summaryParentID ?? ownerID, config.error),
      ...(config.sessionID !== undefined ? { sessionID: config.sessionID } : {}),
      summary: true,
      ...(config.unfinished ? {} : { finish: config.finish ?? "stop" }),
    } as SessionV1.Assistant,
    parts:
      text === null ? [] : ([{ ...basePart(summaryID, "p_summary_text"), type: "text", text }] as SessionV1.Part[]),
  }
  return { user, part, summary }
}

const interpret = (input: PairFixture) => MessageV2.interpretCompactionPair(input)

describe("session.message-v2.interpretCompactionPair", () => {
  const summaryID = MessageID.make("msg_pair_summary")

  test("strict legacy identity (both fields absent) with a successful full summary is published", () => {
    expect(interpret(pairFixture({}))).toEqual({ format: "legacy", ordinary: false, published: true })
  })

  test("legacy summary with a retained tail_start_id is published", () => {
    const result = interpret(pairFixture({ tailStartID: "msg_pair_tail" }))
    expect(result).toEqual({ format: "legacy", ordinary: false, published: true })
  })

  test("legacy pair without a summary is not published", () => {
    expect(interpret(pairFixture({ summary: false })).published).toBe(false)
  })

  test("legacy pair with an unfinished summary is not published", () => {
    expect(interpret(pairFixture({ summary: { unfinished: true } })).published).toBe(false)
  })

  test("legacy pair with a failed summary is not published", () => {
    const result = interpret(
      pairFixture({
        summary: { finish: "error", error: { name: "MessageAbortedError", data: { message: "stopped" } } },
      }),
    )
    expect(result).toEqual({ format: "legacy", ordinary: false, published: false })
  })

  test("strict legacy summary with finish:'error' and no error object is not published", () => {
    const result = interpret(pairFixture({ summary: { finish: "error" } }))
    expect(result).toEqual({ format: "legacy", ordinary: false, published: false })
  })

  test("strict legacy pair with valid empty-text compatibility stays recognized", () => {
    for (const text of ["", "   "]) {
      expect(interpret(pairFixture({ summary: { text } }))).toEqual({
        format: "legacy",
        ordinary: false,
        published: true,
      })
    }
    expect(interpret(pairFixture({ summary: { text: null } }))).toEqual({
      format: "legacy",
      ordinary: false,
      published: true,
    })
  })

  test("published binding whose summary text is Unicode whitespace only is not readable", () => {
    for (const text of ["\u00A0", "\u2003", "\u2028"]) {
      expect(
        interpret(pairFixture({ origin: "compaction", publication: { state: "published", summaryID }, summary: { text } })),
      ).toEqual({ format: "new", ordinary: true, published: false })
    }
    expect(
      interpret(
        pairFixture({
          origin: "compaction",
          publication: { state: "published", summaryID },
          summary: { text: "genuinely readable" },
        }),
      ),
    ).toEqual({ format: "new", ordinary: true, published: true })
  })

  test("explicit synthetic origin with absent publication is malformed, never legacy, even with a successful summary", () => {
    for (const origin of ["compaction", "recovery-preparation", "future-synthetic"]) {
      expect(interpret(pairFixture({ origin }))).toEqual({
        format: "malformed",
        ordinary: false,
        published: false,
      })
    }
  })

  test("new ordinary pair published with the exact summaryID is published", () => {
    const result = interpret(
      pairFixture({ origin: "compaction", publication: { state: "published", summaryID } }),
    )
    expect(result).toEqual({ format: "new", ordinary: true, published: true })
  })

  test("upgraded legacy pair (absent origin, explicit published metadata) is recognized without a tail", () => {
    const result = interpret(pairFixture({ publication: { state: "published", summaryID } }))
    expect(result).toEqual({ format: "new", ordinary: false, published: true })
  })

  test("upgraded legacy pair (absent origin, explicit published metadata) is recognized with a retained tail", () => {
    const result = interpret(
      pairFixture({ publication: { state: "published", summaryID }, tailStartID: "msg_pair_tail" }),
    )
    expect(result).toEqual({ format: "new", ordinary: false, published: true })
  })

  test("published binding that references a different summary is not published", () => {
    const result = interpret(
      pairFixture({ publication: { state: "published", summaryID: MessageID.make("msg_pair_other") } }),
    )
    expect(result).toEqual({ format: "new", ordinary: false, published: false })
  })

  test("published binding without a summary message is not published", () => {
    const result = interpret(pairFixture({ publication: { state: "published", summaryID }, summary: false }))
    expect(result).toEqual({ format: "new", ordinary: false, published: false })
  })

  test("published binding with a failed summary is not published", () => {
    const result = interpret(
      pairFixture({
        publication: { state: "published", summaryID },
        summary: { finish: "error", error: { name: "MessageAbortedError", data: { message: "stopped" } } },
      }),
    )
    expect(result).toEqual({ format: "new", ordinary: false, published: false })
  })

  test("published binding whose summary belongs to a different user is not published", () => {
    const result = interpret(
      pairFixture({
        publication: { state: "published", summaryID },
        summaryParentID: "msg_pair_other_owner",
      }),
    )
    expect(result).toEqual({ format: "new", ordinary: false, published: false })
  })

  test("queued, preparing, and abandoned are never published even with a successful summary and a tail", () => {
    for (const state of ["queued", "preparing", "abandoned"] as const) {
      const result = interpret(
        pairFixture({
          origin: "compaction",
          publication: { state },
          tailStartID: "msg_pair_tail",
        }),
      )
      expect(result).toEqual({ format: "new", ordinary: true, published: false })
    }
  })

  test("a compaction part owned by another message never publishes its pair", () => {
    const result = interpret(pairFixture({ partOwnerID: "msg_pair_other_owner" }))
    expect(result).toEqual({ format: "legacy", ordinary: false, published: false })
  })

  test("new published pair with a real text summary part is published", () => {
    const result = interpret(
      pairFixture({ origin: "compaction", publication: { state: "published", summaryID } }),
    )
    expect(result).toEqual({ format: "new", ordinary: true, published: true })
    expect(interpret(pairFixture({ publication: { state: "published", summaryID } }))).toEqual({
      format: "new",
      ordinary: false,
      published: true,
    })
  })

  test("new published pair requires durably readable summary text evidence", () => {
    const published = (summary: { text?: string | null }) =>
      interpret(pairFixture({ origin: "compaction", publication: { state: "published", summaryID }, summary }))

    expect(published({ text: "summary body" }).published).toBe(true)
    expect(published({ text: "" }).published).toBe(false)
    expect(published({ text: "   " }).published).toBe(false)
    expect(published({ text: null }).published).toBe(false)
  })

  test("new published pair with finish error and no error object is not published", () => {
    const result = interpret(
      pairFixture({
        origin: "compaction",
        publication: { state: "published", summaryID },
        summary: { finish: "error" },
      }),
    )
    expect(result).toEqual({ format: "new", ordinary: true, published: false })
  })

  test("legacy empty-text summaries remain valid legacy pairs", () => {
    expect(interpret(pairFixture({ summary: { text: "" } }))).toEqual({
      format: "legacy",
      ordinary: false,
      published: true,
    })
    expect(interpret(pairFixture({ summary: { text: null } }))).toEqual({
      format: "legacy",
      ordinary: false,
      published: true,
    })
  })

  test("U, P, and S must belong to the same session", () => {
    const otherSession = SessionID.make("session_other")

    expect(interpret(pairFixture({ summary: { sessionID: otherSession } }))).toEqual({
      format: "legacy",
      ordinary: false,
      published: false,
    })
    expect(interpret(pairFixture({ partSessionID: otherSession }))).toEqual({
      format: "legacy",
      ordinary: false,
      published: false,
    })
    expect(
      interpret(
        pairFixture({
          origin: "compaction",
          publication: { state: "published", summaryID },
          summary: { sessionID: otherSession },
        }),
      ),
    ).toEqual({ format: "new", ordinary: true, published: false })
    expect(
      interpret(
        pairFixture({
          origin: "compaction",
          publication: { state: "published", summaryID },
          partSessionID: otherSession,
        }),
      ),
    ).toEqual({ format: "new", ordinary: true, published: false })
  })

  test("only origin compaction classifies a new pair as ordinary", () => {
    expect(interpret(pairFixture({ origin: "compaction", publication: { state: "queued" }, summary: false }))).toEqual(
      { format: "new", ordinary: true, published: false },
    )
    expect(
      interpret(pairFixture({ origin: "recovery-preparation", publication: { state: "queued" }, summary: false })),
    ).toEqual({ format: "new", ordinary: false, published: false })
    expect(interpret(pairFixture({ origin: "future-synthetic", publication: { state: "queued" }, summary: false }))).toEqual(
      { format: "new", ordinary: false, published: false },
    )
    expect(interpret(pairFixture({ publication: { state: "queued" }, summary: false }))).toEqual({
      format: "new",
      ordinary: false,
      published: false,
    })
  })

  test("a newer inactive candidate does not displace the older valid pair", () => {
    const older = pairFixture({
      ownerID: "msg_chain_older",
      summaryID: "msg_chain_older_summary",
      origin: "compaction",
      publication: { state: "published", summaryID: MessageID.make("msg_chain_older_summary") },
    })
    const newer = pairFixture({
      ownerID: "msg_chain_newer",
      summaryID: "msg_chain_newer_summary",
      origin: "compaction",
      publication: { state: "preparing" },
    })
    const chain = [older, newer]
    const interpreted = chain.map((entry) => ({ entry, result: interpret(entry) }))
    const applicable = interpreted.filter((item) => item.result.published).at(-1)

    expect(interpreted[1]?.result.published).toBe(false)
    expect(applicable?.entry).toBe(older)
  })
})

describe("session.message-v2 publication negative controls", () => {
  const isPublished = (input: PairFixture) => interpret(input).published

  const tailAsPublication = (input: PairFixture) => input.part.tail_start_id !== undefined
  const finishAsPublication = (input: PairFixture) =>
    input.summary?.info.role === "assistant" &&
    Boolean(input.summary.info.finish) &&
    input.summary.info.error === undefined

  test("negative control: tail_start_id as publication rejects a valid full summary", () => {
    const full = pairFixture({})
    const acceptance = (isPublishedFn: (input: PairFixture) => boolean) => {
      expect(isPublishedFn(full)).toBe(true)
    }

    acceptance(isPublished)
    expect(() => acceptance(tailAsPublication)).toThrow()
  })

  test("negative control: tail_start_id as publication accepts an unpublished tailed pair", () => {
    const unpublishedTailed = pairFixture({
      origin: "compaction",
      publication: { state: "preparing" },
      tailStartID: "msg_pair_tail",
    })
    const acceptance = (isPublishedFn: (input: PairFixture) => boolean) => {
      expect(isPublishedFn(unpublishedTailed)).toBe(false)
    }

    acceptance(isPublished)
    expect(() => acceptance(tailAsPublication)).toThrow()
  })

  test("negative control: S.finish as publication hides prior context before commit", () => {
    const prior = pairFixture({
      ownerID: "msg_prior_owner",
      summaryID: "msg_prior_summary",
      origin: "compaction",
      publication: { state: "published", summaryID: MessageID.make("msg_prior_summary") },
    })
    const newer = pairFixture({
      ownerID: "msg_newer_owner",
      summaryID: "msg_newer_summary",
      origin: "compaction",
      publication: { state: "preparing" },
    })
    const chain = [prior, newer]
    const acceptance = (isPublishedFn: (input: PairFixture) => boolean) => {
      expect(chain.filter(isPublishedFn).at(-1)).toBe(prior)
    }

    acceptance(isPublished)
    expect(() => acceptance(finishAsPublication)).toThrow()
  })
})

type ProjectionFilter = (msgs: Iterable<SessionV1.WithParts>) => SessionV1.WithParts[]

function projectionUser(
  id: string,
  input: {
    created: number
    text?: string
    origin?: string
    compaction?: { tail?: string; publication?: SessionV1.CompactionPart["publication"] }
  },
): SessionV1.WithParts {
  const parts: SessionV1.Part[] = []
  if (input.compaction) {
    parts.push({
      ...basePart(id, `compact_${id}`),
      type: "compaction",
      auto: true,
      ...(input.compaction.tail !== undefined ? { tail_start_id: MessageID.make(input.compaction.tail) } : {}),
      ...(input.compaction.publication !== undefined ? { publication: input.compaction.publication } : {}),
    } as SessionV1.Part)
  } else if (input.text !== undefined) {
    parts.push({ ...basePart(id, `text_${id}`), type: "text", text: input.text } as SessionV1.Part)
  }
  return {
    info: {
      ...userInfo(id),
      time: { created: input.created },
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    },
    parts,
  }
}

function projectionAssistant(
  id: string,
  input: {
    parentID: string
    created: number
    summary?: boolean
    finish?: string
    unfinished?: boolean
    error?: SessionV1.Assistant["error"]
    text?: string
  },
): SessionV1.WithParts {
  return {
    info: {
      ...assistantInfo(id, input.parentID, input.error),
      time: { created: input.created },
      ...(input.summary === true ? { summary: true } : {}),
      ...(input.unfinished === true ? {} : { finish: input.finish ?? "stop" }),
    },
    parts:
      input.text === undefined
        ? []
        : ([{ ...basePart(id, `text_${id}`), type: "text", text: input.text }] as SessionV1.Part[]),
  }
}

const projectionIDs = (msgs: SessionV1.WithParts[]): string[] => msgs.map((msg) => msg.info.id)

const projectionText = (msgs: SessionV1.WithParts[]) =>
  msgs
    .flatMap((msg) => msg.parts)
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

const project = (chronological: SessionV1.WithParts[]) => MessageV2.filterCompacted(chronological.toReversed())

const itPersisted = testEffect(
  LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node])),
)

describe("session.message-v2.filterCompacted publication authority", () => {
  const head = () => {
    const u = projectionUser("msg_head", { created: 100, text: "head question" })
    const a = projectionAssistant("msg_head_reply", {
      parentID: u.info.id,
      created: 110,
      finish: "end_turn",
      text: "head reply",
    })
    return [u, a]
  }

  const priorPair = () => {
    const u = projectionUser("msg_u1", { created: 200, compaction: {} })
    const s = projectionAssistant("msg_s1", {
      parentID: u.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "summary one",
    })
    return { u, s }
  }

  const laterTurn = () => projectionUser("msg_y", { created: 400, text: "later genuine question" })

  test("A: a newer preparing pair with a completed summary does not replace the prior projection", () => {
    const prior = priorPair()
    const u2 = projectionUser("msg_u2", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "preparing" } },
    })
    const s2 = projectionAssistant("msg_s2", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "summary two",
    })
    const y = laterTurn()
    const history = [...head(), prior.u, prior.s, u2, s2, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([prior.u.info.id, prior.s.info.id, y.info.id])
    expect(projectionText(filtered)).toContain("summary one")
    expect(projectionText(filtered)).not.toContain("summary two")
    expect(projectionText(filtered)).not.toContain("head question")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(JSON.stringify(history)).toBe(before)
  })

  test("B: tail metadata on an unpublished pair cannot activate that pair", () => {
    const prior = priorPair()
    const tail = projectionUser("msg_tail", { created: 250, text: "recent tail turn" })
    const u2 = projectionUser("msg_u2", {
      created: 300,
      origin: "compaction",
      compaction: { tail: tail.info.id, publication: { state: "preparing" } },
    })
    const s2 = projectionAssistant("msg_s2", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "summary two",
    })
    const y = laterTurn()
    const history = [...head(), prior.u, prior.s, tail, u2, s2, y]

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([prior.u.info.id, prior.s.info.id, tail.info.id, y.info.id])
    expect(projectionText(filtered)).not.toContain("summary two")
    expect(projectionText(filtered)).toContain("recent tail turn")
    expect(projectionIDs(filtered)).not.toContain(u2.info.id)
  })

  test("C: a published binding uses only its exact referenced summary", () => {
    const prior = priorPair()
    const u2 = projectionUser("msg_u2", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_s3") } },
    })
    const stale = projectionAssistant("msg_s2", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      unfinished: true,
      text: "stale summary",
    })
    const exact = projectionAssistant("msg_s3", {
      parentID: u2.info.id,
      created: 320,
      summary: true,
      finish: "end_turn",
      text: "summary three",
    })
    const y = laterTurn()
    const history = [...head(), prior.u, prior.s, u2, stale, exact, y]

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([u2.info.id, exact.info.id, y.info.id])
    expect(projectionIDs(filtered).filter((id) => id === exact.info.id)).toHaveLength(1)
    expect(projectionText(filtered)).toContain("summary three")
    expect(projectionText(filtered)).not.toContain("stale summary")
  })

  test("C: a published binding whose referenced summary is missing does not publish", () => {
    const prior = priorPair()
    const u2 = projectionUser("msg_u2", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_s3") } },
    })
    const stale = projectionAssistant("msg_s2", {
      parentID: u2.info.id,
      created: 320,
      summary: true,
      finish: "end_turn",
      text: "stale summary",
    })
    const y = laterTurn()
    const history = [...head(), prior.u, prior.s, u2, stale, y]

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([prior.u.info.id, prior.s.info.id, y.info.id])
    expect(projectionText(filtered)).toContain("summary one")
    expect(projectionText(filtered)).not.toContain("stale summary")
    expect(projectionIDs(filtered)).not.toContain(u2.info.id)
  })

  test("D: scanning recovers the older valid boundary past a newer invalid candidate", () => {
    const prior = priorPair()
    const middle = projectionUser("msg_m", { created: 250, text: "intermediate genuine turn" })
    const u2 = projectionUser("msg_u2", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "preparing" } },
    })
    const s2 = projectionAssistant("msg_s2", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "error",
      error: new SessionV1.AbortedError({ message: "compaction failed" }).toObject(),
      text: "failed summary",
    })
    const y = laterTurn()
    const history = [...head(), prior.u, prior.s, middle, u2, s2, y]

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([prior.u.info.id, prior.s.info.id, middle.info.id, y.info.id])
    expect(projectionText(filtered)).not.toContain("failed summary")
  })

  test("E: the newest valid published pair determines the projection without duplicate summaries", () => {
    const prior = priorPair()
    const tail = projectionUser("msg_tail", { created: 250, text: "retained turn" })
    const u2 = projectionUser("msg_u2", {
      created: 300,
      origin: "compaction",
      compaction: {
        tail: tail.info.id,
        publication: { state: "published", summaryID: MessageID.make("msg_s2") },
      },
    })
    const s2 = projectionAssistant("msg_s2", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "summary two",
    })
    const y = laterTurn()
    const history = [...head(), prior.u, prior.s, tail, u2, s2, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([u2.info.id, s2.info.id, tail.info.id, y.info.id])
    const summaries = filtered.filter((msg) => msg.info.role === "assistant" && msg.info.summary)
    expect(summaries).toHaveLength(1)
    expect(projectionText(filtered)).toContain("summary two")
    expect(projectionText(filtered)).not.toContain("summary one")
    expect(projectionText(filtered)).toContain("retained turn")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(JSON.stringify(history)).toBe(before)
  })

  test("negative control: break-to-continue alone still permits provisional U/S contamination", () => {
    const scenarioA = () => {
      const prior = priorPair()
      const u2 = projectionUser("msg_u2", {
        created: 300,
        origin: "compaction",
        compaction: { publication: { state: "preparing" } },
      })
      const s2 = projectionAssistant("msg_s2", {
        parentID: u2.info.id,
        created: 310,
        summary: true,
        finish: "end_turn",
        text: "summary two",
      })
      const y = laterTurn()
      return {
        history: [...head(), prior.u, prior.s, u2, s2, y],
        expected: [prior.u.info.id, prior.s.info.id, y.info.id],
      }
    }
    const scenarioB = () => {
      const prior = priorPair()
      const tail = projectionUser("msg_tail", { created: 250, text: "recent tail turn" })
      const u2 = projectionUser("msg_u2", {
        created: 300,
        origin: "compaction",
        compaction: { tail: tail.info.id, publication: { state: "preparing" } },
      })
      const s2 = projectionAssistant("msg_s2", {
        parentID: u2.info.id,
        created: 310,
        summary: true,
        finish: "end_turn",
        text: "summary two",
      })
      const y = laterTurn()
      return {
        history: [...head(), prior.u, prior.s, tail, u2, s2, y],
        expected: [prior.u.info.id, prior.s.info.id, tail.info.id, y.info.id],
      }
    }
    const accept =
      (scenario: () => { history: SessionV1.WithParts[]; expected: string[] }) =>
      (filter: ProjectionFilter) => {
        const { history, expected } = scenario()
        expect(projectionIDs(filter(history.toReversed()))).toEqual(expected)
      }
    const acceptA = accept(scenarioA)
    const acceptB = accept(scenarioB)

    acceptA(MessageV2.filterCompacted)
    acceptB(MessageV2.filterCompacted)

    const defectiveA = projectionIDs(oneSidedFixFilterCompacted(scenarioA().history.toReversed()))
    expect(defectiveA).toContain("msg_u2")
    expect(defectiveA).toContain("msg_s2")
    expect(() => acceptA(oneSidedFixFilterCompacted)).toThrow()
    expect(() => acceptB(oneSidedFixFilterCompacted)).toThrow()
  })
})

function oneSidedFixFilterCompacted(msgs: Iterable<SessionV1.WithParts>) {
  const result = [] as SessionV1.WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) continue
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some(
        (item): item is SessionV1.CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
      ),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is SessionV1.CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ]
  }
  return result
}

describe("session.message-v2.filterCompacted full projection", () => {
  const head = () => [
    projectionUser("msg_head", { created: 100, text: "head question" }),
    projectionAssistant("msg_head_reply", {
      parentID: "msg_head",
      created: 110,
      finish: "end_turn",
      text: "head reply",
    }),
  ]

  const priorPair = () => {
    const u = projectionUser("msg_u1", { created: 200, compaction: {} })
    const s = projectionAssistant("msg_s1", {
      parentID: u.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "summary one",
    })
    return { u, s }
  }

  test("legacy published full summary hides the compacted head and exposes the summary", () => {
    const prior = priorPair()
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })
    const history = [...head(), prior.u, prior.s, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([prior.u.info.id, prior.s.info.id, y.info.id])
    expect(projectionText(filtered)).toContain("summary one")
    expect(projectionText(filtered)).not.toContain("head question")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(JSON.stringify(history)).toBe(before)
  })

  test("legacy published summary with a retained tail orders summary, tail and later turns", () => {
    const prior = priorPair()
    const tail = projectionUser("msg_tail", { created: 150, text: "tail question" })
    const tailReply = projectionAssistant("msg_tail_reply", {
      parentID: tail.info.id,
      created: 155,
      finish: "end_turn",
      text: "tail reply",
    })
    const u = projectionUser("msg_u2", { created: 200, compaction: { tail: tail.info.id } })
    const s = projectionAssistant("msg_s2", {
      parentID: u.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "summary two",
    })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })
    const history = [...head(), tail, tailReply, u, s, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([u.info.id, s.info.id, tail.info.id, tailReply.info.id, y.info.id])
    expect(projectionIDs(filtered).filter((id) => id === tail.info.id)).toHaveLength(1)
    expect(projectionText(filtered)).not.toContain("head question")
    expect(JSON.stringify(history)).toBe(before)
  })

  test("new published full summary with real readable text becomes authoritative", () => {
    const prior = priorPair()
    const u2 = projectionUser("msg_u3", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_s3") } },
    })
    const s2 = projectionAssistant("msg_s3", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "summary three",
    })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })
    const history = [...head(), prior.u, prior.s, u2, s2, y]

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([u2.info.id, s2.info.id, y.info.id])
    expect(projectionText(filtered)).toContain("summary three")
    expect(projectionText(filtered)).not.toContain("summary one")
    expect(projectionText(filtered)).not.toContain("head question")
  })

  test("new published tailed summary preserves summary, tail and later turns", () => {
    const prior = priorPair()
    const tail = projectionUser("msg_tail", { created: 250, text: "tail question" })
    const tailReply = projectionAssistant("msg_tail_reply", {
      parentID: tail.info.id,
      created: 255,
      finish: "end_turn",
      text: "tail reply",
    })
    const u2 = projectionUser("msg_u3", {
      created: 300,
      origin: "compaction",
      compaction: {
        tail: tail.info.id,
        publication: { state: "published", summaryID: MessageID.make("msg_s3") },
      },
    })
    const s2 = projectionAssistant("msg_s3", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "summary three",
    })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })
    const history = [...head(), prior.u, prior.s, tail, tailReply, u2, s2, y]

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([
      u2.info.id,
      s2.info.id,
      tail.info.id,
      tailReply.info.id,
      y.info.id,
    ])
    expect(projectionText(filtered)).not.toContain("head question")
    expect(projectionText(filtered)).not.toContain("summary one")
  })

  test("a new queued compaction user never reaches model history", () => {
    const prior = priorPair()
    const queued = projectionUser("msg_queued", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "queued" } },
    })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })

    const withPrior = project([...head(), prior.u, prior.s, queued, y])
    expect(projectionIDs(withPrior)).toEqual([prior.u.info.id, prior.s.info.id, y.info.id])

    const withoutPrior = project([...head(), queued, y])
    expect(projectionIDs(withoutPrior)).toEqual(["msg_head", "msg_head_reply", y.info.id])
    expect(projectionIDs(withoutPrior)).not.toContain(queued.info.id)
  })

  test("a preparing user with a streaming summary stays out of model history", () => {
    const prior = priorPair()
    const preparing = projectionUser("msg_prep", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "preparing" } },
    })
    const streaming = projectionAssistant("msg_stream", {
      parentID: preparing.info.id,
      created: 310,
      summary: true,
      unfinished: true,
      text: "partial summary",
    })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })

    const filtered = project([...head(), prior.u, prior.s, preparing, streaming, y])

    expect(projectionIDs(filtered)).toEqual([prior.u.info.id, prior.s.info.id, y.info.id])
    expect(projectionText(filtered)).not.toContain("partial summary")
  })

  test("a preparing user with a completed summary stays out of model history", () => {
    const prior = priorPair()
    const preparing = projectionUser("msg_prep", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "preparing" } },
    })
    const complete = projectionAssistant("msg_done", {
      parentID: preparing.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "completed unpublished summary",
    })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })

    const filtered = project([...head(), prior.u, prior.s, preparing, complete, y])

    expect(projectionIDs(filtered)).toEqual([prior.u.info.id, prior.s.info.id, y.info.id])
    expect(projectionText(filtered)).not.toContain("completed unpublished summary")
    expect(projectionText(filtered)).toContain("summary one")
  })

  test("an abandoned candidate stays out of model history", () => {
    const prior = priorPair()
    const abandoned = projectionUser("msg_aband", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "abandoned" } },
    })
    const summary = projectionAssistant("msg_aband_s", {
      parentID: abandoned.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "abandoned summary",
    })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })

    const filtered = project([...head(), prior.u, prior.s, abandoned, summary, y])

    expect(projectionIDs(filtered)).toEqual([prior.u.info.id, prior.s.info.id, y.info.id])
    expect(projectionText(filtered)).not.toContain("abandoned summary")
  })

  test("an orphan synthetic user without a compaction part stays out of model history", () => {
    const prior = priorPair()
    const orphan = projectionUser("msg_orphan", { created: 300, origin: "compaction", text: "orphan marker" })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })

    const withPrior = project([...head(), prior.u, prior.s, orphan, y])
    expect(projectionIDs(withPrior)).toEqual([prior.u.info.id, prior.s.info.id, y.info.id])
    expect(projectionText(withPrior)).not.toContain("orphan marker")

    const withoutPrior = project([...head(), orphan, y])
    expect(projectionIDs(withoutPrior)).toEqual(["msg_head", "msg_head_reply", y.info.id])
  })

  test("a newer invalid summary does not displace the prior published pair", () => {
    const prior = priorPair()
    const u2 = projectionUser("msg_u2", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_s2") } },
    })
    const failed = projectionAssistant("msg_s2", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "error",
      error: new SessionV1.AbortedError({ message: "compaction failed" }).toObject(),
      text: "failed summary",
    })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })

    const filtered = project([...head(), prior.u, prior.s, u2, failed, y])

    expect(projectionIDs(filtered)).toEqual([prior.u.info.id, prior.s.info.id, y.info.id])
    expect(projectionText(filtered)).toContain("summary one")
    expect(projectionText(filtered)).not.toContain("failed summary")
  })

  test("later genuine user turns survive a published boundary", () => {
    const prior = priorPair()
    const preparing = projectionUser("msg_prep", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "preparing" } },
    })
    const streaming = projectionAssistant("msg_stream", {
      parentID: preparing.info.id,
      created: 310,
      summary: true,
      unfinished: true,
      text: "partial summary",
    })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })
    const ya = projectionAssistant("msg_y_reply", {
      parentID: y.info.id,
      created: 410,
      finish: "end_turn",
      text: "later genuine reply",
    })

    const filtered = project([...head(), prior.u, prior.s, preparing, streaming, y, ya])

    expect(projectionIDs(filtered)).toEqual([prior.u.info.id, prior.s.info.id, y.info.id, ya.info.id])
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(projectionText(filtered)).toContain("later genuine reply")
    expect(projectionText(filtered)).not.toContain("partial summary")
  })

  test("chained published summaries select the newest pair, including upgraded legacy publication", () => {
    const legacyChain = () => {
      const first = priorPair()
      const secondU = projectionUser("msg_u2", { created: 300, compaction: {} })
      const secondS = projectionAssistant("msg_s2", {
        parentID: secondU.info.id,
        created: 310,
        summary: true,
        finish: "end_turn",
        text: "summary two",
      })
      const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })
      return { history: [...head(), first.u, first.s, secondU, secondS, y], secondU, secondS, first, y }
    }

    const legacy = legacyChain()
    const legacyFiltered = project(legacy.history)
    expect(projectionIDs(legacyFiltered)).toEqual([
      legacy.secondU.info.id,
      legacy.secondS.info.id,
      legacy.y.info.id,
    ])
    expect(legacyFiltered.filter((msg) => msg.info.role === "assistant" && msg.info.summary)).toHaveLength(1)
    expect(projectionText(legacyFiltered)).not.toContain("summary one")

    const first = priorPair()
    const upgradedU = projectionUser("msg_u2", {
      created: 300,
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_s2") } },
    })
    const upgradedS = projectionAssistant("msg_s2", {
      parentID: upgradedU.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "summary two",
    })
    const y = projectionUser("msg_y", { created: 400, text: "later genuine question" })
    const upgraded = project([...head(), first.u, first.s, upgradedU, upgradedS, y])

    expect(projectionIDs(upgraded)).toEqual([upgradedU.info.id, upgradedS.info.id, y.info.id])
    expect(upgraded.filter((msg) => msg.info.role === "assistant" && msg.info.summary)).toHaveLength(1)
    expect(projectionText(upgraded)).not.toContain("summary one")
    expect(projectionText(upgraded)).toContain("summary two")
  })

  itPersisted.instance("persisted projection excludes provisional pairs without mutating raw history", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})

      const headUser = yield* ssn.updateMessage({
        id: MessageID.make("msg_p_head"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID, modelID: ModelV2.ID.make("test") },
        time: { created: 100 },
      })
      yield* ssn.updatePart({
        id: PartID.make("prt_p_head"),
        sessionID: session.id,
        messageID: headUser.id,
        type: "text",
        text: "head question",
      })

      const compaction = yield* ssn.updateMessage({
        id: MessageID.make("msg_p_c1"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID, modelID: ModelV2.ID.make("test") },
        time: { created: 200 },
      })
      yield* ssn.updatePart({
        id: PartID.make("prt_p_c1"),
        sessionID: session.id,
        messageID: compaction.id,
        type: "compaction",
        auto: true,
      })

      const summary = yield* ssn.updateMessage({
        id: MessageID.make("msg_p_s1"),
        role: "assistant",
        parentID: compaction.id,
        sessionID: session.id,
        mode: "compaction",
        agent: "compaction",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test"),
        providerID,
        summary: true,
        finish: "end_turn",
        time: { created: 210 },
      } as unknown as SessionV1.Info)
      yield* ssn.updatePart({
        id: PartID.make("prt_p_s1"),
        sessionID: session.id,
        messageID: summary.id,
        type: "text",
        text: "persisted summary",
      })

      const provisional = yield* ssn.updateMessage({
        id: MessageID.make("msg_p_prep"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID, modelID: ModelV2.ID.make("test") },
        time: { created: 300 },
        origin: "compaction",
      })
      yield* ssn.updatePart({
        id: PartID.make("prt_p_prep"),
        sessionID: session.id,
        messageID: provisional.id,
        type: "compaction",
        auto: true,
        publication: { state: "preparing" },
      })

      const provisionalSummary = yield* ssn.updateMessage({
        id: MessageID.make("msg_p_prep_s"),
        role: "assistant",
        parentID: provisional.id,
        sessionID: session.id,
        mode: "compaction",
        agent: "compaction",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test"),
        providerID,
        summary: true,
        finish: "end_turn",
        time: { created: 310 },
      } as unknown as SessionV1.Info)
      yield* ssn.updatePart({
        id: PartID.make("prt_p_prep_s"),
        sessionID: session.id,
        messageID: provisionalSummary.id,
        type: "text",
        text: "provisional summary",
      })

      const later = yield* ssn.updateMessage({
        id: MessageID.make("msg_p_y"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID, modelID: ModelV2.ID.make("test") },
        time: { created: 400 },
      })
      yield* ssn.updatePart({
        id: PartID.make("prt_p_y"),
        sessionID: session.id,
        messageID: later.id,
        type: "text",
        text: "later genuine question",
      })

      const rawBefore = yield* ssn.messages({ sessionID: session.id })
      const filtered = yield* MessageV2.filterCompactedEffect(session.id)
      const rawAfter = yield* ssn.messages({ sessionID: session.id })

      expect(projectionIDs(filtered)).toEqual(["msg_p_c1", "msg_p_s1", "msg_p_y"])
      expect(projectionText(filtered)).toContain("persisted summary")
      expect(projectionText(filtered)).not.toContain("provisional summary")
      expect(projectionText(filtered)).not.toContain("head question")
      expect(JSON.stringify(rawAfter)).toBe(JSON.stringify(rawBefore))

      const provisionalRaw = rawAfter.find((m) => m.info.id === "msg_p_prep")
      expect(
        provisionalRaw?.parts.some((item) => item.type === "compaction" && item.publication?.state === "preparing"),
      ).toBe(true)
    }),
  )

  itPersisted.instance("stale finalizer cannot demote a published summary; authorized removal still can", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service

      const build = Effect.fn("test.buildPublished")(function* () {
        const session = yield* ssn.create({})
        const owner = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID, modelID: ModelV2.ID.make("test") },
          time: { created: 100 },
          origin: "compaction",
        })
        const queued = yield* ssn.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: owner.id,
          type: "compaction",
          auto: true,
          publication: { state: "queued" },
        } as SessionV1.Part)
        const summary = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: owner.id,
          sessionID: session.id,
          mode: "compaction",
          agent: "compaction",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test"),
          providerID,
          summary: true,
          finish: "end_turn",
          time: { created: 110 },
        } as unknown as SessionV1.Info)
        const summaryText = yield* ssn.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: summary.id,
          type: "text",
          text: "published summary text",
        })
        yield* ssn.updatePart({
          ...queued,
          publication: { state: "published", summaryID: summary.id },
        } as SessionV1.CompactionPart)
        return { session, owner, queued, summary, summaryText }
      })

      // Negative control: an ordinary stale MessageUpdated that demotes the
      // published summary to finish:"error" is rejected by the projector
      // before event-log insertion. This is distinct from an authorized
      // MessageRemoved, which remains supported.
      const fixture = yield* build()
      const before = yield* ssn.messages({ sessionID: fixture.session.id })
      const demote = yield* ssn
        .updateMessage({
          ...fixture.summary,
          finish: "error",
          error: new SessionV1.AbortedError({ message: "late finalizer" }).toObject(),
        } as SessionV1.Info)
        .pipe(Effect.exit)
      expect(Exit.isSuccess(demote)).toBe(false)

      const afterFailed = yield* ssn.messages({ sessionID: fixture.session.id })
      expect(JSON.stringify(afterFailed)).toBe(JSON.stringify(before))
      const stored = afterFailed.find((msg) => msg.info.id === fixture.summary.id)
      const storedInfo = stored?.info as SessionV1.Assistant | undefined
      expect(storedInfo?.role).toBe("assistant")
      expect(storedInfo?.finish).toBe("end_turn")
      expect(storedInfo?.error).toBeUndefined()
      const storedOwner = afterFailed.find((msg) => msg.info.id === fixture.owner.id)
      const storedPart = storedOwner?.parts.find((part) => part.type === "compaction")
      expect(storedPart?.type === "compaction" && storedPart.publication?.state).toBe("published")
      expect(projectionIDs(yield* MessageV2.filterCompactedEffect(fixture.session.id))).toEqual([
        fixture.owner.id,
        fixture.summary.id,
      ])

      // The event sequence is unchanged: the authorized MessageRemoved path
      // still works afterwards, and only that explicit deletion removes S.
      yield* ssn.removeMessage({ sessionID: fixture.session.id, messageID: fixture.summary.id })
      const afterRemoval = yield* ssn.messages({ sessionID: fixture.session.id })
      expect(afterRemoval.map((msg) => msg.info.id)).not.toContain(fixture.summary.id)
      expect(projectionIDs(yield* MessageV2.filterCompactedEffect(fixture.session.id))).toEqual([])

      yield* ssn.remove(fixture.session.id).pipe(Effect.ignore)
    }),
  )
})

describe("session.message-v2 legacy scheduling compatibility", () => {
  const legacySchedulingFixture = (finalize: "unfinished" | "failed") => {
    const tailUser = projectionUser("msg_tail_u", { created: 160, text: "tail question" })
    const tailAssistant = projectionAssistant("msg_tail_a", {
      parentID: tailUser.info.id,
      created: 170,
      finish: "end_turn",
      text: "tail reply",
    })
    const c1 = projectionUser("msg_c1", { created: 200, compaction: { tail: tailUser.info.id } })
    const s1 = projectionAssistant("msg_sc1", {
      parentID: c1.info.id,
      created: 250,
      summary: true,
      finish: "end_turn",
      text: "summary one",
    })
    const c2 = projectionUser("msg_c2", { created: 300, compaction: {} })
    const s2 = projectionAssistant("msg_sc2", {
      parentID: c2.info.id,
      created: 350,
      summary: true,
      text: finalize === "failed" ? "failed summary" : "partial summary",
      ...(finalize === "failed"
        ? { finish: "error", error: new SessionV1.AbortedError({ message: "compaction failed" }).toObject() }
        : { unfinished: true }),
    })
    return {
      history: [tailUser, tailAssistant, c1, s1, c2, s2],
      tailUser,
      tailAssistant,
      c1,
      s1,
      c2,
      s2,
    }
  }

  const expectedOrder = (fixture: ReturnType<typeof legacySchedulingFixture>) => [
    fixture.c1.info.id,
    fixture.s1.info.id,
    fixture.tailUser.info.id,
    fixture.tailAssistant.info.id,
    fixture.c2.info.id,
    fixture.s2.info.id,
  ]

  test("case A: an unfinished legacy summary keeps the task under the chronological finished-relative cutoff", () => {
    const fixture = legacySchedulingFixture("unfinished")
    const filtered = project(fixture.history)

    expect(projectionIDs(filtered)).toEqual(expectedOrder(fixture))

    const state = MessageV2.latest(filtered)
    expect(state.user?.id).toBe(fixture.c2.info.id)
    expect(state.finished?.id).toBe(fixture.s1.info.id)
    expect(state.finished?.id).not.toBe(fixture.tailAssistant.info.id)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ type: "compaction", messageID: fixture.c2.info.id })
  })

  test("case B: a terminal failed legacy summary suppresses the legacy compaction task", () => {
    const fixture = legacySchedulingFixture("failed")
    const filtered = project(fixture.history)

    expect(projectionIDs(filtered)).toEqual(expectedOrder(fixture))

    const state = MessageV2.latest(filtered)
    expect(state.user?.id).toBe(fixture.c2.info.id)
    expect(state.finished?.id).toBe(fixture.s2.info.id)
    expect(state.finished?.finish).toBe("error")
    expect(state.tasks).toEqual([])
  })

  test("an explicit synthetic user missing publication metadata is not eligible legacy work", () => {
    const uX = projectionUser("msg_x", { created: 100, text: "genuine question" })
    const aX = projectionAssistant("msg_ax", {
      parentID: uX.info.id,
      created: 150,
      finish: "end_turn",
      text: "genuine reply",
    })
    const malformed = projectionUser("msg_mal", { created: 200, origin: "compaction", compaction: {} })
    const sMal = projectionAssistant("msg_smal", {
      parentID: malformed.info.id,
      created: 250,
      summary: true,
      finish: "end_turn",
      text: "misclassified summary",
    })

    const filtered = project([uX, aX, malformed, sMal])

    expect(projectionIDs(filtered)).toEqual([uX.info.id, aX.info.id])
    const state = MessageV2.latest(filtered)
    expect(state.user?.id).toBe(uX.info.id)
    expect(state.finished?.id).toBe(aX.info.id)
    expect(state.tasks).toEqual([])
  })
})

describe("session.message-v2 failed strict-legacy summary without error object", () => {
  const work = (chronological: SessionV1.WithParts[]) => MessageV2.pendingWork(chronological.toReversed())

  const legacyFixture = (finalize: "failed-no-error" | "unfinished") => {
    const priorU = projectionUser("msg_fe_u1", { created: 200, compaction: {} })
    const priorS = projectionAssistant("msg_fe_s1", {
      parentID: priorU.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "summary one",
    })
    const failedU = projectionUser("msg_fe_u2", { created: 300, compaction: {} })
    const failedS = projectionAssistant("msg_fe_s2", {
      parentID: failedU.info.id,
      created: 310,
      summary: true,
      text: finalize === "failed-no-error" ? "failed summary" : "partial summary",
      ...(finalize === "failed-no-error" ? { finish: "error" } : { unfinished: true }),
    })
    return { priorU, priorS, failedU, failedS }
  }

  test("a failed strict-legacy pair (finish:'error', no error object) does not replace the prior published pair", () => {
    const fixture = legacyFixture("failed-no-error")
    const filtered = project([fixture.priorU, fixture.priorS, fixture.failedU, fixture.failedS])

    expect(projectionIDs(filtered)).toEqual([
      fixture.priorU.info.id,
      fixture.priorS.info.id,
      fixture.failedU.info.id,
      fixture.failedS.info.id,
    ])
    expect(projectionText(filtered)).toContain("summary one")
    expect(projectionText(filtered)).toContain("failed summary")
  })

  test("failed strict-legacy U is not runnable while unfinished strict-legacy U stays runnable", () => {
    const failed = legacyFixture("failed-no-error")
    const failedTasks = work([failed.priorU, failed.priorS, failed.failedU, failed.failedS]).tasks
    expect(failedTasks).toEqual([])

    const unfinished = legacyFixture("unfinished")
    const unfinishedTasks = work([
      unfinished.priorU,
      unfinished.priorS,
      unfinished.failedU,
      unfinished.failedS,
    ]).tasks
    expect(unfinishedTasks).toHaveLength(1)
    expect(unfinishedTasks[0]).toMatchObject({ type: "compaction", messageID: unfinished.failedU.info.id })
  })

  test("unfinished strict-legacy pair keeps the same full-visibility projection as the historical reader", () => {
    const unfinished = legacyFixture("unfinished")
    const filtered = project([unfinished.priorU, unfinished.priorS, unfinished.failedU, unfinished.failedS])
    expect(projectionIDs(filtered)).toEqual([
      unfinished.priorU.info.id,
      unfinished.priorS.info.id,
      unfinished.failedU.info.id,
      unfinished.failedS.info.id,
    ])
  })
})

describe("session.message-v2.filterCompacted multi-summary legacy pairs", () => {
  const fixture = (stale: "failed" | "incomplete", retainedTail: boolean) => {
    const headUser = projectionUser("msg_ms_head", { created: 100, text: "head question" })
    const headReply = projectionAssistant("msg_ms_head_reply", {
      parentID: headUser.info.id,
      created: 110,
      finish: "end_turn",
      text: "head reply",
    })
    const tailTurn = projectionUser("msg_ms_tail", { created: 150, text: "retained turn" })
    const owner = projectionUser("msg_ms_owner", {
      created: 200,
      compaction: retainedTail ? { tail: tailTurn.info.id } : {},
    })
    const staleSummary = projectionAssistant("msg_ms_stale", {
      parentID: owner.info.id,
      created: 210,
      summary: true,
      text: stale === "failed" ? "stale failed summary" : "stale partial summary",
      ...(stale === "failed"
        ? { finish: "error", error: new SessionV1.AbortedError({ message: "compaction failed" }).toObject() }
        : { unfinished: true }),
    })
    const validated = projectionAssistant("msg_ms_valid", {
      parentID: owner.info.id,
      created: 220,
      summary: true,
      finish: "end_turn",
      text: "validated summary",
    })
    const later = projectionUser("msg_ms_y", { created: 400, text: "later genuine question" })
    const history = retainedTail
      ? [headUser, headReply, tailTurn, owner, staleSummary, validated, later]
      : [headUser, headReply, owner, staleSummary, validated, later]
    const expected = retainedTail
      ? [owner.info.id, validated.info.id, tailTurn.info.id, later.info.id]
      : [owner.info.id, validated.info.id, later.info.id]
    return { history, expected, owner, staleSummary, validated, later }
  }

  for (const stale of ["failed", "incomplete"] as const) {
    for (const retainedTail of [false, true]) {
      const tailLabel = retainedTail ? "with a retained tail" : "without a tail"
      test(`the validated summary after an older ${stale} child is the boundary ${tailLabel}`, () => {
        const f = fixture(stale, retainedTail)
        const before = JSON.stringify(f.history)

        const filtered = project(f.history)

        expect(projectionIDs(filtered)).toEqual(f.expected)
        expect(projectionIDs(filtered).filter((id) => id === f.validated.info.id)).toHaveLength(1)
        expect(projectionIDs(filtered)).not.toContain(f.staleSummary.info.id)
        expect(projectionText(filtered)).toContain("validated summary")
        expect(projectionText(filtered)).toContain("later genuine question")
        expect(projectionText(filtered)).not.toContain(
          stale === "failed" ? "stale failed summary" : "stale partial summary",
        )
        expect(projectionText(filtered)).not.toContain("head question")
        expect(JSON.stringify(f.history)).toBe(before)
      })
    }
  }
})

describe("session.message-v2.filterCompacted invalid retained-tail pointers", () => {
  const fixture = (options: {
    tail: (ownerID: string) => string
    previousPair: boolean
    legacyOwner?: boolean
  }) => {
    const headUser = projectionUser("msg_it_head", { created: 100, text: "head question" })
    const headReply = projectionAssistant("msg_it_head_reply", {
      parentID: headUser.info.id,
      created: 110,
      finish: "end_turn",
      text: "head reply",
    })
    const previousOwner = projectionUser("msg_it_u1", { created: 200, compaction: {} })
    const previousSummary = projectionAssistant("msg_it_s1", {
      parentID: previousOwner.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "summary one",
    })
    const middle = projectionUser("msg_it_middle", { created: 250, text: "middle turn" })
    const newerOwner = projectionUser("msg_it_u2", {
      created: 300,
      ...(options.legacyOwner ? {} : { origin: "compaction" }),
      compaction: {
        tail: options.tail("msg_it_u2"),
        ...(options.legacyOwner
          ? {}
          : { publication: { state: "published" as const, summaryID: MessageID.make("msg_it_s2") } }),
      },
    })
    const newerSummary = projectionAssistant("msg_it_s2", {
      parentID: newerOwner.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "summary two",
    })
    const later = projectionUser("msg_it_y", { created: 400, text: "later genuine question" })
    const prior = options.previousPair ? [previousOwner, previousSummary] : []
    const history = [headUser, headReply, ...prior, middle, newerOwner, newerSummary, later]
    const expected = options.previousPair
      ? [previousOwner.info.id, previousSummary.info.id, middle.info.id, later.info.id]
      : [headUser.info.id, headReply.info.id, middle.info.id, later.info.id]
    return {
      history,
      expected,
      headUser,
      previousOwner,
      previousSummary,
      middle,
      newerOwner,
      newerSummary,
      later,
    }
  }

  const previousBoundaryFallbackTests: {
    name: string
    options: Parameters<typeof fixture>[0]
  }[] = [
    {
      name: "a published tail pointing at its own compaction user falls back to the previous boundary",
      options: { tail: (ownerID) => ownerID, previousPair: true },
    },
    {
      name: "a published tail pointing after its owner falls back to the previous boundary",
      options: { tail: () => "msg_it_y", previousPair: true },
    },
    {
      name: "a published tail referencing a missing message falls back to the previous boundary",
      options: { tail: () => "msg_it_missing", previousPair: true },
    },
    {
      name: "a completed legacy pair with a self-referencing tail falls back to the previous boundary",
      options: { tail: (ownerID) => ownerID, previousPair: true, legacyOwner: true },
    },
  ]

  for (const entry of previousBoundaryFallbackTests) {
    test(entry.name, () => {
      const f = fixture(entry.options)
      const before = JSON.stringify(f.history)

      const filtered = project(f.history)

      expect(projectionIDs(filtered)).toEqual(f.expected)
      expect(projectionIDs(filtered)[0]).toBe(f.previousOwner.info.id)
      expect(projectionIDs(filtered)).not.toContain(f.newerOwner.info.id)
      expect(projectionIDs(filtered)).not.toContain(f.newerSummary.info.id)
      expect(projectionText(filtered)).toContain("summary one")
      expect(projectionText(filtered)).toContain("middle turn")
      expect(projectionText(filtered)).toContain("later genuine question")
      expect(projectionText(filtered)).not.toContain("summary two")
      expect(projectionText(filtered)).not.toContain("head question")
      const state = MessageV2.latest(filtered)
      expect(state.finished?.id).toBe(f.previousSummary.info.id)
      expect(state.tasks).toEqual([])
      expect(JSON.stringify(f.history)).toBe(before)
    })
  }

  test("a published invalid-tail candidate with no previous pair leaves genuine un-compacted history", () => {
    const f = fixture({ tail: (ownerID) => ownerID, previousPair: false })
    const before = JSON.stringify(f.history)

    const filtered = project(f.history)

    expect(projectionIDs(filtered)).toEqual(f.expected)
    expect(projectionIDs(filtered)[0]).toBe(f.headUser.info.id)
    expect(projectionIDs(filtered)).not.toContain(f.newerOwner.info.id)
    expect(projectionIDs(filtered)).not.toContain(f.newerSummary.info.id)
    expect(projectionText(filtered)).toContain("head question")
    expect(projectionText(filtered)).toContain("middle turn")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(projectionText(filtered)).not.toContain("summary two")
    expect(JSON.stringify(f.history)).toBe(before)
  })

  test("a completed legacy invalid-tail candidate with no previous pair leaves genuine un-compacted history", () => {
    const f = fixture({ tail: (ownerID) => ownerID, previousPair: false, legacyOwner: true })
    const before = JSON.stringify(f.history)

    const filtered = project(f.history)

    expect(projectionIDs(filtered)).toEqual(f.expected)
    expect(projectionIDs(filtered)[0]).toBe(f.headUser.info.id)
    expect(projectionIDs(filtered)).not.toContain(f.newerOwner.info.id)
    expect(projectionIDs(filtered)).not.toContain(f.newerSummary.info.id)
    expect(projectionText(filtered)).toContain("head question")
    expect(projectionText(filtered)).toContain("middle turn")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(projectionText(filtered)).not.toContain("summary two")
    const state = MessageV2.latest(filtered)
    expect(state.tasks).toEqual([])
    expect(JSON.stringify(f.history)).toBe(before)
  })

  test("controls: valid legacy full and tailed summaries remain the applicable projection", () => {
    const head = projectionUser("msg_ctl_head", { created: 100, text: "head question" })
    const tailTurn = projectionUser("msg_ctl_tail", { created: 150, text: "retained turn" })
    const fullOwner = projectionUser("msg_ctl_full", { created: 200, compaction: {} })
    const fullSummary = projectionAssistant("msg_ctl_full_s", {
      parentID: fullOwner.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "full summary",
    })
    const later = projectionUser("msg_ctl_y", { created: 400, text: "later genuine question" })
    expect(projectionIDs(project([head, fullOwner, fullSummary, later]))).toEqual([
      fullOwner.info.id,
      fullSummary.info.id,
      later.info.id,
    ])

    const tailedOwner = projectionUser("msg_ctl_tailed", { created: 200, compaction: { tail: tailTurn.info.id } })
    const tailedSummary = projectionAssistant("msg_ctl_tailed_s", {
      parentID: tailedOwner.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "tailed summary",
    })
    expect(projectionIDs(project([head, tailTurn, tailedOwner, tailedSummary, later]))).toEqual([
      tailedOwner.info.id,
      tailedSummary.info.id,
      tailTurn.info.id,
      later.info.id,
    ])
  })
})

describe("session.message-v2.filterCompacted orphan summary visibility", () => {
  test("a summary whose compaction owner is missing is not model-visible", () => {
    const priorOwner = projectionUser("msg_or_ph", { created: 200, compaction: {} })
    const priorSummary = projectionAssistant("msg_or_ps", {
      parentID: priorOwner.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "summary one",
    })
    const orphan = projectionAssistant("msg_or_s", {
      parentID: "msg_or_missing_owner",
      created: 300,
      summary: true,
      finish: "end_turn",
      text: "orphan summary",
    })
    const later = projectionUser("msg_or_y", { created: 400, text: "later genuine question" })
    const history = [priorOwner, priorSummary, orphan, later]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([priorOwner.info.id, priorSummary.info.id, later.info.id])
    expect(projectionIDs(filtered)).not.toContain(orphan.info.id)
    expect(projectionText(filtered)).not.toContain("orphan summary")
    expect(projectionText(filtered)).toContain("summary one")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(JSON.stringify(history)).toBe(before)
  })
})

describe("session.message-v2.filterCompacted lazy stream enumeration", () => {
  const originalEarlyStopScanConsumed = (records: SessionV1.WithParts[]) => {
    const completed = new Set<string>()
    let retain: MessageID | undefined
    let consumed = 0
    for (const msg of records) {
      consumed++
      if (retain) {
        if (msg.info.id === retain) break
        continue
      }
      if (msg.info.role === "user" && completed.has(msg.info.id)) {
        const part = msg.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
        if (!part) continue
        if (!part.tail_start_id) break
        retain = part.tail_start_id
        if (msg.info.id === retain) break
        continue
      }
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
        completed.add(msg.info.parentID)
    }
    return consumed
  }

  test("a recent published boundary does not stop enumeration of a lazy stream", () => {
    const boundaryOwner = projectionUser("msg_perf_owner", { created: 6000, compaction: {} })
    const boundarySummary = projectionAssistant("msg_perf_summary", {
      parentID: boundaryOwner.info.id,
      created: 6010,
      summary: true,
      finish: "end_turn",
      text: "boundary summary",
    })
    const later = projectionUser("msg_perf_later", { created: 6100, text: "later turn" })
    const head: SessionV1.WithParts[] = []
    for (let i = 0; i < 5000; i++) {
      head.push(projectionUser(`msg_perf_head_${i}`, { created: 1 + i, text: `head ${i}` }))
    }
    const streamOrder = [later, boundarySummary, boundaryOwner, ...head.toReversed()]
    let consumed = 0
    const lazy: Iterable<SessionV1.WithParts> = {
      *[Symbol.iterator]() {
        for (const msg of streamOrder) {
          consumed++
          yield msg
        }
      },
    }

    const filtered = MessageV2.filterCompacted(lazy)

    expect(projectionIDs(filtered)).toEqual([boundaryOwner.info.id, boundarySummary.info.id, later.info.id])
    expect(consumed).toBe(5003)
    expect(consumed).toBe(streamOrder.length)

    const earlyStopConsumed = originalEarlyStopScanConsumed(streamOrder)
    expect(earlyStopConsumed).toBe(3)
    expect(earlyStopConsumed).toBeLessThan(consumed)
  })
})

describe("session.message-v2.filterCompacted hidden retained-tail anchor", () => {
  const historical = () => {
    const h = projectionUser("msg_gate_h", { created: 100, text: "historical question" })
    const hr = projectionAssistant("msg_gate_h_reply", {
      parentID: h.info.id,
      created: 110,
      finish: "end_turn",
      text: "historical reply",
    })
    return { h, hr }
  }

  const publishedPair = (input: { ownerID: string; summaryID: string; created: number; text: string }) => {
    const owner = projectionUser(input.ownerID, {
      created: input.created,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make(input.summaryID) } },
    })
    const summary = projectionAssistant(input.summaryID, {
      parentID: owner.info.id,
      created: input.created + 10,
      summary: true,
      finish: "end_turn",
      text: input.text,
    })
    return { owner, summary }
  }

  const queuedU = () =>
    projectionUser("msg_gate_uq", {
      created: 200,
      origin: "compaction",
      compaction: { publication: { state: "queued" } },
    })

  test("a hidden queued synthetic user cannot anchor an applicable published retained tail", () => {
    const { h, hr } = historical()
    const prior = publishedPair({
      ownerID: "msg_gate_u1",
      summaryID: "msg_gate_s1",
      created: 150,
      text: "summary one",
    })
    const uq = queuedU()
    const y1 = projectionUser("msg_gate_y1", { created: 250, text: "later genuine question" })
    const u2 = projectionUser("msg_gate_u2", {
      created: 300,
      origin: "compaction",
      compaction: {
        tail: uq.info.id,
        publication: { state: "published", summaryID: MessageID.make("msg_gate_s2") },
      },
    })
    const s2 = projectionAssistant("msg_gate_s2", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "summary two",
    })
    const y2 = projectionUser("msg_gate_y2", { created: 400, text: "newest genuine question" })
    const history = [h, hr, prior.owner, prior.summary, uq, y1, u2, s2, y2]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([prior.owner.info.id, prior.summary.info.id, y1.info.id, y2.info.id])
    expect(projectionText(filtered)).toContain("summary one")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(projectionText(filtered)).toContain("newest genuine question")
    expect(projectionText(filtered)).not.toContain("summary two")
    expect(projectionText(filtered)).not.toContain("historical question")
    expect(projectionIDs(filtered)).not.toContain(uq.info.id)
    expect(projectionIDs(filtered)).not.toContain(u2.info.id)
    expect(projectionIDs(filtered)).not.toContain(s2.info.id)
    expect(JSON.stringify(history)).toBe(before)
  })

  test("a hidden queued synthetic tail with no older publication leaves genuine un-compacted history", () => {
    const { h, hr } = historical()
    const uq = queuedU()
    const y1 = projectionUser("msg_gate_ny1", { created: 250, text: "later genuine question" })
    const u2 = projectionUser("msg_gate_nu2", {
      created: 300,
      origin: "compaction",
      compaction: {
        tail: uq.info.id,
        publication: { state: "published", summaryID: MessageID.make("msg_gate_ns2") },
      },
    })
    const s2 = projectionAssistant("msg_gate_ns2", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "summary two",
    })
    const y2 = projectionUser("msg_gate_ny2", { created: 400, text: "newest genuine question" })
    const history = [h, hr, uq, y1, u2, s2, y2]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([h.info.id, hr.info.id, y1.info.id, y2.info.id])
    expect(projectionText(filtered)).toContain("historical question")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(projectionText(filtered)).toContain("newest genuine question")
    expect(projectionText(filtered)).not.toContain("summary two")
    expect(projectionIDs(filtered)).not.toContain(uq.info.id)
    expect(projectionIDs(filtered)).not.toContain(u2.info.id)
    expect(projectionIDs(filtered)).not.toContain(s2.info.id)
    expect(JSON.stringify(history)).toBe(before)
  })

  test("a completed legacy pair referencing a hidden synthetic tail is not an applicable projection", () => {
    const { h, hr } = historical()
    const priorOwner = projectionUser("msg_gate_lu1", { created: 150, compaction: {} })
    const priorSummary = projectionAssistant("msg_gate_ls1", {
      parentID: priorOwner.info.id,
      created: 160,
      summary: true,
      finish: "end_turn",
      text: "summary one",
    })
    const uq = queuedU()
    const y1 = projectionUser("msg_gate_ly1", { created: 250, text: "later genuine question" })
    const u2 = projectionUser("msg_gate_lu2", { created: 300, compaction: { tail: uq.info.id } })
    const s2 = projectionAssistant("msg_gate_ls2", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "summary two",
    })
    const y2 = projectionUser("msg_gate_ly2", { created: 400, text: "newest genuine question" })
    const history = [h, hr, priorOwner, priorSummary, uq, y1, u2, s2, y2]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([priorOwner.info.id, priorSummary.info.id, y1.info.id, y2.info.id])
    expect(projectionText(filtered)).toContain("summary one")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(projectionText(filtered)).not.toContain("summary two")
    expect(projectionIDs(filtered)).not.toContain(uq.info.id)
    expect(projectionIDs(filtered)).not.toContain(u2.info.id)
    expect(projectionIDs(filtered)).not.toContain(s2.info.id)
    expect(JSON.stringify(history)).toBe(before)
  })

  test("a valid retained tail beginning at an assistant message keeps the established ordering", () => {
    const h = projectionUser("msg_gate_ah", { created: 100, text: "historical question" })
    const anchor = projectionAssistant("msg_gate_anchor", {
      parentID: h.info.id,
      created: 110,
      finish: "end_turn",
      text: "retained assistant reply",
    })
    const owner = projectionUser("msg_gate_au", {
      created: 300,
      origin: "compaction",
      compaction: {
        tail: anchor.info.id,
        publication: { state: "published", summaryID: MessageID.make("msg_gate_as") },
      },
    })
    const summary = projectionAssistant("msg_gate_as", {
      parentID: owner.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "assistant-tail summary",
    })
    const later = projectionUser("msg_gate_ay", { created: 400, text: "later genuine question" })
    const history = [h, anchor, owner, summary, later]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([owner.info.id, summary.info.id, anchor.info.id, later.info.id])
    expect(projectionText(filtered)).toContain("assistant-tail summary")
    expect(projectionText(filtered)).toContain("retained assistant reply")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(projectionText(filtered)).not.toContain("historical question")
    expect(JSON.stringify(history)).toBe(before)
  })
})

describe("session.message-v2.pendingWork raw discovery", () => {
  const work = (chronological: SessionV1.WithParts[]) => MessageV2.pendingWork(chronological.toReversed())
  const runnableIDs = (chronological: SessionV1.WithParts[]) => work(chronological).tasks.map((task) => task.messageID)

  test("a queued synthetic compaction user is pending work while hidden from model history", () => {
    const x = projectionUser("msg_pw_x", { created: 100, text: "question" })
    const b = projectionAssistant("msg_pw_b", {
      parentID: x.info.id,
      created: 110,
      finish: "stop",
      text: "answer",
    })
    const uq = projectionUser("msg_pw_uq", {
      created: 200,
      origin: "compaction",
      compaction: { publication: { state: "queued" } },
    })
    const history = [x, b, uq]
    const before = JSON.stringify(history)

    const filtered = project(history)
    const tasks = work(history).tasks

    expect(projectionIDs(filtered)).not.toContain(uq.info.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ type: "compaction", messageID: uq.info.id })
    expect(JSON.stringify(history)).toBe(before)
  })

  test("published, preparing, abandoned and completed-unpublished candidates are not runnable", () => {
    const x = projectionUser("msg_cl_x", { created: 100, text: "question" })
    const b = projectionAssistant("msg_cl_b", {
      parentID: x.info.id,
      created: 110,
      finish: "stop",
      text: "answer",
    })
    const published = projectionUser("msg_cl_pub", {
      created: 200,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_cl_pub_s") } },
    })
    const publishedS = projectionAssistant("msg_cl_pub_s", {
      parentID: published.info.id,
      created: 210,
      summary: true,
      finish: "stop",
      text: "summary",
    })
    const preparing = projectionUser("msg_cl_prep", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "preparing" } },
    })
    const preparingS = projectionAssistant("msg_cl_prep_s", {
      parentID: preparing.info.id,
      created: 310,
      summary: true,
      finish: "stop",
      text: "unpublished summary",
    })
    const abandoned = projectionUser("msg_cl_aban", {
      created: 400,
      origin: "compaction",
      compaction: { publication: { state: "abandoned" } },
    })
    const queued = projectionUser("msg_cl_queued", {
      created: 500,
      origin: "compaction",
      compaction: { publication: { state: "queued" } },
    })
    const history = [x, b, published, publishedS, preparing, preparingS, abandoned, queued]

    expect(runnableIDs(history)).toEqual([queued.info.id])
  })

  test("orphan, malformed, recovery-preparation and unknown-origin synthetics are inert", () => {
    const x = projectionUser("msg_in_x", { created: 100, text: "question" })
    const orphan = projectionUser("msg_in_orphan", { created: 200, origin: "compaction" })
    const orphanText = projectionUser("msg_in_orphan_text", {
      created: 250,
      origin: "compaction",
      text: "accidental text",
    })
    const malformed = projectionUser("msg_in_malformed", {
      created: 300,
      origin: "compaction",
      compaction: {},
    })
    const recovery = projectionUser("msg_in_recovery", {
      created: 400,
      origin: "recovery-preparation",
      compaction: { publication: { state: "queued" } },
    })
    const unknown = projectionUser("msg_in_unknown", {
      created: 500,
      origin: "future-origin",
      compaction: { publication: { state: "queued" } },
    })
    const history = [x, orphan, orphanText, malformed, recovery, unknown]

    expect(work(history).tasks).toEqual([])
    const filtered = project(history)
    expect(projectionIDs(filtered)).toEqual([x.info.id])
  })

  test("strict legacy compaction keeps the historical finished-relative cutoff", () => {
    const head = projectionUser("msg_lg_head", { created: 100, text: "head" })
    const reply = projectionAssistant("msg_lg_reply", {
      parentID: head.info.id,
      created: 110,
      finish: "stop",
      text: "reply",
    })
    const legacyU = projectionUser("msg_lg_u", { created: 200, compaction: {} })
    const unfinishedS = projectionAssistant("msg_lg_s", {
      parentID: legacyU.info.id,
      created: 210,
      summary: true,
      unfinished: true,
      text: "partial summary",
    })
    const unfinishedHistory = [head, reply, legacyU, unfinishedS]
    expect(runnableIDs(unfinishedHistory)).toEqual([legacyU.info.id])

    const failedS = projectionAssistant("msg_lg_s2", {
      parentID: legacyU.info.id,
      created: 210,
      summary: true,
      finish: "error",
      error: new SessionV1.AbortedError({ message: "compaction failed" }).toObject(),
      text: "failed summary",
    })
    const failedHistory = [head, reply, legacyU, failedS]
    expect(work(failedHistory).tasks).toEqual([])
  })

  test("an explicit synthetic origin without publication metadata is malformed, not legacy", () => {
    const head = projectionUser("msg_mf_head", { created: 100, text: "head" })
    const reply = projectionAssistant("msg_mf_reply", {
      parentID: head.info.id,
      created: 110,
      finish: "stop",
      text: "reply",
    })
    const malformed = projectionUser("msg_mf_u", { created: 200, origin: "compaction", compaction: {} })
    const summary = projectionAssistant("msg_mf_s", {
      parentID: malformed.info.id,
      created: 210,
      summary: true,
      finish: "stop",
      text: "misclassified summary",
    })

    expect(work([head, reply, malformed, summary]).tasks).toEqual([])
  })

  test("pending subtasks are preserved with deterministic newest-first pop ordering", () => {
    const finished = projectionAssistant("msg_od_finished", {
      parentID: "msg_od_parent",
      created: 100,
      finish: "stop",
      text: "done",
    })
    const older = projectionUser("msg_od_older", { created: 200, text: "older turn" })
    older.parts.push({
      ...basePart("msg_od_older", "subtask_older"),
      type: "subtask",
      prompt: "older subtask",
      description: "older",
      agent: "general",
    } as SessionV1.Part)
    const newer = projectionUser("msg_od_newer", { created: 300, text: "newer turn" })
    newer.parts.push({
      ...basePart("msg_od_newer", "subtask_newer"),
      type: "subtask",
      prompt: "newer subtask",
      description: "newer",
      agent: "general",
    } as SessionV1.Part)
    const queued = projectionUser("msg_od_queued", {
      created: 400,
      origin: "compaction",
      compaction: { publication: { state: "queued" } },
    })

    const tasks = work([finished, older, newer, queued]).tasks
    expect(tasks.map((task) => task.messageID)).toEqual([older.info.id, newer.info.id, queued.info.id])
    expect(tasks.pop()!.messageID).toBe(queued.info.id)
    expect(tasks.map((task) => task.messageID)).toEqual([older.info.id, newer.info.id])
    expect(tasks.filter((task) => task.type === "subtask")).toHaveLength(2)
  })

  test("negative control: deriving pending work only from model-visible history loses the queued task", () => {
    const x = projectionUser("msg_nc_x", { created: 100, text: "question" })
    const b = projectionAssistant("msg_nc_b", {
      parentID: x.info.id,
      created: 110,
      finish: "stop",
      text: "answer",
    })
    const uq = projectionUser("msg_nc_uq", {
      created: 200,
      origin: "compaction",
      compaction: { publication: { state: "queued" } },
    })
    const history = [x, b, uq]

    const productionModelHistory = project(history)
    const productionPendingWork = work(history).tasks
    expect(projectionIDs(productionModelHistory)).not.toContain(uq.info.id)
    expect(productionPendingWork.map((task) => task.messageID)).toEqual([uq.info.id])

    const defectivePendingWork = (raw: SessionV1.WithParts[]) => MessageV2.latest(MessageV2.filterCompacted(raw)).tasks
    const acceptance = (tasks: SessionV1.Part[]) => {
      expect(tasks.map((task) => task.messageID)).toEqual([uq.info.id])
    }

    acceptance(productionPendingWork)
    expect(() => acceptance(defectivePendingWork(history.toReversed()))).toThrow()
  })
})

describe("session.message-v2.pendingWork finished-relative cutoff vs provisional summaries", () => {
  const work = (chronological: SessionV1.WithParts[]) => MessageV2.pendingWork(chronological.toReversed())
  const runnableIDs = (chronological: SessionV1.WithParts[]) => work(chronological).tasks.map((task) => task.messageID)
  const subtaskUser = (id: string, created: number) => {
    const user = projectionUser(id, { created, text: `${id} turn` })
    user.parts.push({
      ...basePart(id, `subtask_${id}`),
      type: "subtask",
      prompt: "pending subtask",
      description: "pending",
      agent: "general",
    } as SessionV1.Part)
    return user
  }
  const provisionalPair = () => {
    const u2 = projectionUser("msg_cut_prep_u", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "preparing" } },
    })
    const s2 = projectionAssistant("msg_cut_prep_s", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "stop",
      text: "provisional summary",
    })
    return { u2, s2 }
  }

  test("A1: a completed-but-unpublished summary does not suppress a later genuine subtask", () => {
    const x = projectionUser("msg_a1_x", { created: 100, text: "question" })
    const b = projectionAssistant("msg_a1_b", {
      parentID: x.info.id,
      created: 110,
      finish: "stop",
      text: "answer",
    })
    const y = subtaskUser("msg_a1_y", 200)
    const { u2, s2 } = provisionalPair()
    const history = [x, b, y, u2, s2]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([x.info.id, b.info.id, y.info.id])
    expect(projectionIDs(filtered)).not.toContain(u2.info.id)
    expect(projectionIDs(filtered)).not.toContain(s2.info.id)
    expect(runnableIDs(history)).toEqual([y.info.id])
    expect(work(history).tasks.filter((task) => task.type === "compaction")).toEqual([])
    expect(JSON.stringify(history)).toBe(before)
  })

  test("A1 positive control: ordinary finished replies and genuinely published summaries still advance the cutoff", () => {
    const x = projectionUser("msg_a1c_x", { created: 100, text: "question" })
    const early = subtaskUser("msg_a1c_early", 105)
    const b = projectionAssistant("msg_a1c_b", {
      parentID: x.info.id,
      created: 110,
      finish: "stop",
      text: "answer",
    })
    const legacyU = projectionUser("msg_a1c_legacy", { created: 150, compaction: {} })
    const legacyS = projectionAssistant("msg_a1c_legacy_s", {
      parentID: legacyU.info.id,
      created: 160,
      summary: true,
      unfinished: true,
      text: "partial legacy summary",
    })
    const pubU = projectionUser("msg_a1c_pub", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_a1c_pub_s") } },
    })
    const pubS = projectionAssistant("msg_a1c_pub_s", {
      parentID: pubU.info.id,
      created: 310,
      summary: true,
      finish: "stop",
      text: "published summary",
    })
    const queued = projectionUser("msg_a1c_queued", {
      created: 400,
      origin: "compaction",
      compaction: { publication: { state: "queued" } },
    })
    const history = [x, early, b, legacyU, legacyS, pubU, pubS, queued]

    expect(runnableIDs(history)).toEqual([queued.info.id])
  })

  test("A2: an unfinished legacy task survives a newer completed-but-unpublished summary", () => {
    const x = projectionUser("msg_a2_x", { created: 100, text: "question" })
    const b = projectionAssistant("msg_a2_b", {
      parentID: x.info.id,
      created: 110,
      finish: "stop",
      text: "answer",
    })
    const u1 = projectionUser("msg_a2_u1", { created: 200, compaction: {} })
    const s1 = projectionAssistant("msg_a2_s1", {
      parentID: u1.info.id,
      created: 210,
      summary: true,
      unfinished: true,
      text: "partial legacy summary",
    })
    const { u2, s2 } = provisionalPair()
    const history = [x, b, u1, s1, u2, s2]
    const before = JSON.stringify(history)

    expect(runnableIDs(history)).toEqual([u1.info.id])
    expect(runnableIDs(history)).not.toContain(u2.info.id)
    expect(JSON.stringify(history)).toBe(before)
  })

  test('A2 control: terminal legacy finish:"error" still suppresses the legacy task beside an unpublished candidate', () => {
    const x = projectionUser("msg_a2e_x", { created: 100, text: "question" })
    const b = projectionAssistant("msg_a2e_b", {
      parentID: x.info.id,
      created: 110,
      finish: "stop",
      text: "answer",
    })
    const u1 = projectionUser("msg_a2e_u1", { created: 200, compaction: {} })
    const s1 = projectionAssistant("msg_a2e_s1", {
      parentID: u1.info.id,
      created: 210,
      summary: true,
      finish: "error",
      error: new SessionV1.AbortedError({ message: "compaction failed" }).toObject(),
      text: "failed legacy summary",
    })
    const { u2, s2 } = provisionalPair()
    const history = [x, b, u1, s1, u2, s2]

    expect(work(history).tasks).toEqual([])
  })

  test("A2 control: a genuinely published summary still advances the cutoff over older legacy work", () => {
    const x = projectionUser("msg_a2p_x", { created: 100, text: "question" })
    const b = projectionAssistant("msg_a2p_b", {
      parentID: x.info.id,
      created: 110,
      finish: "stop",
      text: "answer",
    })
    const u1 = projectionUser("msg_a2p_u1", { created: 200, compaction: {} })
    const s1 = projectionAssistant("msg_a2p_s1", {
      parentID: u1.info.id,
      created: 210,
      summary: true,
      unfinished: true,
      text: "partial legacy summary",
    })
    const pubU = projectionUser("msg_a2p_pub", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_a2p_pub_s") } },
    })
    const pubS = projectionAssistant("msg_a2p_pub_s", {
      parentID: pubU.info.id,
      created: 310,
      summary: true,
      finish: "stop",
      text: "published summary",
    })
    const history = [x, b, u1, s1, pubU, pubS]

    expect(work(history).tasks).toEqual([])
  })
})

describe("session.message-v2.pendingWork cutoff agrees with applicable publication", () => {
  const work = (chronological: SessionV1.WithParts[]) => MessageV2.pendingWork(chronological.toReversed())
  const runnableIDs = (chronological: SessionV1.WithParts[]) => work(chronological).tasks.map((task) => task.messageID)
  const subtaskUser = (id: string, created: number) => {
    const user = projectionUser(id, { created, text: `${id} turn` })
    user.parts.push({
      ...basePart(id, `subtask_${id}`),
      type: "subtask",
      prompt: "pending subtask",
      description: "pending",
      agent: "general",
    } as SessionV1.Part)
    return user
  }

  // Genuine X/B, strict legacy pending pair U1 with unfinished S1, genuine Y
  // with an eligible pending subtask, then new ordinary U2 published against a
  // readable successful S2 whose tail boundary is controlled by the caller.
  const fixture = (input: {
    tail: (ownerID: string) => string | undefined
    legacySummary: "unfinished" | "error"
    queuedTailAnchor?: boolean
  }) => {
    const x = projectionUser("msg_gate_x", { created: 100, text: "question" })
    const b = projectionAssistant("msg_gate_b", {
      parentID: x.info.id,
      created: 110,
      finish: "stop",
      text: "answer",
    })
    const u1 = projectionUser("msg_gate_u1", { created: 150, compaction: {} })
    const s1 =
      input.legacySummary === "error"
        ? projectionAssistant("msg_gate_s1", {
            parentID: u1.info.id,
            created: 160,
            summary: true,
            finish: "error",
            error: new SessionV1.AbortedError({ message: "legacy compaction failed" }).toObject(),
            text: "failed legacy summary",
          })
        : projectionAssistant("msg_gate_s1", {
            parentID: u1.info.id,
            created: 160,
            summary: true,
            unfinished: true,
            text: "partial legacy summary",
          })
    const y = subtaskUser("msg_gate_y", 200)
    const queuedAnchor = input.queuedTailAnchor
      ? projectionUser("msg_gate_uq", {
          created: 250,
          origin: "compaction",
          compaction: { publication: { state: "queued" } },
        })
      : undefined
    const tail = input.tail("msg_gate_u2")
    const u2 = projectionUser("msg_gate_u2", {
      created: 300,
      origin: "compaction",
      compaction: {
        ...(tail !== undefined ? { tail } : {}),
        publication: { state: "published", summaryID: MessageID.make("msg_gate_s2") },
      },
    })
    const s2 = projectionAssistant("msg_gate_s2", {
      parentID: u2.info.id,
      created: 310,
      summary: true,
      finish: "stop",
      text: "published summary two",
    })
    const history = [x, b, u1, s1, y, ...(queuedAnchor ? [queuedAnchor] : []), u2, s2]
    return { x, b, u1, s1, y, queuedAnchor, u2, s2, history }
  }

  const assertProjectionRejectsPair = (history: SessionV1.WithParts[], ids: { u2: string; s2: string }) => {
    const filtered = project(history)
    expect(projectionIDs(filtered)).not.toContain(ids.u2)
    expect(projectionIDs(filtered)).not.toContain(ids.s2)
    expect(projectionText(filtered)).not.toContain("published summary two")
    return filtered
  }

  test("a published pair whose tail is a self-pointer never advances the pending-work cutoff", () => {
    const f = fixture({ tail: (ownerID) => ownerID, legacySummary: "unfinished" })
    const before = JSON.stringify(f.history)

    const filtered = assertProjectionRejectsPair(f.history, { u2: f.u2.info.id, s2: f.s2.info.id })
    expect(projectionIDs(filtered)).toEqual([
      f.x.info.id,
      f.b.info.id,
      f.u1.info.id,
      f.s1.info.id,
      f.y.info.id,
    ])
    expect(runnableIDs(f.history)).toEqual([f.u1.info.id, f.y.info.id])
    expect(work(f.history).tasks.filter((task) => task.type === "subtask")).toHaveLength(1)
    expect(work(f.history).tasks.filter((task) => task.type === "compaction").map((task) => task.messageID)).toEqual([
      f.u1.info.id,
    ])
    expect(JSON.stringify(f.history)).toBe(before)
  })

  test("a published pair whose tail is a hidden queued synthetic U never advances the pending-work cutoff", () => {
    const f = fixture({ tail: () => "msg_gate_uq", legacySummary: "unfinished", queuedTailAnchor: true })
    const before = JSON.stringify(f.history)

    const filtered = assertProjectionRejectsPair(f.history, { u2: f.u2.info.id, s2: f.s2.info.id })
    expect(projectionIDs(filtered)).not.toContain(f.queuedAnchor!.info.id)
    expect(runnableIDs(f.history)).toEqual([f.u1.info.id, f.y.info.id, f.queuedAnchor!.info.id])
    expect(JSON.stringify(f.history)).toBe(before)
  })

  test("controls: a valid published full or tailed summary still advances the cutoff", () => {
    const full = fixture({ tail: () => undefined, legacySummary: "unfinished" })
    const tailed = fixture({ tail: () => "msg_gate_y", legacySummary: "unfinished" })

    expect(runnableIDs(full.history)).toEqual([])
    expect(projectionIDs(project(full.history))).toEqual([full.u2.info.id, full.s2.info.id])

    expect(runnableIDs(tailed.history)).toEqual([])
    expect(projectionIDs(project(tailed.history))).toEqual([
      tailed.u2.info.id,
      tailed.s2.info.id,
      tailed.y.info.id,
    ])
  })

  test('control: legacy finish:"error" still suppresses its legacy task beside the invalid-tail pair', () => {
    const f = fixture({ tail: (ownerID) => ownerID, legacySummary: "error" })

    expect(runnableIDs(f.history)).toEqual([f.y.info.id])
    const filtered = assertProjectionRejectsPair(f.history, { u2: f.u2.info.id, s2: f.s2.info.id })
    expect(projectionIDs(filtered)).toContain(f.u1.info.id)
    expect(projectionIDs(filtered)).toContain(f.s1.info.id)
  })
})

describe("session.message-v2 published full and tailed consumer regressions", () => {
  const work = (chronological: SessionV1.WithParts[]) => MessageV2.pendingWork(chronological.toReversed())
  const head = () => {
    const u = projectionUser("msg_fn_h", { created: 100, text: "head question" })
    const a = projectionAssistant("msg_fn_hr", {
      parentID: u.info.id,
      created: 110,
      finish: "end_turn",
      text: "head reply",
    })
    return { u, a }
  }
  const later = () => projectionUser("msg_fn_y", { created: 400, text: "later genuine question" })
  const summariesOf = (msgs: SessionV1.WithParts[]) =>
    msgs.filter((msg) => msg.info.role === "assistant" && msg.info.summary === true)

  const assertUnchanged = (history: SessionV1.WithParts[], before: string) => {
    expect(JSON.stringify(history)).toBe(before)
  }

  test("1. a successful legacy full summary hides the compacted head without a tail marker", () => {
    const h = head()
    const owner = projectionUser("msg_fn_u1", { created: 200, compaction: {} })
    const summary = projectionAssistant("msg_fn_s1", {
      parentID: owner.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "legacy full summary",
    })
    const y = later()
    const history = [h.u, h.a, owner, summary, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([owner.info.id, summary.info.id, y.info.id])
    expect(projectionText(filtered)).toContain("legacy full summary")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(projectionText(filtered)).not.toContain("head question")
    expect(summariesOf(filtered)).toHaveLength(1)
    expect(work(history).tasks).toEqual([])
    expect(MessageV2.latest(filtered).user?.id).toBe(y.info.id)
    assertUnchanged(history, before)
  })

  test("2. a successful legacy tailed summary preserves summary, tail and later-turn order", () => {
    const h = head()
    const tail = projectionUser("msg_fn_t2", { created: 150, text: "retained turn" })
    const owner = projectionUser("msg_fn_u2", { created: 200, compaction: { tail: tail.info.id } })
    const summary = projectionAssistant("msg_fn_s2", {
      parentID: owner.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "legacy tailed summary",
    })
    const y = later()
    const history = [h.u, h.a, tail, owner, summary, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([owner.info.id, summary.info.id, tail.info.id, y.info.id])
    expect(projectionText(filtered)).toContain("legacy tailed summary")
    expect(projectionText(filtered)).toContain("retained turn")
    expect(projectionText(filtered)).not.toContain("head question")
    expect(summariesOf(filtered)).toHaveLength(1)
    expect(work(history).tasks).toEqual([])
    assertUnchanged(history, before)
  })

  test("3. a new published full summary with readable text hides the compacted head", () => {
    const h = head()
    const owner = projectionUser("msg_fn_u3", {
      created: 200,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_fn_s3") } },
    })
    const summary = projectionAssistant("msg_fn_s3", {
      parentID: owner.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "published full summary",
    })
    const y = later()
    const history = [h.u, h.a, owner, summary, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([owner.info.id, summary.info.id, y.info.id])
    expect(projectionText(filtered)).toContain("published full summary")
    expect(projectionText(filtered)).not.toContain("head question")
    expect(summariesOf(filtered)).toHaveLength(1)
    expect(work(history).tasks).toEqual([])
    assertUnchanged(history, before)
  })

  test("4. a new published tailed summary preserves summary, tail and later-turn order", () => {
    const h = head()
    const tail = projectionUser("msg_fn_t4", { created: 150, text: "retained turn" })
    const owner = projectionUser("msg_fn_u4", {
      created: 200,
      origin: "compaction",
      compaction: {
        tail: tail.info.id,
        publication: { state: "published", summaryID: MessageID.make("msg_fn_s4") },
      },
    })
    const summary = projectionAssistant("msg_fn_s4", {
      parentID: owner.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "published tailed summary",
    })
    const y = later()
    const history = [h.u, h.a, tail, owner, summary, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([owner.info.id, summary.info.id, tail.info.id, y.info.id])
    expect(projectionText(filtered)).toContain("published tailed summary")
    expect(projectionText(filtered)).toContain("retained turn")
    expect(summariesOf(filtered)).toHaveLength(1)
    expect(work(history).tasks).toEqual([])
    assertUnchanged(history, before)
  })

  test("5. an upgraded legacy user with absent origin and explicit published metadata is authoritative", () => {
    const h = head()
    const owner = projectionUser("msg_fn_u5", {
      created: 200,
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_fn_s5") } },
    })
    const summary = projectionAssistant("msg_fn_s5", {
      parentID: owner.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "upgraded summary",
    })
    const y = later()
    const history = [h.u, h.a, owner, summary, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([owner.info.id, summary.info.id, y.info.id])
    expect(projectionText(filtered)).toContain("upgraded summary")
    expect(projectionText(filtered)).not.toContain("head question")
    expect(summariesOf(filtered)).toHaveLength(1)
    expect(work(history).tasks).toEqual([])
    assertUnchanged(history, before)
  })

  test("6. multiple successive published summaries expose only the newest applicable pair", () => {
    const h = head()
    const owner1 = projectionUser("msg_fn_u6a", {
      created: 150,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_fn_s6a") } },
    })
    const summary1 = projectionAssistant("msg_fn_s6a", {
      parentID: owner1.info.id,
      created: 160,
      summary: true,
      finish: "end_turn",
      text: "first published summary",
    })
    const tail = projectionUser("msg_fn_t6", { created: 250, text: "retained turn" })
    const owner2 = projectionUser("msg_fn_u6b", {
      created: 300,
      origin: "compaction",
      compaction: {
        tail: tail.info.id,
        publication: { state: "published", summaryID: MessageID.make("msg_fn_s6b") },
      },
    })
    const summary2 = projectionAssistant("msg_fn_s6b", {
      parentID: owner2.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "second published summary",
    })
    const y = later()
    const history = [h.u, h.a, owner1, summary1, tail, owner2, summary2, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([owner2.info.id, summary2.info.id, tail.info.id, y.info.id])
    expect(summariesOf(filtered)).toHaveLength(1)
    expect(projectionText(filtered)).toContain("second published summary")
    expect(projectionText(filtered)).not.toContain("first published summary")
    expect(projectionIDs(filtered).filter((id) => id === summary2.info.id)).toHaveLength(1)
    expect(work(history).tasks).toEqual([])
    assertUnchanged(history, before)
  })

  test("7. an older valid published pair survives a newer unpublished and an invalid-tail candidate", () => {
    const h = head()
    const owner1 = projectionUser("msg_fn_u7", {
      created: 200,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_fn_s7") } },
    })
    const summary1 = projectionAssistant("msg_fn_s7", {
      parentID: owner1.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "stable published summary",
    })
    const unpublished = projectionUser("msg_fn_u7b", {
      created: 300,
      origin: "compaction",
      compaction: { publication: { state: "preparing" } },
    })
    const unpublishedS = projectionAssistant("msg_fn_s7b", {
      parentID: unpublished.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "unpublished summary",
    })
    const y = later()
    const unpublishedHistory = [h.u, h.a, owner1, summary1, unpublished, unpublishedS, y]
    const unpublishedBefore = JSON.stringify(unpublishedHistory)

    const filteredUnpublished = project(unpublishedHistory)
    expect(projectionIDs(filteredUnpublished)).toEqual([owner1.info.id, summary1.info.id, y.info.id])
    expect(projectionText(filteredUnpublished)).toContain("stable published summary")
    expect(projectionText(filteredUnpublished)).not.toContain("unpublished summary")
    expect(summariesOf(filteredUnpublished)).toHaveLength(1)
    expect(work(unpublishedHistory).tasks).toEqual([])
    assertUnchanged(unpublishedHistory, unpublishedBefore)

    const invalid = projectionUser("msg_fn_u7c", {
      created: 300,
      origin: "compaction",
      compaction: {
        tail: "msg_fn_u7c",
        publication: { state: "published", summaryID: MessageID.make("msg_fn_s7c") },
      },
    })
    const invalidS = projectionAssistant("msg_fn_s7c", {
      parentID: invalid.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "invalid tail summary",
    })
    const invalidHistory = [h.u, h.a, owner1, summary1, invalid, invalidS, y]
    const invalidBefore = JSON.stringify(invalidHistory)

    const filteredInvalid = project(invalidHistory)
    expect(projectionIDs(filteredInvalid)).toEqual([owner1.info.id, summary1.info.id, y.info.id])
    expect(projectionText(filteredInvalid)).not.toContain("invalid tail summary")
    expect(summariesOf(filteredInvalid)).toHaveLength(1)
    assertUnchanged(invalidHistory, invalidBefore)
  })

  test("8. a genuine later user remains the newest real request in every projection", () => {
    const h = head()
    const owner = projectionUser("msg_fn_u8", {
      created: 200,
      origin: "compaction",
      compaction: { publication: { state: "published", summaryID: MessageID.make("msg_fn_s8") } },
    })
    const summary = projectionAssistant("msg_fn_s8", {
      parentID: owner.info.id,
      created: 210,
      summary: true,
      finish: "end_turn",
      text: "published summary",
    })
    const y = later()
    const yReply = projectionAssistant("msg_fn_y8", {
      parentID: y.info.id,
      created: 410,
      finish: "end_turn",
      text: "y reply",
    })
    const history = [h.u, h.a, owner, summary, y, yReply]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([owner.info.id, summary.info.id, y.info.id, yReply.info.id])
    const state = MessageV2.latest(filtered)
    expect(state.user?.id).toBe(y.info.id)
    expect(state.finished?.id).toBe(yReply.info.id)
    expect(work(history).tasks).toEqual([])
    assertUnchanged(history, before)
  })

  test("9. a valid assistant-anchored retained tail keeps established ordering end to end", () => {
    const h = projectionUser("msg_fn_u9h", { created: 100, text: "head question" })
    const anchor = projectionAssistant("msg_fn_u9a", {
      parentID: h.info.id,
      created: 110,
      finish: "end_turn",
      text: "retained assistant reply",
    })
    const owner = projectionUser("msg_fn_u9", {
      created: 300,
      origin: "compaction",
      compaction: {
        tail: anchor.info.id,
        publication: { state: "published", summaryID: MessageID.make("msg_fn_s9") },
      },
    })
    const summary = projectionAssistant("msg_fn_s9", {
      parentID: owner.info.id,
      created: 310,
      summary: true,
      finish: "end_turn",
      text: "assistant anchored summary",
    })
    const y = later()
    const history = [h, anchor, owner, summary, y]
    const before = JSON.stringify(history)

    const filtered = project(history)

    expect(projectionIDs(filtered)).toEqual([owner.info.id, summary.info.id, anchor.info.id, y.info.id])
    expect(summariesOf(filtered)).toHaveLength(1)
    expect(projectionText(filtered)).toContain("assistant anchored summary")
    expect(projectionText(filtered)).toContain("retained assistant reply")
    expect(projectionText(filtered)).toContain("later genuine question")
    expect(work(history).tasks).toEqual([])
    assertUnchanged(history, before)
  })

  test("pending work ignores tail markers: a queued owner with a tail stays runnable", () => {
    const tail = projectionUser("msg_fn_tq", { created: 150, text: "retained turn" })
    const queued = projectionUser("msg_fn_uq2", {
      created: 200,
      origin: "compaction",
      compaction: { tail: tail.info.id, publication: { state: "queued" } },
    })
    const history = [tail, queued]

    expect(work(history).tasks.map((task) => task.messageID)).toEqual([queued.info.id])
    expect(work(history).tasks).toHaveLength(1)
  })
})
