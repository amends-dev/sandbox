/**
 * A Daytona sandbox provider creates each sandbox in Daytona's cloud, a Linux machine of its own,
 * which Daytona names by the sandbox's id. It reaches Daytona through Daytona's SDK, with the API
 * key of the organization the sandboxes belong to, and closes the SDK's client with its scope.
 *
 * A sandbox made from a template starts from a snapshot of the template's version once Daytona has
 * made one, and is prepared on its own until then; snapshots still being made when the provider's
 * scope closes are left for the next create to make.
 *
 * A sandbox runs until it is stopped or destroyed. Daytona stops a sandbox that sees no requests
 * to its API for a while, and requests to the sandbox's ports do not count, so a sandbox would stop
 * under an agent that only serves a host through a port; the provider turns that off unless the
 * options set it. A port's endpoint is Daytona's preview URL for it, which takes the sandbox's
 * preview token in a header and passes the request's other headers on. Daytona opens a sandbox's
 * port the first time it gives its preview URL, so exposing a port only records it.
 *
 * @since 0.1.0
 */

import { Network, Sandbox, SandboxError, SandboxProvider, type Template } from "@amends-dev/sandbox"
import {
  type CreateSandboxFromSnapshotParams,
  Daytona,
  DaytonaConflictError,
  type Sandbox as DaytonaSandbox
} from "@daytona/sdk"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { call, fromDaytonaError, providerId, sandboxError } from "./internal/call.ts"
import { makeFileSystem } from "./internal/files.ts"
import { makeChildProcessSpawner } from "./internal/processes.ts"
import { claimMinutes, findSnapshot } from "./internal/snapshots.ts"

/**
 * How the provider reaches Daytona, and what every sandbox it creates gets unless the sandbox's
 * `ProviderOptions` say otherwise.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options {
  /** The API key of the Daytona organization the sandboxes belong to. */
  readonly apiKey: Redacted.Redacted<string>

  /** Daytona's API, when it is not that of Daytona's own cloud. */
  readonly apiUrl?: string

  /** The region to create sandboxes in, such as `us` or `eu`, rather than the organization's. */
  readonly target?: string

  /** The snapshot sandboxes start from, rather than Daytona's default. */
  readonly snapshot?: string

  /**
   * Minutes without requests to Daytona's API, which requests to the sandbox's ports do not count
   * as, after which Daytona stops a sandbox. 0, the default, never stops it.
   */
  readonly autoStopInterval?: number
}

/**
 * What a sandbox on Daytona is created with besides the contract's options, under
 * `providerOptions.daytona`, each in place of the provider's own option for this sandbox.
 *
 * **Details**
 *
 * An entry that is not this fails the create with `InvalidOptionsError` before Daytona is asked.
 *
 * **Example** (A sandbox from another snapshot, which Daytona stops after an hour idle)
 *
 * ```ts
 * import { SandboxProvider } from "@amends-dev/sandbox"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const sandboxProvider = yield* SandboxProvider.SandboxProvider
 *   return yield* sandboxProvider.create({
 *     providerOptions: { daytona: { snapshot: "python-3.13", autoStopInterval: 60 } }
 *   })
 * })
 * ```
 *
 * @category options
 * @since 0.1.0
 */
