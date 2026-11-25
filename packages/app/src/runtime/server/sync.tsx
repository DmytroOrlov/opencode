import type { Project } from "@/runtime/server/types"
import { getOwner, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { type ServerSDK } from "./client"
import {
  bootstrapGlobal,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjects,
  loadProjectsQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import type { GlobalStore, ProjectMeta } from "./global-sync/types"
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { normalizeProjectInfo, updateProjectInfo } from "./global-sync/utils"
import { persisted } from "@/runtime/persistence/storage"
import { createConnectionSync } from "./server-sync/connection"
import type { ConfigUpdateInput } from "@opencode/client/promise"
import { ConfigConfirmationFailure } from "./config-outcome"
import type { Data } from "@opencode/client/solid"
import { createWorktreeInventory, withWorktreeInventory, worktreeInventoryViewKey } from "@/workspaces/inventory"

function createServerSyncContextInner(serverSDK: ServerSDK, data: Data) {
  const language = useLanguage()
  const owner = getOwner()

  if (!owner) throw new Error("ServerSync must be created within owner")

  const connected = () => serverSDK.connection.status() === "connected"

  // Each of these is its own `useQuery`, like `bootstrap` and `projectsQuery` below. `useQueries` hands its option
  // objects to one `QueriesObserver` at creation and re-reads them only when the array's length changes, so an
  // `enabled` that flips from false to true later — which is exactly what a page whose sync context is created
  // before the connection resolves goes through — never re-enables either reader, and `config` below would stay
  // empty forever. One `useQuery` per key re-evaluates its own options, and keeps each reader's own pending state
  // instead of a combined result, which is what `path` and `config` read.
  const configQuery = useQuery(() => ({
    ...loadGlobalConfigQuery(serverSDK.scope, serverSDK.api.config),
    enabled: connected(),
  }))

  const pathQuery = useQuery(() => ({
    ...loadPathQuery(serverSDK.scope, null, serverSDK.api.location),
    enabled: connected(),
  }))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    project: [],
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }

      if (pathQuery.isPending) return EMPTY

      return pathQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isPending) return {}

      return configQuery.data ?? {}
    },
  })

  const queryClient = useQueryClient()

  const worktrees = createWorktreeInventory({
    scope: serverSDK.scope,
    queryClient,
    api: () => serverSDK.api.worktree,
    updated: (projectID, items) => {
      setGlobalStore("project", (projects) =>
        projects.map((project) => (project.id === projectID ? withWorktreeInventory(project, items) : project)),
      )

      for (const key of [
        worktreeInventoryViewKey(serverSDK.scope, projectID),
        worktreeInventoryViewKey(serverSDK.scope),
      ]) {
        queryClient.setQueryData<Project[]>(key, (projects) =>
          projects?.map((project) => (project.id === projectID ? withWorktreeInventory(project, items) : project)),
        )
      }
    },
  })

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverAPI: serverSDK.api,
        scope: serverSDK.scope,
        setGlobalStore,
        queryClient,
      })

      return Date.now()
    },
    enabled: connected(),
  }))

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    translate: language.t,
    data,
    global: {
      get path() {
        return globalStore.path
      },
    },
  })

  const connection = createConnectionSync({
    status: serverSDK.connection.status,
    invalidate: () => {
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope,
        refetchType: "none",
      })
    },
    // The first `connected` status enables the bootstrap query, which loads on its own. Once an earlier stream
    // reported `connected`, a fetch it started may still be running and may have read nothing, so going live replaces
    // it rather than joining it.
    connected: (info) => {
      if (info.restart) void bootstrap.refetch({ cancelRefetch: true })
    },
  })

  // Mirrors the server's list: unarchived projects, most recently active first. Unknown projects join the list and
  // archived ones leave it.
  function applyProjectUpdate(update: Parameters<typeof updateProjectInfo>[1]) {
    setGlobalStore("project", (projects) => {
      const rest = projects.filter((project) => project.id !== update.id)

      if (update.time.archived) return rest

      const previous = projects.find((project) => project.id === update.id)

      // The wire payload carries no worktrees; keep the inventory this project already loaded.
      const next = withWorktreeInventory(
        previous ? updateProjectInfo(previous, update) : normalizeProjectInfo(update),
        worktrees.cached(update.id),
      )

      return [...rest, next].toSorted(
        (a, b) => b.time.active - a.time.active || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
    })
  }

  // Observes the list the bootstrap loads without fetching it again, so readers can tell "no projects" from "not loaded".
  const projectsQuery = useQuery(() => ({
    ...loadProjectsQuery(serverSDK.scope, serverSDK.api.project),
    enabled: false,
  }))

  const refreshProjects = () =>
    loadProjects({ scope: serverSDK.scope, project: serverSDK.api.project, setGlobalStore, queryClient })

  const unsub = serverSDK.event.listen((event) => {
    connection.handleEvent({ type: event.type })

    if (event.type === "project.updated") applyProjectUpdate(event.data)

    if (event.type === "worktree.updated") {
      void worktrees.list(event.data.projectID)
      void bootstrap.refetch()

      return
    }

    if (!event.location && (event.type === "config.updated" || event.type === "agent.updated")) bootstrap.refetch()
  })

  onCleanup(unsub)

  const projectApi = {
    update: applyProjectUpdate,
    ready: () => projectsQuery.isSuccess,
    refresh: refreshProjects,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: async (config: ConfigUpdateInput) => serverSDK.api.config.update(config),
    // Awaiting the refetch matters: it re-reads the server's config through the bootstrap before this mutation resolves,
    // which is when the fallback UI drops its optimistic override, so the reader never falls back to a stale value.
    // The bootstrap tolerates a failed individual GET, so the config read is awaited on its own: a successful PATCH
    // whose confirming GET fails rejects updateConfig() rather than reporting a confirmation the client never saw.
    // That is a confirmation failure, not evidence the server rolled the PATCH back, so it keeps its own identity: a
    // caller must reconcile from the source instead of restoring the value written over.
    onSuccess: async () => {
      try {
        await Promise.all([
          bootstrap.refetch(),
          queryClient.fetchQuery(loadGlobalConfigQuery(serverSDK.scope, serverSDK.api.config)),
        ])
      } catch (cause) {
        throw new ConfigConfirmationFailure(cause)
      }

      data.location.provider.invalidate()
      data.location.model.invalidate()
      void Promise.all([data.location.provider.sync(), data.location.model.sync()])
    },
    onError: () => queryClient.invalidateQueries({ queryKey: [serverSDK.scope, "config"] }),
  }))

  return {
    data: globalStore,
    set: setGlobalStore,
    child: children.child,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    // Re-reads the document through the query that feeds `data.config`. A caller whose write is durable, or whose only
    // unknown is the confirmation, reconciles from the source through this instead of asserting the pre-write value.
    refreshConfig: async () => {
      const result = await configQuery.refetch()

      // A query refetch may resolve with an error result instead of
      // rejecting its Promise. Both forms are failed reconciliation,
      // not successful confirmation of the committed document.
      if (!result.isSuccess) {
        throw result.error ?? new Error("Configuration reconciliation did not succeed")
      }
    },
    project: projectApi,
    worktrees,
  }
}

export function createServerSyncContext(serverSDK: ServerSDK, data: Data) {
  return createServerSyncContextInner(serverSDK, data)
}

export type ServerSync = ReturnType<typeof createServerSyncContext>
