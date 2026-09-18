import { expect, test, afterEach } from "bun:test"
import { Effect, Exit } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { MLXTelemetry, type TelemetrySnapshot } from "@/session/llm/mlx-telemetry"
import { FallbackTelemetry, type FallbackTelemetrySnapshot } from "@/session/llm/fallback-telemetry"

const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
const sseCRLF = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`
const round = (req: string, i: number, committed: number, ms: number) => sse({ req, i, committed, ms })
const prefill = (req: string, processed: number, total: number) => sse({ type: "prefill", req, processed, total })
const statsFrame = "event: stats\ndata: {}\n\n"

type Connection = { controller: ReadableStreamDefaultController; dead: boolean }

async function startMlx(options: { apiKey?: string } = {}) {
  const encoder = new TextEncoder()
  const plan = { replay: [] as string[], stats: true }
  const conns: Connection[] = []
  let hits = 0
  const write = (frame: string) =>
    conns.forEach((conn) => {
      if (conn.dead) return
      try {
        conn.controller.enqueue(encoder.encode(frame))
      } catch {
        conn.dead = true
      }
    })
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/events") return new Response("not found", { status: 404 })
      hits++
      if (options.apiKey && req.headers.get("authorization") !== `Bearer ${options.apiKey}`)
        return new Response("unauthorized", { status: 401 })
      const conn: Connection = { controller: undefined!, dead: false }
      const write = (frame: string) => {
        if (conn.dead) return
        try {
          conn.controller.enqueue(encoder.encode(frame))
        } catch {
          conn.dead = true
        }
      }
      const stream = new ReadableStream({
        start(controller) {
          conn.controller = controller
        },
        cancel() {
          conn.dead = true
        },
      })
      conns.push(conn)
      queueMicrotask(() => {
        for (const frame of plan.replay) write(frame)
        if (plan.stats) write(statsFrame)
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    baseURL: `http://localhost:${server.port}/v1`,
    hits: () => hits,
    setPlan(next: Partial<typeof plan>) {
      Object.assign(plan, next)
    },
    push: write,
    sendStats: () => write("event: stats\ndata: {}\n\n"),
    drop: () => {
      for (const conn of conns.splice(0)) {
        conn.dead = true
        try {
          conn.controller.close()
        } catch {}
      }
    },
    stop: () => (server as { stop?: () => void; close?: () => void }).stop?.(),
  }
}

function collect() {
  const snapshots: TelemetrySnapshot[] = []
  return {
    snapshots,
    publish: (snapshot: TelemetrySnapshot) => snapshots.push(snapshot),
  }
}

async function attach(
  server: Awaited<ReturnType<typeof startMlx>>,
  assistantMessageID: string,
  sink: ReturnType<typeof collect>,
  extra: { abort?: AbortSignal } = {},
) {
  return MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: server.baseURL },
    sessionID: "ses_test",
    assistantMessageID,
    publish: sink.publish,
    ...extra,
  })
}

// Registration emits an ephemeral { phase:"prefill", done:false } state-clear
// marker with no counts. Provider events are everything else.
const isReset = (item: TelemetrySnapshot) =>
  item.phase === "prefill" &&
  item.processed === undefined &&
  item.total === undefined &&
  item.tokensPerSecond === undefined &&
  item.done === false
const provider = (snapshots: TelemetrySnapshot[]) => snapshots.filter((item) => !isReset(item))
const rates = (snapshots: TelemetrySnapshot[]) =>
  provider(snapshots).filter((item) => item.tokensPerSecond !== undefined)

// Captured before any mock.timers.enable() so tests can still await real I/O
// while Date.now() is under manual control.
const realSetTimeout = setTimeout
const settle = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms))

const waitFor = async (predicate: () => boolean, ms = 3000, poll = 10) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for telemetry condition")
    await settle(poll)
  }
}

afterEach(() => MLXTelemetry.stopAll())

test("telemetry disabled starts no watcher", async () => {
  const server = await startMlx()
  const result = await MLXTelemetry.attach({
    options: { baseURL: server.baseURL },
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: () => {
      throw new Error("must not publish")
    },
  })
  expect(result).toBeUndefined()
  await settle(50)
  expect(server.hits()).toBe(0)
})

