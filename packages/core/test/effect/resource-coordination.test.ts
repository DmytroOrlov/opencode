/**
 * Owner-level proof of the cross-host Config-resource registry in `resource-coordination.ts`.
 *
 * Every case identifies a directory exactly as an embedded host does — `FSUtil.identifyConfigResource` against the
 * effective filesystem — then borrows through that identity and observes the pair's OWN state machines. Sharing is
 * proven by one holder withholding another on the same pair; non-sharing by a holder in one resource never
 * withholding a holder in another. Pairs are compared by object identity, so an alias that produced an
 * equivalent-but-separate admission and intent fails rather than passing.
 */
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { FileSystem } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { localFilesystemLayer } from "@opencode/util/effect/app-node-platform"
import { localBackingNamespace, withNamespace } from "@opencode/util/filesystem-provenance"
import { ResourceCoordination } from "@opencode/core/effect/resource-coordination"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/tmpdir"

const it = testEffect(Layer.empty)

const localLayer = localFilesystemLayer

/** The identity an embedded host would compute, for one filesystem and one spelled config directory. */
const identify = (layer: Layer.Layer<FileSystem.FileSystem>, configDirectory: string) =>
  Effect.flatMap(FSUtil.Service, (util) => FSUtil.identifyConfigResource(util, configDirectory)).pipe(
    Effect.provide(FSUtil.layer),
    Effect.provide(layer),
  )

/** The OS filesystem re-annotated with the claimed backing namespace, optionally with `stat` that reports no
 * device or inode, as a store that cannot prove a stable directory key would. */
const annotated = (
  namespace: object,
  anonymousStat = false,
): Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem> =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) =>
      withNamespace(
        anonymousStat
          ? {
              ...real,
              stat: (target: string) =>
                real.stat(target).pipe(
                  Effect.map(
                    (info) =>
                      ({ ...info, dev: undefined, ino: undefined }) as unknown as FileSystem.File.Info,
                  ),
                ),
            }
          : { ...real },
        namespace,
      )),
  )

/** A transparent wrapper whose provenance was lost: it cannot say who owns the store it writes. */
const unprovenLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (real) =>
    Object.fromEntries(Object.entries(real)) as unknown as FileSystem.FileSystem,
  ),
).pipe(Layer.provide(localLayer))

/** A grant that must be admitted, or the case fails instead of waiting: the observation is the assertion. */
const admitted = <A, E>(grant: Effect.Effect<A, E>) =>
  grant.pipe(
    Effect.timeoutOrElse({
      duration: "1 seconds",
      orElse: () => Effect.die("expected this acquisition to be admitted, and it was not"),
    }),
  )

