/**
 * Errors a sandbox provider reports for operations on the sandbox itself: creating, resuming,
 * stopping, and configuring it. File and process operations inside a sandbox fail with Effect's
 * `PlatformError` instead, as `FileSystem` and `ChildProcessSpawner` define.
 *
 * `SandboxError` says which provider failed and holds the reason, so callers can recover from one
 * reason with `Effect.catchReason("SandboxError", "NotFoundError", ...)`. The operation that failed
 * is the one the caller ran, which its span names. Each reason has a `description`, what happened
 * in the provider's words, and says with `isRetryable` whether trying again may succeed, as the
 * reasons of `AiError` do.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * The provider's credentials are missing, invalid, or not authorized for the operation.
 *
 * @category errors
 * @since 0.1.0
 */
export class AuthenticationError extends Schema.TaggedError<AuthenticationError>(
  "@amends-dev/sandbox/SandboxError/AuthenticationError"
)("AuthenticationError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The provider's credentials are missing, invalid, or not authorized"
  }
}

/**
 * The sandbox does not exist, as for an unknown or destroyed id, or it does not expose the port.
 *
 * @category errors
 * @since 0.1.0
 */
export class NotFoundError extends Schema.TaggedError<NotFoundError>("@amends-dev/sandbox/SandboxError/NotFoundError")(
  "NotFoundError",
  { description: Schema.optional(Schema.String) }
) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The sandbox does not exist"
  }
}

/**
 * A sandbox with the id `create` was given exists already.
 *
 * @category errors
 * @since 0.1.0
 */
export class AlreadyExistsError extends Schema.TaggedError<AlreadyExistsError>(
  "@amends-dev/sandbox/SandboxError/AlreadyExistsError"
)("AlreadyExistsError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "A sandbox with this id already exists"
  }
}

/**
 * The options under the provider's id in `CreateOptions.providerOptions` are not what the provider
 * takes.
 *
 * @category errors
 * @since 0.1.0
 */
export class InvalidOptionsError extends Schema.TaggedError<InvalidOptionsError>(
  "@amends-dev/sandbox/SandboxError/InvalidOptionsError"
)("InvalidOptionsError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The provider was given options it does not take"
  }
}

/**
 * The provider cannot do this on its platform, such as enforce a network policy, transform
 * requests, or expose a port once the sandbox exists.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnsupportedError extends Schema.TaggedError<UnsupportedError>(
  "@amends-dev/sandbox/SandboxError/UnsupportedError"
)("UnsupportedError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The provider does not support this operation"
  }
}

/**
 * The provider cannot be reached right now, or asks for fewer requests. Trying again may succeed.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnavailableError extends Schema.TaggedError<UnavailableError>(
  "@amends-dev/sandbox/SandboxError/UnavailableError"
)("UnavailableError", { description: Schema.optional(Schema.String) }) {
  get isRetryable(): boolean {
    return true
  }

  override get message(): string {
    return this.description ?? "The provider is temporarily unavailable"
  }
}

/**
 * The provider failed for a reason none of the others names.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnknownError extends Schema.TaggedError<UnknownError>("@amends-dev/sandbox/SandboxError/UnknownError")(
  "UnknownError",
  { description: Schema.optional(Schema.String) }
) {
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "The provider failed"
  }
}

/**
 * Why a sandbox operation failed: one of the errors above, which `SandboxError.reason` holds.
 *
 * @category errors
 * @since 0.1.0
 */
export const SandboxErrorReason = Schema.Union([
  AuthenticationError,
  NotFoundError,
  AlreadyExistsError,
  InvalidOptionsError,
  UnsupportedError,
  UnavailableError,
  UnknownError
]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * @category errors
 * @since 0.1.0
 */
export type SandboxErrorReason = typeof SandboxErrorReason.Type

/**
 * The error every operation on a sandbox fails with: which provider failed, and why.
 *
 * **Example** (Recovering from one reason)
 *
 * ```ts
 * import { Sandbox, SandboxProvider } from "@amends-dev/sandbox"
 * import { Effect } from "effect"
 *
 * declare const id: Sandbox.SandboxId
 *
 * // The sandbox with this id, created if it does not exist yet.
 * const sandbox = Effect.gen(function* () {
 *   const sandboxProvider = yield* SandboxProvider.SandboxProvider
 *   return yield* sandboxProvider
 *     .resume(id)
 *     .pipe(Effect.catchReason("SandboxError", "NotFoundError", () => sandboxProvider.create({ id })))
 * })
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class SandboxError extends Schema.TaggedError<SandboxError>("@amends-dev/sandbox/SandboxError")("SandboxError", {
  /** The provider that failed, such as `local`. */
  provider: Schema.String,
  reason: SandboxErrorReason,
  cause: Schema.optional(Schema.Defect())
}) {
  get isRetryable(): boolean {
    return this.reason.isRetryable
  }

  override get message(): string {
    return `${this.provider}: ${this.reason.message}`
  }
}
