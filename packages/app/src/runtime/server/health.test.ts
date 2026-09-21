import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/runtime/server/registry"
import { createServerHealthChecker, checkServerHealth } from "./health"
import { ServerKey } from "./persistence"

const server: ServerConnection.HttpBase = {
  url: "http://localhost:4096",
}

const info = (version = "1.2.3", tlsCaMode?: "bundled" | "system", hostname?: string) =>
  Response.json({
    version,
    pid: 1,
    urls: [server.url],
    paths: { tmp: "/tmp/opencode" },
    ...(tlsCaMode ? { tlsCaMode } : {}),
    ...(hostname ? { hostname } : {}),
  })

// SAFETY: `checkServerHealth` only calls `fetch(input, init)`, which these fakes implement; none reads `preconnect`.
const fakeFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  handler as typeof globalThis.fetch

function controlledFetch() {
  const requests: ReturnType<typeof Promise.withResolvers<Response>>[] = []

  return {
    requests,
    fetch: fakeFetch(() => {
      const request = Promise.withResolvers<Response>()
      requests.push(request)

      return request.promise
    }),
  }
}

// A deterministic clock for the cache's cleanup timers: `jump` moves time without delivering them.
function fakeClock() {
  const originalNow = Date.now
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let now = 0
  let nextID = 0
  const timers = new Map<number, { readonly id: number; readonly at: number; readonly run: () => void }>()

  Date.now = () => now
  globalThis.setTimeout = ((run: () => void, ms = 0) => {
    const id = ++nextID
    timers.set(id, { id, at: now + ms, run })

    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout> | undefined) => {
    if (typeof id === "number") timers.delete(id)
  }) as typeof clearTimeout

  const next = () =>
    [...timers.values()].filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at || a.id - b.id)[0]

  return {
    advance(ms: number) {
      now += ms

      for (let timer = next(); timer; timer = next()) {
        timers.delete(timer.id)
        timer.run()
      }
    },
    jump(ms: number) {
      now += ms
    },
    pending: () => timers.size,
    restore() {
      Date.now = originalNow
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}

function scope(name: string, incarnation = 1) {
  return { key: ServerKey.make(`http://${name}`), incarnation }
}

// Puts back the `AbortSignal.timeout` a test replaced, or removes the stand-in when the runtime had none.
function restoreTimeout(descriptor: PropertyDescriptor | undefined) {
  if (descriptor) return void Object.defineProperty(AbortSignal, "timeout", descriptor)

  const signal: Partial<typeof AbortSignal> = AbortSignal
  delete signal.timeout
}

function abortFromInput(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.signal) return init.signal

  if (input instanceof Request) return input.signal

  return undefined
}

describe("checkServerHealth", () => {
  test.each([undefined, "secret"])("reads /api/info authenticating with only the password (%s)", async (password) => {
    const requests: { path: string; authorization: string | null }[] = []

    const fetch = fakeFetch(async (input, init) => {
      const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
      requests.push({ path: url.pathname, authorization: new Headers(init?.headers).get("authorization") })

      return info("2.0.0", "system", "srv-a")
    })

    expect(await checkServerHealth({ ...server, password }, fetch)).toEqual({
      type: "healthy",
      version: "2.0.0",
      hostname: "srv-a",
      tlsCaMode: "system",
    })
    expect(requests).toEqual([
      { path: "/api/info", authorization: password ? `Basic ${btoa(`opencode:${password}`)}` : null },
    ])
  })

  test("keeps the CA mode unknown when an older server omits metadata", async () => {
    const fetch = fakeFetch(async () => info("1.0.0"))
    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ type: "healthy", version: "1.0.0" })
    expect("tlsCaMode" in result).toBe(false)
  })

  test("reports rejected credentials without retrying", async () => {
    let calls = 0

    const fetch = fakeFetch(async () => {
      calls++

      return new Response(`{"_tag":"UnauthorizedError","message":"Authentication required"}`, {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    })

    expect(await checkServerHealth(server, fetch)).toEqual({ type: "unauthorized" })
    expect(calls).toBe(1)
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

    const fetch = fakeFetch(async () => info())

    await checkServerHealth(server, fetch).finally(() => restoreTimeout(timeout))

    expect(timeoutMs).toBe(30_000)
  })

  test("uses timeout fallback when AbortSignal.timeout is unavailable", async () => {
    const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: undefined,
    })

    let aborted = false

    const fetch = fakeFetch(
      (input, init) =>
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
        }),
    )

    const result = await checkServerHealth(server, fetch, {
      timeoutMs: 10,
    }).finally(() => restoreTimeout(timeout))

    expect(aborted).toBe(true)
    expect(result).toEqual({ type: "unreachable" })
  })

  test("uses provided abort signal", async () => {
    let signal: AbortSignal | undefined

    const fetch = fakeFetch(async (input, init) => {
      signal = abortFromInput(input, init)

      return info()
    })

    const abort = new AbortController()
    await checkServerHealth(server, fetch, {
      signal: abort.signal,
    })

    expect(signal).toBe(abort.signal)
  })

  test("retries transient failures and eventually succeeds", async () => {
    let count = 0

    const fetch = fakeFetch(async () => {
      count += 1

      if (count < 3) throw new TypeError("network")

      return info()
    })

    const result = await checkServerHealth(server, fetch, {
      retryCount: 2,
      retryDelayMs: 1,
    })

    expect(count).toBe(3)
    expect(result).toEqual({ type: "healthy", version: "1.2.3" })
  })

  test("returns unreachable when retries are exhausted", async () => {
    let count = 0

    const fetch = fakeFetch(async () => {
      count += 1
      throw new TypeError("network")
    })

    const result = await checkServerHealth(server, fetch, {
      retryCount: 2,
      retryDelayMs: 1,
    })

    expect(count).toBe(3)
    expect(result).toEqual({ type: "unreachable" })
  })
})

