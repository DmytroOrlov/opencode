import type { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ModelAttemptRef } from "./model-attempt"

export type FallbackResolution =
  | {
      reason: "disabled" | "already_used" | "same_model" | "model_unavailable" | "variant_unavailable"
      ref?: ModelAttemptRef
    }
  | { reason: "available"; ref: ModelAttemptRef; model: Provider.Model }

export type AvailableFallback = Extract<FallbackResolution, { reason: "available" }>

export type RecoveryFacts = {
  interrupted: boolean
  contextOverflow: boolean
  needsCompaction: boolean
  blocked: boolean
  executingToolCalls: number
  settledExecutedToolCalls: number
  fallback: FallbackResolution
  retryable: boolean
  retryExhausted: boolean
}

export type RecoveryDecision =
  | { type: "retry_current"; reason: "retryable_failure" }
  | { type: "failover_restart"; reason: "replay_safe"; fallback: AvailableFallback }
  | { type: "failover_continue"; reason: "settled_tool_result"; fallback: AvailableFallback }
  | { type: "continue_current"; reason: "settled_tool_result" }
  | {
      type: "terminal"
      reason:
        | "executing_tool_unknown"
        | "aborted"
        | "context_overflow"
        | "blocked"
        | "retry_exhausted"
        | "non_retryable_failure"
    }

export function decide(facts: RecoveryFacts): RecoveryDecision {
  if (facts.interrupted) return { type: "terminal", reason: "aborted" }
  if (facts.contextOverflow || facts.needsCompaction) return { type: "terminal", reason: "context_overflow" }
  if (facts.blocked) return { type: "terminal", reason: "blocked" }
  if (facts.executingToolCalls > 0) return { type: "terminal", reason: "executing_tool_unknown" }
  if (facts.fallback.reason === "available") {
    if (facts.settledExecutedToolCalls > 0)
      return { type: "failover_continue", reason: "settled_tool_result", fallback: facts.fallback }
    return { type: "failover_restart", reason: "replay_safe", fallback: facts.fallback }
  }
  if (facts.settledExecutedToolCalls > 0 && facts.retryable) {
    return { type: "continue_current", reason: "settled_tool_result" }
  }
  if (facts.retryable && !facts.retryExhausted) return { type: "retry_current", reason: "retryable_failure" }
  return {
    type: "terminal",
    reason: facts.retryable ? "retry_exhausted" : "non_retryable_failure",
  }
}

export function errorFacts(error: unknown, input: Omit<RecoveryFacts, "interrupted" | "contextOverflow" | "retryable">, retryable: boolean) {
  return {
    ...input,
    interrupted: SessionV1.AbortedError.isInstance(error),
    contextOverflow: SessionV1.ContextOverflowError.isInstance(error),
    retryable,
  } satisfies RecoveryFacts
}

export * as SessionRecovery from "./recovery"
