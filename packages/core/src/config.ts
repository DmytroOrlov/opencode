export * as Config from "./config.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import path from "path"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import { Cause, Context, Effect, Exit, FiberMap, Layer, Option, PubSub, Ref, Schema, Semaphore, Stream } from "effect"
import { Directory, Document, Info, type Patch, type Entry, Event } from "@opencode/schema/config"
import { Credential } from "./credential.js"
import { Bus } from "./bus.js"
import { Watcher } from "./filesystem/watcher.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "./location.js"
import { AbsolutePath } from "./schema.js"
import { ConfigVariable } from "./config/variable.js"
import { ConfigNormalize } from "./config/normalize.js"
import { ConfigModel } from "@opencode/schema/config/model"
import { ConfigDiscovery } from "./config/discovery.js"
import { ConfigWatch } from "./config/watch.js"
import { ConfigIntegration } from "./config/integration.js"
import { ConfigManaged } from "./config/managed.js"
import { ManagedPolicy } from "./managed-policy.js"
import { Connection } from "@opencode/schema/connection"
import { WellKnown } from "./wellknown.js"
import { AppProcess } from "@opencode/util/process"
import { ChildProcess } from "effect/process"
import { SessionGenerationAdmission } from "./session/generation-admission.js"
import { FallbackRuntimeIntent } from "./config/fallback-runtime-intent.js"

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries.findLast((entry): entry is Document => entry.type === "document" && entry.info[key] !== undefined)
    ?.info[key]
}

/**
 * An update rejected before any byte changed. The previous document stays committed
 * and neither committed-state identity below applies.
 */
