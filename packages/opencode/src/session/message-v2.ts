import { SessionID, MessageID } from "./schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  APIError,
  AbortedError,
  Assistant,
  AuthError,
  CompactionPart,
  ContextOverflowError,
  Info,
  OutputLengthError,
  Part,
  SubtaskPart,
  User,
  WithParts,
} from "@opencode-ai/core/v1/session"

import { NamedError } from "@opencode-ai/core/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProviderError } from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { Effect, Schema } from "effect"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"
export { isMedia }

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

export const Event = {
  Updated: SessionV1.Event.MessageUpdated,
  Removed: SessionV1.Event.MessageRemoved,
  PartUpdated: SessionV1.Event.PartUpdated,
  PartDelta: SessionV1.Event.PartDelta,
  PartRemoved: SessionV1.Event.PartRemoved,
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as Info

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

function hydrate(db: Database.Interface["db"], rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  return Effect.gen(function* () {
    if (ids.length > 0) {
      const partRows = yield* db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all()
        .pipe(Effect.orDie)
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  })
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support that media type in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Some SDKs only support a subset
  // of media in tool results; e.g. Bedrock supports images but not PDFs there.
  //
  // Only apply this workaround if the model actually supports that media input -
  // otherwise unsupportedParts() will turn it into a user-visible error.
  const supportsMediaInToolResult = (attachment: { mime: string }) => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") {
      if (!attachment.mime.startsWith("image/")) return false
      const id = model.api.id.toLowerCase()
      return id.includes("anthropic.") || id.includes("nova") || id.includes("llama4") || id.includes("llama-4")
    }
    if (model.api.npm === "@ai-sdk/xai") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  }

  // xAI rejects any other image format (e.g. GIF) with invalid_image, failing the whole request.
  const rejectedByProvider = (attachment: { mime: string }) =>
    model.api.npm === "@ai-sdk/xai" &&
    attachment.mime.startsWith("image/") &&
    !["image/png", "image/jpeg", "image/webp"].includes(attachment.mime)

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      for (const part of msg.parts) {
        // User message parts should never be empty
        if (part.type === "text" && !part.ignored && part.text !== "")
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
      if (userMessage.parts.length > 0) result.push(userMessage)
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string; filename?: string }> = []

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      // Anthropic adaptive thinking can persist assistant turns like:
      // step-start, reasoning(signature), text(""), step-start,
      // reasoning(signature). The empty text part is a structural separator,
      // but it does not carry the signature metadata itself. Dropping it shifts
      // signed thinking positions after step-start splitting/provider regrouping;
      // keeping it as "" is filtered by the AI SDK and rejected by Anthropic.
      // It is unclear whether this shape originates in our stream processing,
      // a proxy, or a lower-level library, but preserving a non-empty separator
      // here is the only safe replay point we have.
      // Use a single space so the separator survives replay without changing
      // the neighboring signed reasoning blocks.
      const hasSignedReasoning = msg.parts.some((part) => {
        if (part.type !== "reasoning") return false
        return part.metadata?.anthropic?.signature != null
      })
      for (const part of msg.parts) {
        if (part.type === "text") {
          const text = part.text === "" && hasSignedReasoning ? " " : part.text
          assistantMessage.parts.push({
            type: "text",
            text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        }
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
            const attachments =
              part.state.time.compacted || options?.stripMedia
                ? []
                : (part.state.attachments ?? []).filter((a) => !rejectedByProvider(a))

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const extractedMedia = mediaAttachments.filter((a) => !supportsMediaInToolResult(a))
            if (extractedMedia.length > 0) {
              media.push(...extractedMedia)
            }
            const finalAttachments = attachments.filter((a) => !isMedia(a.mime) || supportsMediaInToolResult(a))

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          if (differentModel) {
            if (part.text.trim().length > 0)
              assistantMessage.parts.push({
                type: "text",
                text: part.text,
              })
            continue
          }
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            providerMetadata: part.metadata,
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
                filename: attachment.filename,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options))
}

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const { db } = yield* Database.Service
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(where)
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    const row = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = yield* hydrate(db, slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})

export function stream(sessionID: SessionID) {
  const size = 50
  return Effect.gen(function* () {
    const result = [] as WithParts[]
    let before: string | undefined
    while (true) {
      const next = yield* page({ sessionID, limit: size, before }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () =>
          Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
        ),
      )
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        const item = next.items[i]
        if (item) result.push(item)
      }
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
    return result
  })
}

