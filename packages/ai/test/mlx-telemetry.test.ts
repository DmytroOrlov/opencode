import { expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Headers } from "effect/http"
import { Auth } from "../src/route/auth.js"
import { OpenAIChat } from "../src/protocols.js"
import { LanguageModel } from "../src/schema/index.js"
import { attachMlxObserver } from "../src/telemetry/mlx.js"
import { LLM } from "../src/llm.js"
import { RequestExecutor, type HttpMiddleware } from "../src/route.js"
import { handlerLayer } from "./lib/http.js"

const settle = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate: () => boolean, timeout = 500) => {
  const started = Date.now()
  while (!predicate() && Date.now() - started < timeout) await settle(5)
  return predicate()
}

function fixture(options: { readonly stats?: boolean; readonly statsDelayMs?: number } = {}) {
  const encoder = new TextEncoder()
  const feeds: Array<{
    readonly headers: RequestInit["headers"]
    stream: ReadableStreamDefaultController<Uint8Array> | undefined
    aborted: boolean
    cancelled: boolean
  }> = []
  const fetch: typeof globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const feed: (typeof feeds)[number] = {
        headers: init?.headers,
        stream: undefined,
        aborted: false,
        cancelled: false,
      }
      feeds.push(feed)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          feed.stream = controller
          const stats = () => {
            try {
              controller.enqueue(encoder.encode("event: stats\ndata: {}\n\n"))
            } catch {
              // A canceled fixture feed has no readiness event to deliver.
            }
          }
          if (options.stats !== false) {
            if (options.statsDelayMs) setTimeout(stats, options.statsDelayMs)
            else stats()
          }
        },
        cancel() {
          feed.aborted = true
          feed.cancelled = true
        },
      })
      init?.signal?.addEventListener("abort", () => {
        feed.aborted = true
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  return {
    fetch,
    count: () => feeds.length,
    headers: (index = feeds.length - 1) => new globalThis.Headers(feeds[index]?.headers).get("authorization"),
    deploymentHeader: (index = feeds.length - 1) => new globalThis.Headers(feeds[index]?.headers).get("x-deployment-key"),
    routeHeader: (index = feeds.length - 1) => new globalThis.Headers(feeds[index]?.headers).get("x-route-deployment"),
    aborted: (index = feeds.length - 1) => feeds[index]?.aborted,
    cancelled: (index = feeds.length - 1) => feeds[index]?.cancelled,
    push(value: unknown, index = feeds.length - 1) {
      feeds[index]?.stream?.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
    },
  }
}

const request = LLM.request({
  model: LanguageModel.make({ id: "mlx-model", provider: "mlx", route: OpenAIChat.route }),
  prompt: "hello",
})

const executor = Effect.runSync(
  Effect.provide(Effect.service(RequestExecutor.Service), RequestExecutor.fetchLayer),
)
const attach = (input: Parameters<typeof attachMlxObserver>[0]) =>
  attachMlxObserver(input).pipe(Effect.provideService(RequestExecutor.Service, executor))

test("waits for delayed MLX stats before allowing request attribution", async () => {
  const local = fixture({ statsDelayMs: 25 })
  const observations: unknown[] = []
  const observer = await Effect.runPromise(
    attach({
      endpoint: "http://127.0.0.1:43123/v1",
      auth: Auth.bearer("telemetry-secret"),
      request,
      fetch: local.fetch,
      observe: (value) => observations.push(value),
    }),
  )

  expect(local.count()).toBe(1)
  expect(local.headers()).toBe("Bearer telemetry-secret")
  local.push({ type: "prefill", req: "req-1", processed: 4, total: 10 })
  await settle()
  expect(observations).toEqual([{ phase: "prefill", processed: 4, total: 10 }])
  expect(JSON.stringify(observations)).not.toContain("telemetry-secret")
  observer?.discard()
  expect(await waitFor(() => local.cancelled())).toBe(true)
  expect(local.aborted()).toBe(true)
})

test("poisons an epoch that misses the readiness barrier and ignores later request IDs", async () => {
  const local = fixture({ stats: false })
  const observations: unknown[] = []
  const started = Date.now()
  const observer = await Effect.runPromise(
    attach({
      endpoint: "http://127.0.0.1:43127/v1",
      auth: Auth.none,
      request,
      fetch: local.fetch,
      observe: (value) => observations.push(value),
    }),
  )

  expect(Date.now() - started).toBeGreaterThanOrEqual(450)
  expect(observer).toBeDefined()
  local.push({ type: "stats" })
  local.push({ type: "prefill", req: "late-req", processed: 2, total: 8 })
  await settle()
  expect(observations).toEqual([])
  observer?.discard()
  expect(await waitFor(() => local.cancelled())).toBe(true)
  expect(local.aborted()).toBe(true)
})

test("reuses a ready feed across sequential attempts during the bounded idle window", async () => {
  const local = fixture()
  const auth = Auth.bearer("same-key")
  const first = await Effect.runPromise(
    attach({ endpoint: "http://127.0.0.1:43128/v1", auth, request, fetch: local.fetch, observe: () => undefined }),
  )
  local.push({ type: "prefill", req: "first-sequential-req", processed: 1, total: 2 })
  await settle()
  first?.finalize()

  const observations: unknown[] = []
  const second = await Effect.runPromise(
    attach({
      endpoint: "http://127.0.0.1:43128/v1",
      auth,
      request,
      fetch: local.fetch,
      observe: (value) => observations.push(value),
    }),
  )

  expect(local.count()).toBe(1)
  local.push({ type: "prefill", req: "sequential-req", processed: 3, total: 6 })
  await settle()
  expect(observations).toEqual([{ phase: "prefill", processed: 3, total: 6 }])
  second?.discard()
})

test("replaces a shared feed when its executor, scoped middleware or injected fetch changes", async () => {
  const local = fixture()
  const other = fixture()
  const auth = Auth.bearer("transport-identity")
  const scoped: HttpMiddleware = (input, next) => next(input)
  const otherExecutor = Effect.runSync(
    Effect.provide(Effect.service(RequestExecutor.Service), RequestExecutor.fetchLayer),
  )
  const cleanup: (() => void)[] = []

  const open = async (
    transport: ReturnType<typeof fixture>,
    service: RequestExecutor.Interface,
    middleware: HttpMiddleware | undefined,
  ) => {
    const observations: unknown[] = []
    const observer = await Effect.runPromise(
      attachMlxObserver({
        endpoint: "http://127.0.0.1:43135/v1",
        auth,
        request,
        fetch: transport.fetch,
        observe: (value) => observations.push(value),
      }).pipe(
        Effect.provideService(RequestExecutor.Service, service),
        Effect.provideService(RequestExecutor.CurrentMiddleware, middleware),
      ),
    )
    if (observer) cleanup.push(observer.discard)
    expect(observer).toBeDefined()
    return { observer, observations }
  }

  const finish = async (
    attempt: Awaited<ReturnType<typeof open>>,
    req: string,
  ) => {
    local.push({ type: "prefill", req, processed: 1, total: 2 })
    expect(await waitFor(() => attempt.observations.length === 1)).toBe(true)
    expect(attempt.observations).toEqual([
      { phase: "prefill", processed: 1, total: 2 },
    ])
    attempt.observer?.finalize()
    // The previous feed must actually be eligible for reuse.
    expect(local.cancelled()).toBe(false)
  }

  try {
    const first = await open(local, executor, undefined)
    expect(local.count()).toBe(1)
    await finish(first, "identity-first")

    // Change only the scoped middleware.
    const second = await open(local, executor, scoped)
    expect(local.count()).toBe(2)
    expect(await waitFor(() => local.cancelled(0))).toBe(true)
    await finish(second, "identity-second")

    // Change only the executor.
    const third = await open(local, otherExecutor, scoped)
    expect(local.count()).toBe(3)
    expect(await waitFor(() => local.cancelled(1))).toBe(true)
    await finish(third, "identity-third")

    // Change only the injected fetch.
    const fourth = await open(other, otherExecutor, scoped)
    expect(other.count()).toBe(1)
    expect(local.count()).toBe(3)
    expect(await waitFor(() => local.cancelled(2))).toBe(true)
    fourth.observer?.discard()
    expect(await waitFor(() => other.cancelled())).toBe(true)
  } finally {
    for (const discard of cleanup) discard()
  }
})

test("refreshes a shared watcher when the same auth definition resolves rotated credentials", async () => {
  const local = fixture()
  let secret = "credential-one"
  const auth = Auth.custom((input) =>
    Effect.succeed(Headers.set(input.headers, "authorization", `Bearer ${secret}`)),
  )
  const firstObservations: unknown[] = []
  const first = await Effect.runPromise(
    attach({
      endpoint: "http://127.0.0.1:43129/v1",
      auth,
      request,
      fetch: local.fetch,
      observe: (value) => firstObservations.push(value),
    }),
  )
  local.push({ type: "prefill", req: "before-rotation", processed: 1, total: 2 })
  expect(await waitFor(() => firstObservations.length === 1)).toBe(true)
  expect(firstObservations).toEqual([
    { phase: "prefill", processed: 1, total: 2 },
  ])
  first?.finalize()
  expect(local.cancelled(0)).toBe(false)

  secret = "credential-two"
  const observations: unknown[] = []
  const second = await Effect.runPromise(
    attach({
      endpoint: "http://127.0.0.1:43129/v1",
      auth,
      request,
      fetch: local.fetch,
      observe: (value) => observations.push(value),
    }),
  )

  expect(local.count()).toBe(2)
  expect(local.headers(0)).toBe("Bearer credential-one")
  expect(local.headers(1)).toBe("Bearer credential-two")
  local.push({ type: "prefill", req: "rotated-req", processed: 2, total: 4 }, 1)
  await settle()
  expect(observations).toEqual([{ phase: "prefill", processed: 2, total: 4 }])
  second?.discard()
})

test("starts a replacement feed when a stopped epoch remains registered", async () => {
  const local = fixture()
  const auth = Auth.bearer("same-key")
  const first = await Effect.runPromise(
    attach({ endpoint: "http://127.0.0.1:43130/v1", auth, request, fetch: local.fetch, observe: () => undefined }),
  )
  for (let index = 0; index < 258; index++) local.push({ req: `old-${index}`, i: 1, committed: 1, ms: 1 })
  await settle()

  const observations: unknown[] = []
  const replacement = await Effect.runPromise(
    attach({
      endpoint: "http://127.0.0.1:43130/v1",
      auth,
      request,
      fetch: local.fetch,
      observe: (value) => observations.push(value),
    }),
  )

  expect(local.count()).toBe(2)
  local.push({ type: "prefill", req: "must-not-bind-poisoned-replacement", processed: 1, total: 2 }, 1)
  await settle()
  expect(observations).toEqual([])
  first?.discard()
  replacement?.discard()
})

test("uses prepared deployment headers on the same-origin event feed without following redirects", async () => {
  const local = fixture()
  const model = LanguageModel.update(request.model, {
    route: {
      ...request.model.route,
      headers: () => ({ "x-route-deployment": "route-secret" }),
    },
  })
  const effective = LLM.request({
    model,
    prompt: "hello",
    headers: { "x-deployment-key": "deployment-secret" },
  })
  const observer = await Effect.runPromise(
    attach({
      endpoint: "https://127.0.0.1:43131/v1",
      auth: Auth.none,
      request: effective,
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const response = await local.fetch(input, init)
          expect(new URL(String(input)).origin).toBe("https://127.0.0.1:43131")
          expect(init?.redirect).toBe("error")
          return response
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
      observe: () => undefined,
    }),
  )

  expect(local.deploymentHeader()).toBe("deployment-secret")
  expect(local.routeHeader()).toBe("route-secret")
  observer?.discard()
})

test("rejects redirects on the ordinary executor transport", async () => {
  let originRequests = 0
  let destinationRequests = 0
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      destinationRequests++
      return new Response("unexpected redirect target")
    },
  })
  const origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      originRequests++
      return Response.redirect(`http://127.0.0.1:${destination.port}/events`, 302)
    },
  })
  try {
    const observer = await Effect.runPromise(
      attach({
        endpoint: `http://127.0.0.1:${origin.port}/v1`,
        auth: Auth.none,
        request,
        observe: () => undefined,
      }),
    )
    expect(observer).toBeDefined()
    await settle(50)
    expect(originRequests).toBeGreaterThan(0)
    expect(destinationRequests).toBe(0)
    observer?.discard()
  } finally {
    await origin.stop(true)
    await destination.stop(true)
  }
})

