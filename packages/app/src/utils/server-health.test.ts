import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { checkServerHealth } from "./server-health"

const server: ServerConnection.HttpBase = {
  url: "http://localhost:4096",
}

function abortFromInput(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.signal) return init.signal
  if (input instanceof Request) return input.signal
  return undefined
}

function headerFromInput(input: RequestInfo | URL, init?: RequestInit, name?: string): string | undefined {
  const h = init?.headers
  if (h instanceof Headers) return (h as Headers).get(name ?? "") ?? undefined
  if (typeof h === "object" && h !== null) return (h as Record<string, string>)[name ?? ""]
  if (input instanceof Request) return input.headers.get(name ?? "") ?? undefined
  return undefined
}

describe("checkServerHealth", () => {
  test("returns healthy response with version and tlsCaMode", async () => {
    let request: URL | undefined
    const fetch = (async (input: RequestInfo | URL) => {
      request = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3", tlsCaMode: "system" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: true, version: "1.2.3", tlsCaMode: "system" })
    expect(request?.pathname).toBe("/global/health")
  })

  test("v2 success does not call legacy health", async () => {
    const paths: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
      paths.push(url.pathname)
      return Response.json({ healthy: true, version: "1.2.3", tlsCaMode: "system" })
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: true, version: "1.2.3", tlsCaMode: "system" })
    expect(paths).toEqual(["/global/health"])
  })

  test("falls back to legacy health when v2 fails", async () => {
    const paths: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
      paths.push(url.pathname)
      if (url.pathname === "/global/health") return new Response(undefined, { status: 404 })
      return Response.json({ healthy: true, version: "1.18.4" })
    }) as unknown as typeof globalThis.fetch

    expect(await checkServerHealth(server, fetch)).toEqual({ healthy: true, version: "1.18.4" })
    expect(paths).toEqual(["/global/health", "/api/health"])
  })

  test("legacy success returns no tlsCaMode", async () => {
    const fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
      if (url.pathname === "/global/health") return new Response(undefined, { status: 404 })
      return Response.json({ healthy: true, version: "1.18.4" })
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch)
    expect(result).toEqual({ healthy: true, version: "1.18.4" })
    expect("tlsCaMode" in result).toBe(false)
  })

  test("authentication is present on both /global/health and /api/health", async () => {
    const authServer: ServerConnection.HttpBase = {
      url: "http://localhost:4096",
      username: "user",
      password: "pass",
    }
    const auths: Record<string, string> = {}
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
      const auth = headerFromInput(input, init, "Authorization")
      if (auth) auths[url.pathname] = auth
      if (url.pathname === "/global/health") return new Response(undefined, { status: 404 })
      return Response.json({ healthy: true, version: "1.18.4" })
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(authServer, fetch)
    expect(result).toEqual({ healthy: true, version: "1.18.4" })
    expect(auths["/global/health"]).toBe("Basic dXNlcjpwYXNz")
    expect(auths["/api/health"]).toBe("Basic dXNlcjpwYXNz")
  })

  test("retries when v2 fails and legacy throws transport error", async () => {
    let legacyCalls = 0
    const paths: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
      paths.push(url.pathname)
      if (url.pathname === "/global/health") return new Response(undefined, { status: 404 })
      legacyCalls++
      if (legacyCalls === 1) throw new TypeError("network error")
      return Response.json({ healthy: true, version: "1.0.0" })
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch, {
      retryCount: 2,
      retryDelayMs: 1,
    })

    expect(result).toEqual({ healthy: true, version: "1.0.0" })
    expect(legacyCalls).toBe(2)
    expect(paths).toEqual(["/global/health", "/api/health", "/global/health", "/api/health"])
  })

  test("allows slow servers thirty seconds by default", async () => {
    const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")
    let timeoutMs = 0
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (ms: number) => {
        timeoutMs = ms
        return new AbortController().signal
      },
    })

    const fetch = (async () =>
      new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch

    await checkServerHealth(server, fetch).finally(() => {
      if (timeout) Object.defineProperty(AbortSignal, "timeout", timeout)
      if (!timeout) Reflect.deleteProperty(AbortSignal, "timeout")
    })

    expect(timeoutMs).toBe(30_000)
  })

  test("returns unhealthy when request fails", async () => {
    const fetch = (async () => {
      throw new Error("network")
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: false })
  })

  test("uses timeout fallback when AbortSignal.timeout is unavailable", async () => {
    const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: undefined,
    })

    let aborted = false
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = abortFromInput(input, init)
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(new DOMException("Aborted", "AbortError"))
          },
          { once: true },
        )
      })) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch, {
      timeoutMs: 10,
    }).finally(() => {
      if (timeout) Object.defineProperty(AbortSignal, "timeout", timeout)
      if (!timeout) Reflect.deleteProperty(AbortSignal, "timeout")
    })

    expect(aborted).toBe(true)
    expect(result).toEqual({ healthy: false })
  })

  test("uses provided abort signal", async () => {
    let signal: AbortSignal | undefined
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      signal = abortFromInput(input, init)
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    const abort = new AbortController()
    await checkServerHealth(server, fetch, {
      signal: abort.signal,
    })

    expect(signal).toBe(abort.signal)
  })

  test("retries transient failures and eventually succeeds", async () => {
    let count = 0
    const fetch = (async () => {
      count += 1
      if (count < 3) throw new TypeError("network")
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch, {
      retryCount: 2,
      retryDelayMs: 1,
    })

    expect(count).toBe(3)
    expect(result).toEqual({ healthy: true, version: "1.2.3" })
  })

  test("returns unhealthy when retries are exhausted", async () => {
    let count = 0
    const fetch = (async () => {
      count += 1
      throw new TypeError("network")
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch, {
      retryCount: 2,
      retryDelayMs: 1,
    })

    expect(count).toBe(6)
    expect(result).toEqual({ healthy: false })
  })
})
