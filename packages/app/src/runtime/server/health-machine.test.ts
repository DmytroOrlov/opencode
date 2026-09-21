import { expect, test } from "bun:test"
import {
  canUseServer,
  createServerHealthState,
  isServerFailed,
  selectServerHealthRank,
  selectServerHealthRecord,
  selectServerIndicator,
  SERVER_HEALTH_POLL_MS,
  transitionServerHealth,
  type ServerHealth,
  type ServerHealthEffect,
  type ServerHealthEvent,
  type ServerHealthInput,
  type ServerHealthState,
  type ServerProbeResult,
} from "./health-machine"
import { ServerKey } from "./persistence"

const key = (name: string) => ServerKey.make(`http://${name}`)

const endpoint = (name: string, password?: string, managed = false): ServerHealthInput => ({
  type: "endpoint",
  key: key(name),
  http: { url: `http://${name}`, password },
  managed,
})

const staged = (name: string, stage: Extract<ServerHealthInput, { type: "staged" }>["stage"]): ServerHealthInput => ({
  type: "staged",
  key: key(name),
  stage,
})

const synced = (...servers: ServerHealthInput[]): ServerHealthEvent => ({ type: "servers.synced", servers })

const poll: ServerHealthEvent = { type: "poll.due" }

function replay(events: readonly ServerHealthEvent[], state: ServerHealthState = createServerHealthState()) {
  return events.reduce<{ state: ServerHealthState; effects: ServerHealthEffect[] }>(
    (result, event) => {
      const next = transitionServerHealth(result.state, event)

      return { state: next.state, effects: [...result.effects, ...next.effects] }
    },
    { state, effects: [] },
  )
}

const health = (state: ServerHealthState, name: string) => selectServerHealthRecord(state)[key(name)]

const probes = (effects: readonly ServerHealthEffect[]) =>
  effects.flatMap((effect) => (effect.type === "probe" ? [`${effect.key} #${effect.attempt}`] : []))

const notified = (effects: readonly ServerHealthEffect[]) => effects.filter((effect) => effect.type === "notify.probe")

function probeEffect(effects: readonly ServerHealthEffect[], name: string, attempt: number) {
  const effect = effects.find(
    (item) => item.type === "probe" && item.key === key(name) && item.attempt === attempt,
  )
  if (!effect || effect.type !== "probe") throw new Error(`Missing probe ${name} #${attempt}`)
  return effect
}

function answerFrom(
  effect: Extract<ServerHealthEffect, { type: "probe" }>,
  result: ServerProbeResult,
): ServerHealthEvent {
  return { ...effect, type: "probe.settled", result }
}

test("a slow server's answer never reverts a faster server's newer answer", () => {
  const listed = replay([synced(endpoint("fast"), endpoint("slow"))])
  const start = transitionServerHealth(
    listed.state,
    answerFrom(probeEffect(listed.effects, "fast", 1), { type: "unreachable" }),
  )

  // The poll comes due while the slow probe still runs: only the idle server probes again.
  const polled = transitionServerHealth(start.state, poll)
  expect(probes(polled.effects)).toEqual(["http://fast #2"])

  const end = replay(
    [
      answerFrom(probeEffect(polled.effects, "fast", 2), { type: "healthy" }),
      answerFrom(probeEffect(listed.effects, "slow", 1), { type: "unreachable" }),
    ],
    polled.state,
  )

  expect(health(end.state, "fast")).toEqual({ type: "healthy" })
  expect(health(end.state, "slow")).toEqual({ type: "unreachable" })
})

test("a probe that a retry replaced never reaches the listener", () => {
  const listed = replay([synced(endpoint("s", "pw1"))])
  const discarded = probeEffect(listed.effects, "s", 1)

  const retried = transitionServerHealth(listed.state, { type: "retry.requested", resolve: () => {} })
  const current = transitionServerHealth(
    retried.state,
    answerFrom(probeEffect(retried.effects, "s", 2), { type: "healthy" }),
  )
  expect(notified(current.effects)).toEqual([
    { type: "notify.probe", probe: { key: key("s"), auth: "http://s\npw1", result: { type: "healthy" } } },
  ])

  // The replaced probe answers 401 late: it neither signs the server out nor changes its health.
  const late = transitionServerHealth(current.state, answerFrom(discarded, { type: "unauthorized" }))
  expect(late).toEqual({ state: current.state, effects: [] })
  expect(health(late.state, "s")).toEqual({ type: "healthy" })
})

