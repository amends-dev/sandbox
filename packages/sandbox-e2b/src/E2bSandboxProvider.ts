/**
 * E2B sandboxes, resumed through provider-owned metadata and stopped with filesystem-only
 * persistence so processes do not return on resume. E2B assigns its own machine IDs; logical
 * IDs are metadata, not an atomic distributed name reservation. See the package README.
 *
 * @since 0.1.0
 */

import { Network, Sandbox, SandboxError, SandboxProvider } from "@amends-dev/sandbox"
import { Sandbox as E2bSandbox, type ConnectionOpts, type SandboxInfo } from "e2b"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import { call, providerId, sandboxError } from "./internal/call.ts"
import { makeFileSystem } from "./internal/files.ts"
import { networkSettingsOf } from "./internal/network.ts"
import { makeChildProcessSpawner } from "./internal/processes.ts"

/**
 * Connection settings and defaults for machines created by this provider.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options {
  readonly apiKey: Redacted.Redacted<string>
  readonly apiUrl?: string
  readonly domain?: string
  /** E2B template or snapshot ID; defaults to E2B's base image. */
  readonly template?: string
  /** E2B's running lifetime; defaults to one hour, then pauses with files preserved. */
  readonly timeoutMs?: number
  readonly requestTimeoutMs?: number
}

/**
 * Overrides under `providerOptions.e2b`. Invalid options fail before any allocation.
 *
 * @category options
 * @since 0.1.0
 */
export const ProviderOptions = Schema.Struct({
  template: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})

/** @category options
 * @since 0.1.0
 */
export type ProviderOptions = typeof ProviderOptions.Type

const ownerKey = "amends-provider"
const idKey = "amends-id"
const creationKey = "amends-creation"
const portDirectory = "/var/tmp/amends/ports"

