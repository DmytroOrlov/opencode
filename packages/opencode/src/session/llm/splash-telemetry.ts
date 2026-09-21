import type { AttemptTelemetrySource } from "./attempt-telemetry"
import { isRecord } from "@/util/record"

export type TelemetrySnapshot = {
  phase: "prefill" | "decode"
  processed?: number
  total?: number
  tokensPerSecond?: number
  done?: boolean
}

export type TelemetryAttempt = AttemptTelemetrySource & {
  readonly startStep: () => void
  readonly observeRaw: (rawValue: unknown) => void
}

const DEFAULT_THROTTLE_MS = 250

const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

export function create(input: {
  publish: (snapshot: TelemetrySnapshot) => void
  now?: () => number
  throttleMs?: number
}): TelemetryAttempt {
  const now = input.now ?? (() => Date.now())
  const throttleMs = input.throttleMs ?? DEFAULT_THROTTLE_MS
  let closed = false
  let total: number | undefined
  let cache: number | undefined
  let processed: number | undefined
  let pending: TelemetrySnapshot | undefined
  let lastPublishedAt: number | undefined
  let terminalCount = 0
  let terminalRate: unknown

  const publish = (snapshot: TelemetrySnapshot) => {
    try {
      input.publish(snapshot)
    } catch {}
  }

  const flushPrefill = () => {
    if (!pending) return
    const snapshot = pending
    pending = undefined
    publish(snapshot)
    try {
      lastPublishedAt = now()
    } catch {}
  }

  const observeProgress = (value: unknown) => {
    if (!isRecord(value)) return
    const nextTotal = value.total
    const nextCache = value.cache
    const nextProcessed = value.processed
    const timeMs = value.time_ms
    if (
      typeof nextTotal !== "number" ||
      !Number.isFinite(nextTotal) ||
      nextTotal <= 0 ||
      !finiteNonnegative(nextCache) ||
      !finiteNonnegative(nextProcessed) ||
      !finiteNonnegative(timeMs) ||
      nextCache > nextTotal ||
      nextProcessed > nextTotal
    ) return
    if (total !== undefined && (nextTotal !== total || nextCache !== cache)) return
    if (processed !== undefined && nextProcessed <= processed) return

    total ??= nextTotal
    cache ??= nextCache
    processed = nextProcessed
    pending = { phase: "prefill", processed: nextProcessed, total: nextTotal }

    const at = now()
    if (lastPublishedAt === undefined || at - lastPublishedAt >= throttleMs) {
      const snapshot = pending
      pending = undefined
      publish(snapshot)
      lastPublishedAt = at
    }
  }

  const observeTerminal = (raw: Record<string, unknown>, choices: unknown[]) => {
    if (!isRecord(raw.timings)) return
    if (
      !choices.some(
        (choice) => isRecord(choice) && choice.finish_reason !== null && choice.finish_reason !== undefined,
      )
    ) return
    terminalCount++
    terminalRate = raw.timings.predicted_per_second
    flushPrefill()
  }

  return {
    startStep: () => {
      if (closed) return
      flushPrefill()
      total = undefined
      cache = undefined
      processed = undefined
      pending = undefined
    },
    observeRaw: (rawValue) => {
      if (closed || !isRecord(rawValue)) return
      if (rawValue.object !== "chat.completion.chunk" || !Array.isArray(rawValue.choices)) return
      try {
        if (rawValue.prompt_progress !== undefined) observeProgress(rawValue.prompt_progress)
        observeTerminal(rawValue, rawValue.choices)
      } catch {}
    },
    finalize: () => {
      if (closed) return
      closed = true
      flushPrefill()
      if (terminalCount !== 1) return
      const rate = terminalRate
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return
      publish({ phase: "decode", tokensPerSecond: rate, done: true })
      terminalRate = undefined
    },
    discard: () => {
      if (closed) return
      closed = true
      pending = undefined
      terminalCount = 0
      terminalRate = undefined
    },
  }
}

export * as SplashTelemetry from "./splash-telemetry"
