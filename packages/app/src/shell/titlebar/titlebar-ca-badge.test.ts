import { describe, expect, test } from "bun:test"
import { selectServerTlsCaMode, type ServerHealth } from "@/runtime/server/health-machine"
import { ServerConnection } from "@/runtime/server/registry"
import type { LayoutRoute } from "@/shell/state/layout"
import { caBadgeMapping, selectCaBadgeServer, type CaBadge, type CaBadgeServerInput } from "./titlebar-ca-badge"

describe("caBadgeMapping", () => {
  test("bundled mode returns green/security-positive badge", () => {
    const result = caBadgeMapping("bundled")
    expect(result.labelKey).toBe("server.tlsCa.mode.bundled")
    expect(result.className).toContain("bg-v2-state-bg-success")
    expect(result.className).toContain("text-v2-state-fg-success")
    expect(result.tooltipKey).toBe("server.tlsCa.description.bundled")
  })

  test("system mode returns warning/yellow badge", () => {
    const result = caBadgeMapping("system")
    expect(result.labelKey).toBe("server.tlsCa.mode.system")
    expect(result.className).toContain("bg-v2-state-bg-warning")
    expect(result.className).toContain("text-v2-state-fg-warning")
    expect(result.tooltipKey).toBe("server.tlsCa.description.system")
  })

  test("undefined returns danger/red unknown badge", () => {
    const result = caBadgeMapping(undefined)
    expect(result.labelKey).toBe("server.tlsCa.mode.unknown")
    expect(result.className).toContain("bg-v2-state-bg-danger")
    expect(result.className).toContain("text-v2-state-fg-danger")
    expect(result.tooltipKey).toBe("server.tlsCa.description.unknown")
  })

  test("unknown string returns danger/red unknown badge", () => {
    const result = caBadgeMapping("garbage")
    expect(result.labelKey).toBe("server.tlsCa.mode.unknown")
    expect(result.className).toContain("bg-v2-state-bg-danger")
    expect(result.className).toContain("text-v2-state-fg-danger")
  })

  test("all three mappings produce distinct classes", () => {
    const bundled = caBadgeMapping("bundled")
    const system = caBadgeMapping("system")
    const unknown = caBadgeMapping(undefined)
    expect(bundled.className).not.toBe(system.className)
    expect(system.className).not.toBe(unknown.className)
    expect(unknown.className).not.toBe(bundled.className)
  })
})

describe("selectCaBadgeServer", () => {
  const A = ServerConnection.Key.make("http://127.0.0.1:4096")
  const B = ServerConnection.Key.make("http://127.0.0.1:4097")
  const sidecar = ServerConnection.Key.make("sidecar")

  const otherInputs = {
    draftServer: B,
    homeServer: B,
    settingsServer: B,
  } satisfies Omit<CaBadgeServerInput, "route">

  test("session routes return their exact key without consulting another context", () => {
    expect(
      selectCaBadgeServer({
        route: { type: "session", sessionId: "session-a", server: A },
        ...otherInputs,
      }),
    ).toBe(A)
  })

  test("draft routes use only the resolved draft server", () => {
    const route: LayoutRoute = { type: "draft", draftID: "draft-b" }

    expect(selectCaBadgeServer({ route, ...otherInputs })).toBe(B)
    expect(
      selectCaBadgeServer({
        route,
        draftServer: undefined,
        homeServer: B,
        settingsServer: B,
      }),
    ).toBeUndefined()
  })

  test("Home routes use the bound focused server", () => {
    const route: LayoutRoute = { type: "home" }

    expect(selectCaBadgeServer({ route, ...otherInputs, homeServer: sidecar })).toBe(sidecar)
    expect(
      selectCaBadgeServer({
        route,
        draftServer: B,
        homeServer: undefined,
        settingsServer: B,
      }),
    ).toBeUndefined()
  })

  test("Settings routes use their visible context", () => {
    expect(
      selectCaBadgeServer({
        route: { type: "settings" },
        ...otherInputs,
        settingsServer: A,
      }),
    ).toBe(A)
  })

  test("routes without a server context return undefined", () => {
    for (const route of [{ type: "connect" }, { type: "components" }] satisfies LayoutRoute[])
      expect(selectCaBadgeServer({ route, ...otherInputs })).toBeUndefined()
  })

  test("a removed session route keeps its exact key; missing health is unknown, not another key's mode", () => {
    const removed = ServerConnection.Key.make("http://127.0.0.1:4999")
    const route: LayoutRoute = { type: "session", sessionId: "removed", server: removed }
    const health: Record<string, ServerHealth | undefined> = {
      [A]: { type: "healthy", tlsCaMode: "bundled" },
      [B]: { type: "healthy", tlsCaMode: "system" },
    }

    const key = selectCaBadgeServer({ route, ...otherInputs })

    expect(key).toBe(removed)
    expect(caBadgeMapping(selectServerTlsCaMode(key ? health[key] : undefined)).labelKey).toBe(
      "server.tlsCa.mode.unknown",
    )
    expect(caBadgeMapping(selectServerTlsCaMode(health[B])).labelKey).toBe("server.tlsCa.mode.system")
  })

  test("healthy-only metadata drives the mapping through the selected key", () => {
    const checking = ServerConnection.Key.make("checking")
    const starting = ServerConnection.Key.make("starting")
    const unauthorized = ServerConnection.Key.make("unauthorized")
    const incompatible = ServerConnection.Key.make("incompatible")
    const unreachable = ServerConnection.Key.make("unreachable")
    const health: Record<string, ServerHealth | undefined> = {
      [A]: { type: "healthy", tlsCaMode: "bundled" },
      [B]: { type: "healthy", tlsCaMode: "system" },
      [sidecar]: { type: "healthy" },
      [checking]: { type: "checking", managed: false },
      [starting]: { type: "starting" },
      [unauthorized]: { type: "unauthorized" },
      [incompatible]: { type: "incompatible" },
      [unreachable]: { type: "unreachable" },
    }
    const expected: Array<[ServerConnection.Key, CaBadge["labelKey"]]> = [
      [A, "server.tlsCa.mode.bundled"],
      [B, "server.tlsCa.mode.system"],
      [sidecar, "server.tlsCa.mode.unknown"],
      [checking, "server.tlsCa.mode.unknown"],
      [starting, "server.tlsCa.mode.unknown"],
      [unauthorized, "server.tlsCa.mode.unknown"],
      [incompatible, "server.tlsCa.mode.unknown"],
      [unreachable, "server.tlsCa.mode.unknown"],
    ]

    for (const [server, labelKey] of expected) {
      const route: LayoutRoute = { type: "session", sessionId: server, server }
      const key = selectCaBadgeServer({ route, ...otherInputs })

      expect(key).toBe(server)
      expect(caBadgeMapping(selectServerTlsCaMode(key ? health[key] : undefined)).labelKey).toBe(labelKey)
    }
  })
})
