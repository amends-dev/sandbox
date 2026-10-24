/**
 * A local sandbox provider keeps each sandbox in a directory on this machine and runs its
 * processes as this machine's processes. Nothing is isolated: a sandbox's processes can read and
 * write the whole machine and see its environment variables, so it suits development, tests, and
 * agents you would trust on this machine anyway.
 *
 * Each sandbox is a directory under the provider's `directory`, named by its id, that holds its
 * settings, the ports it exposes, in `sandbox.json` and the sandbox's files in `workspace`, its
 * working directory. Processes start in the working directory and resolve a relative `cwd`
 * against it. File paths are this machine's paths.
 *
 * `stop` and `destroy` end the processes the provider started for the sandbox, through any
 * `Sandbox` value for it, including those that outlived their scopes. A provider made again, as
 * when the host restarts, does not know of processes an earlier one left running.
 *
 * @since 0.1.0
 */

import { Network, Sandbox, SandboxError, SandboxProvider } from "@amends-dev/sandbox"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"

/**
 * Where the provider keeps its sandboxes.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options {
  /** The directory that holds one directory per sandbox, created if it is missing. */
  readonly directory: string
}

/** The settings a sandbox keeps in its `sandbox.json`: the ports it exposes. */
const Settings = Schema.fromJsonString(Schema.Struct({ ports: Schema.Array(Network.Port) }))

