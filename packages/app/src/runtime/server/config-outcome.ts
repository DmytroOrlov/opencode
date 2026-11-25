/**
 * What one `PATCH /api/experimental/config` outcome actually says about the document on disk.
 *
 * The server answers 500 for both an ordinary precommit rejection and a failure that happened AFTER a durable commit.
 * Only the second kind carries a code (`_tag: "UnknownError"` plus `code`), and the code comes from the core writer's
 * real commit and publication state, never from the HTTP status. A caller that rolled back or re-wrote on any 500 would
 * be asserting a durable commit the server already made.
 */
import { isUnknownError } from "@opencode/client/promise"
import type { UnknownError } from "@opencode/client/promise"

/**
 * The committed-state codes, read off the generated contract rather than restated here.
 *
 * The tuple pins the list below to that union in both directions: a code added to the wire breaks the annotation here
 * rather than silently reading as an ordinary failure, and a name that no longer exists on the wire is a type error.
 */
export type ConfigCommittedCode = NonNullable<UnknownError["code"]>

const COMMITTED_CODES: readonly [ConfigCommittedCode, ConfigCommittedCode] = [
  "CONFIG_COMMITTED_BUT_UNPUBLISHED",
  "CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE",
]

/**
 * The structural code, when this failure says a durable commit was made for this request.
 *
 * `undefined` means no commit can be attributed to the request: an ordinary precommit rejection, a filesystem fault
 * before the rename, or a defect. Reading the generated error's `code` (never `message` or the status) is what keeps
 * the two apart once the wire has flattened both into one tag. A `code` outside the two literals names no committed
 * state the client knows, so it reads as no code at all rather than as a guess.
 */
export const committedConfigCode = (cause: unknown): ConfigCommittedCode | undefined => {
  if (!isUnknownError(cause)) return undefined

  return COMMITTED_CODES.find((code) => code === cause.code)
}

/**
 * A PATCH that landed whose confirming re-read failed.
 *
 * `sync.updateConfig` awaits the re-read before it resolves, so a rejection here is a confirmation gap: the write
 * succeeded and only what the client got back is unknown. The identity is what stops a caller from treating a
 * successful write as a precommit rejection.
 */
export class ConfigConfirmationFailure extends Error {
  readonly _tag = "ConfigConfirmationFailure"

  constructor(readonly cause: unknown) {
    super()
  }
}

/** Whether a rejection is only a missing confirmation, so nothing may be written back on top of it. */
export const isConfigConfirmationFailure = (cause: unknown): cause is ConfigConfirmationFailure =>
  cause instanceof ConfigConfirmationFailure

/**
 * Whether a write must be answered by reading the source again instead of restoring what was there before it.
 *
 * Both identities say the same thing about disk state: this request's value is durable, or at least not known to be
 * absent, so the pre-write value is not the authority. Every other failure keeps the existing rollback behaviour.
 */
export const configNeedsReconciliation = (cause: unknown): boolean =>
  committedConfigCode(cause) !== undefined || isConfigConfirmationFailure(cause)