export const ProviderOptions = Schema.Struct({
  /** The snapshot the sandbox starts from, rather than the provider's. */
  snapshot: Schema.optionalKey(Schema.String),

  /** Minutes without requests to Daytona's API after which Daytona stops the sandbox; 0 never. */
  autoStopInterval: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

/**
 * @category options
 * @since 0.1.0
 */
export type ProviderOptions = typeof ProviderOptions.Type

/** The label that keeps the ports a sandbox exposes. */
const portsLabel = "amends-ports"

/** The label that names the template a sandbox prepares a version of. */
const templateLabel = "amends-template"

/** How long Daytona may take to make a snapshot of a prepared sandbox. */
const snapshotSeconds = 15 * 60

/** States of a sandbox that Daytona has deleted or is deleting, which cannot be resumed. */
const deletedStates = new Set(["destroyed", "destroying"])

/** States of a sandbox that is not running, from which `stop` has nothing to do. */
const stoppedStates = new Set(["stopped", "archived"])

/**
 * The provider over Daytona's SDK with `options`, in a scope that closes the SDK's client and
 * leaves snapshots still being made to a later create.
 *
 * **Details**
 *
 * It needs Effect's `Crypto` service, as `BunCrypto.layer` or `NodeCrypto.layer` provide it.
 *
 * **Example** (A provider for one piece of work)
 *
 * ```ts
 * import { DaytonaSandboxProvider } from "@amends-dev/sandbox-daytona"
 * import { BunCrypto } from "@effect/platform-bun"
 * import { Effect, Redacted } from "effect"
 *
 * declare const apiKey: Redacted.Redacted<string>
 *
 * const program = Effect.gen(function* () {
 *   const sandboxProvider = yield* DaytonaSandboxProvider.make({ apiKey, target: "eu" })
 *   const sandbox = yield* sandboxProvider.createScoped()
 *   return sandbox.workingDirectory
 * }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = Effect.fnUntraced(function* (options: Options) {
  const crypto = yield* Crypto.Crypto
  // Snapshots of templates are made in the background, until the provider closes.
  const scope = yield* Effect.scope
  // The client holds a connection for sandboxes' events, which keeps a process running until the
  // client is disposed.
  const daytona = yield* Effect.acquireDisposable(
    Effect.sync(
      () =>
        new Daytona({
          apiKey: Redacted.value(options.apiKey),
          ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
          ...(options.target === undefined ? {} : { target: options.target })
        })
    )
  )

  const openSandbox = Effect.fnUntraced(function* (sandbox: DaytonaSandbox, id: Sandbox.SandboxId) {
    const workingDirectory = (yield* call(() => sandbox.getWorkDir())) ?? "/"
    /**
     * Whether the sandbox exposes `port`, as its label said when last read, or says now, for a
     * port exposed through another `Sandbox` of it since.
     */
    const isExposed = (port: Network.Port) =>
      portsOf(sandbox.labels).includes(port)
        ? Effect.succeed(true)
        : Effect.map(
            call(() => sandbox.refreshData()),
            () => portsOf(sandbox.labels).includes(port)
          )
    return Sandbox.Sandbox.of({
      id,
      workingDirectory,
      fileSystem: makeFileSystem(sandbox, workingDirectory),
      childProcessSpawner: yield* makeChildProcessSpawner(sandbox, workingDirectory).pipe(
        Effect.provideService(Crypto.Crypto, crypto)
      ),
      // Daytona replaces the labels whole, so of two hosts exposing different ports at once, one
      // loses its port.
      exposePorts: (ports) =>
        retryConflicts(
          Effect.gen(function* () {
            yield* call(() => sandbox.refreshData())
            const exposed = portsOf(sandbox.labels)
            const added = ports.filter((port) => !exposed.includes(port))
            if (added.length === 0) return
            yield* call(() =>
              sandbox.setLabels({
                ...sandbox.labels,
                [portsLabel]: [...exposed, ...added].join(",")
              })
            )
          })
        ),
      endpoint: (port, protocol) =>
        Effect.flatMap(isExposed(port), (exposed) =>
          exposed
            ? Effect.map(
                call(() => sandbox.getPreviewLink(port)),
                (link): Network.Endpoint => ({
                  url: protocol === "ws" ? link.url.replace(/^http/, "ws") : link.url,
                  headers: link.token === undefined ? {} : { "x-daytona-preview-token": Redacted.make(link.token) }
                })
              )
            : Effect.fail(sandboxError(new SandboxError.NotFoundError({ description: `Port ${port} is not exposed` })))
        ),
      // A sandbox another call is stopping or destroying refuses the request until it has, and
      // is then found stopped or destroyed when the request is retried.
      stop: retryConflicts(
        Effect.andThen(
          call(() => sandbox.refreshData()),
          () => (stoppedStates.has(sandbox.state ?? "") ? Effect.void : call(() => sandbox.stop()))
        )
      ),
      destroy: retryConflicts(
        Effect.andThen(
          call(() => sandbox.refreshData()),
          () => (deletedStates.has(sandbox.state ?? "") ? Effect.void : call(() => sandbox.delete()))
        )
      ).pipe(Effect.catchReason("SandboxError", "NotFoundError", () => Effect.void)),
      // Daytona applies the settings a moment after it answers, and lifts a full block before an
      // allow list takes over.
      setNetworkPolicy: (policy) =>
        Effect.flatMap(networkSettingsOf(policy), (settings) =>
          retryConflicts(call(() => sandbox.updateNetworkSettings(settings)))
        ),
      setRequestTransformations: () =>
        Effect.fail(
          sandboxError(
            new SandboxError.UnsupportedError({
              description: "The Daytona provider sets no headers on outbound requests"
            })
          )
        )
    })
  })

  /**
   * Creates the Daytona sandbox named `name`, failing with `AlreadyExistsError` when the name is
   * taken. One that fails after Daytona may have made it, as when it does not start in time, is
   * deleted.
   */
  const createSandbox = (name: string, params: Omit<CreateSandboxFromSnapshotParams, "name">) =>
    Effect.tryPromise({
      try: () => daytona.create({ name, ...params }),
      catch: (error) =>
        error instanceof DaytonaConflictError
          ? sandboxError(
              new SandboxError.AlreadyExistsError({
                description: `A sandbox named ${name} already exists`
              }),
              error
            )
          : fromDaytonaError(error)
    }).pipe(
      Effect.tapError((error) =>
        SandboxError.SandboxErrorReason.isAnyOf(["AlreadyExistsError"])(error.reason)
          ? Effect.void
          : call(() => daytona.get(name)).pipe(
              Effect.flatMap((sandbox) => call(() => sandbox.delete())),
              Effect.ignore
            )
      )
    )

  /**
   * Prepares `template` in a sandbox named `name`, which then becomes the snapshot of that name and
   * is deleted. Succeeds with `false`, making nothing, when another create has claimed the name.
   */
  const makeSnapshot = <E>(template: Template.Template<E>, base: string | undefined, name: string) =>
    Effect.acquireUseRelease(
      createSandbox(name, {
        labels: { [templateLabel]: template.name },
        autoStopInterval: 0,
        ttlMinutes: claimMinutes,
        ...(base === undefined ? {} : { snapshot: base })
      }),
      (sandbox) =>
        openSandbox(sandbox, Sandbox.SandboxId.make(name)).pipe(
          Effect.flatMap((opened) => template.prepare.pipe(Effect.provide(Sandbox.layerServices(opened)))),
          Effect.andThen(call(() => sandbox.createSnapshot(name, snapshotSeconds))),
          Effect.as(true)
        ),
      (sandbox) => Effect.ignore(call(() => sandbox.delete()))
    ).pipe(
      Effect.catchIf(
        (error) =>
          Schema.is(SandboxError.SandboxError)(error) &&
          SandboxError.SandboxErrorReason.isAnyOf(["AlreadyExistsError"])(error.reason),
        () => Effect.succeed(false)
      )
    )

  const create = Effect.fn("DaytonaSandboxProvider.create")(function* <E = never>(
    createOptions: SandboxProvider.CreateOptions<E> = {}
  ) {
    const id =
      createOptions.id ??
      Sandbox.SandboxId.make(
        yield* crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError((cause) =>
              sandboxError(new SandboxError.UnknownError({ description: cause.message }), cause)
            )
          )
      )
    const ports = createOptions.ports ?? []
    const { template, networkPolicy } = createOptions
    // Options Daytona does not take fail before anything is created.
    const providerOptions = yield* Schema.decodeUnknownEffect(ProviderOptions)(
      createOptions.providerOptions?.[providerId] ?? {}
    ).pipe(
      Effect.mapError((error) =>
        sandboxError(new SandboxError.InvalidOptionsError({ description: error.message }), error)
      )
    )
    const base = providerOptions.snapshot ?? options.snapshot
    // A policy Daytona cannot enforce fails before anything is created.
    const networkSettings = networkPolicy === undefined ? undefined : yield* networkSettingsOf(networkPolicy)
    const templateSnapshot =
      template === undefined
        ? Option.none<string>()
        : yield* findSnapshot(daytona, scope, template, base, (name) => makeSnapshot(template, base, name)).pipe(
            Effect.provideService(Crypto.Crypto, crypto)
          )
    const snapshot = Option.getOrElse(templateSnapshot, () => base)
    // Until the template's snapshot is made, each sandbox is prepared on its own, before its
    // network policy applies, as preparing may download what the template installs.
    const preparesHere = template !== undefined && Option.isNone(templateSnapshot)
    return yield* Effect.acquireUseRelease(
      createSandbox(id, {
        labels: { [portsLabel]: ports.join(",") },
        autoStopInterval: providerOptions.autoStopInterval ?? options.autoStopInterval ?? 0,
        ...(snapshot === undefined ? {} : { snapshot }),
        // Daytona applies a policy it is created with before the sandbox starts.
        ...(preparesHere ? {} : networkSettings)
      }),
      (sandbox) =>
        Effect.tap(openSandbox(sandbox, id), (opened) =>
          preparesHere
            ? template.prepare.pipe(
                Effect.provide(Sandbox.layerServices(opened)),
                Effect.andThen(
                  networkSettings === undefined
                    ? Effect.void
                    : retryConflicts(call(() => sandbox.updateNetworkSettings(networkSettings)))
                )
              )
            : Effect.void
        ),
      // A failed create leaves no sandbox behind to resume.
      (sandbox, exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.ignore(call(() => sandbox.delete())))
    )
  })

  const resume = Effect.fn("DaytonaSandboxProvider.resume")(function* (id: Sandbox.SandboxId) {
    const sandbox = yield* call(() => daytona.get(id))
    if (deletedStates.has(sandbox.state ?? "")) {
      return yield* sandboxError(new SandboxError.NotFoundError({ description: `The sandbox ${id} was destroyed` }))
    }
    if (sandbox.state !== "started") yield* retryConflicts(call(() => sandbox.start()))
    return yield* openSandbox(sandbox, id)
  })

  return SandboxProvider.make({ create, resume })
})