export function parts(messageID: MessageID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.message_id, messageID))
      .orderBy(PartTable.id)
      .all()
      .pipe(Effect.orDie)
    return rows.map(part)
  })
}

export const get = Effect.fn("MessageV2.get")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: yield* parts(input.messageID),
  }
})

export type CompactionPairFormat = "legacy" | "new" | "malformed"

export type CompactionPairInterpretation = {
  readonly format: CompactionPairFormat
  readonly ordinary: boolean
  readonly published: boolean
}

function hasReadableSummaryText(parts: readonly Part[]) {
  return parts.some((part) => part.type === "text" && part.text.trim() !== "")
}

export function interpretCompactionPair(input: {
  readonly user: WithParts
  readonly part: CompactionPart
  readonly summary?: WithParts
}): CompactionPairInterpretation {
  const owner = input.user.info
  if (owner.role !== "user") return { format: "malformed", ordinary: false, published: false }
  const summary = input.summary?.info
  const owned =
    input.part.messageID === owner.id &&
    input.part.sessionID === owner.sessionID &&
    (input.summary === undefined || summary?.sessionID === owner.sessionID)
  const summarySucceeded =
    summary !== undefined &&
    summary.role === "assistant" &&
    summary.parentID === owner.id &&
    summary.summary === true &&
    Boolean(summary.finish) &&
    summary.finish !== "error" &&
    summary.error === undefined
  const publication = input.part.publication

  if (owner.origin === undefined && publication === undefined)
    return { format: "legacy", ordinary: false, published: owned && summarySucceeded }
  if (publication === undefined) return { format: "malformed", ordinary: false, published: false }
  return {
    format: "new",
    ordinary: owner.origin === "compaction",
    published:
      owned &&
      summarySucceeded &&
      publication.state === "published" &&
      publication.summaryID === summary.id &&
      hasReadableSummaryText(input.summary!.parts),
  }
}

type CompactionPairCandidate = {
  readonly owner: WithParts
  readonly ownerIndex: number
  readonly part: CompactionPart
  readonly interpretation: CompactionPairInterpretation
  readonly boundarySummary: WithParts | undefined
}

function compactionPartOf(msg: WithParts) {
  return msg.parts.find((item): item is CompactionPart => item.type === "compaction")
}

function isTailAnchorEligible(msg: WithParts | undefined): boolean {
  if (msg === undefined) return false
  const info = msg.info
  if (info.role === "user") return info.origin === undefined && compactionPartOf(msg) === undefined
  if (info.role === "assistant") return info.summary !== true
  return false
}

// Shared applicability check for a recognized published pair: the optional
// retained-tail boundary must be a genuine anchor positioned after the summary
// and owner in newest-first raw order, otherwise the publication cannot form
// an applicable model projection. Model-history filtering and the
// finished-relative pending-work cutoff must agree here, so a pair that is
// durably recognizable but has an invalid tail can neither become model
// context nor suppress legitimate earlier pending work.
function publishedPairApplicable(input: {
  readonly collected: readonly WithParts[]
  readonly indexOf: ReadonlyMap<string, number>
  readonly ownerIndex: number
  readonly part: CompactionPart
  readonly summary: WithParts
}): boolean {
  const tailID = input.part.tail_start_id
  if (tailID === undefined) return true
  const tailIndex = input.indexOf.get(tailID)
  if (tailIndex === undefined) return false
  if (!isTailAnchorEligible(input.collected[tailIndex])) return false
  const summaryIndex = input.indexOf.get(input.summary.info.id)
  if (summaryIndex === undefined) return false
  return summaryIndex < input.ownerIndex && input.ownerIndex < tailIndex
}

