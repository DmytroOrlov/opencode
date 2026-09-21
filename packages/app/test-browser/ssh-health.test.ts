import { expect, mock, test } from "bun:test"
import { createRoot, createSignal, onCleanup } from "solid-js"
import type { HealthProbeScope } from "../src/runtime/server/health"
import type { ServerProbe, ServerProbeResult } from "../src/runtime/server/health-machine"
import type { PluginServerStatus } from "../src/runtime/server/plugin-machine"
import { ServerConnection } from "../src/runtime/server/registry"

let platformFetch: typeof globalThis.fetch = globalThis.fetch
mock.module("@/runtime/platform/platform", () => ({
  usePlatform: () => ({ fetch: platformFetch }),
}))

const { createServerHealth, createServerHealthChecker, useCheckServerHealth } = await import(
  "../src/runtime/server/health"
)

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function plugin(status: () => PluginServerStatus): ServerConnection.Plugin {
  return {
    type: "plugin",
    key: "ssh:fixture",
    plugin: "ssh",
    managed: true,
    authenticate: () => false,
    get status() {
      return status()
    },
  }
}

function probes() {
  const requests: ReturnType<typeof Promise.withResolvers<ServerProbeResult>>[] = []
  const scopes: HealthProbeScope[] = []

  return {
    requests,
    scopes,
    check: (_http: ServerConnection.HttpBase, scope: HealthProbeScope) => {
      scopes.push(scope)
      const request = Promise.withResolvers<ServerProbeResult>()
      requests.push(request)

      return request.promise
    },
  }
}

test("SSH health follows the plugin's stage and checks only an active tunnel", async () => {
  const fake = probes()
  const tunnel = { type: "ready", http: { url: "http://127.0.0.1:12345" } } as const

  const app = createRoot((dispose) => {
    const [status, setStatus] = createSignal<PluginServerStatus>({ type: "stopped" })
    const connection = plugin(status)
    const health = createServerHealth(() => [connection], fake.check)

    return { dispose, setStatus, health: () => health.status[ServerConnection.key(connection)] }
  })

  try {
    expect(app.health()).toEqual({ type: "stopped" })
    app.setStatus({ type: "starting" })
    expect(app.health()).toEqual({ type: "starting" })
    app.setStatus({ type: "auth" })
    expect(app.health()).toEqual({ type: "auth" })
    expect(fake.requests).toHaveLength(0)

    app.setStatus(tunnel)
    expect(fake.requests).toHaveLength(1)
    expect(app.health()).toEqual({ type: "checking", managed: true })

    // The tunnel asks for sign-in again before its probe answers: the late answer is stale.
    app.setStatus({ type: "auth" })
    fake.requests[0]?.resolve({ type: "unreachable" })
    await flush()
    expect(app.health()).toEqual({ type: "auth" })

    app.setStatus({ type: "failed" })
    expect(app.health()).toEqual({ type: "unreachable" })

    app.setStatus(tunnel)
    fake.requests[1]?.resolve({ type: "healthy", version: "2.0.0" })
    await flush()
    expect(app.health()).toEqual({ type: "healthy", version: "2.0.0" })
  } finally {
    app.dispose()
  }
})

test("a late failure from the old endpoint cannot overwrite the new endpoint check", async () => {
  const fake = probes()

  const app = createRoot((dispose) => {
    const [url, setUrl] = createSignal("http://127.0.0.1:12344")
    const connection = plugin(() => ({ type: "ready", http: { url: url() } }))
    const health = createServerHealth(() => [connection], fake.check)

    return { dispose, setUrl, health: () => health.status[ServerConnection.key(connection)] }
  })

  try {
    app.setUrl("http://127.0.0.1:12345")
    fake.requests[0]?.resolve({ type: "unreachable" })
    await flush()
    expect(app.health()).toEqual({ type: "checking", managed: true })
    fake.requests[1]?.resolve({ type: "healthy" })
    await flush()
    expect(app.health()).toEqual({ type: "healthy" })
  } finally {
    app.dispose()
  }
})

test("retry probes again before the next poll and resolves once that probe answers", async () => {
  const fake = probes()
  const connection: ServerConnection.Http = { type: "http", http: { url: "http://127.0.0.1:12346" } }

  const app = createRoot((dispose) => {
    const health = createServerHealth(() => [connection], fake.check)

    return { dispose, retry: health.retry, health: () => health.status[ServerConnection.key(connection)] }
  })

  try {
    fake.requests[0]?.resolve({ type: "unreachable" })
    await flush()
    expect(app.health()).toEqual({ type: "unreachable" })

    const state = { done: false }
    const retried = app.retry().then(() => (state.done = true))
    expect(fake.requests).toHaveLength(2)
    await flush()
    expect(state.done).toBe(false)
    fake.requests[1]?.resolve({ type: "healthy" })
    await retried
    expect(app.health()).toEqual({ type: "healthy" })
  } finally {
    app.dispose()
  }
})

