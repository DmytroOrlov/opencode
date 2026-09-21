import { Effect } from "effect"
import { Service } from "@opencode/client/effect/service"
import { verifyTlsCaMode } from "@opencode/util/tls-ca"
import path from "node:path"
import { Standalone } from "../../src/services/standalone"

process.chdir(path.join(import.meta.dir, "../../../.."))
verifyTlsCaMode("bundled")

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const endpoint = yield* Standalone.start({
        command: [process.execPath, path.join(import.meta.dir, "../../src/index.ts"), "serve"],
      })
      const response = yield* Effect.promise(() =>
        fetch(new URL("/api/info", endpoint.url), { headers: Service.headers(endpoint) }),
      )
      const info = (yield* Effect.promise(() => response.json())) as { tlsCaMode?: string }
      console.log(`STANDALONE_READY ${endpoint.pid} ${endpoint.url} ${response.status} ${info.tlsCaMode}`)
      return yield* Effect.never
    }),
  ),
)