/**
 * The provider over `options.directory`, which it creates if it is missing.
 *
 * **Details**
 *
 * It needs Effect's `FileSystem`, `Path`, `Crypto`, and `ChildProcessSpawner` services for this
 * machine, as `BunServices.layer` or `NodeServices.layer` provide them.
 *
 * **Example** (A provider for one piece of work, over a temporary directory)
 *
 * ```ts
 * import { LocalSandboxProvider } from "@amends-dev/sandbox-local"
 * import { BunServices } from "@effect/platform-bun"
 * import { Effect, FileSystem } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const fs = yield* FileSystem.FileSystem
 *   const sandboxProvider = yield* LocalSandboxProvider.make({
 *     directory: yield* fs.makeTempDirectoryScoped()
 *   })
 *   const sandbox = yield* sandboxProvider.createScoped()
 *   return sandbox.workingDirectory
 * }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = Effect.fnUntraced(function* (options: Options) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const directory = path.resolve(options.directory)
  yield* fs.makeDirectory(directory, { recursive: true })
  /** Held while a sandbox's settings change, so that ports exposed together are all kept. */
  const settingsLock = yield* Semaphore.make(1)

  const pathsOf = (id: Sandbox.SandboxId) => {
    const root = path.join(directory, id)
    return {
      root,
      settings: path.join(root, "sandbox.json"),
      workspace: path.join(root, "workspace")
    }
  }

  /**
   * The processes running in each sandbox, so that `stop` and `destroy` end them whichever
   * `Sandbox` value started them.
   */
  const processes = new Map<Sandbox.SandboxId, Set<ChildProcessSpawner.ChildProcessHandle>>()

  /**
   * Spawns `command`, keeping its process in `running` while it runs. When the caller's scope
   * closes, the spawner ends the process unless its handle was unreferenced; one still running
   * then stays in `running` until the sandbox stops.
   */
  const spawnInto = Effect.fnUntraced(function* (
    running: Set<ChildProcessSpawner.ChildProcessHandle>,
    command: ChildProcess.Command
  ) {
    // The spawner ends the process in a scope of its own, which this one closes before it
    // looks at whether the process still runs.
    const spawnScope = yield* Scope.fork(yield* Effect.scope)
    const handle = yield* Scope.provide(spawner.spawn(command), spawnScope)
    running.add(handle)
    const forgetEnded = Effect.flatMap(handle.isRunning, (isRunning) =>
      isRunning ? Effect.void : Effect.sync(() => running.delete(handle))
    )
    yield* Effect.addFinalizer((exit) => Effect.andThen(Scope.close(spawnScope, exit), Effect.ignore(forgetEnded)))
    return handle
  })

  /** The ports the sandbox `id` exposes, as its settings keep them. */
  const readPorts = Effect.fnUntraced(function* (id: Sandbox.SandboxId) {
    const settings = yield* fs.readFileString(pathsOf(id).settings).pipe(Effect.mapError(fromPlatformError))
    const { ports } = yield* Schema.decodeEffect(Settings)(settings).pipe(
      Effect.mapError((cause) =>
        sandboxError(new SandboxError.UnknownError({ description: "The sandbox's settings are unreadable" }), cause)
      )
    )
    return ports
  })

  /** Keeps `ports` as the ports the sandbox `id` exposes. */
  const writePorts = (id: Sandbox.SandboxId, ports: ReadonlyArray<Network.Port>) =>
    // Ports are already valid, so encoding them cannot fail.
    Effect.flatMap(Effect.orDie(Schema.encodeEffect(Settings)({ ports })), (settings) =>
      fs.writeFileString(pathsOf(id).settings, settings)
    )

  const openSandbox = (id: Sandbox.SandboxId): Sandbox.Sandbox["Service"] => {
    const paths = pathsOf(id)
    const running = processes.get(id) ?? new Set<ChildProcessSpawner.ChildProcessHandle>()
    processes.set(id, running)
    return Sandbox.Sandbox.of({
      id,
      workingDirectory: paths.workspace,
      fileSystem: fs,
      childProcessSpawner: ChildProcessSpawner.make((command) =>
        spawnInto(running, resolveCwd(path, paths.workspace, command))
      ),
      // A port is this machine's, so exposing it only records it.
      exposePorts: (ports) =>
        Semaphore.withPermit(
          settingsLock,
          Effect.gen(function* () {
            const exposed = yield* readPorts(id)
            const added = ports.filter((port) => !exposed.includes(port))
            if (added.length === 0) return
            yield* writePorts(id, [...exposed, ...added]).pipe(Effect.mapError(fromPlatformError))
          })
        ),
      endpoint: (port, protocol) =>
        Effect.flatMap(readPorts(id), (exposed) =>
          exposed.includes(port)
            ? Effect.succeed({ url: `${protocol}://127.0.0.1:${port}`, headers: {} })
            : Effect.fail(
                sandboxError(
                  new SandboxError.NotFoundError({
                    description: `Port ${port} is not exposed`
                  })
                )
              )
        ),
      stop: endProcesses(running).pipe(Effect.mapError(fromPlatformError)),
      destroy: endProcesses(running).pipe(
        Effect.andThen(fs.remove(paths.root, { recursive: true, force: true })),
        Effect.mapError(fromPlatformError),
        Effect.andThen(Effect.sync(() => processes.delete(id)))
      ),
      setNetworkPolicy: allowAllOnly,
      setRequestTransformations: () =>
        Effect.fail(
          sandboxError(
            new SandboxError.UnsupportedError({
              description: "A local sandbox's requests leave this machine without a proxy"
            })
          )
        )
    })
  }

  const create = Effect.fn("LocalSandboxProvider.create")(function* <E = never>(
    createOptions: SandboxProvider.CreateOptions<E> = {}
  ) {
    const id =
      createOptions.id ?? Sandbox.SandboxId.make(yield* crypto.randomUUIDv4().pipe(Effect.mapError(fromPlatformError)))
    const ports = createOptions.ports ?? []
    const paths = pathsOf(id)
    if (createOptions.networkPolicy !== undefined) yield* allowAllOnly(createOptions.networkPolicy)

    return yield* Effect.acquireUseRelease(
      // Creating the sandbox's directory claims its id, failing when the id is taken.
      fs.makeDirectory(paths.root).pipe(Effect.mapError(fromPlatformError)),
      () =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(paths.workspace).pipe(Effect.mapError(fromPlatformError))
          yield* writePorts(id, ports).pipe(Effect.mapError(fromPlatformError))
          const sandbox = openSandbox(id)
          // The provider takes no snapshots, so a template prepares every sandbox on its own.
          if (createOptions.template !== undefined) {
            yield* Effect.provide(createOptions.template.prepare, Sandbox.layerServices(sandbox))
          }
          return sandbox
        }),
      // A failed create, interrupted or not, leaves no sandbox behind to resume.
      (_, exit) =>
        Exit.isSuccess(exit) ? Effect.void : Effect.ignore(fs.remove(paths.root, { recursive: true, force: true }))
    )
  })

  const resume = Effect.fn("LocalSandboxProvider.resume")(function* (id: Sandbox.SandboxId) {
    // A sandbox without readable settings is not one this provider created.
    yield* readPorts(id)
    return openSandbox(id)
  })

  return SandboxProvider.make({ create, resume })
})