test("disposal releases a retry whose probe never answers", async () => {
  const fake = probes()
  const connection: ServerConnection.Http = { type: "http", http: { url: "http://127.0.0.1:12347" } }

  const app = createRoot((dispose) => ({ dispose, health: createServerHealth(() => [connection], fake.check) }))

  const retried = app.health.retry()
  app.dispose()

  await retried
  expect(fake.requests).toHaveLength(2)
})

test.each([
  { type: "healthy", tlsCaMode: "bundled" },
  { type: "unauthorized" },
] as const)("remove/relist rejects a discarded $type answer", async (discarded) => {
  const fake = probes()
  const notifications: ServerProbe[] = []
  const connection: ServerConnection.Http = { type: "http", http: { url: "http://127.0.0.1:12348" } }

  const app = createRoot((dispose) => {
    const [listed, setListed] = createSignal(true)
    const health = createServerHealth(
      () => (listed() ? [connection] : []),
      fake.check,
      (probe) => notifications.push(probe),
    )

    return { dispose, setListed, health: () => health.status[ServerConnection.key(connection)] }
  })

  try {
    expect(fake.requests).toHaveLength(1)
    expect(app.health()).toEqual({ type: "checking", managed: false })

    app.setListed(false)
    app.setListed(true)
    expect(fake.requests).toHaveLength(2)
    expect(fake.scopes[0]?.key).toBe(ServerConnection.key(connection))
    expect(fake.scopes[1]?.key).toBe(ServerConnection.key(connection))
    expect(fake.scopes[1]?.incarnation).toBeGreaterThan(fake.scopes[0]!.incarnation)

    fake.requests[0]!.resolve(discarded)
    await flush()
    expect(app.health()).toEqual({ type: "checking", managed: false })
    expect(notifications).toEqual([])

    fake.requests[1]!.resolve({ type: "healthy", tlsCaMode: "system" })
    await flush()
    expect(app.health()).toEqual({ type: "healthy", tlsCaMode: "system" })
    expect(notifications).toEqual([
      {
        key: ServerConnection.key(connection),
        auth: "http://127.0.0.1:12348\n",
        result: { type: "healthy", tlsCaMode: "system" },
      },
    ])
  } finally {
    app.dispose()
  }
})

test("staged-to-ready rejects the previous incarnation at identical credentials", async () => {
  const fake = probes()
  const notifications: ServerProbe[] = []
  const tunnel = { type: "ready", http: { url: "http://127.0.0.1:12349", password: "pw" } } as const

  const app = createRoot((dispose) => {
    const [status, setStatus] = createSignal<PluginServerStatus>(tunnel)
    const connection = plugin(status)
    const health = createServerHealth(
      () => [connection],
      fake.check,
      (probe) => notifications.push(probe),
    )

    return { dispose, setStatus, health: () => health.status[ServerConnection.key(connection)] }
  })

  try {
    expect(fake.requests).toHaveLength(1)

    app.setStatus({ type: "auth" })
    expect(fake.requests).toHaveLength(1)
    expect(app.health()).toEqual({ type: "auth" })

    app.setStatus(tunnel)
    expect(fake.requests).toHaveLength(2)
    expect(fake.scopes[1]?.incarnation).toBeGreaterThan(fake.scopes[0]!.incarnation)

    fake.requests[0]!.resolve({ type: "healthy", tlsCaMode: "bundled" })
    await flush()
    expect(app.health()).toEqual({ type: "checking", managed: true })
    expect(notifications).toEqual([])

    fake.requests[1]!.resolve({ type: "healthy", tlsCaMode: "system" })
    await flush()
    expect(app.health()).toEqual({ type: "healthy", tlsCaMode: "system" })
    expect(notifications).toEqual([
      {
        key: ServerConnection.key(plugin(() => tunnel)),
        auth: "http://127.0.0.1:12349\npw",
        result: { type: "healthy", tlsCaMode: "system" },
      },
    ])
  } finally {
    app.dispose()
  }
})

test("a credential replacement during retry rejects the old answer and resolves on the current one", async () => {
  const fake = probes()
  const notifications: ServerProbe[] = []
  const [password, setPassword] = createSignal<string | undefined>("pw1")
  const connection: ServerConnection.Http = {
    type: "http",
    get http() {
      return { url: "http://127.0.0.1:12350", password: password() }
    },
  }
  let resolved = 0

  const app = createRoot((dispose) => {
    const health = createServerHealth(
      () => [connection],
      fake.check,
      (probe) => notifications.push(probe),
    )

    return { dispose, setPassword, retry: health.retry, health: () => health.status[ServerConnection.key(connection)] }
  })

  try {
    fake.requests[0]!.resolve({ type: "healthy" })
    await flush()
    expect(app.health()).toEqual({ type: "healthy" })

    const retried = app.retry().then(() => resolved++)
    expect(fake.requests).toHaveLength(2)

    app.setPassword("pw2")
    expect(fake.requests).toHaveLength(3)
    expect(app.health()).toEqual({ type: "checking", managed: false })

    fake.requests[1]!.resolve({ type: "healthy" })
    await flush()
    expect(resolved).toBe(0)
    expect(notifications).toHaveLength(1)
    expect(app.health()).toEqual({ type: "checking", managed: false })

    fake.requests[2]!.resolve({ type: "healthy", tlsCaMode: "system" })
    await retried
    expect(resolved).toBe(1)
    expect(notifications).toHaveLength(2)
    expect(notifications[1]?.auth).toBe("http://127.0.0.1:12350\npw2")
    expect(app.health()).toEqual({ type: "healthy", tlsCaMode: "system" })
  } finally {
    app.dispose()
  }
})

