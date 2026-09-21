export type GenerationTelemetrySnapshot = {
  phase: "prefill" | "decode"
  processed?: number
  total?: number
  tokensPerSecond?: number
  done?: boolean
  source?: "provider" | "fallback"
  approximate?: boolean
}

const prefillPercent = (processed: number | undefined, total: number | undefined) => {
  if (typeof processed !== "number" || !Number.isFinite(processed) || processed < 0) return undefined
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return undefined
  return Math.min(100, Math.max(0, Math.floor((processed / total) * 100)))
}

const formatRate = (rate: number | undefined, locale?: string) => {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return undefined
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(rate)
}

// Estimated client-side counts render as `~NN.N tok/s`; provider-authoritative
// or usage-corrected numbers do not. Derived from snapshot metadata only.
const rateText = (snapshot: GenerationTelemetrySnapshot, locale?: string) => {
  const rate = formatRate(snapshot.tokensPerSecond, locale)
  if (rate === undefined) return undefined
  return `${snapshot.approximate === true ? "~" : ""}${rate} tok/s`
}

export function formatThinkingTelemetry(
  base: string,
  snapshot: GenerationTelemetrySnapshot | undefined,
  locale?: string,
): string {
  if (!snapshot || snapshot.done === true) return base
  if (snapshot.phase === "prefill") {
    const percent = prefillPercent(snapshot.processed, snapshot.total)
    if (percent === undefined) return base
    return `${base} · context ${percent}%`
  }
  if (snapshot.phase === "decode") {
    const rate = rateText(snapshot, locale)
    if (rate === undefined) return base
    return `${base} · ${rate}`
  }
  return base
}

export function selectGenerationTelemetry<T extends { id: string }>(
  assistantMessages: T[],
  telemetry: Record<string, GenerationTelemetrySnapshot | undefined> | undefined,
): GenerationTelemetrySnapshot | undefined {
  const latest = assistantMessages.at(-1)
  if (!latest) return undefined
  return telemetry?.[latest.id]
}

export type GenerationRateEntry = {
  key: string
  messageID: string
  kind: "tool" | "text"
}

export function formatGenerationRate(
  snapshot: GenerationTelemetrySnapshot | undefined,
  locale?: string,
): string | undefined {
  if (!snapshot || snapshot.done !== true || snapshot.phase !== "decode") return undefined
  return rateText(snapshot, locale)
}

export function completedGenerationRates<
  T extends { id: string; sessionID: string; finish?: string; error?: unknown },
>(
  messages: readonly T[],
  telemetry: Record<string, Record<string, GenerationTelemetrySnapshot | undefined> | undefined> | undefined,
  locale?: string,
): Map<string, string> {
  const rates = new Map<string, string>()
  for (const message of messages) {
    // Normal model requests signal completion via `finish` (step-finish), not `time.completed`.
    if (typeof message.finish !== "string" || message.finish.length === 0 || message.error) continue
    const rate = formatGenerationRate(telemetry?.[message.sessionID]?.[message.id], locale)
    if (rate) rates.set(message.id, rate)
  }
  return rates
}

export function selectGenerationRateTargets(
  entries: readonly GenerationRateEntry[],
  rates: ReadonlyMap<string, string>,
): Map<string, string> {
  const lastTool = new Map<string, string>()
  const lastText = new Map<string, string>()
  for (const entry of entries) {
    if (!rates.has(entry.messageID)) continue
    if (entry.kind === "tool") {
      lastTool.set(entry.messageID, entry.key)
      continue
    }
    lastText.set(entry.messageID, entry.key)
  }

  const targets = new Map<string, string>()
  for (const [messageID, rate] of rates) {
    const key = lastTool.get(messageID) ?? lastText.get(messageID)
    if (key) targets.set(key, rate)
  }
  return targets
}
