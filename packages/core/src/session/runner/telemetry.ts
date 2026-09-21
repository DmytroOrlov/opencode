import type { LLMEvent } from "@opencode/ai"

export type Observation =
  | { readonly phase: "prefill"; readonly processed: number; readonly total: number }
  | { readonly phase: "decode"; readonly tokensPerSecond: number }

export interface Fallback {
  readonly push: (event: LLMEvent) => void
  readonly finalize: () => void
  readonly discard: () => void
}

/** Finalizes successful observations before abort can discard their pending terminal sample. */
export function closeTelemetry(input: {
  readonly completed: boolean
  readonly finalize: () => void
  readonly discard: () => void
  readonly abort: () => void
}) {
  if (input.completed) input.finalize()
  else input.discard()
  input.abort()
}

const DECODE_THROTTLE_MS = 250
const MIN_INTERVAL_MS = 50

const isOutputStart = (event: LLMEvent) =>
  event.type === "text-start" || event.type === "reasoning-start" || event.type === "tool-input-start"

const isOutputDelta = (event: LLMEvent) =>
  event.type === "text-delta" || event.type === "reasoning-delta" || event.type === "tool-input-delta"

const usableTokens = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

const estimatedTokens = (characters: number) => Math.max(0, characters / 4)

/** Estimates decode rate from active output intervals, excluding TTFT and tool waits. */
export function createFallback(input: {
  readonly observe: (observation: Observation) => void
  readonly suppressed: () => boolean
  readonly now?: () => number
  readonly throttleMs?: number
}): Fallback {
  const now = input.now ?? Date.now
  const throttleMs = input.throttleMs ?? DECODE_THROTTLE_MS
  let confirmedTokens = 0
  let intervalMs = 0
  let intervalStart: number | undefined
  let characters = 0
  let closedCharacters = 0
  let lastPublishAt = 0
  let closed = false

  const closeInterval = (at: number) => {
    if (intervalStart === undefined) return
    intervalMs += Math.max(0, at - intervalStart)
    intervalStart = undefined
  }

  const sample = (at: number) => {
    const openMs = intervalStart === undefined ? 0 : Math.max(0, at - intervalStart)
    const duration = intervalMs + openMs
    if (duration < MIN_INTERVAL_MS) return
    const tokens = confirmedTokens + estimatedTokens(characters - closedCharacters)
    if (!(tokens > 0)) return
    return { phase: "decode" as const, tokensPerSecond: (tokens / duration) * 1000 }
  }

  const emit = (at: number, throttled: boolean) => {
    if (input.suppressed() || (throttled && at - lastPublishAt < throttleMs)) return
    const observation = sample(at)
    if (!observation) return
    lastPublishAt = at
    try {
      input.observe(observation)
    } catch {
      // A fallback observer is never part of successful generation.
    }
  }

  const correctUsage = (usage: { outputTokens?: number } | undefined, cumulative: boolean, stepCharacters?: number) => {
    const tokens = usableTokens(usage?.outputTokens)
    if (tokens === undefined) {
      if (stepCharacters !== undefined) confirmedTokens += estimatedTokens(stepCharacters)
      return
    }
    if (cumulative) {
      confirmedTokens = tokens
      return
    }
    confirmedTokens += tokens
  }

  return {
    push: (event) => {
      if (closed) return
      try {
        if (isOutputStart(event)) {
          if (intervalStart === undefined) intervalStart = now()
          return
        }
        if (isOutputDelta(event)) {
          const at = now()
          if (intervalStart === undefined) intervalStart = at
          characters += event.text.length
          emit(at, true)
          return
        }
        if (event.type === "tool-call") {
          closeInterval(now())
          return
        }
        if (event.type === "step-finish") {
          const at = now()
          closeInterval(at)
          const stepCharacters = characters - closedCharacters
          closedCharacters = characters
          correctUsage(event.usage, false, stepCharacters)
          emit(at, false)
          return
        }
        if (event.type === "finish") {
          const at = now()
          closeInterval(at)
          correctUsage(event.usage, true)
          emit(at, false)
        }
      } catch {
        // Malformed or unavailable telemetry cannot change inference.
      }
    },
    finalize: () => {
      if (closed) return
      closed = true
      try {
        closeInterval(now())
        emit(now(), false)
      } catch {
        // Cleanup and clock errors remain observational.
      }
    },
    discard: () => {
      closed = true
      intervalStart = undefined
    },
  }
}