test("registration emits a prefill reset marker that clears stale presentation", async () => {
  const server = await startMlx()
  const sink = collect()
  await attach(server, "msg_a", sink)
  expect(sink.snapshots[0]).toEqual({
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    phase: "prefill",
    done: false,
  })
  expect(provider(sink.snapshots).length).toBe(0)
})

test("pre-stats replayed rounds never bind; post-stats new req binds pending message", async () => {
  const server = await startMlx()
  server.setPlan({ replay: [round("replayed", 1, 5, 100)] })
  const sink = collect()
  const attempt = await attach(server, "msg_a", sink)
  expect(attempt).toBeDefined()
  server.push(round("replayed", 2, 5, 100))
  server.push(round("fresh", 1, 5, 100))
  await waitFor(() => provider(sink.snapshots).length > 0)
  await settle(300)
  expect(provider(sink.snapshots).filter((item) => item.phase === "decode").length).toBe(1)
  expect(sink.snapshots.at(-1)!.assistantMessageID).toBe("msg_a")
  expect(sink.snapshots.at(-1)!.tokensPerSecond).toBeCloseTo(50, 5)
})

test("prefill percentage forwarded and coalesced on integer percent", async () => {
  const server = await startMlx()
  const sink = collect()
  expect(await attach(server, "msg_a", sink)).toBeDefined()
  server.push(prefill("r1", 370, 1000))
  server.push(prefill("r1", 379, 1000))
  server.push(prefill("r1", 380, 1000))
  await waitFor(() => provider(sink.snapshots).length >= 2)
  const events = provider(sink.snapshots)
  expect(events.length).toBe(2)
  expect(events[0]).toEqual({
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    phase: "prefill",
    processed: 370,
    total: 1000,
  })
  expect(events[1].processed).toBe(380)
})

test("round i==0 establishes decode but is excluded from tok/s", async () => {
  const server = await startMlx()
  const sink = collect()
  expect(await attach(server, "msg_a", sink)).toBeDefined()
  server.push(round("r1", 0, 100, 500))
  await waitFor(() => provider(sink.snapshots).length === 1)
  expect(provider(sink.snapshots)[0].phase).toBe("decode")
  expect(provider(sink.snapshots)[0].tokensPerSecond).toBeUndefined()
  server.push(round("r1", 1, 10, 500))
  await waitFor(() => rates(sink.snapshots).length > 0)
  expect(rates(sink.snapshots).at(-1)!.tokensPerSecond).toBeCloseTo(20, 5)
})

test("rate uses rolling window of latest 16 valid rounds", async () => {
  const server = await startMlx()
  const sink = collect()
  expect(await attach(server, "msg_a", sink)).toBeDefined()
  server.push(round("r1", 0, 999, 1))
  for (let i = 1; i <= 17; i++) server.push(round("r1", i, 10, 100))
  await waitFor(() => rates(sink.snapshots).length > 0)
  expect(rates(sink.snapshots).at(-1)!.tokensPerSecond).toBeCloseTo(((16 * 10) / (16 * 100)) * 1000, 5)
})

test("ambiguous registrations suppress attribution; unbound armed closes fail-close the epoch", async () => {
  const server = await startMlx()
  const sink = collect()
  const first = await attach(server, "msg_a", sink)
  const second = await attach(server, "msg_b", sink)
  expect(first).toBeDefined()
  expect(second).toBeDefined()
  server.push(round("contested", 1, 5, 100))
  await settle(300)
  expect(provider(sink.snapshots).length).toBe(0)
  // Closing an armed-but-unbound attempt means its req may still arrive:
  // the epoch fail-closes instead of letting a later req guess ownership.
  first!.finalize()
  server.push(round("winner", 1, 5, 100))
  await settle(300)
  expect(provider(sink.snapshots).length).toBe(0)
  second!.finalize()

  const hitsBefore = server.hits()
  const third = await attach(server, "msg_c", sink)
  expect(third).toBeDefined()
  expect(server.hits()).toBeGreaterThan(hitsBefore)
  server.push(round("next", 1, 5, 100))
  await waitFor(() => provider(sink.snapshots).length > 0)
  expect(sink.snapshots.at(-1)!.assistantMessageID).toBe("msg_c")
})

