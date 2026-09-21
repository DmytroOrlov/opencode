const { appendFileSync } = require("node:fs")

const marker = process.env.TLS_CA_PRELOAD_MARKER
if (marker) appendFileSync(marker, `${process.pid}\n`)
globalThis.__tlsCaHostilePreload = process.pid
