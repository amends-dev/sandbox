/**
 * A sandbox is an isolated machine that code runs in. Its files and processes are Effect's own
 * `FileSystem` and `ChildProcessSpawner`, so any Effect code that uses them runs inside the
 * sandbox once `layerServices` provides them. The `Sandbox` service adds what Effect has no
 * service for: the sandbox's identity, its ports, its network, and its lifecycle.
 *
 * A sandbox outlives the process that created it, so its lifetime is not tied to a `Scope`: it
 * runs until `stop` or `destroy`, and a provider can resume it later by its id. A process in it
 * ends with the scope that spawned it, unless its handle's `unref` lets it outlive that scope, as a
 * server that should keep running after the host lets go does; it then runs until the sandbox
 * stops.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import type * as Network from "./Network.ts"
import type * as SandboxError from "./SandboxError.ts"

/**
 * Checks a name of letters, digits, `-`, and `_`, starting with a letter or digit and at most 63
 * characters long, which any provider can use as a directory name or in a URL. What lives in a
 * sandbox, such as a session, is named under the same check, so that its name can name a
 * directory there.
 *
 * @category validation
 * @since 0.1.0
 */
export const isName = Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/)

/**
 * Names a sandbox, as `isName` checks. A provider resumes a sandbox by it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SandboxId = Schema.String.check(isName).pipe(Schema.brand("SandboxId"))

/**
 * @category schemas
 * @since 0.1.0
 */
export type SandboxId = typeof SandboxId.Type

/**
 * The Effect services a sandbox provides to code that runs inside it: its files, its processes,
 * and paths. `layerServices` provides them.
 *
 * @category utility types
 * @since 0.1.0
 */
export type SandboxServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

/**
 * One sandbox, as its provider's `create` or `resume` returns it. Every value for the same
 * sandbox, created or resumed, works on the same files, processes, and ports.
 *
 * **Example** (Running a command and reading a file inside a sandbox)
 *
 * ```ts
 * import { Sandbox } from "@amends-dev/sandbox"
 * import { Effect, FileSystem, Path } from "effect"
 * import { ChildProcess, ChildProcessSpawner } from "effect/process"
 *
 * declare const sandbox: Sandbox.Sandbox["Service"]
 *
 * // Commands start in the working directory; file paths are absolute.
 * const greeting = Effect.gen(function* () {
 *   const fs = yield* FileSystem.FileSystem
 *   const path = yield* Path.Path
 *   const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
 *
 *   yield* spawner.exitCode(ChildProcess.make("sh", ["-c", "echo hello > greeting.txt"]))
 *   return yield* fs.readFileString(path.join(sandbox.workingDirectory, "greeting.txt"))
 * }).pipe(Effect.provide(Sandbox.layerServices(sandbox)))
 * ```
 *
 * @category services
 * @since 0.1.0
 */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    /** Names the sandbox; its provider resumes it by this id. */
    readonly id: SandboxId

    /**
     * The absolute directory that commands start in when they set no `cwd`, and that a relative
     * `cwd` is resolved against.
     */
    readonly workingDirectory: string

    /**
     * The sandbox's files. Paths must be absolute, such as ones joined onto `workingDirectory`:
     * what a relative path refers to differs between providers.
     */
    readonly fileSystem: FileSystem.FileSystem

    /**
     * The sandbox's processes. A command starts in `workingDirectory` unless it sets a `cwd`, and
     * gets the environment it is given, or the sandbox's with it when it extends the environment.
     */
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"]

    /**
     * Exposes `ports`, besides those exposed at creation or since, so that `endpoint` reaches them
     * for the rest of the sandbox's life. Exposing a port again succeeds. Fails with
     * `UnsupportedError` when the provider cannot expose a port once the sandbox exists.
     */
    readonly exposePorts: (ports: ReadonlyArray<Network.Port>) => Effect.Effect<void, SandboxError.SandboxError>

    /**
     * How to reach `port` from outside the sandbox; fails with `NotFoundError` for a port the
     * sandbox does not expose.
     */
    readonly endpoint: (
      port: Network.Port,
      protocol: Network.EndpointProtocol
    ) => Effect.Effect<Network.Endpoint, SandboxError.SandboxError>

    /**
     * Stops the sandbox, ending every process in it, so that it can be resumed later. Stopping a
     * stopped sandbox succeeds.
     */
    readonly stop: Effect.Effect<void, SandboxError.SandboxError>

    /**
     * Stops the sandbox and deletes it; it cannot be resumed afterwards. Destroying a destroyed
     * sandbox succeeds.
     */
    readonly destroy: Effect.Effect<void, SandboxError.SandboxError>

    /**
     * Replaces the outbound network policy; fails with `UnsupportedError` when the provider cannot
     * enforce one.
     */
    readonly setNetworkPolicy: (policy: Network.NetworkPolicy) => Effect.Effect<void, SandboxError.SandboxError>

    /**
     * Replaces the request transformations with `transformations`, for the rest of the sandbox's
     * life: a set without a credential set earlier revokes it, and an empty set revokes them all.
     * Fails with `UnsupportedError` when the provider cannot transform requests outside the
     * sandbox.
     */
    readonly setRequestTransformations: (
      transformations: ReadonlyArray<Network.RequestTransformation>
    ) => Effect.Effect<void, SandboxError.SandboxError>
  }
>()("@amends-dev/sandbox/Sandbox") {}

/**
 * Provides the sandbox's files, processes, and paths to Effect code, without the `Sandbox` service
 * itself: code given only this layer can work in the sandbox but cannot stop it or change its
 * network.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServices = (sandbox: Sandbox["Service"]): Layer.Layer<SandboxServices> =>
  Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, sandbox.fileSystem),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, sandbox.childProcessSpawner),
    Path.layer
  )
