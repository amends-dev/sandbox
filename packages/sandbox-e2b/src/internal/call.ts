/** Maps E2B SDK failures to the sandbox and Effect platform contracts. */

import { SandboxError } from "@amends-dev/sandbox"
import {
  AuthenticationError,
  InvalidArgumentError,
  NotFoundError,
  SandboxError as E2bError,
  ServiceBusyError,
  TimeoutError
} from "e2b"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"

export const providerId = "e2b"

export const sandboxError = (reason: SandboxError.SandboxErrorReason, cause?: unknown) =>
  new SandboxError.SandboxError({ provider: providerId, reason, cause })

export const call = <A>(request: () => Promise<A>) => Effect.tryPromise({ try: request, catch: fromE2bError })

export const fromE2bError = (error: unknown) => sandboxError(reasonOf(error), error)

const reasonOf = (error: unknown): SandboxError.SandboxErrorReason => {
  const description = error instanceof Error ? error.message : String(error)
  if (error instanceof NotFoundError) return new SandboxError.NotFoundError({ description })
  if (error instanceof AuthenticationError) return new SandboxError.AuthenticationError({ description })
  if (error instanceof InvalidArgumentError) return new SandboxError.InvalidOptionsError({ description })
  if (error instanceof E2bError) {
    if (error.statusCode === 401 || error.statusCode === 403)
      return new SandboxError.AuthenticationError({ description })
    if (error.statusCode === 404) return new SandboxError.NotFoundError({ description })
    if (error.statusCode === 400 || error.statusCode === 422)
      return new SandboxError.InvalidOptionsError({ description })
    // E2B owns machine IDs; a conflict is a lifecycle transition, not our metadata name check.
    if (error.statusCode === 409) return new SandboxError.UnavailableError({ description })
  }
  if (
    error instanceof TimeoutError ||
    error instanceof ServiceBusyError ||
    (error instanceof E2bError && (error.statusCode === 429 || (error.statusCode ?? 0) >= 500))
  ) {
    return new SandboxError.UnavailableError({ description })
  }
  return new SandboxError.UnknownError({ description })
}

export type PlatformModule = "FileSystem" | "ChildProcess"

export const callPlatform = <A>(module: PlatformModule, method: string, request: () => Promise<A>, path?: string) =>
  Effect.tryPromise({ try: request, catch: (error) => toPlatformError(module, method, error, path) })

export const toPlatformError = (module: PlatformModule, method: string, error: unknown, path?: string) =>
  PlatformError.systemError({
    _tag: systemErrorTagOf(error),
    module,
    method,
    pathOrDescriptor: path,
    description: error instanceof Error ? error.message : String(error),
    cause: error
  })

export const systemErrorTagOf = (error: unknown): PlatformError.SystemErrorTag => {
  if (error instanceof NotFoundError || (error instanceof E2bError && error.statusCode === 404)) return "NotFound"
  if (
    error instanceof AuthenticationError ||
    (error instanceof E2bError && (error.statusCode === 401 || error.statusCode === 403))
  )
    return "PermissionDenied"
  if (error instanceof TimeoutError) return "TimedOut"
  const message = error instanceof Error ? error.message : String(error)
  if (/no such file or directory|file not found/i.test(message)) return "NotFound"
  if (/file exists|already exists/i.test(message)) return "AlreadyExists"
  if (/permission denied|operation not permitted/i.test(message)) return "PermissionDenied"
  if (/not a directory|is a directory|too many levels of symbolic links/i.test(message)) return "BadResource"
  if (/resource busy/i.test(message)) return "Busy"
  return "Unknown"
}