test("reconnect requires a fresh stats barrier before events are live again", async () => {
  const server = await startMlx()
  const sink = collect()
  expect(await attach(server, "msg_a", sink)).toBeDefined()
  server.push(round("r1", 1, 5, 100))
  await waitFor(() => provider(sink.snapshots).length > 0)
  const before = sink.snapshots.length

  server.setPlan({ replay: [round("r1", 2, 5, 100)], stats: false })
  server.drop()
  await waitFor(() => server.hits() >= 2)
  await settle(300)
  expect(sink.snapshots.length).toBe(before)

  server.sendStats()
  server.push(round("r1", 3, 5, 100))
  await waitFor(() => sink.snapshots.length > before)
  server.stop()
})

test("superseded attempt cannot publish stale req events", async () => {
  const server = await startMlx()
  const sink = collect()
  const first = await attach(server, "msg_a", sink)
  server.push(round("r1", 1, 5, 100))
  await waitFor(() => provider(sink.snapshots).length > 0)
  const attempt2 = await attach(server, "msg_a", sink)
  expect(attempt2).toBeDefined()
  const before = sink.snapshots.length
  server.push(round("r1", 2, 5, 100))
  await settle(300)
  expect(sink.snapshots.length).toBe(before)
  first!.finalize()
  attempt2!.finalize()
  server.push(round("r1", 3, 5, 100))
  await settle(300)
  expect(sink.snapshots.length).toBe(before)
  server.push(round("r2", 1, 5, 100))
  await settle(300)
  expect(sink.snapshots.length).toBe(before)
})

test("finalize publishes done=true with last snapshot then silences the req", async () => {
  const server = await startMlx()
  const sink = collect()
  const attempt = await attach(server, "msg_a", sink)
  server.push(prefill("r1", 370, 1000))
  await waitFor(() => provider(sink.snapshots).length > 0)
  attempt!.finalize()
  expect(sink.snapshots.at(-1)).toEqual({
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    phase: "prefill",
    processed: 370,
    total: 1000,
    done: true,
  })
  const before = sink.snapshots.length
  server.push(round("r1", 1, 5, 100))
  await settle(300)
  expect(sink.snapshots.length).toBe(before)
})

test("connection refusal and parser failures never surface as errors", async () => {
  const denied = await startMlx({ apiKey: "secret" })
  const rejectedSink = collect()
  const rejected = await MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: denied.baseURL, apiKey: "wrong" },
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: rejectedSink.publish,
  })
  // The readiness timeout still yields a handle so the stream finalizer can
  // close the registration; it just never carries provider telemetry.
  expect(rejected).toBeDefined()
  expect(provider(rejectedSink.snapshots).length).toBe(0)
  rejected!.finalize()

  const server = await startMlx()
  const sink = collect()
  const attempt = await attach(server, "msg_a", sink)
  expect(attempt).toBeDefined()
  server.push("data: {not json\r\n\r\n")
  server.push(": keepalive\n\n")
  server.push(round("r1", 1, 5, 100))
  await waitFor(() => rates(sink.snapshots).length > 0)
  expect(sink.snapshots.at(-1)!.phase).toBe("decode")
})

test("attach follows the dispatch-resolved endpoint, not options.baseURL", async () => {
  const live = await startMlx({ apiKey: "secret" })
  const decoy = await startMlx({ apiKey: "secret" })
  const sink = collect()
  // Mirrors a provider whose effective endpoint comes from provider/model API
  // config rather than options.baseURL: telemetry must follow the resolved
  // endpoint Provider.getEndpoint hands it and hit the same fake server that
  // is actually serving generation.
  const attempt = await MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: decoy.baseURL },
    endpoint: live.baseURL,
    apiKey: "secret",
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: sink.publish,
  })
  expect(attempt).toBeDefined()
  expect(live.hits()).toBeGreaterThan(0)
  expect(decoy.hits()).toBe(0)
  live.push(round("r1", 1, 5, 100))
  await waitFor(() => rates(sink.snapshots).length > 0)
  expect(sink.snapshots.at(-1)!.phase).toBe("decode")
  attempt!.finalize()
  live.stop()
  decoy.stop()
})

test("readiness timeout yields a silent handle without delaying generation", async () => {
  const server = await startMlx()
  server.setPlan({ stats: false })
  const sink = collect()
  const start = Date.now()
  const attempt = await attach(server, "msg_a", sink)
  expect(attempt).toBeDefined()
  expect(Date.now() - start).toBeLessThan(1500)
  expect(provider(sink.snapshots).length).toBe(0)
  attempt!.finalize()
})

