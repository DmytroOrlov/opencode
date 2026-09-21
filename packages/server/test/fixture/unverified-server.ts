import { Effect } from "effect"
import { ServerProcess } from "../../src/process"
import type { ServerOptions } from "../../src/options"

try {
  await Effect.runPromise(
    Effect.scoped(
      ServerProcess.start({
        hostname: "127.0.0.1",
        port: 0,
        password: "secret",
        tlsCaMode: "system",
      } as ServerOptions),
    ),
  )
  process.exit(1)
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error))
}