test.each([
  { name: "disposed", event: { type: "disposed" } as const },
  { name: "unlisted", event: synced() },
  { name: "moved to a new endpoint", event: synced(endpoint("s", "pw2")) },
  { name: "waiting for its plugin", event: synced(staged("s", "auth")) },
])("a probe of a server that was $name never reaches the listener", (input) => {
  const listed = replay([synced(endpoint("s", "pw1"))])
  const discarded = probeEffect(listed.effects, "s", 1)

  const left = transitionServerHealth(listed.state, input.event)
  const late = transitionServerHealth(left.state, answerFrom(discarded, { type: "unauthorized" }))

  expect(late).toEqual({ state: left.state, effects: [] })
})

test.each([0, 2])("an answer for attempt %i is rejected while the incarnation matches", (attempt) => {
  const listed = replay([synced(endpoint("s"))])
  const current = probeEffect(listed.effects, "s", 1)

  const late = transitionServerHealth(listed.state, {
    ...current,
    type: "probe.settled",
    attempt,
    result: { type: "healthy" },
  })

  expect(late).toEqual({ state: listed.state, effects: [] })

  const accepted = transitionServerHealth(listed.state, answerFrom(current, { type: "healthy" }))
  expect(health(accepted.state, "s")).toEqual({ type: "healthy" })
})

test("a credential replacement keeps attempts increasing and rejects the old completion", () => {
  const listed = replay([synced(endpoint("s", "pw1"))])
  const discarded = probeEffect(listed.effects, "s", 1)

  const replaced = transitionServerHealth(listed.state, synced(endpoint("s", "pw2")))
  expect(probes(replaced.effects)).toEqual(["http://s #2"])
  expect(probeEffect(replaced.effects, "s", 2).incarnation).not.toBe(discarded.incarnation)

  const late = transitionServerHealth(replaced.state, answerFrom(discarded, { type: "unauthorized" }))
  expect(late).toEqual({ state: replaced.state, effects: [] })
  expect(health(late.state, "s")).toEqual({ type: "checking", managed: false })

  const accepted = transitionServerHealth(
    replaced.state,
    answerFrom(probeEffect(replaced.effects, "s", 2), { type: "healthy" }),
  )
  expect(notified(accepted.effects)).toEqual([
    {
      type: "notify.probe",
      probe: { key: key("s"), auth: "http://s\npw2", result: { type: "healthy" } },
    },
  ])
})

test("a pending retry resolves on the accepted replacement attempt at or above its target", () => {
  const log: string[] = []

  const listed = replay([synced(endpoint("s", "pw1"))])
  const retried = transitionServerHealth(listed.state, {
    type: "retry.requested",
    resolve: () => log.push("resolved"),
  })
  expect(probes(retried.effects)).toEqual(["http://s #2"])
  const discarded = probeEffect(retried.effects, "s", 2)

  const replaced = transitionServerHealth(retried.state, synced(endpoint("s", "pw2")))
  expect(probes(replaced.effects)).toEqual(["http://s #3"])

  const old = transitionServerHealth(replaced.state, answerFrom(discarded, { type: "healthy" }))
  expect(old.state).toBe(replaced.state)
  expect(log).toEqual([])

  const accepted = transitionServerHealth(
    replaced.state,
    answerFrom(probeEffect(replaced.effects, "s", 3), { type: "healthy" }),
  )
  accepted.effects.forEach((effect) => effect.type === "waiters.resolve" && effect.resolvers.forEach((run) => run()))

  expect(log).toEqual(["resolved"])
  expect(accepted.state.waiters).toEqual([])
})

test("a staged-to-ready transition at identical credentials uses a new incarnation", () => {
  const listed = replay([synced(endpoint("s", "pw"))])
  const discarded = probeEffect(listed.effects, "s", 1)

  const waiting = transitionServerHealth(listed.state, synced(staged("s", "auth")))
  expect(waiting.effects).toEqual([{ type: "timer.stop" }])

  const ready = transitionServerHealth(waiting.state, synced(endpoint("s", "pw")))
  const current = probeEffect(ready.effects, "s", 2)
  expect(current.incarnation).not.toBe(discarded.incarnation)

  const late = transitionServerHealth(ready.state, answerFrom(discarded, { type: "healthy", tlsCaMode: "bundled" }))
  expect(late).toEqual({ state: ready.state, effects: [] })

  const accepted = transitionServerHealth(ready.state, answerFrom(current, { type: "healthy", tlsCaMode: "system" }))
  expect(health(accepted.state, "s")).toEqual({ type: "healthy", tlsCaMode: "system" })
})