test("readiness timeout fail-closes the epoch; a later fresh watcher recovers attribution", async () => {
  const server = await startMlx()
  server.setPlan({ stats: false })
  const sinkA = collect()
  const a = await attach(server, "msg_a", sinkA)
  expect(a).toBeDefined()
  const sinkB = collect()
  server.sendStats()
  const b = await attach(server, "msg_b", sinkB)
  expect(b).toBeDefined()
  // A's generation was dispatched before stats arrived; its reqs must never
  // be guess-bound, not even once A closes and B is the only pending attempt.
  server.push(round("reqA", 1, 5, 100))
  await settle(100)
  a!.finalize()
  server.push(round("reqA2", 1, 5, 100))
  await settle(300)
  expect(provider(sinkA.snapshots).length).toBe(0)
  expect(provider(sinkB.snapshots).length).toBe(0)
  b!.finalize()

  server.setPlan({ stats: true })
  const sinkC = collect()
  const hitsBefore = server.hits()
  const c = await attach(server, "msg_c", sinkC)
  expect(c).toBeDefined()
  expect(server.hits()).toBeGreaterThan(hitsBefore)
  server.push(round("reqC", 1, 5, 100))
  await waitFor(() => rates(sinkC.snapshots).length > 0)
  expect(sinkC.snapshots.at(-1)!.assistantMessageID).toBe("msg_c")
  expect(sinkC.snapshots.at(-1)!.tokensPerSecond).toBeCloseTo(50, 5)
})

test("retry registration reset clears the previous attempt's terminal rate", async () => {
  const server = await startMlx()
  const sink = collect()
  const first = await attach(server, "msg_a", sink)
  server.push(round("r1", 1, 5, 100))
  await waitFor(() => rates(sink.snapshots).length > 0)
  first!.finalize()
  const done = provider(sink.snapshots).at(-1)!
  expect(done.done).toBe(true)
  expect(done.tokensPerSecond).toBeCloseTo(50, 5)

  const second = await attach(server, "msg_a", sink)
  expect(second).toBeDefined()
  expect(sink.snapshots.at(-1)).toEqual({
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    phase: "prefill",
    done: false,
  })
  // No provider telemetry for the retry: finalizing must not resurrect the
  // first attempt's done rate as a terminal snapshot.
  const before = sink.snapshots.length
  second!.finalize()
  expect(sink.snapshots.length).toBe(before)
  const final = sink.snapshots.at(-1)!
  expect(final.done).toBe(false)
  expect(final.tokensPerSecond).toBeUndefined()
})

test("aborted attach closes its attempt and the later attempt binds normally", async () => {
  const server = await startMlx()
  server.setPlan({ stats: false })
  const controller = new AbortController()
  const sinkA = collect()
  const pending = MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: server.baseURL },
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: sinkA.publish,
    abort: controller.signal,
  })
  await settle(100)
  controller.abort()
  const a = await pending
  expect(a).toBeUndefined()
  expect(provider(sinkA.snapshots).length).toBe(0)

  server.sendStats()
  const sinkB = collect()
  const hitsBefore = server.hits()
  const b = await attach(server, "msg_b", sinkB)
  expect(b).toBeDefined()
  server.push(round("reqB", 1, 5, 100))
  await waitFor(() => rates(sinkB.snapshots).length > 0)
  expect(sinkB.snapshots.at(-1)!.assistantMessageID).toBe("msg_b")
  // A closed before attach returned (no dispatch was possible): the watcher
  // must NOT be poisoned and the same connection/epoch is reused.
  expect(server.hits()).toBe(hitsBefore)
  b!.finalize()
})

