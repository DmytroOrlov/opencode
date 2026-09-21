import { appendFileSync } from "node:fs"

const marker = process.env.TLS_CA_PRELOAD_MARKER
if (marker) appendFileSync(marker, `${process.pid}\n`)
;(globalThis as { __tlsCaHostilePreload?: number }).__tlsCaHostilePreload = process.pid
