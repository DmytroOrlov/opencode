/**
 * Real-filesystem fault injection for the server's own route stack.
 *
 * `serveRoutes` builds the production layer graph, so the only way to make the config writer's rename, refresh,
 * announcement or cleanup fail is to replace the global platform filesystem node with a wrapper over the real
 * Node-backed one. Nothing here substitutes for the writer: the wrapper delegates every operation it does not arm.
 *
 * Every recorded operation doubles as the proof that the injected step was reached, and every wait is a Deferred the
 * production path itself resolves: an assertion that counts an operation, or that proceeds only once a parked call
 * resumes, can never pass on a route that never got there. Waits on the config document are keyed by path, because
 * discovery reads many candidates before it reaches the one under test.
 */
import { Deferred, Effect, Exit, FileSystem, Layer, PlatformError } from "effect"
import { localFilesystemLayer } from "@opencode/util/effect/app-node-platform"

type Call = {
  writes: Array<{ path: string; content: string }>
  renames: Array<[string, string]>
  removes: Array<string>
  reads: Array<{ path: string; failed: boolean }>
}

type Fault = {
  write: boolean | ((target: string) => boolean)
  rename: boolean
  remove: boolean
  read: (path: string) => boolean
}

/**
 * Counts one kind of event and hands out waits on it.
 *
 * A wait resolves only when the production path records the event, so a test that needs to see a parked call, a
 * queue boundary or a commit landing proceeds at that instant and never guesses at a duration.
 */
const counter = () => {
  let count = 0
  const waiting: Array<{ target: number; waiter: Deferred.Deferred<void> }> = []
  return {
    get count() {
      return count
    },
    note: () => {
      count += 1
      const ready = waiting.filter(({ target }) => target <= count)
      ready.forEach(({ waiter }) => Deferred.doneUnsafe(waiter, Exit.succeed(undefined)))
    },
    reached: (target: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (count < target) {
          const waiter = Deferred.makeUnsafe<void>()
          waiting.push({ target, waiter })
          yield* Deferred.await(waiter)
        }
      }),
  }
}

const ioFault = (method: string, target: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: target,
    cause: Object.assign(new Error("EIO"), { code: "EIO" }),
  })

export function filesystemInjection() {
  const calls: Call = { writes: [], renames: [], removes: [], reads: [] }
  const faults: Fault = { write: false, rename: false, remove: false, read: () => false }
  const gates: {
    read: Map<string, { wait: Deferred.Deferred<void>; after: number }>
    write: Deferred.Deferred<void> | undefined
    rename: Deferred.Deferred<void> | undefined
  } = { read: new Map(), write: undefined, rename: undefined }
  const renameCount = counter()
  const reads = new Map<string, ReturnType<typeof counter>>()

  // Parks the read of `target` that comes after `after` earlier reads of that same path. The shared config owner reads
  // the document while it loads, before any update runs, so this is what lets a test park an update's own candidate
  // read rather than the load.
  const armReadGate = (target: string, wait: Deferred.Deferred<void>, after = 0) =>
    gates.read.set(target, { wait, after })
  const armWriteGate = (wait: Deferred.Deferred<void>) => (gates.write = wait)
  const armRenameGate = (wait: Deferred.Deferred<void>) => (gates.rename = wait)

  const readCounter = (target: string) => {
    const existing = reads.get(target)
    if (existing) return existing
    const created = counter()
    reads.set(target, created)
    return created
  }

  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return {
        ...fs,
        readFileString: (target: string, encoding?: string) => {
          const countedTarget = readCounter(target)
          // The ordinal of this read of that exact path: the shared owner reads the document while loading before any
          // update runs, so a gate that parks the update's own candidate read names which read it means.
          const ordinal = countedTarget.count + 1
          countedTarget.note()
          const failed = faults.read(target)
          calls.reads.push({ path: target, failed })
          const armed = gates.read.get(target)
          const gate = failed || armed === undefined || ordinal <= armed.after ? undefined : armed.wait
          if (gate !== undefined) {
            gates.read.delete(target)
            return Deferred.await(gate).pipe(Effect.andThen(fs.readFileString(target, encoding)))
          }
          return failed
            ? Effect.fail(ioFault("readFileString", target))
            : fs.readFileString(target, encoding)
        },
        writeFileString: (target: string, content: string) => {
          calls.writes.push({ path: target, content })
          const fault = typeof faults.write === "function" ? faults.write(target) : faults.write
          const gate = gates.write
          if (gate !== undefined) {
            gates.write = undefined
            return Deferred.await(gate).pipe(
              Effect.andThen(fault ? Effect.fail(ioFault("writeFileString", target)) : fs.writeFileString(target, content)),
            )
          }
          return fault
            ? Effect.fail(ioFault("writeFileString", target))
            : fs.writeFileString(target, content)
        },
        rename: (from: string, to: string) => {
          calls.renames.push([from, to])
          renameCount.note()
          const gate = gates.rename
          if (gate !== undefined) {
            gates.rename = undefined
            return Deferred.await(gate).pipe(
              Effect.andThen(
                faults.rename ? Effect.fail(ioFault("rename", from)) : fs.rename(from, to),
              ),
            )
          }
          return faults.rename ? Effect.fail(ioFault("rename", from)) : fs.rename(from, to)
        },
        remove: (target: string, options?: { readonly force?: boolean; readonly recursive?: boolean }) => {
          calls.removes.push(target)
          return faults.remove ? Effect.fail(ioFault("remove", target)) : fs.remove(target, options)
        },
      }
    }),
  ).pipe(Layer.provide(localFilesystemLayer))

  return {
    calls,
    faults,
    armReadGate,
    armWriteGate,
    armRenameGate,
    // Waits on production reaching a boundary: reads of one path it attempted, renames (durable commits) it made.
    awaitedReads: (target: string, count = 1) => readCounter(target).reached(count),
    awaitedRenames: renameCount.reached,
    readCount: (target: string) => readCounter(target).count,
    layer,
  }
}

/**
 * Registers a real listener on the Bus the route graph wired, so a `config.updated` announcement can fail through
 * the production path (`Config.announceUpdate` publishes an ephemeral event, and the Bus runs inline listeners
 * unisolated). Nothing here substitutes for that path: only the listener's outcome is controlled.
 */
export const configAnnouncementFault = () => {
  const state = { armed: false, seen: [] as string[] }
  const listener = (event: { readonly type: string }) =>
    Effect.gen(function* () {
      if (event.type !== "config.updated") return
      state.seen.push(event.type)
      if (!state.armed) return

      // `Bus.listen`'s subscriber type is `Effect<void>`; a failure travels on the cause channel, which is exactly
      // what an ephemeral publish runs unisolated and lets reach the config owner.
      return yield* Effect.die(new Error("test listener refused the announcement"))
    })
  return { state, listener, arm: () => (state.armed = true), disarm: () => (state.armed = false) }
}