test("post-return unbound close fail-closes the epoch and a fresh watcher recovers", async () => {
  const server = await startMlx()
  const sinkA = collect()
  const a = await attach(server, "msg_a", sinkA)
  expect(a).toBeDefined()
  const sinkB = collect()
  const b = await attach(server, "msg_b", sinkB)
  expect(b).toBeDefined()
  // A was dispatched (attach returned) but never emitted its req. Closing it
  // fail-closes the epoch so A's delayed first req cannot bind to B, the
  // only remaining pending attempt.
  a!.finalize()
  server.push(round("lateA", 1, 5, 100))
  server.push(round("lateA", 2, 5, 100))
  await settle(300)
  expect(provider(sinkB.snapshots).length).toBe(0)
  b!.finalize()

  const sinkC = collect()
  const hitsBefore = server.hits()
  const c = await attach(server, "msg_c", sinkC)
  expect(c).toBeDefined()
  expect(server.hits()).toBeGreaterThan(hitsBefore)
  server.push(round("reqC", 1, 5, 100))
  await waitFor(() => rates(sinkC.snapshots).length > 0)
  expect(sinkC.snapshots.at(-1)!.assistantMessageID).toBe("msg_c")
  expect(sinkC.snapshots.at(-1)!.tokensPerSecond).toBeCloseTo(50, 5)
  c!.finalize()
})

test("CRLF frame boundaries enable readiness and carry provider events", async () => {
  const server = await startMlx()
  server.setPlan({ stats: false })
  const sink = collect()
  const pending = MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: server.baseURL },
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: sink.publish,
  })
  await waitFor(() => server.hits() > 0)
  server.push("event: stats\r\ndata: {}\r\n\r\n")
  const attempt = await pending
  expect(attempt).toBeDefined()
  server.push(sseCRLF({ req: "r1", i: 0, committed: 1, ms: 1 }))
  server.push(sseCRLF({ req: "r1", i: 1, committed: 5, ms: 100 }))
  await waitFor(() => rates(sink.snapshots).length > 0)
  expect(sink.snapshots.at(-1)!.phase).toBe("decode")
  expect(sink.snapshots.at(-1)!.tokensPerSecond).toBeCloseTo(50, 5)
})

test("CRLF delimiter split across chunks is still extracted", async () => {
  const server = await startMlx()
  server.setPlan({ stats: false })
  const sink = collect()
  const pending = MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: server.baseURL },
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: sink.publish,
  })
  await waitFor(() => server.hits() > 0)
  server.push("event: stats\r\ndata: {}\r")
  server.push("\n\r\n")
  const attempt = await pending
  expect(attempt).toBeDefined()
  server.push(`data: ${JSON.stringify({ req: "r1", i: 1, committed: 5, ms: 100 })}\r\n`)
  server.push("\r\n")
  await waitFor(() => rates(sink.snapshots).length > 0)
  expect(sink.snapshots.at(-1)!.assistantMessageID).toBe("msg_a")
})

test("safety set overflow fail-closes the epoch without evicting the oldest tombstone", async () => {
  const server = await startMlx()
  const sink = collect()
  for (let i = 0; i < 256; i++) {
    const attempt = await attach(server, `msg_${i}`, sink)
    expect(attempt).toBeDefined()
    server.push(round(`req_${i}`, 1, 5, 100))
    const messageID = `msg_${i}`
    await waitFor(() => provider(sink.snapshots).some((item) => item.assistantMessageID === messageID), 5000, 1)
    attempt!.finalize()
  }
  // One open attempt keeps the epoch alive while the 257th tombstone
  // overflows the bounded dead set.
  const guarded = await attach(server, "msg_guard", sink)
  expect(guarded).toBeDefined()
  server.push(round("req_256", 1, 5, 100))
  await waitFor(() => provider(sink.snapshots).some((item) => item.assistantMessageID === "msg_guard"), 5000, 1)
  const late = collect()
  const next = await attach(server, "msg_late", late)
  expect(next).toBeDefined()
  // The oldest dead req is still tombstoned: no eviction made it bindable.
  server.push(round("req_0", 2, 5, 100))
  guarded!.finalize()
  // That finalize overflowed the dead set and poisoned the epoch: even an
  // unambiguous fresh req must not bind now.
  server.push(round("req_fresh", 1, 5, 100))
  await settle(300)
  expect(provider(late.snapshots).length).toBe(0)
  next!.finalize()

  const fresh = collect()
  const hitsBefore = server.hits()
  const c = await attach(server, "msg_c", fresh)
  expect(c).toBeDefined()
  expect(server.hits()).toBeGreaterThan(hitsBefore)
  server.push(round("req_c", 1, 5, 100))
  await waitFor(() => rates(fresh.snapshots).length > 0)
  expect(fresh.snapshots.at(-1)!.assistantMessageID).toBe("msg_c")
  c!.finalize()
})