export class CandidateRejectedError extends Schema.TaggedError<CandidateRejectedError>()("Config.CandidateRejected", {
  file: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Rejected configuration update for ${this.file}: ${this.reason}`
  }
}

/**
 * The atomic rename committed the new document, but protected readers were not refreshed.
 * The new bytes remain authoritative and reconciliation keeps running forward: this is
 * never a rollback.
 */
export class CommittedButUnpublishedError extends Schema.TaggedError<CommittedButUnpublishedError>()(
  "Config.CommittedButUnpublished",
  {
    file: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause)
    return `Committed ${this.file} without publishing it to protected readers${detail ? `: ${detail}` : ""}`
  }
}

/**
 * The rename committed and protected readers hold the new document; the notification
 * other owners rely on did not complete and no later reload repeats it.
 */
export class CommittedWithPostPublicationFailureError extends Schema.TaggedError<
  CommittedWithPostPublicationFailureError
>()("Config.CommittedWithPostPublicationFailure", {
  file: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause)
    return `Committed and published ${this.file} with an incomplete completion step${detail ? `: ${detail}` : ""}`
  }
}

/** Error union for {@link Interface.update}; the later server owner maps these identities. */
export type UpdateError =
  | FSUtil.Error
  | CandidateRejectedError
  | CommittedButUnpublishedError
  | CommittedWithPostPublicationFailureError

export interface Interface {
  /** Returns location config documents and discovery sources from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
  /** Compatibility roots consumed by internal compatibility plugins. */
  readonly compatibility?: () => Effect.Effect<{
    readonly claude: readonly AbsolutePath[]
    readonly agents: readonly AbsolutePath[]
  }>
  /**
   * Streams raw filesystem updates under config roots. Config owns root
   * topology and watch reconciliation; domain owners filter this feed for the
   * source files they parse and rebuild their own state.
   */
  readonly changes: () => Stream.Stream<Watcher.Update>
  /**
   * Updates supported global config fields while preserving unrelated JSONC content.
   * Failures identify actual state: precommit failures carry no committed marker, a reconciliation
   * failure no commit can be attributed to surfaces its own cause, and the two committed
   * identities describe a renamed document this owner made that did or did not reach protected
   * readers. No call reports success while protected readers remain stale.
   */
  readonly update?: (patch: Patch) => Effect.Effect<void, UpdateError>
  /**
   * Replaces, or clears with `undefined`, the document an integration connection contributes. It loads right after
   * managed policies: its settings layer below remote, user, and project config, while its policies outrank theirs.
   * Changing it reloads config like any other source.
   */
  readonly integration?: (
    integrationID: ConfigIntegration.Document["integrationID"],
    document: ConfigIntegration.Document | undefined,
  ) => Effect.Effect<void>
}

export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  // false skips the system and global config dirs, ~/.claude, and ~/.agents;
  // wellknown, file, and content entries still load.
  global: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Union([Schema.Boolean, Schema.String])),
  // false skips ~/.claude and project .claude dirs.
  claude: Schema.optional(Schema.Boolean),
  file: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export interface TestInterface extends Interface {
  /** Replaces the entries returned by subsequent entries() calls. */
  readonly setEntries: (entries: Entry[]) => Effect.Effect<void>
  /** Emits one filesystem update to every changes() subscriber. */
  readonly emitChange: (update: Watcher.Update) => Effect.Effect<void>
}

export class Test extends Context.Service<Test, TestInterface>()("@opencode/Config/Test") {}

/** In-memory config for tests: static entries with replaceable state and a test-driven change feed. */
export const testLayer = (
  initial: Entry[] = [],
  compatibility: { readonly claude: readonly AbsolutePath[]; readonly agents: readonly AbsolutePath[] } = {
    claude: [],
    agents: [],
  },
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const entries = yield* Ref.make(initial)
      const integrations = yield* Ref.make(new Map<string, ConfigIntegration.Document>())
      const updates = yield* PubSub.unbounded<Watcher.Update>()
      const service = Test.of({
        entries: () =>
          Effect.all([Ref.get(integrations), Ref.get(entries)]).pipe(
            Effect.map(([documents, entries]) => [...documents.values(), ...entries]),
          ),
        compatibility: () => Effect.succeed(compatibility),
        changes: () => Stream.fromPubSub(updates),
        setEntries: (next) => Ref.set(entries, next),
        emitChange: (update) => PubSub.publish(updates, update).pipe(Effect.asVoid),
        integration: (integrationID, document) =>
          Ref.update(integrations, (current) => {
            // Like config, keeps the document it holds when handed a deep-equal one.
            if (isDeepStrictEqual(current.get(integrationID), document)) return current
            const next = new Map(current)
            next.delete(integrationID)
            return document ? next.set(integrationID, document) : next
          }),
      })
      return Context.empty().pipe(Context.add(Service, service), Context.add(Test, service))
    }),
  )

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const watcher = yield* Watcher.Service
      const bus = yield* Bus.Service
      const credentials = yield* Credential.Service
      const globalService = yield* Global.Service
      const wellknown = yield* WellKnown.Service
      const processes = yield* AppProcess.Service
      const integrations = new Map<string, ConfigIntegration.Document>()
      // Integrations set their documents from outside this layer, so their reloads run with its services.
      const context = yield* Effect.context<FSUtil.Service | Global.Service | Location.Service>()
      const admission = yield* SessionGenerationAdmission.Service
      const fallbackIntent = yield* FallbackRuntimeIntent.Service
      const reloadLock = Semaphore.makeUnsafe(1)
      const decodeOptions = { errors: "all", onExcessProperty: "ignore" } as const
      const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
      const parseInfo = Effect.fn("Config.parseInfo")(function* (text: string, source: string) {
        const errors: ParseError[] = []
        const input: unknown = parse(text, errors, { allowTrailingComma: true })
        if (errors.length) {
          yield* Effect.logWarning("configuration normalization diagnostic", {
            source,
            path: "$",
            kind: "invalid",
            action: "rejected malformed JSON or JSONC document",
          })
          return
        }
        const result = ConfigNormalize.normalize(input)
        // Every reload repeats the routine notes on a config that loads. A rejected config or a dropped malformed
        // setting is the user's to fix, so those stay warnings.
        yield* Effect.forEach(result.diagnostics, (diagnostic) => {
          const log = result.type === "rejected" || diagnostic.kind === "invalid" ? Effect.logWarning : Effect.logDebug
          return log("configuration normalization diagnostic", {
            source,
            path: diagnostic.path[0] === "$" ? "$" : `$.${diagnostic.path.join(".")}`,
            kind: diagnostic.kind,
            action: diagnostic.message,
          })
        })
        if (result.type === "rejected") return
        const info = Option.getOrUndefined(decodeInfo(result.encoded))
        if (info) return info
        yield* Effect.logWarning("configuration normalization diagnostic", {
          source,
          path: "$",
          kind: "invalid",
          action: "rejected canonical configuration after final validation",
        })
      })

      const loadFile = Effect.fnUntraced(function* (filepath: string) {
        const text = yield* fs.readFileStringSafe(filepath)
        if (text === undefined) return
        const substituted = yield* ConfigVariable.substitute({ type: "path", path: filepath, text })
        const info = yield* parseInfo(substituted, filepath)
        if (!info) return
        return new Document({ type: "document", path: AbsolutePath.make(filepath), info })
      })

      const loadWellknownEntry = Effect.fnUntraced(function* (entry: WellKnown.Entry) {
        const auth = entry.manifest.auth
        const credential = (yield* credentials.list(entry.integrationID)).at(-1)
        const variables = auth && credential?.value.type === "key" ? { [auth.env]: credential.value.key } : undefined
        // Logging out drops the saved remote config, so the source supplies nothing until a fresh fetch succeeds.
        if (!variables) return yield* wellknown.clearCached(entry.origin).pipe(Effect.as([]))
        // A failed refresh keeps the last resolved config so remote providers and allowlists do not disappear.
        const configs = yield* wellknown.resolve(entry, variables).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to load wellknown config", { source: entry.origin, error }).pipe(
              Effect.andThen(wellknown.cached(entry.origin)),
            ),
          ),
        )
        return yield* Effect.forEach(configs, (config) =>
          ConfigVariable.substitute({
            type: "virtual",
            source: entry.origin,
            dir: entry.origin,
            text: JSON.stringify(config),
            env: variables,
          }).pipe(
            Effect.flatMap((text) => parseInfo(text, entry.origin)),
            Effect.map((info) =>
              info
                ? new ConfigIntegration.WellKnownDocument({
                    type: "document",
                    info,
                    integrationID: entry.integrationID,
                  })
                : undefined,
            ),
          ),
        ).pipe(Effect.map((documents) => documents.filter((document) => document !== undefined)))
      })

      const loadWellknown = Effect.fn("Config.loadWellknown")(function* () {
        const entries = yield* wellknown
          .entries()
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to discover wellknown config", { error }).pipe(Effect.as([] as const)),
            ),
          )
        return yield* Effect.forEach(entries, (entry) =>
          loadWellknownEntry(entry).pipe(
            Effect.map((documents) => ({ integrationID: entry.integrationID, documents })),
          ),
        )
      })

      // `integration.use` decides whether an integration may supply anything. Only managed policies can withhold the
      // documents an integration delivers, so a project file can never strip the Console document carrying org policy.
      // A withheld document keeps its policies, so denying an integration never lifts the restrictions it carries.
      const supplies = Effect.fnUntraced(function* (
        lockdown: ReturnType<typeof ManagedPolicy.statements>,
        integrationID: string,
        connection?: Connection.Info,
      ) {
        const stored =
          connection?.type === "credential" ? yield* credentials.get(Credential.ID.make(connection.id)) : undefined
        const resource = ManagedPolicy.integrationResource(
          integrationID,
          stored ? ManagedPolicy.account(stored.value) : undefined,
        )
        return ManagedPolicy.decision(lockdown, "integration.use", resource) !== "deny"
      })

      const loadPreferences = Effect.fn("Config.loadPreferences")(function* (plist: AbsolutePath) {
        const result = yield* processes
          .run(ChildProcess.make("plutil", ["-convert", "json", "-o", "-", plist], { stdin: "ignore" }), {
            timeout: "10 seconds",
          })
          .pipe(Effect.flatMap(AppProcess.requireSuccess), Effect.option)
        if (Option.isNone(result)) {
          yield* Effect.logWarning("failed to convert managed preferences", { source: plist })
          return []
        }
        const text = yield* ConfigVariable.substitute({
          type: "virtual",
          source: plist,
          dir: path.dirname(plist),
          text: ConfigDiscovery.stripPreferenceMetadata(result.value.stdout.toString()),
        })
        const info = yield* parseInfo(text, plist)
        return info ? [new Document({ type: "document", path: plist, info })] : []
      })

      const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
        return [
          ...(yield* Effect.forEach(ConfigDiscovery.names, (file) => loadFile(path.join(directory, file))).pipe(
            Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
          )),
          new Directory({ type: "directory", path: directory }),
        ]
      })

      const load = Effect.fn("Config.load")(function* (sources: ConfigDiscovery.Sources) {
        const direct = yield* Effect.forEach(sources.direct, (filepath) => loadFile(filepath)).pipe(
          Effect.orDie,
          Effect.map((entries) => entries.filter((entry): entry is Document => entry !== undefined)),
        )

        const explicit = sources.explicit
          ? yield* loadFile(sources.explicit).pipe(
              Effect.map((config) => (config ? [config] : [])),
              Effect.orDie,
            )
          : []
        const content =
          options?.content !== undefined
            ? yield* ConfigVariable.substitute({
                type: "virtual",
                source: "OPENCODE_CONFIG_CONTENT",
                dir: location.directory,
                text: options.content,
              }).pipe(
                Effect.flatMap((text) => parseInfo(text, "OPENCODE_CONFIG_CONTENT")),
                Effect.map((info) => (info ? [new Document({ type: "document", info })] : [])),
                Effect.orDie,
              )
            : []

        // Managed settings load last so they override everything, and MDM
        // preferences outrank the system directory as in V1. Policies evaluate
        // in reverse load order, so managed policies split off and load first
        // to keep final file-based authority.
        const managed = [
          ...(sources.system?.present ? yield* loadDirectory(sources.system.path).pipe(Effect.orDie) : []),
          ...(sources.preferences ? yield* loadPreferences(sources.preferences).pipe(Effect.orDie) : []),
        ]
        const managedPolicies = managed
          .flatMap((entry) =>
            entry.type === "document" && entry.info.policies
              ? [
                  new ConfigManaged.Document({
                    type: "document",
                    path: entry.path,
                    info: new Info({ policies: entry.info.policies }),
                  }),
                ]
              : [],
          )
          .toReversed()
        const managedSettings = managed.map((entry) =>
          entry.type === "document"
            ? new ConfigManaged.Document({ ...entry, info: new Info({ ...entry.info, policies: undefined }) })
            : entry,
        )
        // Integration documents load right after managed policies: every remote, user, and project layer overrides
        // their settings, and since policies evaluate earliest-loaded first, only managed policies outrank theirs.
        // Global entries sit below explicit and direct files; project directories rank above them.
        const globalSupplementary = sources.global ? yield* loadDirectory(sources.global).pipe(Effect.orDie) : []
        const projectSupplementary = yield* Effect.forEach(
          sources.project.filter((root) => root.present),
          (root) => loadDirectory(root.path),
        ).pipe(
          Effect.orDie,
          Effect.map((entries) => entries.flat()),
        )
        const lockdown = ManagedPolicy.statements(managedPolicies)
        const integrated = yield* Effect.forEach(integrations.values(), (document) =>
          supplies(lockdown, document.integrationID, document.connection).pipe(
            Effect.map((allowed) =>
              allowed
                ? document
                : new ConfigIntegration.Document({ ...document, info: new Info({ policies: document.info.policies }) }),
            ),
          ),
        )
        const wellknownDocuments = yield* Effect.forEach(yield* loadWellknown().pipe(Effect.orDie), (entry) =>
          supplies(lockdown, entry.integrationID).pipe(
            Effect.map((allowed) =>
              allowed
                ? entry.documents
                : entry.documents.map(
                    (document) =>
                      new ConfigIntegration.WellKnownDocument({
                        ...document,
                        info: new Info({ policies: document.info.policies }),
                      }),
                  ),
            ),
          ),
        )
        return [
          ...managedPolicies,
          ...integrated,
          ...wellknownDocuments.flat(),
          ...globalSupplementary,
          ...explicit,
          ...direct,
          ...projectSupplementary,
          ...content,
          ...managedSettings,
        ]
      })

      const initial = yield* ConfigDiscovery.discover(options)
      // Highest shared committed revision this owner has actually reconciled from disk. Read BEFORE
      // the initial load: a commit landing during that load must not be marked observed, or a later
      // protected read could present bytes it never read.
      let observedCommitted = yield* fallbackIntent.committedRevision()
      let sources = initial
      let configs = yield* load(initial)
      const updates = yield* PubSub.unbounded<Watcher.Update>()
      const reloads = yield* PubSub.sliding<void>(1)
      // Readiness rescans recover writes made before a watch attached.
      const requestReload = PubSub.publish(reloads, undefined).pipe(Effect.asVoid)
      const watched = yield* FiberMap.make<string>()
      const reconcile = Effect.fn("Config.reconcileWatches")(function* (sources: ConfigDiscovery.Sources) {
        const plan = ConfigWatch.plan(sources)
        for (const key of Array.from(watched, ([key]) => key)) {
          if (!plan.has(key)) yield* FiberMap.remove(watched, key)
        }
        for (const [key, target] of plan) {
          yield* watcher
            .subscribe(target, requestReload)
            .pipe(
              Effect.flatMap(
                Stream.runForEach((update) => PubSub.publish(updates, update).pipe(Effect.andThen(requestReload))),
              ),
              FiberMap.run(watched, key, { onlyIfMissing: true, startImmediately: true }),
            )
        }
      })

      // Installs reader state from disk. `false` means the decoded document and compatibility
      // roots are already equal, which is coherent, so nothing is announced.
      const refresh = Effect.fn("Config.refreshReaders")(function* () {
        // Captured before discovery and loading, so the revision this owner can claim to have read
        // is the one that existed when it started reading. A commit racing the disk load keeps the
        // marker behind that commit, and the next protected read reconciles again instead of
        // presenting bytes this owner never read.
        const committedAtStart = yield* fallbackIntent.committedRevision()
        const discovered = yield* ConfigDiscovery.discover(options)
        const next = yield* load(discovered)
        yield* reconcile(discovered)
        const compatibilityChanged =
          !isDeepStrictEqual(sources.claude, discovered.claude) ||
          !isDeepStrictEqual(sources.agents, discovered.agents)
        if (isDeepStrictEqual(configs, next) && !compatibilityChanged) {
          observedCommitted = committedAtStart
          return false
        }
        sources = discovered
        configs = next
        observedCommitted = committedAtStart
        return true
      })

      // Announces a refreshed document. `Event.Updated` is ephemeral, so Bus runs inline
      // listeners without isolating them: a listener that aborts stops live and typed subscribers
      // from seeing the event at all, and a deferred rescan cannot repeat the announcement because
      // `refresh` then short-circuits on an equal document. The failure therefore propagates;
      // boundaries that must name the state observe it with `Effect.exit`.
      const announceUpdate = Effect.fn("Config.announceUpdate")(function* () {
        yield* bus.publish(Event.Updated, {})
      })

      const reload = Effect.fn("Config.reload")(
        function* () {
          if (!(yield* refresh())) return
          // Ordinary reload callers keep the previous contract: an aborted notification
          // propagates instead of being discarded.
          yield* announceUpdate()
        },
        (effect) => reloadLock.withPermit(effect),
      )

      // Subscribe eagerly so synchronous watch readiness isn't dropped.
      const pendingReloads = yield* PubSub.subscribe(reloads)
      yield* Stream.fromSubscription(pendingReloads).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload config", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* bus.subscribe(Credential.Event.Switched).pipe(
        Stream.filterEffect((event) =>
          wellknown.entries().pipe(
            Effect.map((entries) => entries.some((entry) => entry.integrationID === event.data.integrationID)),
            Effect.orElseSucceed(() => false),
          ),
        ),
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown config", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* bus.subscribe(WellKnown.Event.Updated).pipe(
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown sources", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Effect.sleep("10 minutes").pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (!wellknown.snapshot().length) return Effect.void
            return Effect.gen(function* () {
              const changed = yield* wellknown
                .refresh()
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to refresh wellknown manifests", { error }).pipe(Effect.as(false)),
                  ),
                )
              if (!changed) yield* reload()
            }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to refresh wellknown config", { cause })))
          }),
        ),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* reloadLock.withPermit(reconcile(initial))

      // Two distinct faults, kept apart so a committed-state identity is never invented:
      // `pendingCommit` is a durable commit made by this owner that protected readers were not
      // published to, while `readersStale` records that a reconciliation attempt failed, so
      // readers may lag durable disk state without any commit belonging to this call. Either
      // one keeps a protected read from serving a stale document.
      let pendingCommit = false
      let readersStale = false
      // An aborted mandatory announcement whose delivery has not been retried yet. Reader state
      // may already be coherent, but the pending delivery must not be dropped silently.
      let deliveryPending = false

      // A protected read must not silently return a document older than the last durable
      // commit, so it reconciles from disk. If that refresh fails the read fails explicitly
      // with the real cause: the last coherent document stays held internally as pending state
      // and the fault stays armed for a later retry, but it is never presented as a current
      // successful read. A mandatory announcement that aborts is handled the same way: the
      // coherent document stays installed, the actual failure surfaces to this reader, and the
      // delivery stays pending so the next protected read retries it instead of losing it.
      const reconcileReaders = Effect.fn("Config.reconcileReaders")(function* () {
        const reconciled = yield* Effect.exit(
          reloadLock
            .withPermit(
              Effect.gen(function* () {
                // Preserve mandatory notification across multiple physical loads. A refresh can read
                // an older snapshot while another location commits. Do not publish or return a KNOWN
                // stale result.
                let changed = false

                while (true) {
                  changed = (yield* refresh()) || changed

                  // The marker captured by refresh() was taken BEFORE the load. If another location
                  // committed during that load, run another refresh under the existing reloadLock.
                  if (observedCommitted < (yield* fallbackIntent.committedRevision())) continue

                  if (changed || deliveryPending) {
                    deliveryPending = true
                    yield* announceUpdate()
                    deliveryPending = false
                    changed = false
                  }

                  // A newer commit may also arrive while mandatory notification is executing. Check
                  // again before completing this read.
                  if (observedCommitted < (yield* fallbackIntent.committedRevision())) continue

                  pendingCommit = false
                  readersStale = false
                  return configs
                }
              }),
            )
            .pipe(Effect.provide(context)),
        )
        if (Exit.isSuccess(reconciled)) return reconciled.value
        const cause = Exit.getCause(reconciled)
        // The reconciliation is known to have stalled, so the fault stays armed: the next
        // protected read retries it instead of returning the in-memory document unchecked.
        readersStale = true
        yield* Effect.logWarning("configuration readers could not be reconciled", {
          cause: Option.getOrUndefined(cause),
        })
        return yield* Option.match(cause, {
          // Re-raised unchanged, so a defect, typed failure or interruption keeps its own
          // identity and callers see a failed read rather than stale state.
          onSome: (cause) => Effect.failCause(cause),
          onNone: () => Effect.die(new Error("config reader reconciliation failed")),
        })
      })

      // Candidate validation mirrors the reload pipeline for the complete serialized document
      // produced by sparse editing: it must parse as JSONC, normalize without dropping a recognized
      // field, and decode as Info. Diagnostic kinds "unsupported" (legacy fields) and "conflict"
      // (native/legacy precedence) stay tolerated so legacy documents, comments and formatting
      // still commit.
      const validateCandidate = (text: string): string | undefined => {
        const errors: ParseError[] = []
        const input: unknown = parse(text, errors, { allowTrailingComma: true })
        if (errors.length) return "malformed JSON or JSONC document"
        const result = ConfigNormalize.normalize(input)
        if (result.type === "rejected") return "configuration root is not an object"
        const invalid = result.diagnostics.filter((diagnostic) => diagnostic.kind === "invalid")
        if (invalid.length)
          return `invalid recognized field ${invalid.map((diagnostic) => diagnostic.path.join(".")).join(", ")}`
        if (Option.isNone(decodeInfo(result.encoded))) return "canonical configuration failed validation"
        return undefined
      }

      const update = Effect.fn("Config.update")(function* (patch: Patch) {
        const hasFallback = Object.hasOwn(patch, "fallback")
        const fallback = hasFallback
          ? patch.fallback === null
            ? null
            : Schema.decodeUnknownSync(ConfigModel.Selection)(patch.fallback)
          : undefined
        // FR-007: the update-owner entry position is reserved BEFORE validation. Accepted
        // commits serialize in entry order even when validation finishes out of order, and
        // the position retires on every exit path, so invalid or cancelled updates release
        // it without blocking later writers. The former update lock is gone: entry order
        // comes from the reservation boundary below and commit serialization stays with
        // the exclusive admission lease.
        const reservation = yield* fallbackIntent.reserve()
        let staged = false
        // Candidate validation mirrors the reload pipeline for the complete serialized document
        // produced by sparse editing: it must parse as JSONC, normalize without dropping a recognized
        // field, and decode as Info. Diagnostic kinds "unsupported" (legacy fields) and "conflict"
        // (native/legacy precedence) stay tolerated so legacy documents, comments and formatting
        // still commit. It runs pre-admission (this gates intent staging) and again at the
        // commit boundary (this applies and compares the sparse patch against the latest
        // committed document), so a stale validation never authorizes a stale write.
        const editAndValidate = Effect.fnUntraced(function* () {
          const directory = initial.global ?? AbsolutePath.make(globalService.config)
          const candidates = ConfigDiscovery.names.map((name) => path.join(directory, name))
          const filepath =
            (yield* Effect.filter(candidates, fs.isFile)).at(-1) ?? path.join(directory, "opencode.jsonc")
          const text = (yield* fs.readFileStringSafe(filepath)) ?? "{}\n"
          const formattingOptions = { formattingOptions: { tabSize: 2, insertSpaces: true } } as const
          const updated = yield* Effect.try({
            try: () => {
              const shellUpdated = Object.hasOwn(patch, "shell")
                ? applyEdits(text, modify(text, ["shell"], patch.shell ?? undefined, formattingOptions))
                : text
              const candidate = hasFallback
                ? applyEdits(shellUpdated, modify(shellUpdated, ["fallback"], fallback, formattingOptions))
                : shellUpdated
              return candidate.endsWith("\n") ? candidate : `${candidate}\n`
            },
            catch: (cause) => new FSUtil.FileSystemError({ method: "config.update", cause }),
          })
          // Sparse edits must not smuggle a broken document past the pipeline: the complete
          // candidate is validated before anything is staged or written, so a rejected
          // candidate is an ordinary precommit failure with the old bytes intact.
          const reason = validateCandidate(updated)
          if (reason !== undefined) {
            yield* Effect.logWarning("rejected configuration update", { source: filepath, reason })
            return yield* Effect.fail(new CandidateRejectedError({ file: filepath, reason }))
          }
          return { directory, filepath, text, updated }
        })
        return yield* Effect.gen(function* () {
          if (hasFallback) {
            // FR-006: staging follows validation and precedes admission. A validation failure
            // publishes no intent and keeps the old document; its reserved position still
            // retires on exit, so a later writer progresses.
            const validated = yield* Effect.exit(editAndValidate())
            if (Exit.isSuccess(validated))
              staged = yield* fallbackIntent.stageValidated(reservation, fallback ?? null)
            else
              return yield* Option.match(Exit.getCause(validated), {
                // The actual precommit failure keeps its own identity: typed rejection,
                // filesystem error or interruption. Nothing was staged, written or announced.
                onSome: (cause) => Effect.failCause(cause),
                onNone: () => Effect.die(new Error("configuration update validation failed")),
              })
          }
          // FR-007: the commit boundary waits for every earlier entry position to retire
          // (commit, fail, or cancel), so accepted durable commits occur in entry order even
          // though a newer intent staged first. Shell-only patches never stage and never clear.
          yield* fallbackIntent.awaitPredecessors(reservation)
          const persist = admission.acquireExclusive.pipe(
            Effect.flatMap((lease) =>
              Effect.gen(function* () {
                const fsError = (cause: unknown) => new FSUtil.FileSystemError({ method: "config.update", cause })
                // The patch is (re)applied at this writer's own serialized commit boundary,
                // against the latest committed document, preserving validation-before-write.
                const { directory, filepath, text, updated } = yield* editAndValidate()
                // Publication is required before the lease releases: readers admitted after
                // this writer must observe the committed document, so the refresh is synchronous
                // and the rescan below stays advisory. `load` converts filesystem errors into
                // defects, so the step is observed as an Exit: any refresh failure means a
                // durable document that protected readers cannot see yet.
                // `committedByThisCall` says whether the durable document can be attributed to
                // this writer: the rename path always can, a byte-equal PATCH only when a
                // previous commit by this owner is still unpublished. Without attribution the
                // real failure is surfaced instead of a committed-state identity.
                const publishReaders = Effect.fnUntraced(function* (committedByThisCall: boolean) {
                  // Distinguishes an aborted announcement from a failed refresh: both surface
                  // inside one Exit, and only the first has already installed coherent readers.
                  let announced = false
                  const publication = yield* Effect.exit(
                    reloadLock
                      .withPermit(
                        Effect.gen(function* () {
                          const installed = yield* refresh()
                          pendingCommit = false
                          if (installed || deliveryPending) {
                            announced = true
                            yield* announceUpdate()
                            deliveryPending = false
                          }
                        }),
                      )
                      .pipe(Effect.provide(context)),
                  )
                  if (Exit.isSuccess(publication)) return
                  const cause = Exit.getCause(publication)
                  // A captured interruption stays an interruption rather than becoming an
                  // outcome, so the captured cause is re-raised unchanged.
                  if (Option.isSome(cause) && Cause.hasInterrupts(cause.value))
                    return yield* Effect.failCause(cause.value)
                  if (announced && committedByThisCall) {
                    // An attributable commit is durable and its readers are coherent; only the
                    // mandatory cross-owner announcement is incomplete. Core cannot repeat an
                    // ephemeral event for this writer, so the boundary names that state.
                    yield* Effect.logWarning("configuration update notification did not complete", {
                      cause: Option.getOrUndefined(cause),
                    })
                    return yield* Effect.fail(
                      new CommittedWithPostPublicationFailureError({
                        file: filepath,
                        cause: Option.getOrUndefined(cause),
                      }),
                    )
                  }
                  if (announced) {
                    // Nothing here committed: the announcement was still mandatory and its
                    // delivery is incomplete, so the delivery is left pending for the reader
                    // reconciliation mechanism to retry and the actual notification failure is
                    // propagated. No committed-state identity belongs to this call, and
                    // incomplete mandatory delivery is never reported as success.
                    deliveryPending = true
                    yield* Effect.logWarning("configuration update notification did not complete", {
                      source: filepath,
                      committed: false,
                      cause: Option.getOrUndefined(cause),
                    })
                    return yield* Option.match(cause, {
                      onSome: (cause) => Effect.failCause(cause),
                      onNone: () => Effect.die(new Error("configuration announcement failed")),
                    })
                  }
                  if (committedByThisCall) pendingCommit = true
                  else if (Option.isSome(cause)) readersStale = true
                  if (!pendingCommit) {
                    // No commit can be attributed to this call, so no committed-state identity
                    // is claimed: the reconciliation failure that actually happened is reported,
                    // and success is not available while protected readers remain stale.
                    yield* Effect.logWarning("configuration update could not be reconciled", {
                      source: filepath,
                      cause: Option.getOrUndefined(cause),
                    })
                    return yield* Option.match(cause, {
                      onSome: (cause) => Effect.failCause(cause),
                      onNone: () => Effect.die(new Error("configuration reconciliation failed")),
                    })
                  }
                  yield* Effect.logWarning("configuration could not be published to protected readers", {
                    source: filepath,
                    cause: Option.getOrUndefined(cause),
                  })
                  return yield* Effect.fail(
                    new CommittedButUnpublishedError({
                      file: filepath,
                      cause: Option.getOrUndefined(cause),
                    }),
                  )
                })
                // Equal bytes mean this request changes nothing on disk: no temporary file, no
                // rename, and no announcement when readers already match. Coherence is still
                // required, so a matching PATCH is only a success once the committed document is
                // visible to protected readers. Retrying an unpublished commit keeps the committed
                // identity; a matching PATCH that follows an unrelated external edit reports the
                // reconciliation or announcement failure itself with no committed-state identity, and
                // neither case reports success while protected readers remain stale or a mandatory
                // announcement is incomplete.
                if (updated === text) return yield* publishReaders(pendingCommit)
                const temp = path.join(directory, `.${path.basename(filepath)}.${randomUUID()}.tmp`)
                let committed = false
                // Temporary cleanup always runs. After a successful rename nothing is stranded,
                // so a failed removal is only a diagnostic; before the rename the flag records
                // that a temp file may remain while the precommit failure stands.
                const cleanup = () =>
                  fs.remove(temp, { force: true }).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("failed to clean temporary config file", {
                        source: temp,
                        committed,
                        cause,
                      }),
                    ),
                  )
                // From the first write through publication nothing is interruptible: a writer
                // cancelled across the commit publishes forward and cleans up instead of stranding
                // a renamed document unpublished.
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* fs.ensureDir(directory).pipe(Effect.mapError(fsError))
                    // The temporary file replaces the target, so carry its mode when one exists.
                    const info = yield* fs.stat(filepath).pipe(
                      Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.undefined),
                      Effect.mapError(fsError),
                    )
                    yield* fs.writeFileString(temp, updated).pipe(Effect.mapError(fsError))
                    if (info) yield* fs.chmod(temp, info.mode).pipe(Effect.mapError(fsError))
                    // The rename is the commit boundary: until it succeeds the previous bytes
                    // stay readable, and every failure at or above it stays a precommit failure.
                    yield* fs.rename(temp, filepath).pipe(Effect.mapError(fsError))
                    committed = true
                    // The durable replacement is now visible on disk, so the shared owner records
                    // this revision as committed BEFORE any publication step runs. A later failure
                    // in publication must not let another location's protected read conclude that
                    // the previous document is still current, and neither a reservation nor a rejected
                    // candidate ever reaches this line.
                    yield* fallbackIntent.recordCommit(reservation)
                    yield* publishReaders(true)
                    // Advisory only: protected readers were refreshed above, so this rescan
                    // cannot change the outcome and has no failure channel to classify.
                    yield* requestReload
                  }).pipe(Effect.ensuring(cleanup())),
                )
              }).pipe(Effect.ensuring(lease.release)),
            ),
          )
          return yield* persist
        }).pipe(
          // Cleanup wraps the entire flow, so every exit path — a validation failure before
          // admission, an interruption at the entry-order boundary or the exclusive lease, or
          // success — retires this owner's entry position for later writers, and only drops
          // the staged intent when this revision is still the current one. Shell-only patches
          // never stage and never clear.
          Effect.onExit(() =>
            (staged ? fallbackIntent.clearIfCurrent(reservation) : Effect.void).pipe(
              Effect.andThen(fallbackIntent.retire(reservation)),
            ),
          ),
        )
      })

      return Service.of({
        entries: Effect.fnUntraced(function* () {
          // A protected read only returns the in-memory document while nothing is pending locally
          // AND this owner has already reconciled the latest durable replacement recorded by any
          // location in this application build. A commit by another location advances the shared
          // revision immediately after its rename, so a local owner with a lagging marker reloads
          // from disk instead of serving its older cached document. If that reload fails the read
          // fails explicitly and the marker stays behind, so the next read retries it.
          const committed = yield* fallbackIntent.committedRevision()

          if (
            !pendingCommit &&
            !readersStale &&
            !deliveryPending &&
            observedCommitted >= committed
          ) {
            return configs
          }

          return yield* reconcileReaders()
        }),
        compatibility: () =>
          Effect.all({
            claude: Effect.filter(sources.claude, fs.isDir),
            agents: Effect.filter(sources.agents, fs.isDir),
          }),
        changes: () => Stream.fromPubSub(updates),
        update,
        integration: Effect.fn("Config.integration")(function* (integrationID, document) {
          if (isDeepStrictEqual(integrations.get(integrationID), document)) return
          integrations.delete(integrationID)
          if (document) integrations.set(integrationID, document)
          yield* reload().pipe(
            Effect.provide(context),
            Effect.catchCause((cause) => Effect.logError("failed to reload config", { cause })),
          )
        }),
      })
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      Watcher.node,
      Bus.node,
      FSUtil.node,
      Global.node,
      Location.node,
      Credential.node,
      WellKnown.node,
      AppProcess.node,
      SessionGenerationAdmission.node,
      FallbackRuntimeIntent.node,
    ],
  })
}

export const node = configured()