/**
 * Provides the `SandboxProvider` service over Daytona with `options`, as `make` makes it, to a
 * program that keeps its sandboxes on Daytona.
 *
 * **Example** (Sandboxes of the organization whose key the environment holds)
 *
 * ```ts
 * import { SandboxProvider } from "@amends-dev/sandbox"
 * import { DaytonaSandboxProvider } from "@amends-dev/sandbox-daytona"
 * import { BunCrypto } from "@effect/platform-bun"
 * import { Config, Effect, Layer } from "effect"
 *
 * const sandboxes = Layer.unwrap(
 *   Effect.map(Config.Redacted("DAYTONA_API_KEY"), (apiKey) => DaytonaSandboxProvider.layer({ apiKey }))
 * ).pipe(Layer.provide(BunCrypto.layer))
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

/** The ports a sandbox's label names. */
const portsOf = (labels: Readonly<Record<string, string>>): ReadonlyArray<Network.Port> =>
  (labels[portsLabel] ?? "")
    .split(",")
    .filter((port) => port !== "")
    .map((port) => Network.Port.make(Number(port)))

/**
 * The network settings that replace a sandbox's with `policy`. Daytona keeps a setting an update
 * leaves out, so each policy sets all three, and a list that allows nothing blocks everything.
 * Daytona allows either hosts or CIDR ranges, and denies none.
 */