test("newer immediate decode sample supersedes the older throttled sample", async () => {
  const server = await startMlx()
  // Control Date.now() only: the decode throttle stays a real timer so the
  // pending sample's timer is overdue-but-unfired when the newer round
  // arrives, which is exactly the race the immediate branch must cancel.
  const realNow = Date.now
  let fakeNow = 0
  Date.now = () => fakeNow
  try {
    const sink = collect()
    const attempt = await attach(server, "msg_a", sink)
    expect(attempt).toBeDefined()
    server.push(round("r1", 0, 1, 1))
    await settle(30)
    server.push(round("r1", 1, 10, 500))
    await settle(30)
    expect(rates(sink.snapshots).length).toBe(0)
    fakeNow = 260
    server.push(round("r1", 2, 20, 500))
    await settle(30)
    expect(rates(sink.snapshots).at(-1)!.tokensPerSecond).toBeCloseTo(30, 5)
    attempt!.finalize()
    expect(sink.snapshots.at(-1)).toEqual({
      sessionID: "ses_test",
      assistantMessageID: "msg_a",
      phase: "decode",
      tokensPerSecond: 30,
      done: true,
    })
    await settle(300)
    expect(rates(sink.snapshots).length).toBe(2)
  } finally {
    Date.now = realNow
    server.stop()
  }
})

test("finalization flushes the newest throttled decode sample as the done snapshot", async () => {
  const server = await startMlx()
  const sink = collect()
  const attempt = await attach(server, "msg_a", sink)
  server.push(round("r1", 0, 100, 500))
  await waitFor(() => provider(sink.snapshots).length === 1)
  server.push(round("r1", 1, 10, 500))
  // Let the frame reach the watcher while staying inside the 250 ms throttle
  // window so the newest rate sample is still parked in pendingDecode.
  await settle(100)
  expect(provider(sink.snapshots).length).toBe(1)
  attempt!.finalize()
  expect(sink.snapshots.at(-1)).toEqual({
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    phase: "decode",
    tokensPerSecond: 20,
    done: true,
  })
  await settle(300)
  expect(provider(sink.snapshots).length).toBe(2)
})

test("finalized req stays dead after its binding entry is cleaned up", async () => {
  const server = await startMlx()
  const sink = collect()
  const first = await attach(server, "msg_a", sink)
  server.push(round("r1", 1, 5, 100))
  await waitFor(() => rates(sink.snapshots).length > 0)
  first!.finalize()
  const second = await attach(server, "msg_b", sink)
  expect(second).toBeDefined()
  const before = sink.snapshots.length
  server.push(round("r1", 2, 5, 100))
  await settle(300)
  expect(sink.snapshots.length).toBe(before)
  server.push(round("r2", 1, 5, 100))
  await waitFor(() => sink.snapshots.length > before)
  expect(sink.snapshots.at(-1)!.assistantMessageID).toBe("msg_b")
})

test("snapshots are delivered through the owning attempt's publish callback", async () => {
  const server = await startMlx()
  const sinkA = collect()
  const first = await attach(server, "msg_a", sinkA)
  expect(first).toBeDefined()
  server.push(round("r1", 1, 5, 100))
  await waitFor(() => provider(sinkA.snapshots).length > 0)
  const sinkB = collect()
  const second = await attach(server, "msg_b", sinkB)
  expect(second).toBeDefined()
  server.push(round("r2", 1, 5, 100))
  await waitFor(() => provider(sinkB.snapshots).length > 0)
  server.push(round("r1", 2, 5, 100))
  server.push(round("r2", 2, 5, 100))
  await settle(300)
  expect(sinkA.snapshots.every((item) => item.assistantMessageID === "msg_a")).toBe(true)
  expect(sinkB.snapshots.every((item) => item.assistantMessageID === "msg_b")).toBe(true)
  first!.finalize()
  second!.finalize()
})

test("guardAttempt finalizes the held attempt only when setup fails", async () => {
  let finalized = 0
  const holder: MLXTelemetry.TelemetryHolder = { current: { finalize: () => (finalized += 1) } }
  const failed = await Effect.runPromise(
    Effect.fail(new Error("setup boom")).pipe(MLXTelemetry.guardAttempt(holder), Effect.exit),
  )
  expect(Exit.isFailure(failed)).toBe(true)
  expect(finalized).toBe(1)
  const succeeded = await Effect.runPromise(Effect.succeed(1).pipe(MLXTelemetry.guardAttempt(holder), Effect.exit))
  expect(Exit.isSuccess(succeeded) && succeeded.value).toBe(1)
  expect(finalized).toBe(1)
})