describe("createServerHealthChecker", () => {
  test("coalesces the same owner, key, incarnation and endpoint", async () => {
    const fixture = controlledFetch()
    const checker = createServerHealthChecker(fixture.fetch)
    const current = scope("coalesce")

    const first = checker.check(server, current)
    const second = checker.check(server, current)

    expect(second).toBe(first)
    expect(fixture.requests).toHaveLength(1)

    fixture.requests[0]!.resolve(info())
    expect(await second).toEqual({ type: "healthy", version: "1.2.3" })
    checker.dispose()
  })

  test("does not share across incarnations, keys or credentials", async () => {
    const fixture = controlledFetch()
    const checker = createServerHealthChecker(fixture.fetch)

    const incarnations = [
      checker.check(server, scope("identity", 1)),
      checker.check(server, scope("identity", 2)),
      checker.check(server, scope("other-key", 1)),
      checker.check({ ...server, password: "pw" }, scope("identity", 1)),
    ]

    expect(new Set(incarnations).size).toBe(4)
    expect(fixture.requests).toHaveLength(4)

    fixture.requests.forEach((request) => request.resolve(info()))
    await Promise.all(incarnations)
    checker.dispose()
  })

  test("does not share across owner lifetimes", async () => {
    const fixture = controlledFetch()
    const first = createServerHealthChecker(fixture.fetch)
    const second = createServerHealthChecker(fixture.fetch)
    const current = scope("owner")

    try {
      const left = first.check(server, current)
      const right = second.check(server, current)

      expect(right).not.toBe(left)
      expect(fixture.requests).toHaveLength(2)

      first.dispose()
      expect(second.check(server, current)).toBe(right)
      expect(fixture.requests).toHaveLength(2)

      fixture.requests[0]!.resolve(info())
      fixture.requests[1]!.resolve(info())
      await Promise.all([left, right])
    } finally {
      first.dispose()
      second.dispose()
    }
  })

  test("retains a settled answer for 750 ms after it completes", async () => {
    const clock = fakeClock()

    try {
      const fixture = controlledFetch()
      const checker = createServerHealthChecker(fixture.fetch)
      const current = scope("retention")

      const first = checker.check(server, current)
      clock.advance(100)
      fixture.requests[0]!.resolve(info())
      await first

      expect(clock.pending()).toBe(1)
      clock.advance(749)
      expect(checker.check(server, current)).toBe(first)
      expect(fixture.requests).toHaveLength(1)

      clock.advance(1)
      const second = checker.check(server, current)
      expect(second).not.toBe(first)
      expect(fixture.requests).toHaveLength(2)

      fixture.requests[1]!.resolve(info())
      await second
      checker.dispose()
      expect(clock.pending()).toBe(0)
    } finally {
      clock.restore()
    }
  })

  test("expiry removes the retained entry and a late answer cannot renew it", async () => {
    const clock = fakeClock()

    try {
      const fixture = controlledFetch()
      const checker = createServerHealthChecker(fixture.fetch)
      const current = scope("expiry")

      const first = checker.check(server, current)
      expect(clock.pending()).toBe(1)

      clock.advance(750)
      expect(clock.pending()).toBe(0)

      fixture.requests[0]!.resolve(info())
      await first
      expect(clock.pending()).toBe(0)

      const second = checker.check(server, current)
      expect(fixture.requests).toHaveLength(2)

      fixture.requests[1]!.resolve(info())
      await second
      checker.dispose()
      expect(clock.pending()).toBe(0)
    } finally {
      clock.restore()
    }
  })

  test("an expired entry cannot be refreshed by a late promise or remove its replacement", async () => {
    const clock = fakeClock()

    try {
      const fixture = controlledFetch()
      const checker = createServerHealthChecker(fixture.fetch)
      const current = scope("replacement")

      const first = checker.check(server, current)
      clock.jump(750)

      const second = checker.check(server, current)
      expect(second).not.toBe(first)
      expect(fixture.requests).toHaveLength(2)
      expect(clock.pending()).toBe(1)

      fixture.requests[0]!.resolve(info())
      await first
      expect(checker.check(server, current)).toBe(second)
      expect(clock.pending()).toBe(1)

      fixture.requests[1]!.resolve(info())
      await second
      checker.dispose()
      expect(clock.pending()).toBe(0)
    } finally {
      clock.restore()
    }
  })

  test("disposal cancels cleanup timers and blocks late requests or reinsertion", async () => {
    const clock = fakeClock()

    try {
      const fixture = controlledFetch()
      const checker = createServerHealthChecker(fixture.fetch)

      const first = checker.check(server, scope("dispose-a"))
      const second = checker.check(server, scope("dispose-b"))
      expect(clock.pending()).toBe(2)

      checker.dispose()
      expect(clock.pending()).toBe(0)

      expect(await checker.check(server, scope("dispose-a"))).toEqual({ type: "unreachable" })
      expect(fixture.requests).toHaveLength(2)

      fixture.requests[0]!.resolve(info())
      fixture.requests[1]!.resolve(info())
      await Promise.all([first, second])

      expect(clock.pending()).toBe(0)
      expect(fixture.requests).toHaveLength(2)
    } finally {
      clock.restore()
    }
  })
})
