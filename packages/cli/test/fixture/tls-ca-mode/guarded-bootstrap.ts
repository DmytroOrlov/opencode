import { runTlsCaBootstrap } from "../../../src/bootstrap"

await runTlsCaBootstrap(async () => {
  await import("./guarded-callback")
})
