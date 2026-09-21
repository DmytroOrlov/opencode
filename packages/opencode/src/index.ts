import { assertTlsCaVerified } from "./tls-ca-mode"

assertTlsCaVerified()
const { runMain } = await import("./main")
await runMain()