/**
 * Provides the `SandboxProvider` service over `options.directory`, as `make` makes it, to a
 * program that keeps its sandboxes on this machine.
 *
 * **Example** (Sandboxes under a directory of the host's)
 *
 * ```ts
 * import { SandboxProvider } from "@amends-dev/sandbox"
 * import { LocalSandboxProvider } from "@amends-dev/sandbox-local"
 * import { BunServices } from "@effect/platform-bun"
 * import { Effect, Layer } from "effect"
 *
 * const sandboxes = LocalSandboxProvider.layer({ directory: "/var/lib/amends/sandboxes" }).pipe(
 *   Layer.provide(BunServices.layer)
 * )
 *
 * const program = Effect.gen(function* () {
 *   const sandboxProvider = yield* SandboxProvider.SandboxProvider
 *   const sandbox = yield* sandboxProvider.create()
 *   return sandbox.id
 * }).pipe(Effect.provide(sandboxes))
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: Options) => Layer.effect(SandboxProvider.SandboxProvider, make(options))

/**
 * Resolves the `cwd` of each command in `command` against `workingDirectory`, where a command
 * without one starts.
 */
const resolveCwd = (path: Path.Path, workingDirectory: string, command: ChildProcess.Command): ChildProcess.Command =>
  ChildProcess.isStandardCommand(command)
    ? ChildProcess.setCwd(command, path.resolve(workingDirectory, command.options.cwd ?? "."))
    : ChildProcess.pipeTo(
        resolveCwd(path, workingDirectory, command.left),
        resolveCwd(path, workingDirectory, command.right),
        command.options
      )

/** Ends the processes in `running`, waiting for each to exit, and forgets them. */
const endProcesses = (running: Set<ChildProcessSpawner.ChildProcessHandle>) =>
  Effect.forEach(
    running,
    (handle) =>
      Effect.flatMap(handle.isRunning, (isRunning) =>
        isRunning ? handle.kill({ forceKillAfter: "5 seconds" }) : Effect.void
      ).pipe(Effect.andThen(Effect.sync(() => running.delete(handle)))),
    { concurrency: "unbounded", discard: true }
  )

/** Succeeds for `AllowAll` only, the network a local sandbox has, as it shares this machine's. */
const allowAllOnly = (policy: Network.NetworkPolicy) =>
  Network.NetworkPolicy.isAnyOf(["AllowAll"])(policy)
    ? Effect.void
    : Effect.fail(
        sandboxError(
          new SandboxError.UnsupportedError({
            description: "A local sandbox shares this machine's network"
          })
        )
      )

const sandboxError = (reason: SandboxError.SandboxErrorReason, cause?: unknown) =>
  new SandboxError.SandboxError({ provider: "local", reason, cause })

const fromPlatformError = (error: PlatformError.PlatformError) => sandboxError(reasonOf(error), error)

/** The sandbox error reason a failure of this machine's file system or processes amounts to. */
const reasonOf = (error: PlatformError.PlatformError): SandboxError.SandboxErrorReason =>
  Match.value(error.reason).pipe(
    Match.tag("NotFound", () => new SandboxError.NotFoundError({})),
    Match.tag("AlreadyExists", () => new SandboxError.AlreadyExistsError({})),
    Match.orElse(() => new SandboxError.UnknownError({ description: error.message }))
  )
