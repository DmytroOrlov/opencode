import { FallbackTelemetry, type FallbackTelemetryAttempt } from "./fallback-telemetry"

export type AttemptTelemetrySource = {
  readonly finalize: () => void
  readonly discard: () => void
}

export type AttemptTelemetry = {
  readonly fallback?: FallbackTelemetryAttempt
  readonly attachFallback: (source: AttemptTelemetrySource) => void
  readonly attachProvider: (source: AttemptTelemetrySource) => void
  readonly finalize: () => void
  readonly discard: () => void
}

export function beginAttemptTelemetry(input: {
  reset: () => void
  fallback?: Parameters<typeof FallbackTelemetry.createFallbackTelemetry>[0]
}): AttemptTelemetry {
  input.reset()
  const fallback = input.fallback
    ? FallbackTelemetry.createFallbackTelemetry({ ...input.fallback, emitReset: false })
    : undefined
  let fallbackSource: AttemptTelemetrySource | undefined = fallback
  let provider: AttemptTelemetrySource | undefined
  let closed = false

  const dispose = (kind: "finalize" | "discard") => {
    if (closed) return
    closed = true
    const sources = [provider, fallbackSource]
    for (const source of sources) {
      if (!source) continue
      try {
        source[kind]()
      } catch {}
    }
  }

  return {
    fallback,
    attachFallback: (source) => {
      if (closed) {
        try {
          source.discard()
        } catch {}
        return
      }
      fallbackSource = source
    },
    attachProvider: (source) => {
      if (closed) {
        try {
          source.discard()
        } catch {}
        return
      }
      provider = source
    },
    finalize: () => dispose("finalize"),
    discard: () => dispose("discard"),
  }
}

export * as AttemptTelemetry from "./attempt-telemetry"
