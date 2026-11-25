import { expect, test } from "bun:test"

import { Config } from "@opencode/schema/config"

import { createMockServerHandler, type MockServerConfig } from "./mock-server"

const directory = "/selection-demo"

const patchedPath = `${directory}/.opencode/config.patch.jsonc`

// What the config documents in these cases name. The mock answers `GET /api/config` with these documents verbatim,
// and the app's `Config.Document` decoder reads the same fields.
type ServedInfo = {
  model?: string
  shell?: string | null
  fallback?: Config.Patch["fallback"]
}

type ServedDocument = { type: "document"; path?: string; info?: ServedInfo }

// The smallest scenario a config case needs: no sessions, one global document the app reads back.
const scenario: MockServerConfig = {
  provider: {},
  directory,
  project: { id: "project", directory },
  sessions: [],
  pageMessages: () => ({ items: [] }),
}

// A handler is one server's state, so every case opens its own: `handle.config` is where a scenario arms a rejection.
function openMock(
  configEntries: Array<ServedDocument> = [{ type: "document", info: { model: "provider/a" } }],
) {
  const handle = createMockServerHandler({ ...scenario, configEntries })

  const request = async (method: "GET" | "PATCH", path: string, body?: Config.Patch) => {
    const response = await handle.handler(
      new Request(`http://mock.invalid${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )

    return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
  }

  return {
    handle,
    // What `GET /api/config` answers, which is what a reload refetches and what the fallback owner reads.
    async served() {
      const { body } = await request("GET", "/api/config")

      // SAFETY: the mock serves the documents this test seeded plus the one it patched, in the shape above.
      return body as ServedDocument[]
    },
    patch: (body: Config.Patch) => request("PATCH", "/api/experimental/config", body),
  }
}

// The read rule `loadGlobalConfigQuery` applies: later documents win, and precedence compares against `undefined`,
// so a saved `null` disables fallback instead of exposing an older document's model.
const resolvedFallback = (documents: Array<ServedDocument>) =>
  documents
    .filter((document) => document.type === "document")
    .findLast((document) => document.info?.fallback !== undefined)?.info?.fallback

test("a saved fallback round-trips through the config the mock later serves", async () => {
  const mock = openMock()

  expect(await mock.served()).toEqual([{ type: "document", info: { model: "provider/a" } }])

  const written = { providerID: "provider", model: "b", variant: "high" }
  expect((await mock.patch({ fallback: written })).status).toBe(204)

  // A refetch answers the written fallback, so a reload sees what the app wrote rather than the seeded document.
  expect(await mock.served()).toEqual([
    { type: "document", info: { model: "provider/a" } },
    { type: "document", path: patchedPath, info: { fallback: written } },
  ])
  expect(resolvedFallback(await mock.served())).toEqual(written)

  // A second write replaces the recorded fallback instead of appending a second document.
  const replaced = { providerID: "provider", model: "c" }
  expect((await mock.patch({ fallback: replaced })).status).toBe(204)
  expect(await mock.served()).toEqual([
    { type: "document", info: { model: "provider/a" } },
    { type: "document", path: patchedPath, info: { fallback: replaced } },
  ])
  expect(resolvedFallback(await mock.served())).toEqual(replaced)
})

test("an explicit no-fallback patch round-trips as null, not as an absent field", async () => {
  const mock = openMock([{ type: "document", info: { fallback: { providerID: "provider", model: "a" } } }])

  expect(resolvedFallback(await mock.served())).toEqual({ providerID: "provider", model: "a" })
  expect((await mock.patch({ fallback: null })).status).toBe(204)

  const documents = await mock.served()
  const last = documents.at(-1)

  // The difference between a saved "None" and a field never chosen: the key is present and holds null.
  expect(documents).toEqual([
    { type: "document", info: { fallback: { providerID: "provider", model: "a" } } },
    { type: "document", path: patchedPath, info: { fallback: null } },
  ])
  expect(Object.hasOwn(last?.info ?? {}, "fallback")).toBe(true)
  expect(last?.info?.fallback).toBe(null)

  // "None" also outranks the older document that named a fallback: the app reads `null`, not that model.
  expect(resolvedFallback(documents)).toBe(null)
})

test("an armed rejection answers once and leaves the recorded fallback unchanged", async () => {
  const mock = openMock()

  expect((await mock.patch({ fallback: { providerID: "provider", model: "b" } })).status).toBe(204)

  // One armed rejection, the way one exchange half can fail while the other half landed.
  mock.handle.config.failWrites = 1
  const rejected = await mock.patch({ fallback: { providerID: "provider", model: "c" } })

  expect(rejected.status).toBe(500)

  // The rejected write changed nothing the app can read back: still the fallback from the write before it.
  expect(await mock.served()).toEqual([
    { type: "document", info: { model: "provider/a" } },
    { type: "document", path: patchedPath, info: { fallback: { providerID: "provider", model: "b" } } },
  ])
  expect(resolvedFallback(await mock.served())).toEqual({ providerID: "provider", model: "b" })

  // The rejection was one-shot, so the next patch applies and merges into that document rather than replacing it.
  expect((await mock.patch({ shell: "bash", fallback: { providerID: "provider", model: "c", variant: "low" } })).status).toBe(204)
  expect(resolvedFallback(await mock.served())).toEqual({ providerID: "provider", model: "c", variant: "low" })
  expect((await mock.served()).at(-1)?.info).toEqual({
    fallback: { providerID: "provider", model: "c", variant: "low" },
    shell: "bash",
  })

  // A shell-only patch cannot fabricate or clear the recorded fallback.
  expect((await mock.patch({ shell: "zsh" })).status).toBe(204)
  expect((await mock.served()).at(-1)?.info).toEqual({
    fallback: { providerID: "provider", model: "c", variant: "low" },
    shell: "zsh",
  })
})
