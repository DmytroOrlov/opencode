import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Headers } from "effect/http"
import { LLM } from "../src/index.js"
import { Auth } from "../src/route/auth.js"
import { OpenAIChat } from "../src/protocols.js"
import { HttpOptions, LanguageModel, LLMRequest } from "../src/schema/index.js"
import { attachMlxObserver } from "../src/telemetry/mlx.js"

const settle = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function fixture(options: { readonly stats?: boolean; readonly statsDelayMs?: number } = {}) {
  const encoder = new TextEncoder()
  const feeds: Array<{
    readonly headers: RequestInit["headers"]
    stream: ReadableStreamDefaultController<Uint8Array> | undefined
    aborted: boolean
  }> = []
  const fetch: typeof globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const feed: (typeof feeds)[number] = { headers: init?.headers, stream: undefined, aborted: false }
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
        },
      })
      init?.signal?.addEventListener("abort", () => {
        feed.aborted = true
        try {
          feed.stream?.error(new Error("feed aborted"))
        } catch {
          // A closed fixture feed has already released its reader.
        }
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
    push(value: unknown, index = feeds.length - 1) {
      feeds[index]?.stream?.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
    },
  }
}

const request = LLM.request({
  model: LanguageModel.make({ id: "mlx-model", provider: "mlx", route: OpenAIChat.route }),
  prompt: "hello",
})

test("waits for delayed MLX stats before allowing request attribution", async () => {
  const local = fixture({ statsDelayMs: 25 })
  const observations: unknown[] = []
  const observer = await Effect.runPromise(
    attachMlxObserver({
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
  expect(local.aborted()).toBe(true)
})

test("poisons an epoch that misses the readiness barrier and ignores later request IDs", async () => {
  const local = fixture({ stats: false })
  const observations: unknown[] = []
  const started = Date.now()
  const observer = await Effect.runPromise(
    attachMlxObserver({
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
  expect(local.aborted()).toBe(true)
})

test("reuses a ready feed across sequential attempts during the bounded idle window", async () => {
  const local = fixture()
  const auth = Auth.bearer("same-key")
  const first = await Effect.runPromise(
    attachMlxObserver({ endpoint: "http://127.0.0.1:43128/v1", auth, request, fetch: local.fetch, observe: () => undefined }),
  )
  local.push({ type: "prefill", req: "first-sequential-req", processed: 1, total: 2 })
  await settle()
  first?.finalize()

  const observations: unknown[] = []
  const second = await Effect.runPromise(
    attachMlxObserver({
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

test("refreshes a shared watcher when the same auth definition resolves rotated credentials", async () => {
  const local = fixture()
  let secret = "credential-one"
  const auth = Auth.custom((input) =>
    Effect.succeed(Headers.set(input.headers, "authorization", `Bearer ${secret}`)),
  )
  const first = await Effect.runPromise(
    attachMlxObserver({ endpoint: "http://127.0.0.1:43129/v1", auth, request, fetch: local.fetch, observe: () => undefined }),
  )
  first?.finalize()

  secret = "credential-two"
  const observations: unknown[] = []
  const second = await Effect.runPromise(
    attachMlxObserver({
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
    attachMlxObserver({ endpoint: "http://127.0.0.1:43130/v1", auth, request, fetch: local.fetch, observe: () => undefined }),
  )
  for (let index = 0; index < 258; index++) local.push({ req: `old-${index}`, i: 1, committed: 1, ms: 1 })
  await settle()

  const observations: unknown[] = []
  const replacement = await Effect.runPromise(
    attachMlxObserver({
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
  const effective = LLMRequest.update(request, {
    model,
    http: new HttpOptions({ headers: { "x-deployment-key": "deployment-secret" } }),
  })
  const observer = await Effect.runPromise(
    attachMlxObserver({
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

test("does not guess attempt ownership when two requests are pending", async () => {
  const local = fixture()
  const observations: unknown[][] = [[], []]
  const auth = Auth.bearer("same-key")
  const first = await Effect.runPromise(
    attachMlxObserver({ endpoint: "http://127.0.0.1:43124/v1", auth, request, fetch: local.fetch, observe: (value) => observations[0]?.push(value) }),
  )
  const second = await Effect.runPromise(
    attachMlxObserver({ endpoint: "http://127.0.0.1:43124/v1", auth, request, fetch: local.fetch, observe: (value) => observations[1]?.push(value) }),
  )

  local.push({ req: "ambiguous", i: 1, committed: 4, ms: 100 })
  await settle()
  expect(observations).toEqual([[], []])
  first?.discard()
  second?.discard()
  expect(local.aborted()).toBe(true)
})

test("observer callback errors are isolated and abort closes the feed", async () => {
  const local = fixture()
  const controller = new AbortController()
  const observer = await Effect.runPromise(
    attachMlxObserver({
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
  expect(local.aborted()).toBe(true)
})

test("unavailable auth makes observer setup fail before opening a feed", async () => {
  let requests = 0
  const exit = await Effect.runPromise(
    Effect.exit(
      attachMlxObserver({
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