const networkSettingsOf = Network.NetworkPolicy.match({
  AllowAll: () => Effect.succeed({ networkBlockAll: false, domainAllowList: "", networkAllowList: "" }),
  DenyAll: () => Effect.succeed({ networkBlockAll: true, domainAllowList: "", networkAllowList: "" }),
  AllowList: ({ allowedHosts, allowedCidrs, deniedCidrs }) => {
    if (deniedCidrs.length > 0 || (allowedHosts.length > 0 && allowedCidrs.length > 0)) {
      return Effect.fail(
        sandboxError(
          new SandboxError.UnsupportedError({
            description: "Daytona allows either hosts or CIDR ranges, and denies none"
          })
        )
      )
    }
    return Effect.succeed({
      networkBlockAll: allowedHosts.length === 0 && allowedCidrs.length === 0,
      domainAllowList: allowedHosts.join(","),
      networkAllowList: allowedCidrs.join(",")
    })
  }
})

/**
 * Retries a change to a sandbox that Daytona refused because another change to it was in progress,
 * as one is after a network update, which Daytona applies after answering it.
 */
const retryConflicts = <A, R>(change: Effect.Effect<A, SandboxError.SandboxError, R>) =>
  Effect.retry(change, {
    while: (error) => error.cause instanceof DaytonaConflictError,
    schedule: Schedule.spaced("250 millis").pipe(Schedule.upTo({ duration: "30 seconds" }))
  })