test("teardown arbitration: pending provider sample beats an already-valid fallback", async () => {
  const server = await startMlx()
  const sink = collect()
  const holder: MLXTelemetry.TelemetryHolder = {}
  const attempt = await MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: server.baseURL },
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: (snapshot) => {
      // Mirrors llm.ts: only a finite positive provider decode rate wins
      // decode arbitration.
      if (MLXTelemetry.hasAuthoritativeDecodeRate(snapshot)) holder.providerDecodeAccepted = true
      sink.publish(snapshot)
    },
  })
  expect(attempt).toBeDefined()
  holder.current = attempt

  // The fallback already holds a valid approximate sample published before
  // the provider epoch even reported anything.
  const fallbackSnapshots: FallbackTelemetrySnapshot[] = []
  let nowValue = 0
  const fallback = FallbackTelemetry.createFallbackTelemetry({
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    suppressed: () => holder.providerDecodeAccepted === true,
    publish: (snapshot) => fallbackSnapshots.push(snapshot),
    now: () => nowValue,
  })
  nowValue = 1000
  fallback.push(LLMEvent.textDelta({ id: "t", text: "a".repeat(800) }))
  nowValue = 3000
  fallback.push(LLMEvent.textDelta({ id: "t", text: "a".repeat(800) }))
  expect(fallbackSnapshots.some((item) => item.phase === "decode" && item.tokensPerSecond !== undefined)).toBe(true)

  // An authoritative decode sample exists but is still parked behind the
  // provider's ~250 ms throttle: i==0 establishes decode (no rate), i==1 is
  // throttled into pendingDecode. Acceptance has NOT flipped yet.
  server.push(round("r1", 0, 100, 500))
  await waitFor(() => provider(sink.snapshots).some((item) => item.phase === "decode"))
  expect(holder.providerDecodeAccepted).toBeUndefined()
  server.push(round("r1", 1, 10, 500))
  await settle(100)
  expect(rates(sink.snapshots).length).toBe(0)

  // One composite finalizer: provider flushes first, the valid pending rate
  // synchronously flips acceptance, and the fallback sees the suppression.
  MLXTelemetry.finalizeAttempt(holder, fallback)()
  expect(holder.providerDecodeAccepted).toBe(true)
  expect(rates(sink.snapshots).at(-1)).toEqual(
    expect.objectContaining({ phase: "decode", tokensPerSecond: 20, done: true }),
  )
  expect(fallbackSnapshots.some((item) => item.done === true)).toBe(false)

  // Late scheduled fallback work can never resurrect a competing terminal.
  await settle(300)
  expect(fallbackSnapshots.some((item) => item.done === true)).toBe(false)
  expect(sink.snapshots.filter((item) => item.done === true).length).toBe(1)
  server.stop()
})

// Mirrors the llm.ts arbitration wiring: provider snapshots publish through
// the wrapper, and only a finite positive decode rate flips acceptance.
function arbitration() {
  const sink = collect()
  const holder: MLXTelemetry.TelemetryHolder = {}
  return {
    sink,
    holder,
    publish: (snapshot: TelemetrySnapshot) => {
      if (MLXTelemetry.hasAuthoritativeDecodeRate(snapshot)) holder.providerDecodeAccepted = true
      sink.publish(snapshot)
    },
  }
}

function fallbackAgainst(holder: MLXTelemetry.TelemetryHolder) {
  const snapshots: FallbackTelemetrySnapshot[] = []
  let nowValue = 0
  const attempt = FallbackTelemetry.createFallbackTelemetry({
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    suppressed: () => holder.providerDecodeAccepted === true,
    publish: (snapshot) => snapshots.push(snapshot),
    now: () => nowValue,
  })
  return {
    snapshots,
    attempt,
    advance: (ms: number) => (nowValue += ms),
    generate: () => {
      attempt.push(LLMEvent.textDelta({ id: "t", text: "a".repeat(800) }))
    },
  }
}