test("an unchanged-scope refresh retains the verified CA mode", () => {
  const listed = replay([synced(endpoint("s"))])
  const verified = transitionServerHealth(
    listed.state,
    answerFrom(probeEffect(listed.effects, "s", 1), { type: "healthy", tlsCaMode: "bundled" }),
  )

  const polled = transitionServerHealth(verified.state, poll)
  expect(health(polled.state, "s")).toEqual({ type: "healthy", tlsCaMode: "bundled" })

  const refreshed = transitionServerHealth(
    polled.state,
    answerFrom(probeEffect(polled.effects, "s", 2), { type: "healthy", tlsCaMode: "bundled" }),
  )
  expect(health(refreshed.state, "s")).toEqual({ type: "healthy", tlsCaMode: "bundled" })
})

test("a check in flight does not read as a failed server", () => {
  const moved = replay([synced(endpoint("tunnel", undefined, true), endpoint("plain"))]).state
  const tunnel = health(moved, "tunnel")
  const plain = health(moved, "plain")

  expect(tunnel).toEqual({ type: "checking", managed: true })
  expect(plain).toEqual({ type: "checking", managed: false })
  ;[tunnel, plain].forEach((value) => {
    expect(canUseServer(value)).toBe(true)
    expect(isServerFailed(value)).toBe(false)
    expect(selectServerHealthRank(value)).toBe(1)
  })
  expect(selectServerIndicator(tunnel)).toBe("connecting")
  expect(selectServerIndicator(plain)).toBe("unknown")
})

test("a contributed server that is not ready reports its stage and is never probed", () => {
  const stages = ["stopped", "starting", "auth", "failed", "incompatible"] as const

  const expected: ServerHealth[] = [
    { type: "stopped" },
    { type: "starting" },
    { type: "auth" },
    { type: "unreachable" },
    { type: "incompatible" },
  ]

  const seen = stages.map((stage, index) => {
    const result = replay(stages.slice(0, index + 1).map((item) => synced(staged("ssh", item))))

    expect(probes(result.effects)).toEqual([])

    return health(result.state, "ssh")
  })

  expect(seen).toEqual(expected)
  // The inbox stops waiting for a server that cannot answer yet.
  seen.forEach((value) => expect(canUseServer(value)).toBe(false))
  expect(seen.map(selectServerIndicator)).toEqual(["unknown", "connecting", "auth", "unreachable", "incompatible"])
})

test("a background poll keeps the last answer until the next one arrives", () => {
  const listed = replay([synced(endpoint("s"))])
  const known = transitionServerHealth(
    listed.state,
    answerFrom(probeEffect(listed.effects, "s", 1), { type: "healthy", version: "2.0.0" }),
  )
  const polled = transitionServerHealth(known.state, poll)

  expect(probes(polled.effects)).toEqual(["http://s #2"])
  expect(health(polled.state, "s")).toEqual({ type: "healthy", version: "2.0.0" })
  // A probe already in flight is not started again.
  expect(transitionServerHealth(polled.state, poll)).toEqual({ state: polled.state, effects: [] })
})

test("a server joining the list leaves the probe of an unchanged one running", () => {
  const first = replay([synced(endpoint("a"))])
  const joined = transitionServerHealth(first.state, synced(endpoint("a"), endpoint("b")))

  expect(probes(joined.effects)).toEqual(["http://b #1"])
  expect(
    health(
      transitionServerHealth(
        joined.state,
        answerFrom(probeEffect(first.effects, "a", 1), { type: "healthy" }),
      ).state,
      "a",
    ),
  ).toEqual({
    type: "healthy",
  })
})

test("the poll runs only while a server has an endpoint", () => {
  const listed = replay([synced(staged("ssh", "auth"))])
  expect(listed.effects).toEqual([])

  const ready = transitionServerHealth(listed.state, synced(endpoint("ssh")))
  expect(ready.effects).toContainEqual({ type: "timer.start", intervalMs: SERVER_HEALTH_POLL_MS })

  expect(transitionServerHealth(ready.state, synced()).effects).toEqual([{ type: "timer.stop" }])
})