describe("ResourceCoordination", () => {
  it.effect("shares ONE pair across every alias spelling of one native directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped("opencode-resource-alias-")
        const config = path.join(tmp.path, "config")
        yield* Effect.promise(() => fs.mkdir(config))
        // One native directory, four spellings: the path, a `..` step, a symlink, and a symlink reached through `..`.
        const link = path.join(tmp.path, "config-link")
        yield* Effect.promise(() => fs.symlink(config, link, "dir"))
        const spellings = [
          config,
          path.join(tmp.path, "nested", "..", "config"),
          link,
          path.join(link, "..", "config-link"),
        ]
        const identities = yield* Effect.forEach(spellings, (spelling) => identify(localLayer, spelling))
        // Identity is ONE resource's: one canonical directory, one key, and one namespace object throughout.
        expect(new Set(identities.map(({ directory }) => directory)).size).toBe(1)
        expect(new Set(identities.map(({ directoryKey }) => directoryKey)).size).toBe(1)
        expect(new Set(identities.map(({ namespace }) => namespace)).size).toBe(1)

        const [direct, dotted, linked, linkedDotted] = identities
        const first = yield* ResourceCoordination.borrow(direct!.namespace, direct!.directoryKey)
        const viaDot = yield* ResourceCoordination.borrow(dotted!.namespace, dotted!.directoryKey)
        const viaLink = yield* ResourceCoordination.borrow(linked!.namespace, linked!.directoryKey)
        const viaLinkDot = yield* ResourceCoordination.borrow(linkedDotted!.namespace, linkedDotted!.directoryKey)
        // ONE borrowed pair for all four hosts, not four equivalent ones.
        expect(viaDot).toBe(first)
        expect(viaLink).toBe(first)
        expect(viaLinkDot).toBe(first)
        expect(viaLink.admission).toBe(first.admission)
        expect(viaLink.fallbackIntent).toBe(first.fallbackIntent)

        // The sharing is behavioural: a shared lease taken through one spelling withholds the exclusive grant that
        // another spelling waits for, on the same admission.
        const holder = yield* viaLink.admission.acquireShared
        const queued = yield* Effect.forkScoped(viaDot.admission.acquireExclusive)
        yield* Effect.yieldNow
        expect(queued.pollUnsafe(), "alias spellings did not share one admission").toBeUndefined()
        yield* holder.release
        const acquired = yield* Fiber.join(queued)
        yield* acquired.release
      }),
    ),
  )

  it.effect("coordinates only one resource: a lease here never withholds a writer there", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped("opencode-resource-isolation-")
        const one = path.join(tmp.path, "config")
        const other = path.join(tmp.path, "other-config")
        yield* Effect.promise(() => Promise.all([fs.mkdir(one), fs.mkdir(other)]))
        const first = yield* identify(localLayer, one)
        const second = yield* identify(localLayer, other)
        expect(second.directoryKey).not.toBe(first.directoryKey)

        const firstPair = yield* ResourceCoordination.borrow(first.namespace, first.directoryKey)
        const secondPair = yield* ResourceCoordination.borrow(second.namespace, second.directoryKey)
        expect(secondPair).not.toBe(firstPair)

        // A generation-shaped lease held open in the first resource for the whole observation.
        const held = yield* firstPair.admission.acquireShared
        // Coordination is keyed by resource, never process-wide: this other resource admits an exclusive grant and a
        // shared lease at once, while a queued exclusive INSIDE the first resource stays parked in the same window.
        const thereExclusive = yield* admitted(secondPair.admission.acquireExclusive)
        yield* thereExclusive.release
        const thereShared = yield* secondPair.admission.acquireShared
        const hereQueued = yield* Effect.forkScoped(firstPair.admission.acquireExclusive)
        yield* Effect.yieldNow
        expect(hereQueued.pollUnsafe()).toBeUndefined()
        yield* thereShared.release
        yield* held.release
        const hereAcquired = yield* Fiber.join(hereQueued)
        yield* hereAcquired.release
      }),
    ),
  )

  it.effect("keeps one pair alive until the last borrower releases, and retires it afterwards", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("opencode-resource-refcount-")
      const config = path.join(tmp.path, "config")
      yield* Effect.promise(() => fs.mkdir(config))
      const identity = yield* identify(localLayer, config)

      const survivor = yield* Effect.scoped(
        Effect.gen(function* () {
          // One host holds the resource for the whole window.
          const outer = yield* ResourceCoordination.borrow(identity.namespace, identity.directoryKey)
          yield* Effect.scoped(
            Effect.gen(function* () {
              // A sibling host that closes while the first still holds it: its borrow retires and its lease is let go.
              const sibling = yield* ResourceCoordination.borrow(identity.namespace, identity.directoryKey)
              expect(sibling).toBe(outer)
              const lease = yield* admitted(sibling.admission.acquireShared)
              yield* lease.release
            }),
          )
          // The pair survived the closed host: a NEW borrower gets the SAME live machines, and they still work.
          const newcomer = yield* ResourceCoordination.borrow(identity.namespace, identity.directoryKey)
          expect(newcomer).toBe(outer)
          const lease = yield* admitted(newcomer.admission.acquireShared)
          yield* lease.release
          return outer
        }),
      )
      // Every borrower has released, so the next host gets a FRESH pair: nothing retired is silently reused, and its
      // grants are its own.
      const next = yield* ResourceCoordination.borrow(identity.namespace, identity.directoryKey)
      expect(next).not.toBe(survivor)
      const lease = yield* admitted(next.admission.acquireShared)
      yield* lease.release
    }),
  )

  it.effect("never shares on path data alone, and refuses a host that cannot prove its identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped("opencode-resource-namespace-")
        const config = path.join(tmp.path, "config")
        yield* Effect.promise(() => fs.mkdir(config))
        const local = yield* identify(localLayer, config)
        const localPair = yield* ResourceCoordination.borrow(local.namespace, local.directoryKey)

        // The SAME real directory through a second backing-store token: identical reported path, device and inode,
        // which must never be enough to merge two Config resources.
        const foreign = yield* identify(annotated({ token: "foreign-backing-store" }).pipe(Layer.provide(localLayer)), config)
        expect(foreign.directory).toBe(local.directory)
        expect(foreign.directoryKey).toBe(local.directoryKey)
        expect(foreign.namespace).not.toBe(local.namespace)
        const foreignPair = yield* ResourceCoordination.borrow(foreign.namespace, foreign.directoryKey)
        expect(foreignPair).not.toBe(localPair)
        // A lease in the foreign store never withholds this store's exclusive grant ...
        const foreignLease = yield* foreignPair.admission.acquireShared
        const localExclusive = yield* admitted(localPair.admission.acquireExclusive)
        // ... while within the foreign store that same grant IS withheld, so the boundary is per resource and real.
        const foreignQueued = yield* Effect.forkScoped(foreignPair.admission.acquireExclusive)
        yield* Effect.yieldNow
        expect(foreignQueued.pollUnsafe()).toBeUndefined()
        yield* localExclusive.release
        yield* foreignLease.release
        const foreignAcquired = yield* Fiber.join(foreignQueued)
        yield* foreignAcquired.release

        // A store that cannot report device and inode may fall back to the canonical path ONLY under the proven local
        // namespace; two alias spellings of it still share one pair.
        const anonymousLocal = annotated(localBackingNamespace, true).pipe(Layer.provide(localLayer))
        // The symlink is created here, not assumed: ensureDir would otherwise create a real directory and the two
        // spellings would name two resources.
        const anonymousLink = path.join(tmp.path, "config-link")
        yield* Effect.promise(() => fs.symlink(config, anonymousLink, "dir"))
        const viaPath = yield* identify(anonymousLocal, config)
        const viaLink = yield* identify(anonymousLocal, anonymousLink)
        expect(viaPath.directoryKey).toStartWith("realpath:")
        const anonymousPair = yield* ResourceCoordination.borrow(viaPath.namespace, viaPath.directoryKey)
        expect(yield* ResourceCoordination.borrow(viaLink.namespace, viaLink.directoryKey)).toBe(anonymousPair)
        // Under a foreign namespace the same missing inode data must FAIL instead of inventing a shared-prone key.
        const anonymousForeign = annotated({ token: "foreign-anonymous" }, true).pipe(Layer.provide(localLayer))
        expect(Exit.isFailure(yield* Effect.exit(identify(anonymousForeign, config)))).toBe(true)

        // A wrapper that cannot prove a backing namespace at all fails startup identification too, and neither failure
        // left a partial entry behind: the live pair is still the one borrowed by the host that holds it.
        expect(Exit.isFailure(yield* Effect.exit(identify(unprovenLayer, config)))).toBe(true)
        const notADirectory = path.join(tmp.path, "opencode.jsonc")
        yield* Effect.promise(() => fs.writeFile(notADirectory, "{}\n"))
        expect(Exit.isFailure(yield* Effect.exit(identify(localLayer, notADirectory)))).toBe(true)
        expect(yield* ResourceCoordination.borrow(local.namespace, local.directoryKey)).toBe(localPair)
      }),
    ),
  )
})
