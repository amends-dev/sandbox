import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpClient from "effect/http/HttpClient"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Record from "effect/Record"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Network from "../../Network.ts"
import * as Sandbox from "../../Sandbox.ts"
import type * as SandboxError from "../../SandboxError.ts"
import type * as Fixture from "../Fixture.ts"
import { newSandboxId, providerForTest } from "./perTest.ts"

/** Whether `change` was applied, or the reason it failed with. */
const outcomeOf = (change: Effect.Effect<void, SandboxError.SandboxError>) =>
  change.pipe(
    Effect.as("applied"),
    Effect.catch((error) => Effect.succeed(error.reason._tag))
  )

/** The headers the suite sends with a request through an endpoint, besides the endpoint's own. */
const requestHeaders = { authorization: "Bearer conformance", "x-conformance": "passed on" }

/** Reaching a sandbox's ports from outside it, and what the sandbox reaches outside. */
export const network = <R, E>(fixture: Fixture.Fixture<R, E>) => {
  /**
   * Serves HTTP on `port` in `sandbox` and returns the headers the server received with a request
   * through the port's endpoint.
   */
  const headersThrough = Effect.fnUntraced(function* (sandbox: Sandbox.Sandbox["Service"], port: Network.Port) {
    yield* Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.spawn(fixture.serveHeaders(port))
    }).pipe(Effect.provide(Sandbox.layerServices(sandbox)))

    const endpoint = yield* sandbox.endpoint(port, "http")
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      // The server listens a moment after it starts; until then requests fail.
      HttpClient.retry(Schedule.spaced("200 millis").pipe(Schedule.upTo({ duration: "30 seconds" })))
    )
    const response = yield* client.get(endpoint.url, {
      headers: { ...Record.map(endpoint.headers, Redacted.value), ...requestHeaders }
    })
    return yield* response.json
  })

  layer(fixture.layer, { excludeTestServices: true })("sandbox network", (it) => {
    it.effect(
      "reaches a server on a port exposed at creation, with the request's headers",
      () =>
        Effect.gen(function* () {
          const port = yield* fixture.freePort
          const sandboxProvider = yield* providerForTest(fixture)
          const sandbox = yield* sandboxProvider.create({ ports: [port] })

          expect(yield* headersThrough(sandbox, port)).toMatchObject(requestHeaders)
        }),
      fixture.timeout
    )

    it.effect(
      "exposes a port after creation to every value of the sandbox, or fails with UnsupportedError",
      () =>
        Effect.gen(function* () {
          const port = yield* fixture.freePort
          const sandboxProvider = yield* providerForTest(fixture)
          const sandbox = yield* sandboxProvider.create()
          const resumed = yield* sandboxProvider.resume(sandbox.id)

          const outcome = yield* outcomeOf(resumed.exposePorts([port]))

          expect(["applied", "UnsupportedError"]).toContain(outcome)
          if (outcome !== "applied") return
          // Exposing a port again succeeds.
          yield* resumed.exposePorts([port])
          // `sandbox` is from before the port was exposed through `resumed`, and sees it too.
          expect(yield* headersThrough(sandbox, port)).toMatchObject(requestHeaders)
        }),
      fixture.timeout
    )

    it.effect(
      "gives a WebSocket URL for an exposed port's ws endpoint",
      () =>
        Effect.gen(function* () {
          const port = yield* fixture.freePort
          const sandboxProvider = yield* providerForTest(fixture)
          const sandbox = yield* sandboxProvider.create({ ports: [port] })

          const endpoint = yield* sandbox.endpoint(port, "ws")

          expect(endpoint.url).toMatch(/^wss?:\/\//)
        }),
      fixture.timeout
    )

    it.effect(
      "fails with NotFoundError for a port the sandbox does not expose",
      () =>
        Effect.gen(function* () {
          const port = yield* fixture.freePort
          const sandboxProvider = yield* providerForTest(fixture)
          const sandbox = yield* sandboxProvider.create()

          const error = yield* Effect.flip(sandbox.endpoint(port, "http"))

          expect(error.reason._tag).toBe("NotFoundError")
        }),
      fixture.timeout
    )

    it.effect(
      "creates a sandbox under a network policy, or fails with UnsupportedError and creates none",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const id = yield* newSandboxId

          const outcome = yield* outcomeOf(
            Effect.asVoid(
              sandboxProvider.create({
                id,
                networkPolicy: Network.NetworkPolicy.cases.DenyAll.make({})
              })
            )
          )
          const resumed = yield* Effect.exit(sandboxProvider.resume(id))

          expect(["applied", "UnsupportedError"]).toContain(outcome)
          expect(Exit.isSuccess(resumed)).toBe(outcome === "applied")
        }),
      fixture.timeout
    )

    it.effect(
      "applies a network policy and request transformations, or fails with UnsupportedError",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const sandbox = yield* sandboxProvider.create()

          const policy = yield* outcomeOf(sandbox.setNetworkPolicy(Network.NetworkPolicy.cases.DenyAll.make({})))
          const transformations = yield* outcomeOf(
            sandbox.setRequestTransformations([
              {
                host: "api.example.com",
                matchHeaders: { authorization: "Bearer placeholder" },
                setHeaders: { authorization: Redacted.make("Bearer secret") }
              }
            ])
          )

          expect(["applied", "UnsupportedError"]).toContain(policy)
          expect(["applied", "UnsupportedError"]).toContain(transformations)
        }),
      fixture.timeout
    )
  })
}