test("retry probes every server again and resolves once each answers", () => {
  const log: string[] = []
  const resolve = () => log.push("resolved")

  const listed = replay([synced(endpoint("a"), endpoint("b"), staged("ssh", "auth"))])
  const start = transitionServerHealth(
    listed.state,
    answerFrom(probeEffect(listed.effects, "a", 1), { type: "unreachable" }),
  )

  const retried = transitionServerHealth(start.state, { type: "retry.requested", resolve })
  expect(probes(retried.effects)).toEqual(["http://a #2", "http://b #2"])
  expect(retried.effects).toContainEqual({ type: "timer.start", intervalMs: SERVER_HEALTH_POLL_MS })

  // The probe the retry replaced answers first: the caller keeps waiting.
  const stale = transitionServerHealth(
    retried.state,
    answerFrom(probeEffect(listed.effects, "b", 1), { type: "healthy" }),
  )
  expect(stale.state).toBe(retried.state)

  const partial = transitionServerHealth(
    retried.state,
    answerFrom(probeEffect(retried.effects, "a", 2), { type: "healthy" }),
  )
  expect(partial.effects).not.toContainEqual(expect.objectContaining({ type: "waiters.resolve" }))

  const done = transitionServerHealth(
    partial.state,
    answerFrom(probeEffect(retried.effects, "b", 2), { type: "healthy" }),
  )
  done.effects.forEach((effect) => effect.type === "waiters.resolve" && effect.resolvers.forEach((run) => run()))
  expect(log).toEqual(["resolved"])
  expect(done.state.waiters).toEqual([])
})

test.each([
  { name: "is unlisted", event: synced(endpoint("a")) },
  { name: "waits for its plugin", event: synced(endpoint("a"), staged("b", "starting")) },
  { name: "is disposed", event: { type: "disposed" } as const },
])("retry resolves when the server it waits for $name", (input) => {
  const listed = replay([synced(endpoint("a"), endpoint("b"))])
  const retried = transitionServerHealth(
    listed.state,
    answerFrom(probeEffect(listed.effects, "a", 1), { type: "healthy" }),
  )

  const waiting = transitionServerHealth(retried.state, { type: "retry.requested", resolve: () => {} })
  const partial = transitionServerHealth(
    waiting.state,
    answerFrom(probeEffect(waiting.effects, "a", 2), { type: "healthy" }),
  )

  expect(partial.state.waiters).toHaveLength(1)

  const result = transitionServerHealth(partial.state, input.event)
  expect(result.effects).toContainEqual(expect.objectContaining({ type: "waiters.resolve" }))
  expect(result.state.waiters).toEqual([])
})

test("retry with no server to probe resolves at once", () => {
  const resolve = () => {}

  expect(
    transitionServerHealth(replay([synced(staged("ssh", "auth"))]).state, { type: "retry.requested", resolve }).effects,
  ).toEqual([{ type: "waiters.resolve", resolvers: [resolve] }])
})

test.each([
  { type: "healthy", tlsCaMode: "bundled" },
  { type: "unauthorized" },
] as const)("remove/relist rejects a discarded probe with the same attempt", (result) => {
  const first = replay([synced(endpoint("s", "pw"))])
  const discarded = probeEffect(first.effects, "s", 1)

  const relisted = replay([synced(), synced(endpoint("s", "pw"))], first.state)
  const current = probeEffect(relisted.effects, "s", 1)

  const late = transitionServerHealth(relisted.state, answerFrom(discarded, result))

  expect(late.state).toBe(relisted.state)
  expect(late.effects).toEqual([])
  expect(health(late.state, "s")).toEqual({
    type: "checking",
    managed: false,
  })

  const accepted = transitionServerHealth(
    late.state,
    answerFrom(current, { type: "healthy", tlsCaMode: "system" }),
  )

  expect(health(accepted.state, "s")).toEqual({
    type: "healthy",
    tlsCaMode: "system",
  })
  expect(notified(accepted.effects)).toEqual([
    {
      type: "notify.probe",
      probe: {
        key: key("s"),
        auth: "http://s\npw",
        result: { type: "healthy", tlsCaMode: "system" },
      },
    },
  ])
})