/**
 * Constructs the provider using Effect's Crypto service for generated logical IDs.
 * Templates prepare each sandbox before its requested network policy is applied.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = Effect.fnUntraced(function* (options: Options) {
  const crypto = yield* Crypto.Crypto
  const creates = yield* Semaphore.make(1)
  const connection: ConnectionOpts = {
    apiKey: Redacted.value(options.apiKey),
    // Explicit defaults avoid ambient SDK configuration changing which account endpoint is used.
    apiUrl: options.apiUrl ?? `https://api.${options.domain ?? "e2b.app"}`,
    domain: options.domain ?? "e2b.app",
    debug: false,
    retries: 0,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs })
  }

  const findSandboxes = Effect.fnUntraced(function* (id: Sandbox.SandboxId, creation?: string) {
    const paginator = E2bSandbox.list({
      ...connection,
      query: {
        metadata: {
          [ownerKey]: providerId,
          [idKey]: id,
          ...(creation === undefined ? {} : { [creationKey]: creation })
        },
        state: ["running", "paused"]
      }
    })
    const found: Array<SandboxInfo> = []
    while (paginator.hasNext) found.push(...(yield* call(() => paginator.nextItems())))
    return found
  })

  const openSandbox = Effect.fnUntraced(function* (sandbox: E2bSandbox, id: Sandbox.SandboxId) {
    const workingDirectory = (yield* call(() => sandbox.commands.run("pwd -P"))).stdout.trim()
    const fileSystem = makeFileSystem(sandbox, workingDirectory)
    const exposePorts = (ports: ReadonlyArray<Network.Port>) =>
      Effect.forEach(ports, (port) => call(() => sandbox.files.write(`${portDirectory}/${port}`, "")), {
        discard: true
      })
    return Sandbox.Sandbox.of({
      id,
      workingDirectory,
      fileSystem,
      childProcessSpawner: yield* makeChildProcessSpawner(sandbox, workingDirectory).pipe(
        Effect.provideService(Crypto.Crypto, crypto)
      ),
      exposePorts,
      endpoint: (port, protocol) =>
        Effect.flatMap(
          call(() => sandbox.files.exists(`${portDirectory}/${port}`)),
          (exposed) =>
            exposed
              ? Effect.succeed({
                  url: `${protocol === "ws" ? "wss" : "https"}://${sandbox.getHost(port)}`,
                  headers:
                    sandbox.trafficAccessToken === undefined
                      ? {}
                      : { "e2b-traffic-access-token": Redacted.make(sandbox.trafficAccessToken) }
                })
              : Effect.fail(
                  sandboxError(new SandboxError.NotFoundError({ description: `Port ${port} is not exposed` }))
                )
        ),
      stop: Effect.flatMap(
        call(() => sandbox.getInfo()),
        (info) =>
          info.state === "paused" ? Effect.void : Effect.asVoid(call(() => sandbox.pause({ mode: "filesystem" })))
      ),
      destroy: Effect.asVoid(call(() => sandbox.kill())).pipe(
        Effect.catchReason("SandboxError", "NotFoundError", () => Effect.void)
      ),
      setNetworkPolicy: (policy) =>
        Effect.flatMap(networkSettingsOf(policy), (settings) => call(() => sandbox.updateNetwork(settings))),
      setRequestTransformations: () =>
        Effect.fail(
          sandboxError(
            new SandboxError.UnsupportedError({
              description: "E2B's host-only transformations cannot enforce request path and header matching"
            })
          )
        )
    })
  })

  const create = Effect.fn("E2bSandboxProvider.create")(
    function* <E = never>(createOptions: SandboxProvider.CreateOptions<E> = {}) {
      const providerOptions = yield* Schema.decodeUnknownEffect(ProviderOptions)(
        createOptions.providerOptions?.[providerId] ?? {},
        { onExcessProperty: "error" }
      ).pipe(
        Effect.mapError((error) => sandboxError(new SandboxError.InvalidOptionsError({ description: error.message })))
      )
      const policy = yield* networkSettingsOf(
        createOptions.networkPolicy ?? Network.NetworkPolicy.cases.AllowAll.make({})
      )
      const id =
        createOptions.id ??
        Sandbox.SandboxId.make(
          yield* crypto
            .randomUUIDv4()
            .pipe(
              Effect.mapError((error) => sandboxError(new SandboxError.UnknownError({ description: error.message })))
            )
        )
      if ((yield* findSandboxes(id)).length > 0) {
        return yield* sandboxError(new SandboxError.AlreadyExistsError({ description: `Sandbox ${id} already exists` }))
      }
      const template = providerOptions.template ?? options.template
      const creation = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((error) => sandboxError(new SandboxError.UnknownError({ description: error.message }))))
      return yield* Effect.acquireUseRelease(
        call(() =>
          E2bSandbox.create({
            ...connection,
            ...(template === undefined ? {} : { template }),
            timeoutMs: providerOptions.timeoutMs ?? options.timeoutMs ?? 3_600_000,
            metadata: { [ownerKey]: providerId, [idKey]: id, [creationKey]: creation },
            lifecycle: { onTimeout: { action: "pause", mode: "filesystem" }, autoResume: false },
            network: { allowPublicTraffic: false, ...(createOptions.template === undefined ? policy : {}) }
          })
        ).pipe(
          // A failed response can still have allocated. Locate only this attempt, never a rival's ID.
          Effect.tapError(() =>
            findSandboxes(id, creation).pipe(
              Effect.flatMap((allocated) =>
                Effect.forEach(allocated, (sandbox) => call(() => E2bSandbox.kill(sandbox.sandboxId, connection)), {
                  discard: true
                })
              ),
              Effect.ignore
            )
          )
        ),
        (sandbox) =>
          Effect.gen(function* () {
            // Only this call's machine is cleaned up on failure. Never delete a competing creator's.
            const matches = yield* findSandboxes(id)
            if (matches.some((other) => other.sandboxId !== sandbox.sandboxId)) {
              return yield* sandboxError(
                new SandboxError.AlreadyExistsError({ description: `Another host created sandbox ${id} concurrently` })
              )
            }
            const opened = yield* openSandbox(sandbox, id)
            yield* opened.exposePorts(createOptions.ports ?? [])
            if (createOptions.template !== undefined) {
              yield* createOptions.template.prepare.pipe(Effect.provide(Sandbox.layerServices(opened)))
              yield* call(() => sandbox.updateNetwork(policy))
            }
            return opened
          }),
        (sandbox, exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.orDie(call(() => sandbox.kill())))
      )
    },
    (effect) => creates.withPermit(effect)
  )

  const resume = Effect.fn("E2bSandboxProvider.resume")(function* (id: Sandbox.SandboxId) {
    const matches = yield* findSandboxes(id)
    if (matches.length > 1) {
      return yield* sandboxError(
        new SandboxError.UnknownError({ description: `Conflicting E2B machines claim logical sandbox ${id}` })
      )
    }
    const info = matches[0]
    if (info === undefined) {
      return yield* sandboxError(new SandboxError.NotFoundError({ description: `Sandbox ${id} does not exist` }))
    }
    const sandbox = yield* call(() =>
      E2bSandbox.connect(info.sandboxId, { ...connection, timeoutMs: options.timeoutMs ?? 3_600_000 })
    )
    return yield* openSandbox(sandbox, id)
  })

  return SandboxProvider.make({ create, resume })
})

/**
 * Provides sandboxes through E2B using `make`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: Options) => Layer.effect(SandboxProvider.SandboxProvider, make(options))
