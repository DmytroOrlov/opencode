import type { LayoutRoute } from "@/shell/state/layout"
import type { ServerConnection } from "@/runtime/server/registry"

export type CaBadgeServerInput = {
  route: LayoutRoute
  draftServer?: ServerConnection.Key
  homeServer?: ServerConnection.Key
  settingsServer?: ServerConnection.Key
}

export function selectCaBadgeServer(
  input: CaBadgeServerInput,
): ServerConnection.Key | undefined {
  switch (input.route.type) {
    case "session":
      return input.route.server
    case "draft":
      return input.draftServer
    case "home":
      return input.homeServer
    case "settings":
      return input.settingsServer
    default:
      return undefined
  }
}

export type CaBadge = {
  labelKey:
    | "server.tlsCa.mode.bundled"
    | "server.tlsCa.mode.system"
    | "server.tlsCa.mode.unknown"
  tooltipKey:
    | "server.tlsCa.description.bundled"
    | "server.tlsCa.description.system"
    | "server.tlsCa.description.unknown"
  className: string
}

export function caBadgeMapping(mode: string | undefined): CaBadge {
  if (mode === "bundled") {
    return {
      labelKey: "server.tlsCa.mode.bundled",
      tooltipKey: "server.tlsCa.description.bundled",
      className: "bg-v2-state-bg-success text-v2-state-fg-success",
    }
  }
  if (mode === "system") {
    return {
      labelKey: "server.tlsCa.mode.system",
      tooltipKey: "server.tlsCa.description.system",
      className: "bg-v2-state-bg-warning text-v2-state-fg-warning",
    }
  }
  return {
    labelKey: "server.tlsCa.mode.unknown",
    tooltipKey: "server.tlsCa.description.unknown",
    className: "bg-v2-state-bg-danger text-v2-state-fg-danger",
  }
}
