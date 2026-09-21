import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, createResource, onCleanup, untrack, type Accessor } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { same } from "@/utils/same"

const emptyUserMessages: UserMessage[] = []
const sessionFreshness = 15_000

export type TurnFallbackModel = {
  providerID: string
  modelID: string
  variant?: string
}

export function selectTurnFallbackModel(
  user: UserMessage | undefined,
  assistants: AssistantMessage[],
): TurnFallbackModel | undefined {
  if (!user?.model) return

  let assistant: AssistantMessage | undefined
  for (let i = assistants.length - 1; i >= 0; i--) {
    const candidate = assistants[i]
    if (candidate?.agent !== user.agent) continue
    assistant = candidate
    break
  }

  if (!assistant) return

  const requestedVariant = user.model.variant ?? undefined
  const actualVariant = assistant.variant ?? undefined
  if (
    user.model.providerID === assistant.providerID &&
    user.model.modelID === assistant.modelID &&
    requestedVariant === actualVariant
  ) {
    return
  }

  return {
    providerID: assistant.providerID,
    modelID: assistant.modelID,
    variant: actualVariant,
  }
}

export function createTimelineModel(input: {
  sessionID: Accessor<string | undefined>
  revertMessageID: Accessor<string | undefined>
}) {
  const serverSync = useServerSync()
  const sync = useSync()
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined

  const [resource] = createResource(
    () => input.sessionID(),
    (id) => {
      clearRefresh()
      if (!id) return

      const cached = untrack(() => sync().data.message[id] !== undefined)
      const stale = cached && !serverSync().session.fresh(id, sessionFreshness)

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (input.sessionID() !== id) return
          untrack(() => {
            if (stale) void sync().session.sync(id, { force: true })
          })
        }, 0)
      })

      return sync().session.sync(id)
    },
  )
  const messages = createMemo(() => {
    const id = input.sessionID()
    return id ? (sync().data.message[id] ?? []) : []
  })
  const ready = createMemo(() => {
    const id = input.sessionID()
    return !id || isTimelineReady(sync().data.message[id], serverSync().session.history.loading(id))
  })
  const userMessages = createMemo(() => selectUserMessages(messages()), emptyUserMessages, { equals: same })
  const visibleUserMessages = createMemo(
    () => {
      return selectVisibleUserMessages(userMessages(), input.revertMessageID())
    },
    emptyUserMessages,
    { equals: same },
  )
  const more = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.more(id) : false
  })
  const loading = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.loading(id) : false
  })
  const loadOlder = async (options?: { before?: () => void; after?: (done: boolean) => void }) => {
    return loadOlderTimeline({
      sessionID: input.sessionID,
      more,
      loading,
      loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
      before: options?.before,
      after: options?.after,
    })
  }

  onCleanup(clearRefresh)

  return {
    history: { loadOlder, loading, more },
    lastUserMessage: createMemo(() => visibleUserMessages().at(-1)),
    messages,
    ready,
    resource,
    userMessages,
    visibleUserMessages,
  }

  function clearRefresh() {
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    refreshFrame = undefined
    refreshTimer = undefined
  }
}

export function selectUserMessages(messages: Message[]) {
  return messages.filter((message): message is UserMessage => message.role === "user")
}

export function isTimelineReady(messages: Message[] | undefined, loading: boolean) {
  return messages !== undefined && (messages.some((message) => message.role === "user") || !loading)
}

export function selectVisibleUserMessages(messages: UserMessage[], revertMessageID?: string) {
  if (!revertMessageID) return messages
  const boundary = messages.findIndex((message) => message.id === revertMessageID)
  return boundary < 0 ? messages : messages.slice(0, boundary)
}

export async function loadOlderTimeline(input: {
  sessionID: Accessor<string | undefined>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadMore: (sessionID: string) => Promise<void>
  before?: () => void
  after?: (done: boolean) => void
}) {
  const id = input.sessionID()
  if (!id || !input.more() || input.loading()) return

  input.before?.()
  await input.loadMore(id).catch((error) => {
    if (input.sessionID() === id) input.after?.(true)
    throw error
  })
  if (input.sessionID() !== id) return
  input.after?.(true)
}
