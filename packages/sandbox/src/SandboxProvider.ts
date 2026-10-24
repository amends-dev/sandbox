/**
 * A sandbox provider creates sandboxes on one platform, such as this machine or Daytona, and
 * resumes sandboxes it created before. The settings a platform needs, such as credentials or a
 * root directory, go to the provider's layer, so code that creates sandboxes does not depend on
 * which provider it uses.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Network from "./Network.ts"
import type * as Sandbox from "./Sandbox.ts"
import type * as SandboxError from "./SandboxError.ts"
import type * as Template from "./Template.ts"

/**
 * What only one platform takes on a create, keyed by the provider's id, as `SandboxError.provider`
 * names it, with JSON values: such as the snapshot a sandbox on Daytona starts from.
 *
 * **Details**
 *
 * A provider decodes its own entry and ignores the others, so one value can name several providers;
 * an entry that is not what the provider takes fails with `InvalidOptionsError`, creating nothing.
 *
 * **Example** (The snapshot a sandbox on Daytona starts from)
 *
 * ```ts
 * import { SandboxProvider } from "@amends-dev/sandbox"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const sandboxProvider = yield* SandboxProvider.SandboxProvider
 *   return yield* sandboxProvider.create({
 *     providerOptions: { daytona: { snapshot: "python-3.13" } }
 *   })
 * })
 * ```
 *
 * @category options
 * @since 0.1.0
 */
export const ProviderOptions = Schema.Record(Schema.String, Schema.Json)

/**
 * @category options
 * @since 0.1.0
 */
export type ProviderOptions = typeof ProviderOptions.Type

/**
 * What a sandbox is created with: its id, the ports it exposes, the template that prepares it, the
 * network policy it starts under, and what only its provider takes. Each has a default.
 *
 * @category options
 * @since 0.1.0
 */
export interface CreateOptions<E> {
  /**
   * Names the new sandbox. Creating never looks a sandbox up, so an id already in use fails with
   * `AlreadyExistsError`. When omitted, the provider picks one.
   */
  readonly id?: Sandbox.SandboxId

  /** The ports to expose from the start; `Sandbox.exposePorts` exposes more later. */
  readonly ports?: ReadonlyArray<Network.Port>

  /**
   * Prepares the sandbox before `create` returns it. It may be given as `undefined`, as an agent's
   * `template` is when the agent needs no sandbox.
   */
  readonly template?: Template.Template<E> | undefined

  /**
   * The outbound network policy the sandbox starts under, `AllowAll` when omitted. It is in force
   * before `create` returns, so nothing run in the sandbox afterwards reaches further than it
   * allows; the template prepares the sandbox before it applies, as preparing may download what it
   * installs. Fails with `UnsupportedError`, creating nothing, when the provider cannot enforce the
   * policy, as `Sandbox.setNetworkPolicy` does.
   */
  readonly networkPolicy?: Network.NetworkPolicy

  /** What only one platform takes, under its provider's id, as `ProviderOptions` describes. */
  readonly providerOptions?: ProviderOptions
}

/**
 * Creates sandboxes on one platform and resumes the ones it created before.
 *
 * **Details**
 *
 * A program asks for the service and gets whichever provider's layer it runs under. `make` builds
 * the service from a provider's `create` and `resume`.
 *
 * **Example** (Creating a sandbox, stopping it, and resuming it later)
 *
 * ```ts
 * import { Network, Sandbox, SandboxProvider } from "@amends-dev/sandbox"
 * import { Effect, FileSystem, Path } from "effect"
 *
 * const id = Sandbox.SandboxId.make("review-42")
 * const port = Network.Port.make(3000)
 *
 * const program = Effect.gen(function* () {
 *   const sandboxProvider = yield* SandboxProvider.SandboxProvider
 *   const sandbox = yield* sandboxProvider.create({ id, ports: [port] })
 *   yield* Effect.gen(function* () {
 *     const fs = yield* FileSystem.FileSystem
 *     const path = yield* Path.Path
 *     yield* fs.writeFileString(path.join(sandbox.workingDirectory, "notes.md"), "# Review")
 *   }).pipe(Effect.provide(Sandbox.layerServices(sandbox)))
 *   yield* sandbox.stop
 *
 *   // Later, in this process or another: the files are still there, and so is the port.
 *   const resumed = yield* sandboxProvider.resume(id)
 *   const endpoint = yield* resumed.endpoint(port, "http")
 *   return endpoint.url
 * })
 * ```
 *
 * @category services
 * @since 0.1.0
 */
export class SandboxProvider extends Context.Service<
  SandboxProvider,
  {
    /**
     * Creates and starts a sandbox, which runs until `stop` or `destroy`. A create that fails,
     * including when its template fails or it is interrupted, first removes what it made, so no
     * sandbox is left behind.
     */
    readonly create: <E = never>(
      options?: CreateOptions<E>
    ) => Effect.Effect<Sandbox.Sandbox["Service"], SandboxError.SandboxError | E>

    /**
     * Creates and starts a sandbox that is destroyed when the scope closes, however it closes, for
     * work that must leave no sandbox behind, as `FileSystem.makeTempDirectoryScoped` leaves no
     * directory. Failing to destroy it is a defect.
     */
    readonly createScoped: <E = never>(
      options?: CreateOptions<E>
    ) => Effect.Effect<Sandbox.Sandbox["Service"], SandboxError.SandboxError | E, Scope.Scope>

    /**
     * Reattaches to a sandbox this provider created, starting it again if it was stopped. It never
     * creates one: an unknown or destroyed id fails with `NotFoundError`.
     */
    readonly resume: (id: Sandbox.SandboxId) => Effect.Effect<Sandbox.Sandbox["Service"], SandboxError.SandboxError>
  }
>()("@amends-dev/sandbox/SandboxProvider") {}

/**
 * The service over a provider's `create` and `resume`, with `createScoped` derived from them, as
 * `ChildProcessSpawner.make` derives the rest of that service from `spawn`.
 *
 * **Example** (A sandbox for one piece of work)
 *
 * ```ts
 * import { SandboxProvider } from "@amends-dev/sandbox"
 * import { Effect } from "effect"
 *
 * declare const create: SandboxProvider.SandboxProvider["Service"]["create"]
 * declare const resume: SandboxProvider.SandboxProvider["Service"]["resume"]
 *
 * const sandboxProvider = SandboxProvider.make({ create, resume })
 *
 * // The sandbox is destroyed when the scope closes, however it closes.
 * const program = Effect.scoped(
 *   Effect.gen(function* () {
 *     const sandbox = yield* sandboxProvider.createScoped()
 *     return sandbox.workingDirectory
 *   })
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (provider: Pick<SandboxProvider["Service"], "create" | "resume">): SandboxProvider["Service"] =>
  SandboxProvider.of({
    ...provider,
    createScoped: (options) =>
      Effect.acquireRelease(provider.create(options), (sandbox) => Effect.orDie(sandbox.destroy))
  })
