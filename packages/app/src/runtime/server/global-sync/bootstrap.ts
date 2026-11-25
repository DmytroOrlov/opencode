import type { Config, Path } from "@/runtime/server/types"
import type { ConfigGetOutput, LocationGetInput, LocationGetOutput, ProjectListOutput } from "@opencode/client/promise"
import { retry } from "@opencode/util/retry"
import type { SetStoreFunction } from "solid-js/store"
import type { GlobalStore } from "./types"
import { normalizeProjectInfo } from "./utils"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import type { ServerScope } from "@/runtime/server/scope"
import { withWorktreeInventory, worktreeInventoryKey } from "@/workspaces/inventory"

export const loadGlobalConfigQuery = (
  scope: ServerScope,
  api: { readonly get: () => Promise<ConfigGetOutput> },
) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: async (): Promise<Config> => {
      const entries = await api.get()
      const documents = entries.filter((entry) => entry.type === "document")

      // Later documents win, and a document that disables fallback says so with `null`, so precedence compares against
      // `undefined`; a truthiness check would drop that and read a stale model instead.
      return {
        fallback: documents.findLast((entry) => entry.info.fallback !== undefined)?.info.fallback,
        share: documents.findLast((entry) => entry.info.share !== undefined)?.info.share,
      }
    },
  })

type ProjectApi = {
  readonly list: () => Promise<ProjectListOutput>
}

type LocationApi = { readonly get: (input?: LocationGetInput) => Promise<LocationGetOutput> }

// Metadata only, in the server's order (most recently active first). Worktree inventories load per project when a
// view shows it (see workspaces/inventory).
export const loadProjectsQuery = (scope: ServerScope, projects: ProjectApi) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      retry(() =>
        projects
          .list()
          .then((items) => items.flatMap((project) => (project?.id ? [normalizeProjectInfo(project)] : []))),
      ),
  })

export function loadProjects(input: {
  scope: ServerScope
  project: ProjectApi
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  return input.queryClient.fetchQuery(loadProjectsQuery(input.scope, input.project)).then((data) =>
    input.setGlobalStore(
      "project",
      data.map((project) =>
        withWorktreeInventory(project, input.queryClient.getQueryData(worktreeInventoryKey(input.scope, project.id))),
      ),
    ),
  )
}

export async function bootstrapGlobal(input: {
  serverAPI: {
    readonly location: LocationApi
    readonly project: ProjectApi
    readonly config: { readonly get: () => Promise<ConfigGetOutput> }
  }
  scope: ServerScope
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  await Promise.allSettled([
    input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.serverAPI.config)),
    input.queryClient
      .fetchQuery(loadPathQuery(input.scope, null, input.serverAPI.location))
      .then((data) => input.setGlobalStore("path", data)),
    loadProjects({
      scope: input.scope,
      project: input.serverAPI.project,
      setGlobalStore: input.setGlobalStore,
      queryClient: input.queryClient,
    }),
  ])
}

export function inferHomeDirectory(path: string) {
  const normalized = path.replaceAll("\\", "/")
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/.exec(normalized)

  if (!match) return ""

  return path.includes("\\") ? match[1]!.replaceAll("/", "\\") : match[1]!
}

export const loadPathQuery = (scope: ServerScope, directory: string | null, api: LocationApi) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: () =>
      api.get(directory ? { location: { directory } } : undefined).then((location) => ({
        state: "",
        config: "",
        worktree: location.project.directory,
        directory: location.directory,
        home: inferHomeDirectory(location.directory) || inferHomeDirectory(location.project.directory),
      })),
  })