export function filterCompacted(msgs: Iterable<WithParts>) {
  const collected: WithParts[] = Array.isArray(msgs) ? msgs : Array.from(msgs)
  const indexByID = new Map<string, number>()
  const summariesByParent = new Map<string, WithParts[]>()
  for (let i = 0; i < collected.length; i++) {
    const msg = collected[i]!
    indexByID.set(msg.info.id, i)
    if (msg.info.role !== "assistant" || !msg.info.summary) continue
    const siblings = summariesByParent.get(msg.info.parentID)
    if (siblings) siblings.push(msg)
    else summariesByParent.set(msg.info.parentID, [msg])
  }

  const pairs = new Map<string, CompactionPairCandidate>()
  for (let i = 0; i < collected.length; i++) {
    const msg = collected[i]!
    if (msg.info.role !== "user") continue
    const part = compactionPartOf(msg)
    if (!part) continue
    const children = summariesByParent.get(msg.info.id) ?? []
    const publishedSummaryID = part.publication?.state === "published" ? part.publication.summaryID : undefined
    const candidates: (WithParts | undefined)[] =
      publishedSummaryID !== undefined
        ? [collected[indexByID.get(publishedSummaryID) ?? -1]]
        : children.length > 0
          ? children
          : [undefined]
    let interpretation = interpretCompactionPair({ user: msg, part, summary: candidates[0] })
    let resolved = candidates[0]
    if (!interpretation.published) {
      for (const candidate of candidates.slice(1)) {
        const next = interpretCompactionPair({ user: msg, part, summary: candidate })
        if (!next.published) continue
        interpretation = next
        resolved = candidate
        break
      }
    }
    pairs.set(msg.info.id, {
      owner: msg,
      ownerIndex: i,
      part,
      interpretation,
      boundarySummary: resolved,
    })
  }

  const isVisible = (msg: WithParts, active: CompactionPairCandidate | undefined): boolean => {
    const info = msg.info
    if (info.role === "user") {
      if (compactionPartOf(msg) === undefined) return info.origin === undefined
      const pair = pairs.get(info.id)
      if (pair === undefined) return info.origin === undefined
      if (pair.interpretation.format === "legacy") return !pair.interpretation.published || isApplicable(pair)
      return active !== undefined && active.owner.info.id === info.id
    }
    if (info.role === "assistant" && info.summary) {
      const parentIndex = indexByID.get(info.parentID)
      const parent = parentIndex === undefined ? undefined : collected[parentIndex]
      if (parent === undefined || parent.info.role !== "user") return false
      const parentPair = pairs.get(parent.info.id)
      if (parentPair === undefined) return false
      if (parentPair.interpretation.format === "legacy") {
        if (!parentPair.interpretation.published) return true
        return isApplicable(parentPair) && parentPair.boundarySummary?.info.id === info.id
      }
      return (
        active !== undefined &&
        active.owner.info.id === parent.info.id &&
        parentPair.interpretation.published &&
        parentPair.boundarySummary?.info.id === info.id
      )
    }
    return true
  }

  const isApplicable = (pair: CompactionPairCandidate): boolean => {
    if (!pair.interpretation.published) return false
    const summary = pair.boundarySummary
    if (summary === undefined) return false
    return publishedPairApplicable({
      collected,
      indexOf: indexByID,
      ownerIndex: pair.ownerIndex,
      part: pair.part,
      summary,
    })
  }

  let boundary: CompactionPairCandidate | undefined
  for (const msg of collected) {
    const pair = pairs.get(msg.info.id)
    if (!pair || !isApplicable(pair)) continue
    boundary = pair
    break
  }

  let keepEnd = collected.length
  if (boundary) {
    const tailID = boundary.part.tail_start_id
    keepEnd = tailID !== undefined ? indexByID.get(tailID)! + 1 : boundary.ownerIndex + 1
  }

  const visible = collected.slice(0, keepEnd).reverse().filter((msg) => isVisible(msg, boundary))

  const active = boundary
  const tailID = active?.part.tail_start_id
  if (active && tailID !== undefined) {
    const ownerIndex = visible.findIndex((msg) => msg.info.id === active.owner.info.id)
    const summaryIndex = visible.findIndex((msg) => msg.info.id === active.boundarySummary?.info.id)
    const tailIndex = visible.findIndex((msg) => msg.info.id === tailID)
    if (tailIndex >= 0 && tailIndex < ownerIndex && summaryIndex > ownerIndex) {
      return [
        ...visible.slice(ownerIndex, summaryIndex + 1),
        ...visible.slice(tailIndex, ownerIndex),
        ...visible.slice(summaryIndex + 1),
      ]
    }
  }
  return visible
}

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return filterCompacted(yield* stream(sessionID))
})