test("provider prefill progress publishes but does not suppress the decode fallback", async () => {
  const server = await startMlx()
  const a = arbitration()
  const attempt = await MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: server.baseURL },
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: a.publish,
  })
  expect(attempt).toBeDefined()
  a.holder.current = attempt

  server.push(prefill("r1", 370, 1000))
  await waitFor(() => a.sink.snapshots.some((item) => item.processed === 370))
  // The context progress stays provider-owned and authoritative, but it is
  // not a decode rate: acceptance must not flip.
  expect(a.holder.providerDecodeAccepted).toBeUndefined()

  const fb = fallbackAgainst(a.holder)
  fb.advance(1000)
  fb.generate()
  fb.advance(2000)
  fb.generate()
  const live = fb.snapshots.at(-1)!
  expect(live.phase).toBe("decode")
  expect(live.tokensPerSecond).toBeCloseTo(200, 5)
  expect(live.approximate).toBe(true)
  server.stop()
})

test("i==0 phase transition does not decode-accept the provider", async () => {
  const server = await startMlx()
  const a = arbitration()
  const attempt = await MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: server.baseURL },
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: a.publish,
  })
  expect(attempt).toBeDefined()
  a.holder.current = attempt

  server.push(round("r1", 0, 100, 500))
  await waitFor(() => provider(a.sink.snapshots).some((item) => item.phase === "decode"))
  // The no-rate phase transition is published (it is real provider
  // information) yet produces no rate by design: i==0's ms contains prefill.
  expect(rates(a.sink.snapshots).length).toBe(0)
  expect(a.holder.providerDecodeAccepted).toBeUndefined()

  const fb = fallbackAgainst(a.holder)
  fb.advance(1000)
  fb.generate()
  fb.advance(2000)
  fb.generate()
  expect(fb.snapshots.some((item) => item.phase === "decode" && item.tokensPerSecond !== undefined)).toBe(true)
  server.stop()
})

test("a valid i>0 provider rate flips acceptance and permanently suppresses the fallback", async () => {
  const server = await startMlx()
  const a = arbitration()
  const attempt = await MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: server.baseURL },
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: a.publish,
  })
  expect(attempt).toBeDefined()
  a.holder.current = attempt

  server.push(round("r1", 0, 100, 500))
  await waitFor(() => provider(a.sink.snapshots).some((item) => item.phase === "decode"))
  const fb = fallbackAgainst(a.holder)
  expect(a.holder.providerDecodeAccepted).toBeUndefined()

  // Past the throttle window so the i==1 rate publishes immediately.
  await settle(300)
  server.push(round("r1", 1, 10, 500))
  await waitFor(() => rates(a.sink.snapshots).length > 0)
  expect(a.holder.providerDecodeAccepted).toBe(true)

  // Acceptance is sticky: no fallback measurement can appear after it.
  const before = fb.snapshots.length
  fb.advance(1000)
  fb.generate()
  fb.advance(2000)
  fb.generate()
  fb.attempt.finalize()
  expect(fb.snapshots.length).toBe(before)
  server.stop()
})

test("short generation: i0-only provider terminal lets the fallback freeze its rate", async () => {
  const server = await startMlx()
  const a = arbitration()
  const attempt = await MLXTelemetry.attach({
    options: { mlxTelemetry: true, baseURL: server.baseURL },
    sessionID: "ses_test",
    assistantMessageID: "msg_a",
    publish: a.publish,
  })
  expect(attempt).toBeDefined()
  a.holder.current = attempt

  server.push(prefill("r1", 500, 1000))
  server.push(round("r1", 0, 100, 500))
  await waitFor(() => provider(a.sink.snapshots).some((item) => item.phase === "decode"))

  const fb = fallbackAgainst(a.holder)
  fb.advance(1000)
  fb.generate()
  fb.advance(2000)
  fb.generate()

  // Stream tears down with no valid provider decode rate ever published:
  // the composite finalizer must NOT decode-accept the provider and the
  // fallback freezes its useful approximate measurement as the terminal.
  MLXTelemetry.finalizeAttempt(a.holder, fb.attempt)()
  expect(a.holder.providerDecodeAccepted).toBeUndefined()
  expect(a.sink.snapshots.some((item) => item.tokensPerSecond !== undefined)).toBe(false)
  const done = fb.snapshots.at(-1)!
  expect(done.done).toBe(true)
  expect(done.phase).toBe("decode")
  expect(done.tokensPerSecond).toBeCloseTo(200, 5)
  expect(done.approximate).toBe(true)
  server.stop()
})
