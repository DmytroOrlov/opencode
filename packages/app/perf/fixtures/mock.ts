import type { Page, Route } from "@playwright/test"
import type { MockRequest, MockResponse, PrepareContext } from "@hona/strobe"
import { fixture } from "../../e2e/utils/session-fixture"

type Handler = Parameters<Page["route"]>[1]

type Fulfill = {
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer
  json?: object
  contentType?: string
}

/**
 * The block's page for the e2e mock server and the fixtures, with its routes answered through strobe's `mock`
 * (`prepare`'s `ctx.mock`). Playwright's routing turns the browser's HTTP cache off for the whole page, so a case that
 * reloads in `reset` would refetch every script, which no person does; `mock` pauses only the mocked URLs. Routes keep
 * Playwright's order (the latest answers first, `fallback` passes on), take URL globs and last for the whole case.
 *
 * In Chromium it is Playwright's page, so the mock server and its fixtures run as in the e2e suites. Other engines
 * (`--engine firefox`) have no Playwright page: a stand-in takes init scripts through strobe's `addInitScript` and
 * cannot evaluate in the page, so the mock server publishes no events there after a mutation.
 */
export function cached(ctx: Pick<PrepareContext<unknown>, "playwright" | "mock" | "addInitScript">) {
  const page = playwrightPage(ctx) ?? standIn(ctx.addInitScript)
  const { mock } = ctx

  page.route = async (url, handler) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- discriminates Playwright's own URL matcher union
    if (typeof url !== "string") throw new Error("strobe mocks URL globs; no benchmark routes by RegExp or predicate")

    await mock(url.replaceAll("**", "*"), (request) => legacy(request) ?? answer(request, handler))

    return { dispose: kept, [Symbol.asyncDispose]: kept }
  }

  // The mock terminal's socket: no benchmark opens a terminal.
  page.routeWebSocket = async () => {}

  return page
}

// A `--base <ref>` comparison drives one harness at two builds, so the older build's client still asks for three
// endpoints this checkout no longer routes: its protocol probe (`src/utils/server-protocol.ts` reads `/global/health`
// then `/api/health`, and needs the numeric `pid` before it recognises v2), the current-project lookup, and the
// question poll. Refusing one is not a finding: `mock-server.ts:422` throws on an unmocked API request, that launch
// never settles, and the base side measures nothing (`RunIncomplete: setup: cdp Runtime.evaluate: no reply in 70s`).
// These are the baseline's own contracts, copied from its `e2e/utils/mock-server.ts` (`:77`, `:153`, `:171`) and its
// `location` helper (`:317`) — not invented successes — over the directory and project id the benchmark fixtures
// configure the app with (`session-fixture.ts:336`, used by `mockLargeDraft` and `mockStressTimeline`). No benchmark
// sets pending questions, so that poll legitimately answers none.
//
// Only these three exact GET pathnames: any other path, any other method, and every other request fall through to
// `answer`, so the variant's own routes keep Playwright's order and this checkout's mock server still answers 501,
// then throws, for a path it does not route. The one header mirrors the mock server's CORS block (`:549`).
const cors = { "access-control-allow-origin": "*" }

function legacy(request: MockRequest): MockResponse | undefined {
  if (request.method !== "GET") return undefined

  const pathname = new URL(request.url).pathname

  if (pathname === "/api/health") return fulfilled({ json: { healthy: true, version: "2.0.0", pid: 1 }, headers: cors })

  if (pathname === "/api/project/current")
    return fulfilled({
      json: { id: fixture.project.id, directory: fixture.directory },
      headers: cors,
    })

  if (pathname === "/api/question/request")
    return fulfilled({
      json: {
        location: {
          directory: fixture.directory,
          project: { id: fixture.project.id, directory: fixture.directory },
        },
        // A benchmark's project has nothing awaiting an answer.
        data: [],
      },
      headers: cors,
    })

  return undefined
}

// `ctx.playwright` is Chromium's: reading it in another engine throws.
function playwrightPage(ctx: Pick<PrepareContext<unknown>, "playwright">): Page | undefined {
  try {
    // SAFETY: strobe hands Chromium blocks Playwright's own page.
    return ctx.playwright.page as Page
  } catch {
    return undefined
  }
}

// The members of a page the e2e mock server and the fixtures use, over strobe's calls. `route` is set by `cached`.
function standIn(addInitScript: PrepareContext<unknown>["addInitScript"]) {
  const page = {
    addInitScript,
    // The block's browser closes with the block.
    on: () => page,
    isClosed: () => false,
    // The mock server's event delivery treats a missing stream as retryable and drops the events.
    evaluate: async () => {
      throw new Error("No mock event stream: strobe drives this engine without Playwright")
    },
  }

  // SAFETY: the e2e mock server and the benchmark fixtures call only these members (and `route`, `routeWebSocket`).
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
  return page as unknown as Page
}

async function kept() {
  throw new Error("a strobe mock cannot be removed")
}

// Runs a Playwright route handler against a paused request and resolves with what it fulfilled.
function answer(request: MockRequest, handler: Handler) {
  const done = Promise.withResolvers<MockResponse | undefined>()

  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
  )

  const route = {
    request: () => ({
      url: () => request.url,
      method: () => request.method,
      headers: () => headers,
      headerValue: async (name: string) => headers[name.toLowerCase()] ?? null,
      postDataBuffer: () => (request.body === undefined ? null : Buffer.from(request.body)),
    }),
    fulfill: async (response: Fulfill) => done.resolve(fulfilled(response)),
    fallback: async () => done.resolve(undefined),
    continue: async () => done.resolve(undefined),
  }

  // SAFETY: the e2e mock server and the benchmark fixtures call only these members of a route and its request.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
  const playwright = route as unknown as Route

  // A handler that throws after answering (an unmocked API request) reports in the runner's log.
  Promise.resolve(handler(playwright, playwright.request())).catch((error) => {
    console.error(error)
    done.resolve(undefined)
  })

  return done.promise
}

function fulfilled(response: Fulfill): MockResponse {
  const headers = { ...response.headers }

  if (response.contentType) headers["content-type"] = response.contentType

  if (response.json === undefined) return { status: response.status ?? 200, headers, body: response.body }
  headers["content-type"] = "application/json"

  return { status: response.status ?? 200, headers, body: JSON.stringify(response.json) }
}
