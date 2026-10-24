/**
 * Persistent named sandboxes on Vercel. Logical IDs are project-scoped sandbox names;
 * filesystem snapshots survive stops while the processes belong to one VM session.
 *
 * @since 0.1.0
 */

import { Network, Sandbox, SandboxError, SandboxProvider } from "@amends-dev/sandbox"
import { Sandbox as VercelSandbox } from "@vercel/sandbox"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import { call, providerId, sandboxError } from "./internal/call.ts"
import { makeFileSystem } from "./internal/files.ts"
import { hasRequestRules, networkPolicyOf, withTransformations } from "./internal/network.ts"
import { makeChildProcessSpawner } from "./internal/processes.ts"

/** @category options
 * @since 0.1.0
 */
export interface Options {
  readonly token: Redacted.Redacted<string>
  readonly teamId: string
  readonly projectId: string
  readonly image?: string
  readonly timeoutMs?: number
  /** The SDK transport, for proxies and tests; credentials are still explicit. */
  readonly fetch?: typeof globalThis.fetch
}

/** Overrides under `providerOptions.vercel`, validated before allocating.
 * @category options
 * @since 0.1.0
 */
export const ProviderOptions = Schema.Struct({
  image: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})

/** @category options
 * @since 0.1.0
 */
export type ProviderOptions = typeof ProviderOptions.Type

/** Constructs a Vercel provider with explicit account credentials.
 * @category constructors
 * @since 0.1.0
 */
export const make = Effect.fnUntraced(function* (options: Options) {
  const crypto = yield* Crypto.Crypto
  const updates = yield* Semaphore.make(1)
  const connection = {
    token: Redacted.value(options.token),
    teamId: options.teamId,
    projectId: options.projectId,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  }
  const get = (id: Sandbox.SandboxId, resume = false) =>
    call(() => VercelSandbox.get({ ...connection, name: id, resume }))

  const openSandbox = Effect.fnUntraced(function* (sandbox: VercelSandbox, id: Sandbox.SandboxId) {
    const session = sandbox.currentSession()
    const workingDirectory = session.cwd
    return Sandbox.Sandbox.of({
      id,
      workingDirectory,
      fileSystem: makeFileSystem(session, workingDirectory),
      childProcessSpawner: yield* makeChildProcessSpawner(session, workingDirectory).pipe(
        Effect.provideService(Crypto.Crypto, crypto)
      ),
      exposePorts: (ports) =>
        updates.withPermit(
          Effect.gen(function* () {
            const current = yield* get(id)
            const desired = [...new Set([...current.routes.map((route) => route.port), ...ports])]
            yield* call(() => current.update({ ports: desired }))
          })
        ),
      endpoint: (port, protocol) =>
        Effect.gen(function* () {
          const current = yield* get(id)
          if (!current.routes.some((route) => route.port === port)) {
            return yield* sandboxError(new SandboxError.NotFoundError({ description: `Port ${port} is not exposed` }))
          }
          const url = current.domain(port)
          return { url: protocol === "ws" ? url.replace(/^https:/, "wss:").replace(/^http:/, "ws:") : url, headers: {} }
        }),
      stop: Effect.gen(function* () {
        const current = yield* get(id)
        if (current.status !== "stopped") yield* call(() => current.stop())
      }),
      destroy: Effect.asVoid(call(() => sandbox.delete({ deleteOrphanSnapshots: true }))).pipe(
        Effect.catchReason("SandboxError", "NotFoundError", () => Effect.void)
      ),
      setNetworkPolicy: (policy) =>
        updates.withPermit(
          Effect.gen(function* () {
            const current = yield* get(id)
            const network = current.networkPolicy
            if (hasRequestRules(network)) {
              return yield* sandboxError(
                new SandboxError.UnsupportedError({
                  description:
                    "Vercel redacts existing request transformations; changing their network policy would discard those rules"
                })
              )
            }
            yield* call(() => current.update({ networkPolicy: networkPolicyOf(policy) }))
          })
        ),
      setRequestTransformations: (transformations) =>
        updates.withPermit(
          Effect.gen(function* () {
            const current = yield* get(id)
            const networkPolicy = yield* withTransformations(current.networkPolicy, transformations)
            yield* call(() => current.update({ networkPolicy }))
          })
        )
    })
  })

  const create = Effect.fn("VercelSandboxProvider.create")(function* <E = never>(
    createOptions: SandboxProvider.CreateOptions<E> = {}
  ) {
    const providerOptions = yield* Schema.decodeUnknownEffect(ProviderOptions)(
      createOptions.providerOptions?.[providerId] ?? {},
      { onExcessProperty: "error" }
    ).pipe(
      Effect.mapError((error) => sandboxError(new SandboxError.InvalidOptionsError({ description: error.message })))
    )
    const id =
      createOptions.id ??
      Sandbox.SandboxId.make(
        yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError((error) => sandboxError(new SandboxError.UnknownError({ description: error.message }))))
      )
    const image = providerOptions.image ?? options.image
    const policy = networkPolicyOf(createOptions.networkPolicy ?? Network.NetworkPolicy.cases.AllowAll.make({}))
    const attempt = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError((error) => sandboxError(new SandboxError.UnknownError({ description: error.message }))))
    // Vercel atomically rejects duplicate project-scoped names; never get-or-create here.
    return yield* Effect.acquireUseRelease(
      call(() =>
        VercelSandbox.create({
          ...connection,
          name: id,
          persistent: true,
          snapshotExpiration: 0,
          tags: { "amends-creation": attempt },
          keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: true },
          ...(image === undefined ? {} : { image }),
          timeout: providerOptions.timeoutMs ?? options.timeoutMs ?? 3_600_000,
          ports: [...(createOptions.ports ?? [])],
          networkPolicy: createOptions.template === undefined ? policy : "allow-all"
        })
      ).pipe(
        Effect.tapError(() =>
          get(id).pipe(
            Effect.flatMap((allocated) =>
              allocated.tags?.["amends-creation"] === attempt
                ? call(() => allocated.delete({ deleteOrphanSnapshots: true }))
                : Effect.void
            ),
            Effect.ignore
          )
        )
      ),
      (sandbox) =>
        Effect.gen(function* () {
          const opened = yield* openSandbox(sandbox, id)
          if (createOptions.template !== undefined) {
            yield* createOptions.template.prepare.pipe(Effect.provide(Sandbox.layerServices(opened)))
            yield* call(() => sandbox.update({ networkPolicy: policy }))
          }
          return opened
        }),
      (sandbox, exit) =>
        Exit.isSuccess(exit) ? Effect.void : Effect.orDie(call(() => sandbox.delete({ deleteOrphanSnapshots: true })))
    )
  })
  const resume = Effect.fn("VercelSandboxProvider.resume")(function* (id: Sandbox.SandboxId) {
    return yield* openSandbox(yield* get(id, true), id)
  })
  return SandboxProvider.make({ create, resume })
})

/** @category layers
 * @since 0.1.0
 */
export const layer = (options: Options) => Layer.effect(SandboxProvider.SandboxProvider, make(options))