export function pendingWork(raw: Iterable<WithParts>) {
  const collected: WithParts[] = Array.isArray(raw) ? raw : Array.from(raw)
  const indexByID = new Map<string, WithParts>()
  const positions = new Map<string, number>()
  for (let i = 0; i < collected.length; i++) {
    indexByID.set(collected[i]!.info.id, collected[i]!)
    positions.set(collected[i]!.info.id, i)
  }

  // The finished-relative scheduling cutoff only advances for assistants that
  // historical scheduling could observe: ordinary finished replies, strict
  // legacy summaries (including terminal failures), and summaries whose pair
  // is actually published as an applicable model projection. A
  // completed-but-unpublished new-format summary is hidden from model history,
  // and a published pair whose invalid tail cannot form an applicable
  // projection is rejected by filterCompacted; neither raw finish may advance
  // the cutoff and suppress legitimate pending work that predates it.
  const advancesCutoff = (msg: WithParts, info: Assistant): boolean => {
    if (!info.finish) return false
    if (info.summary !== true) return true
    const owner = indexByID.get(info.parentID)
    if (owner === undefined || owner.info.role !== "user") return false
    const part = compactionPartOf(owner)
    if (part === undefined) return false
    const interpretation = interpretCompactionPair({ user: owner, part, summary: msg })
    if (interpretation.format === "legacy") return true
    if (!interpretation.published) return false
    const ownerIndex = positions.get(owner.info.id)
    if (ownerIndex === undefined) return false
    return publishedPairApplicable({ collected, indexOf: positions, ownerIndex, part, summary: msg })
  }
  let finished: Assistant | undefined
  for (const msg of collected) {
    const info = msg.info
    if (info.role === "assistant" && advancesCutoff(msg, info) && isAfter(info, finished)) finished = info
  }
  const tasks: (CompactionPart | SubtaskPart)[] = []
  for (const msg of collected) {
    const info = msg.info
    const origin = info.role === "user" ? info.origin : undefined
    for (const part of msg.parts) {
      if (part.type === "subtask") {
        if (finished && !isAfter(info, finished)) continue
        tasks.push(part)
        continue
      }
      if (part.type !== "compaction") continue
      if (origin === undefined && part.publication === undefined) {
        if (finished && !isAfter(info, finished)) continue
        tasks.push(part)
        continue
      }
      if (part.publication === undefined) continue
      if (origin !== "compaction") continue
      if (part.publication.state !== "queued") continue
      tasks.push(part)
    }
  }
  tasks.reverse()
  return { tasks }
}

export function compactionWorkInput(msgs: WithParts[], owner: WithParts): WithParts[] {
  const result: WithParts[] = []
  let placed = false
  const placeOwner = () => {
    if (placed) return
    placed = true
    result.push(owner)
  }
  for (const msg of msgs) {
    if (msg.info.id === owner.info.id) {
      placed = true
      result.push(msg)
      continue
    }
    if (!isAfter(msg.info, owner.info)) {
      result.push(msg)
      continue
    }
    const ownerChild = msg.info.role === "assistant" && msg.info.parentID === owner.info.id
    placeOwner()
    if (ownerChild) result.push(msg)
  }
  placeOwner()
  return result
}

// filterCompacted reorders messages for model consumption
// ([compaction-user, summary, ...retained tail..., continue-user]), so array
// position is not chronological. IDs are only a deterministic tie-breaker
// because imported messages do not necessarily have monotonic IDs.
export function latest(msgs: WithParts[]) {
  let user: User | undefined
  let assistant: Assistant | undefined
  let finished: Assistant | undefined
  for (const msg of msgs) {
    const info = msg.info
    if (info.role === "user" && isAfter(info, user)) user = info
    if (info.role === "assistant" && isAfter(info, assistant)) assistant = info
    if (info.role === "assistant" && info.finish && isAfter(info, finished)) finished = info
  }
  const tasks = msgs.flatMap((m) =>
    finished && !isAfter(m.info, finished)
      ? []
      : m.parts.filter((p): p is CompactionPart | SubtaskPart => p.type === "compaction" || p.type === "subtask"),
  )
  return { user, assistant, finished, tasks }
}

function isAfter(info: Info, other?: Info) {
  if (!other) return true
  if (info.time.created !== other.time.created) return info.time.created > other.time.created
  return info.id > other.id
}

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderV2.ID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.HeaderTimeoutError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
            timeoutMs: String(e.ms),
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.ResponseStreamError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

export * as MessageV2 from "./message-v2"
export const node = LayerNode.group([Database.node])
