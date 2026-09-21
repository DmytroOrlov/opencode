import type { SessionTelemetry } from "@opencode/client/promise"

export type AttemptTelemetry = {
  readonly attemptID: SessionTelemetry["data"]["attemptID"]
  readonly attemptSequence: SessionTelemetry["data"]["attemptSequence"]
  readonly phase: SessionTelemetry["data"]["phase"]
  readonly measurements: SessionTelemetry["data"]["measurements"]
}

export type State = Readonly<Record<string, AttemptTelemetry | undefined>>

export function resetForConnectionEpoch(): State {
  return {}
}

export function reduce(state: State, event: SessionTelemetry["data"]): State {
  const current = state[event.assistantMessageID]
  if (event.phase === "start") {
    if (current && event.attemptSequence <= current.attemptSequence) return state
    return {
      ...state,
      [event.assistantMessageID]: {
        attemptID: event.attemptID,
        attemptSequence: event.attemptSequence,
        phase: event.phase,
        measurements: [],
      },
    }
  }
  if (
    !current ||
    current.attemptID !== event.attemptID ||
    current.attemptSequence !== event.attemptSequence
  )
    return state
  return {
    ...state,
    [event.assistantMessageID]: {
      attemptID: event.attemptID,
      attemptSequence: event.attemptSequence,
      phase: event.phase,
      measurements: event.phase === "discard" ? [] : event.measurements,
    },
  }
}

export function measurement(state: State, assistantMessageID: string, metric: string) {
  const attempt = state[assistantMessageID]
  if (!attempt) return undefined
  return attempt.measurements.find((value) => value.metric === metric)
}
