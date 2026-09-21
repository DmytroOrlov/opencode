import type { GenerationTelemetrySnapshot } from "@opencode-ai/session-ui/generation-telemetry"

type SessionTelemetryProperties = {
  sessionID: string
  assistantMessageID: string
  phase: GenerationTelemetrySnapshot["phase"]
  processed?: number
  total?: number
  tokensPerSecond?: number
  done?: boolean
  source?: GenerationTelemetrySnapshot["source"]
  approximate?: boolean
}

export function projectGenerationTelemetry(properties: unknown) {
  const props = properties as SessionTelemetryProperties
  if (!props.sessionID || !props.assistantMessageID) return
  return {
    sessionID: props.sessionID,
    assistantMessageID: props.assistantMessageID,
    snapshot: {
      phase: props.phase,
      processed: props.processed,
      total: props.total,
      tokensPerSecond: props.tokensPerSecond,
      done: props.done,
      source: props.source,
      approximate: props.approximate,
    } satisfies GenerationTelemetrySnapshot,
  }
}
