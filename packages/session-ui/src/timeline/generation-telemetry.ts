import type { SessionTelemetry } from "@opencode/client/promise"

export type Measurement = SessionTelemetry["data"]["measurements"][number]

const rateText = (
  value: Extract<Measurement, { metric: "decode-rate" }> | undefined,
  locale?: string,
) => {
  if (!value || !Number.isFinite(value.tokensPerSecond) || value.tokensPerSecond <= 0) return undefined
  const rate = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
    value.tokensPerSecond,
  )
  return `${value.source === "estimated" || value.approximate ? "~" : ""}${rate} tok/s`
}

export function formatThinkingTelemetry(base: string, measurement: Measurement | undefined, locale?: string) {
  if (!measurement) return base
  if (measurement.metric === "prefill-progress") {
    if (!Number.isFinite(measurement.processed) || !Number.isFinite(measurement.total) || measurement.total <= 0)
      return base
    const percent = Math.min(100, Math.max(0, Math.floor((measurement.processed / measurement.total) * 100)))
    return `${base} · context ${percent}%`
  }
  const rate = rateText(measurement, locale)
  return rate ? `${base} · ${rate}` : base
}

export function formatGenerationRate(measurement: Measurement | undefined, locale?: string) {
  return measurement?.metric === "decode-rate" ? rateText(measurement, locale) : undefined
}

export function selectGenerationRateTarget(entries: ReadonlyArray<{ id: string; kind: "tool" | "text" | "other" }>) {
  return entries.findLast((entry) => entry.kind === "tool")?.id ??
    entries.findLast((entry) => entry.kind === "text")?.id
}
