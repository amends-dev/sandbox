/**
 * Calls to Daytona's SDK, and the errors their failures amount to: a sandbox error for the
 * provider's operations, and a platform error for a sandbox's files and processes, as Effect's
 * own file systems and process spawners fail.
 */

import { SandboxError } from "@amends-dev/sandbox"
import {
  DaytonaAuthenticationError,
  DaytonaBadGatewayError,
  DaytonaConnectionError,
  DaytonaForbiddenError,
  DaytonaInternalServerError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
  DaytonaTimeoutError
} from "@daytona/sdk"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"

/** The provider's id, which its errors and its entry of `providerOptions` carry. */
export const providerId = "daytona"

/** Calls Daytona, failing with the sandbox error its failure amounts to. */
export const call = <A>(request: () => Promise<A>) => Effect.tryPromise({ try: request, catch: fromDaytonaError })

export const sandboxError = (reason: SandboxError.SandboxErrorReason, cause?: unknown) =>
  new SandboxError.SandboxError({ provider: providerId, reason, cause })

export const fromDaytonaError = (error: unknown) => sandboxError(reasonOf(error), error)

/** The sandbox error reason a failure of Daytona's SDK amounts to. */
const reasonOf = (error: unknown): SandboxError.SandboxErrorReason => {
  const description = error instanceof Error ? error.message : String(error)
  if (error instanceof DaytonaNotFoundError) return new SandboxError.NotFoundError({ description })
  if (error instanceof DaytonaAuthenticationError || error instanceof DaytonaForbiddenError) {
    return new SandboxError.AuthenticationError({ description })
  }
  if (
    error instanceof DaytonaRateLimitError ||
    error instanceof DaytonaTimeoutError ||
    error instanceof DaytonaConnectionError ||
    error instanceof DaytonaInternalServerError ||
    error instanceof DaytonaBadGatewayError ||
    error instanceof DaytonaServiceUnavailableError
  ) {
    return new SandboxError.UnavailableError({ description })
  }
  return new SandboxError.UnknownError({ description })
}

/** The Effect service a platform error comes from: a sandbox's files or its processes. */
export type PlatformModule = "FileSystem" | "ChildProcess"

/**
 * Calls Daytona for `method` of the sandbox's `module`, failing with the platform error its failure
 * amounts to, which names `path` when the method works on one.
 */
export const callPlatform = <A>(module: PlatformModule, method: string, request: () => Promise<A>, path?: string) =>
  Effect.tryPromise({
    try: request,
    catch: (error) => toPlatformError(module, method, error, path)
  })

/** The platform error a failure of Daytona's SDK amounts to, for `method` of `module` on `path`. */
export const toPlatformError = (module: PlatformModule, method: string, error: unknown, path?: string) =>
  PlatformError.systemError({
    _tag: systemErrorTagOf(error),
    module,
    method,
    pathOrDescriptor: path,
    description: error instanceof Error ? error.message : String(error),
    cause: error
  })

/**
 * The system error a failure amounts to: by its class for one of Daytona's SDK, and otherwise by
 * its message, as the sandbox's own tools name their errors in English under `LC_ALL=C`.
 */
export const systemErrorTagOf = (error: unknown): PlatformError.SystemErrorTag => {
  if (error instanceof DaytonaNotFoundError) return "NotFound"
  if (error instanceof DaytonaAuthenticationError || error instanceof DaytonaForbiddenError) {
    return "PermissionDenied"
  }
  if (error instanceof DaytonaTimeoutError) return "TimedOut"
  const message = error instanceof Error ? error.message : String(error)
  if (/no such file or directory|file not found/i.test(message)) return "NotFound"
  if (/file exists|already exists/i.test(message)) return "AlreadyExists"
  if (/permission denied|operation not permitted/i.test(message)) return "PermissionDenied"
  if (/not a directory|is a directory|points to a directory|too many levels of symbolic links/i.test(message)) {
    return "BadResource"
  }
  if (/resource busy/i.test(message)) return "Busy"
  return "Unknown"
}
