import { appendFileSync } from "node:fs"

const marker = process.env.TLS_CA_GUARD_MARKER
if (marker) appendFileSync(marker, "guarded callback executed\n")
console.log("GUARDED CALLBACK EXECUTED")
