// Generic OpenCode-local generation throughput fallback for providers that
// expose no authoritative telemetry feed (OpenCode Go, remote APIs, and mlx
// attempts whose /events epoch is unavailable). Derived only from the
// normalized LLMEvent stream: an active decode interval starts at the FIRST
// model-generated content event of a step and closes at the next hard model
// boundary (tool-call) or step/finish, so TTFT/prefill, tool execution, retry
// delay, and permission waits never enter the denominator. The denominator is
// the SUM of active decode intervals, never whole request wall time. Live
// token counts are estimated from generated text; step and request usage
// corrections (provider outputTokens, which already INCLUDE reasoning)
// replace the estimate with exact numbers, but only when they report a
// positive finite count: a zero/missing usage must never erase a real
// estimate.
import type { LLMEvent, Usage } from "@opencode-ai/llm"

export type FallbackTelemetrySnapshot = {
  phase: "prefill" | "decode"
  tokensPerSecond?: number
  done?: boolean
  approximate?: boolean
}

export type FallbackTelemetryInput = {
  sessionID: string
  assistantMessageID: string
  publish: (snapshot: FallbackTelemetrySnapshot) => void
  // Authoritative provider telemetry was accepted for this attempt: the
  // fallback must never publish measurements afterwards.
  suppressed?: () => boolean
  now?: () => number
  throttleMs?: number
}

export type FallbackTelemetryAttempt = {
  readonly push: (event: LLMEvent) => void
  readonly finalize: () => void
  readonly discard: () => void
}

const DECODE_THROTTLE_MS = 250
const MIN_INTERVAL_MS = 50

const generatedDelta = (event: LLMEvent) =>
  event.type === "text-delta" || event.type === "reasoning-delta" || event.type === "tool-input-delta"

const generatedStart = (event: LLMEvent) =>
  event.type === "text-start" || event.type === "reasoning-start" || event.type === "tool-input-start"

// Only a positive finite outputTokens can correct throughput: zero,
// negative, non-finite, or missing usage is unusable and must leave any real
// local estimate intact so a meaningful rate is never replaced by 0 tok/s.
const usableTokens = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

// Same character-count basis as core's `Token.estimate` (4 chars/token), but
// O(1) on an incremental running character total instead of re-walking the
// full accumulated response on every publish. Kept fractional: rounding
// would map a handful of generated characters to 0 tokens and drop a
// measurable generation entirely, while fractional tok/s stays meaningful and
// the UI already formats rates to one decimal.
const estimateChars = (characters: number) => Math.max(0, characters / 4)

export function createFallbackTelemetry(input: FallbackTelemetryInput): FallbackTelemetryAttempt {
  const now = input.now ?? (() => Date.now())
  const throttleMs = input.throttleMs ?? DECODE_THROTTLE_MS
  // Provider-confirmed generated tokens. AI SDK/LLM `finish` usage is a
  // cumulative total, so a usable finish replaces the summed step values.
  let confirmedTokens = 0
  // True while any counted token came from the local estimator instead of
  // provider usage; drives the `~` presentation marker.
  let estimating = false
  let closedMs = 0
  let intervalStart: number | undefined
  // Cumulative generated characters and the total at the last step boundary.
  let chars = 0
  let closedChars = 0
  let lastPublishAt = 0
  let finalized = false

  // Ephemeral state-clear marker: a new attempt must overwrite a previous
  // attempt's stale terminal rate even before any local measurement exists.
  input.publish({ phase: "prefill", done: false })

  const sample = (at: number): FallbackTelemetrySnapshot | undefined => {
    const openMs = intervalStart === undefined ? 0 : at - intervalStart
    const duration = closedMs + Math.max(0, openMs)
    if (!(duration >= MIN_INTERVAL_MS)) return undefined
    const openTokens = estimateChars(chars - closedChars)
    const tokens = confirmedTokens + openTokens
    if (!(tokens > 0)) return undefined
    const approximate = estimating || openTokens > 0
    return {
      phase: "decode",
      tokensPerSecond: (tokens / duration) * 1000,
      ...(approximate ? { approximate: true } : {}),
    }
  }

  const publish = (snapshot: FallbackTelemetrySnapshot | undefined) => {
    if (!snapshot || input.suppressed?.()) return
    try {
      input.publish(snapshot)
    } catch {}
  }

  const closeInterval = (at: number) => {
    if (intervalStart === undefined) return
    closedMs += Math.max(0, at - intervalStart)
    intervalStart = undefined
  }

  // Fold one usage report in. `cumulative` marks the request-level `finish`
  // total, which already covers every step.
  const applyUsage = (usage: Usage | undefined, cumulative: boolean, stepChars: number | undefined) => {
    const tokens = usableTokens(usage?.outputTokens)
    if (tokens === undefined) {
      if (stepChars !== undefined) {
        confirmedTokens += estimateChars(stepChars)
        estimating = true
      }
      return
    }
    if (cumulative) {
      confirmedTokens = tokens
      estimating = false
      return
    }
    confirmedTokens += tokens
  }

  const live = (at: number) => {
    if (input.suppressed?.()) return
    if (at - lastPublishAt < throttleMs) return
    lastPublishAt = at
    publish(sample(at))
  }

  const corrected = (at: number) => {
    lastPublishAt = at
    publish(sample(at))
  }

  return {
    push: (event) => {
      if (finalized) return
      try {
        if (generatedStart(event)) {
          // Earliest observable model-generation boundary; deltas below
          // tolerate adapters that omit the start event entirely.
          if (intervalStart === undefined) intervalStart = now()
          return
        }
        if (generatedDelta(event)) {
          const at = now()
          if (intervalStart === undefined) intervalStart = at
          chars += event.text.length
          live(at)
          return
        }
        // A tool-call is a hard model-generation boundary: everything after
        // it is external execution time and must never dilute the rate.
        // tool-result/tool-error never open or extend decode timing.
        if (event.type === "tool-call") {
          closeInterval(now())
          return
        }
        if (event.type === "step-finish") {
          const at = now()
          closeInterval(at)
          const stepChars = chars - closedChars
          closedChars = chars
          applyUsage(event.usage, false, stepChars)
          corrected(at)
          return
        }
        if (event.type === "finish") {
          const at = now()
          closeInterval(at)
          applyUsage(event.usage, true, undefined)
          corrected(at)
          return
        }
      } catch {}
    },
    finalize: () => {
      if (finalized) return
      finalized = true
      try {
        const at = now()
        closeInterval(at)
        const terminal = sample(at)
        if (!terminal || input.suppressed?.()) return
        publish({ ...terminal, done: true })
      } catch {}
    },
    discard: () => {
      finalized = true
      intervalStart = undefined
    },
  }
}

export * as FallbackTelemetry from "./fallback-telemetry"
