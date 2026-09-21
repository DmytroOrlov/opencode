export type CaBadge = {
  label: string
  className: string
  tooltip: string
}

export function caBadgeMapping(mode: string | undefined): CaBadge {
  if (mode === "bundled") {
    return {
      label: "CA:BUNDLED",
      className: "bg-v2-state-bg-success text-v2-state-fg-success",
      tooltip: "Bun default CA set was verified as bundled at startup.",
    }
  }
  if (mode === "system") {
    return {
      label: "CA:SYSTEM",
      className: "bg-v2-state-bg-warning text-v2-state-fg-warning",
      tooltip: "Bun default CA mode was verified as system at startup; certificate verification is enabled.",
    }
  }
  return {
    label: "CA:UNKNOWN",
    className: "bg-v2-state-bg-danger text-v2-state-fg-danger",
    tooltip: "TLS default CA mode was not verified.",
  }
}