test("routes the injected MLX event feed through executor-wide and scoped middleware", async () => {
  const local = fixture()
  const calls: string[] = []
  const record =
    (scope: string): HttpMiddleware =>
    (input, next) =>
      Effect.sync(() => calls.push(`${scope} ${input.method} ${input.url}`)).pipe(Effect.andThen(next(input)))
  const observer = await Effect.runPromise(
    attachMlxObserver({
      endpoint: "http://127.0.0.1:43133/v1",
      auth: Auth.bearer("middleware-secret"),
      request,
      fetch: local.fetch,
      observe: () => undefined,
    }).pipe(
      RequestExecutor.withMiddleware(record("scoped")),
      Effect.provide(RequestExecutor.middleware(record("shared"), RequestExecutor.fetchLayer)),
    ),
  )

  expect(calls).toEqual([
    "shared GET http://127.0.0.1:43133/events",
    "scoped GET http://127.0.0.1:43133/events",
  ])
  expect(local.count()).toBe(1)
  expect(local.headers()).toBe("Bearer middleware-secret")
  observer?.discard()
  expect(await waitFor(() => local.cancelled())).toBe(true)
  expect(local.aborted()).toBe(true)
})

test("routes the default MLX event feed through the configured executor middleware", async () => {
  const encoder = new TextEncoder()
  const calls: string[] = []
  const record =
    (scope: string): HttpMiddleware =>
    (input, next) =>
      Effect.sync(() => calls.push(`${scope} ${input.method} ${input.url}`)).pipe(Effect.andThen(next(input)))
  const transport = handlerLayer((input) =>
    Effect.sync(() => {
      calls.push(`transport ${input.request.method} ${input.request.url}`)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: stats\ndata: {}\n\n"))
        },
      })
      return input.respond(body, { headers: { "content-type": "text/event-stream" } })
    }),
  )
  const observer = await Effect.runPromise(
    attachMlxObserver({
      endpoint: "http://127.0.0.1:43134/v1",
      auth: Auth.none,
      request,
      observe: () => undefined,
    }).pipe(
      RequestExecutor.withMiddleware(record("scoped")),
      Effect.provide(
        RequestExecutor.middleware(
          record("shared"),
          RequestExecutor.layer.pipe(Layer.provide(transport)),
        ),
      ),
    ),
  )

  expect(calls).toEqual([
    "shared GET http://127.0.0.1:43134/events",
    "scoped GET http://127.0.0.1:43134/events",
    "transport GET http://127.0.0.1:43134/events",
  ])
  expect(observer).toBeDefined()
  observer?.discard()
})

