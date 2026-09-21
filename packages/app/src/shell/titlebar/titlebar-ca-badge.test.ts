import { describe, expect, test } from "bun:test"
import { caBadgeMapping } from "./titlebar-ca-badge"

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