test("disposal rejects a late answer and starts no further probing", async () => {
  const fake = probes()
  const notifications: ServerProbe[] = []
  const connection: ServerConnection.Http = { type: "http", http: { url: "http://127.0.0.1:12351" } }

  const app = createRoot((dispose) => {
    const health = createServerHealth(
      () => [connection],
      fake.check,
      (probe) => notifications.push(probe),
    )

    return { dispose, retry: health.retry }
  })

  expect(fake.requests).toHaveLength(1)

  app.dispose()
  await app.retry()
  fake.requests[0]!.resolve({ type: "healthy" })
  await flush()

  expect(notifications).toEqual([])
  expect(fake.requests).toHaveLength(1)
})

test("an existing one-argument checker still drives the owner", async () => {
  const requests: ReturnType<typeof Promise.withResolvers<ServerProbeResult>>[] = []
  const check = (_http: ServerConnection.HttpBase) => {
    const request = Promise.withResolvers<ServerProbeResult>()
    requests.push(request)

    return request.promise
  }
  const connection: ServerConnection.Http = { type: "http", http: { url: "http://127.0.0.1:12354" } }

  const app = createRoot((dispose) => ({ dispose, health: createServerHealth(() => [connection], check) }))

  try {
    expect(requests).toHaveLength(1)

    requests[0]!.resolve({ type: "healthy" })
    await flush()
    expect(app.health.status[ServerConnection.key(connection)]).toEqual({ type: "healthy" })
  } finally {
    app.dispose()
  }
})

test("the non-owner checker keeps its one-argument endpoint coalescing API", async () => {
  const requests: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const fetch = (() => {
    const request = Promise.withResolvers<Response>()
    requests.push(request)

    return request.promise
  }) as typeof globalThis.fetch
  platformFetch = fetch

  const check = createRoot((dispose) => {
    const check = useCheckServerHealth()
    dispose()

    return check
  })

  try {
    const endpoint = { url: "http://127.0.0.1:12355" }
    const first = check(endpoint)
    const second = check(endpoint)

    expect(second).toBe(first)
    expect(requests).toHaveLength(1)

    const other = check({ ...endpoint, password: "pw" })
    expect(other).not.toBe(first)
    expect(requests).toHaveLength(2)

    const answer = () =>
      Response.json({
        version: "1.2.3",
        pid: 1,
        urls: [endpoint.url],
        paths: { tmp: "/tmp/opencode" },
      })
    requests[0]!.resolve(answer())
    requests[1]!.resolve(answer())
    await Promise.all([first, other])
  } finally {
    platformFetch = globalThis.fetch
  }
})

test("the real cache checker does not attach a discarded incarnation after remove/relist", async () => {
  const requests: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const fetch = (() => {
    const request = Promise.withResolvers<Response>()
    requests.push(request)

    return request.promise
  }) as typeof globalThis.fetch
  const notifications: ServerProbe[] = []
  const connection: ServerConnection.Http = { type: "http", http: { url: "http://127.0.0.1:12352" } }

  const app = createRoot((dispose) => {
    const checker = createServerHealthChecker(fetch)
    onCleanup(checker.dispose)
    const [listed, setListed] = createSignal(true)
    const health = createServerHealth(
      () => (listed() ? [connection] : []),
      checker.check,
      (probe) => notifications.push(probe),
    )

    return { dispose, setListed, health: () => health.status[ServerConnection.key(connection)] }
  })

  const answer = (tlsCaMode: "bundled" | "system") =>
    Response.json({
      version: "1.2.3",
      pid: 1,
      urls: [connection.http.url],
      paths: { tmp: "/tmp/opencode" },
      tlsCaMode,
    })

  try {
    await flush()
    expect(requests).toHaveLength(1)
    expect(app.health()).toEqual({ type: "checking", managed: false })

    app.setListed(false)
    app.setListed(true)
    await flush()
    expect(requests).toHaveLength(2)

    requests[0]!.resolve(answer("bundled"))
    await flush()
    expect(app.health()).toEqual({ type: "checking", managed: false })
    expect(notifications).toEqual([])

    requests[1]!.resolve(answer("system"))
    await flush()
    expect(app.health()).toEqual({ type: "healthy", version: "1.2.3", tlsCaMode: "system" })
    expect(notifications).toEqual([
      {
        key: ServerConnection.key(connection),
        auth: "http://127.0.0.1:12352\n",
        result: { type: "healthy", version: "1.2.3", tlsCaMode: "system" },
      },
    ])
  } finally {
    app.dispose()
  }
})
