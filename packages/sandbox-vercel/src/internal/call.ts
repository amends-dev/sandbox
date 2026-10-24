/** Maps the Vercel SDK boundary to sandbox and Effect platform errors. */

import { SandboxError } from "@amends-dev/sandbox"
import { APIError } from "@vercel/sandbox"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"

export const providerId = "vercel"
export const sandboxError = (reason: SandboxError.SandboxErrorReason, cause?: unknown) =>
  new SandboxError.SandboxError({ provider: providerId, reason, cause })
export const call = <A>(request: () => Promise<A>) => Effect.tryPromise({ try: request, catch: fromVercelError })
export const fromVercelError = (error: unknown) => sandboxError(reasonOf(error), error)

const reasonOf = (error: unknown): SandboxError.SandboxErrorReason => {
  const description = error instanceof Error ? error.message : String(error)
  if (error instanceof APIError) {
    const status = error.response.status
    if (status === 401 || status === 403) return new SandboxError.AuthenticationError({ description })
    if (status === 404) return new SandboxError.NotFoundError({ description })
    if (status === 409) return new SandboxError.AlreadyExistsError({ description })
    if (status === 400 || status === 422) return new SandboxError.InvalidOptionsError({ description })
    if (status === 429 || status >= 500) return new SandboxError.UnavailableError({ description })
  }
  return new SandboxError.UnknownError({ description })
}

const errorCode = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) })
export const isEndedSession = (error: unknown): boolean =>
  error instanceof APIError &&
  (error.response.status === 404 ||
    error.response.status === 410 ||
    (Schema.is(errorCode)(error.json) &&
      ["sandbox_stopped", "sandbox_not_running", "sandbox_stopping", "sandbox_snapshotting"].includes(
        error.json.error.code
      )))

export const callPlatform = <A>(
  module: "FileSystem" | "ChildProcess",
  method: string,
  request: () => Promise<A>,
  path?: string
) => Effect.tryPromise({ try: request, catch: (error) => toPlatformError(module, method, error, path) })

export const toPlatformError = (module: "FileSystem" | "ChildProcess", method: string, error: unknown, path?: string) =>
  PlatformError.systemError({
    _tag: systemErrorTagOf(error),
    module,
    method,
    pathOrDescriptor: path,
    description: error instanceof Error ? error.message : String(error),
    cause: error
  })

export const systemErrorTagOf = (error: unknown): PlatformError.SystemErrorTag => {
  if (error instanceof APIError) {
    if (error.response.status === 404) return "NotFound"
    if (error.response.status === 401 || error.response.status === 403) return "PermissionDenied"
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/no such file or directory|file not found/i.test(message)) return "NotFound"
  if (/file exists|already exists/i.test(message)) return "AlreadyExists"
  if (/permission denied|operation not permitted/i.test(message)) return "PermissionDenied"
  if (/not a directory|is a directory|too many levels of symbolic links/i.test(message)) return "BadResource"
  if (/resource busy/i.test(message)) return "Busy"
  return "Unknown"
}
