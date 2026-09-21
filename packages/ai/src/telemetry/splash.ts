export type Observation =
  | { readonly phase: "prefill"; readonly processed: number; readonly total: number }
  | { readonly phase: "decode"; readonly tokensPerSecond: number }

export interface Observer {
  readonly observeFrame: (protocol: string, frame: unknown) => void
  /** Emits a terminal rate only after the owning stream has completed successfully. */
  readonly finalize: () => void
  readonly discard: () => void
}

const THROTTLE_MS = 250

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

/** Observes Splash's existing OpenAI Chat stream without changing its request options. */
export function createSplashObserver(input: {
  readonly observe: (observation: Observation) => void
  readonly now?: () => number
  readonly throttleMs?: number
}): Observer {
  const now = input.now ?? Date.now
  const throttleMs = input.throttleMs ?? THROTTLE_MS
  let closed = false
  let total: number | undefined
  let cache: number | undefined
  let processed: number | undefined
  let pending: Extract<Observation, { phase: "prefill" }> | undefined
  let lastPublishedAt: number | undefined
  let terminalCount = 0
  let terminalRate: unknown

  const emit = (observation: Observation) => {
    try {
      input.observe(observation)
    } catch {
      // Telemetry failures never escape into the inference stream.
    }
  }

  const flushPrefill = () => {
    if (!pending) return
    const observation = pending
    pending = undefined
    emit(observation)
    try {
      lastPublishedAt = now()
    } catch {
      // Clock failures only suppress this optional measurement.
    }
  }

  return {
    observeFrame: (protocol, frame) => {
      if (closed || protocol !== "openai-chat" || !isRecord(frame)) return
      if (frame.object !== "chat.completion.chunk" || !Array.isArray(frame.choices)) return
      try {
        const progress = frame.prompt_progress
        if (isRecord(progress)) {
          const nextTotal = progress.total
          const nextCache = progress.cache
          const nextProcessed = progress.processed
          const time = progress.time_ms
          if (
            typeof nextTotal === "number" &&
            Number.isFinite(nextTotal) &&
            nextTotal > 0 &&
            finiteNonnegative(nextCache) &&
            finiteNonnegative(nextProcessed) &&
            finiteNonnegative(time) &&
            nextCache <= nextTotal &&
            nextProcessed <= nextTotal &&
            (total === undefined || (nextTotal === total && nextCache === cache)) &&
            (processed === undefined || nextProcessed > processed)
          ) {
            total ??= nextTotal
            cache ??= nextCache
            processed = nextProcessed
            pending = { phase: "prefill", processed: nextProcessed, total: nextTotal }
            const at = now()
            if (lastPublishedAt === undefined || at - lastPublishedAt >= throttleMs) flushPrefill()
          }
        }

        if (!isRecord(frame.timings)) return
        if (
          !frame.choices.some(
            (choice) => isRecord(choice) && choice.finish_reason !== null && choice.finish_reason !== undefined,
          )
        )
          return
        terminalCount++
        terminalRate = frame.timings.predicted_per_second
        flushPrefill()
      } catch {
        // Malformed protocol metadata cannot affect inference.
      }
    },
    finalize: () => {
      if (closed) return
      closed = true
      flushPrefill()
      if (terminalCount !== 1) return
      const rate = terminalRate
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return
      emit({ phase: "decode", tokensPerSecond: rate })
      terminalRate = undefined
    },
    discard: () => {
      closed = true
      pending = undefined
      terminalCount = 0
      terminalRate = undefined
    },
  }
}