test("does not guess attempt ownership when two requests are pending", async () => {
  const local = fixture()
  const observations: unknown[][] = [[], []]
  const auth = Auth.bearer("same-key")
  const first = await Effect.runPromise(
    attach({ endpoint: "http://127.0.0.1:43124/v1", auth, request, fetch: local.fetch, observe: (value) => observations[0]?.push(value) }),
  )
  const second = await Effect.runPromise(
    attach({ endpoint: "http://127.0.0.1:43124/v1", auth, request, fetch: local.fetch, observe: (value) => observations[1]?.push(value) }),
  )

  local.push({ req: "ambiguous", i: 1, committed: 4, ms: 100 })
  await settle()
  expect(observations).toEqual([[], []])
  first?.discard()
  second?.discard()
  expect(await waitFor(() => local.cancelled())).toBe(true)
  expect(local.aborted()).toBe(true)
})

test("observer callback errors are isolated and abort closes the feed", async () => {
  const local = fixture()
  const controller = new AbortController()
  const observer = await Effect.runPromise(
    attach({
      endpoint: "http://127.0.0.1:43125/v1",
      auth: Auth.none,
      request,
      signal: controller.signal,
      fetch: local.fetch,
      observe: () => {
        throw new Error("telemetry unavailable")
      },
    }),
  )

  local.push({ type: "prefill", req: "req-2", processed: 2, total: 8 })
  await settle()
  controller.abort()
  observer?.discard()
  expect(await waitFor(() => local.cancelled())).toBe(true)
  expect(local.aborted()).toBe(true)
})

test("unavailable auth makes observer setup fail before opening a feed", async () => {
  let requests = 0
  const exit = await Effect.runPromise(
    Effect.exit(
      attach({
        endpoint: "http://127.0.0.1:43126/v1",
        auth: Auth.optional(undefined, "MLX telemetry key"),
        request,
        fetch: async () => {
          requests++
          return new Response(null)
        },
        observe: () => undefined,
      }),
    ),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(requests).toBe(0)
})
