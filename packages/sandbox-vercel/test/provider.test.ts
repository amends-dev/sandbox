import { Network, Sandbox, Template } from "@amends-dev/sandbox"
import { VercelSandboxProvider } from "@amends-dev/sandbox-vercel"
import { BunCrypto } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { APIError } from "@vercel/sandbox"
import { Deferred, Effect, Fiber, Redacted, Schema } from "effect"
import { fromVercelError } from "../src/internal/call.ts"
import { apiError, credentials, responseOf, routesOf, sandboxData, sessionData, withApi } from "./api.ts"

const id = Sandbox.SandboxId.make("provider-test")
const options = { ...credentials, token: Redacted.make(credentials.token) }

it.effect("validates provider options before allocating", () =>
  Effect.gen(function* () {
    let requests = 0
    const fetch = yield* withApi(() => {
      requests++
      return apiError(400)
    })
    const provider = yield* VercelSandboxProvider.make({ ...options, fetch })
    expect((yield* Effect.flip(provider.create({ providerOptions: { vercel: { timeoutMs: 0 } } }))).reason._tag).toBe(
      "InvalidOptionsError"
    )
    expect((yield* Effect.flip(provider.create({ providerOptions: { vercel: { typo: true } } }))).reason._tag).toBe(
      "InvalidOptionsError"
    )
    expect(requests).toBe(0)
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("creates a persistent named sandbox with explicit credentials, ports and denied egress", () =>
  Effect.gen(function* () {
    const payloads: Array<unknown> = []
    const fetch = yield* withApi(async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer test-token")
      expect(new URL(request.url).searchParams.get("teamId")).toBe("team_test")
      expect(request.method).toBe("POST")
      expect(new URL(request.url).pathname).toBe("/api/v3/sandboxes")
      payloads.push(await request.json())
      return Response.json(responseOf(id, {}, [4500]))
    })
    const provider = yield* VercelSandboxProvider.make({ ...options, fetch })
    const sandbox = yield* provider.create({
      id,
      ports: [Network.Port.make(4500)],
      networkPolicy: { _tag: "DenyAll" },
      providerOptions: { vercel: { image: "custom:v1", timeoutMs: 90_000 } }
    })
    expect(sandbox.id).toBe(id)
    expect(sandbox.workingDirectory).toBe("/vercel/sandbox")
    expect(payloads).toEqual([
      expect.objectContaining({
        name: id,
        persistent: true,
        projectId: credentials.projectId,
        image: "custom:v1",
        timeout: 90_000,
        networkPolicy: { mode: "deny-all" },
        ports: [4500],
        snapshotExpiration: 0,
        keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: true }
      })
    ])
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("refuses an occupied name without deleting it and resumes unknown names without creating", () =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    let found = true
    const fetch = yield* withApi((request) => {
      calls.push(request.method)
      if (request.method === "POST") return apiError(409, "already_exists")
      return found ? Response.json(responseOf(id, { tags: { "amends-creation": "another-attempt" } })) : apiError(404)
    })
    const provider = yield* VercelSandboxProvider.make({ ...options, fetch })
    expect((yield* Effect.flip(provider.create({ id }))).reason._tag).toBe("AlreadyExistsError")
    found = false
    expect((yield* Effect.flip(provider.resume(id))).reason._tag).toBe("NotFoundError")
    expect(calls).toEqual(["POST", "GET", "GET"])
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("removes its own allocation after an unsuccessful response without claiming a competing name", () =>
  Effect.gen(function* () {
    let tags: unknown
    const methods: Array<string> = []
    const fetch = yield* withApi(async (request) => {
      methods.push(request.method)
      if (request.method === "POST") {
        tags = Schema.decodeUnknownSync(Schema.Struct({ tags: Schema.Record(Schema.String, Schema.String) }))(
          await request.json()
        ).tags
        return apiError(400, "allocated_but_response_failed")
      }
      if (request.method === "DELETE")
        expect(new URL(request.url).searchParams.get("deleteOrphanSnapshots")).toBe("true")
      return Response.json(responseOf(id, { tags }))
    })
    const provider = yield* VercelSandboxProvider.make({ ...options, fetch })
    expect((yield* Effect.flip(provider.create({ id }))).reason._tag).toBe("InvalidOptionsError")
    expect(methods).toEqual(["POST", "GET", "DELETE"])
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("destroys failed and interrupted preparations before returning", () =>
  Effect.gen(function* () {
    const deleted: Array<string> = []
    const policies: Array<unknown> = []
    const fetch = yield* withApi(async (request) => {
      if (request.method === "POST")
        policies.push(
          Schema.decodeUnknownSync(Schema.Struct({ networkPolicy: Schema.Unknown }))(await request.json()).networkPolicy
        )
      if (request.method === "DELETE") deleted.push(new URL(request.url).pathname)
      return Response.json(responseOf(id))
    })
    const provider = yield* VercelSandboxProvider.make({ ...options, fetch })
    const failed = yield* Effect.flip(
      provider.create({
        id,
        networkPolicy: { _tag: "DenyAll" },
        template: {
          name: Template.TemplateName.make("failure"),
          identity: "failure",
          prepare: Effect.fail("preparation failed")
        }
      })
    )
    expect(failed).toBe("preparation failed")
    const preparing = yield* Deferred.make<void>()
    const fiber = yield* provider
      .create({
        id,
        template: {
          name: Template.TemplateName.make("interrupted"),
          identity: "interrupted",
          prepare: Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never))
        }
      })
      .pipe(Effect.forkChild)
    yield* Deferred.await(preparing)
    yield* Fiber.interrupt(fiber)
    expect(deleted).toEqual([`/api/v2/sandboxes/${id}`, `/api/v2/sandboxes/${id}`])
    expect(policies).toEqual([{ mode: "allow-all" }, { mode: "allow-all" }])
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("applies the final policy only after successful preparation", () =>
  Effect.gen(function* () {
    const events: Array<string> = []
    const fetch = yield* withApi(async (request) => {
      events.push(request.method)
      if (request.method === "PATCH")
        expect(
          Schema.decodeUnknownSync(Schema.Struct({ networkPolicy: Schema.Unknown }))(await request.json()).networkPolicy
        ).toEqual({ mode: "deny-all" })
      return Response.json(responseOf(id))
    })
    const provider = yield* VercelSandboxProvider.make({ ...options, fetch })
    yield* provider.create({
      id,
      networkPolicy: { _tag: "DenyAll" },
      template: {
        name: Template.TemplateName.make("prepared"),
        identity: "prepared",
        prepare: Effect.sync(() => {
          events.push("prepared")
        })
      }
    })
    expect(events).toEqual(["POST", "prepared", "PATCH", "POST"])
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("refreshes ports across handles, preserves existing ports and gives HTTPS and WebSocket URLs", () =>
  Effect.gen(function* () {
    let ports = [4500]
    const fetch = yield* withApi(async (request) => {
      if (request.method === "PATCH")
        ports = Schema.decodeUnknownSync(Schema.Struct({ ports: Schema.Array(Schema.Finite) }))(
          await request.json()
        ).ports.slice()
      return Response.json(responseOf(id, {}, ports))
    })
    const provider = yield* VercelSandboxProvider.make({ ...options, fetch })
    const first = yield* provider.resume(id)
    const second = yield* provider.resume(id)
    yield* second.exposePorts([Network.Port.make(4600)])
    yield* second.exposePorts([Network.Port.make(4600)])
    expect(ports).toEqual([4500, 4600])
    expect(yield* first.endpoint(Network.Port.make(4600), "ws")).toEqual({
      url: "wss://test-4600.vercel.run",
      headers: {}
    })
    expect(yield* first.endpoint(Network.Port.make(4500), "http")).toEqual({
      url: "https://test-4500.vercel.run",
      headers: {}
    })
    expect((yield* Effect.flip(first.endpoint(Network.Port.make(4700), "http"))).reason._tag).toBe("NotFoundError")
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("stops the latest session without resuming it, resumes explicitly and destroys idempotently", () =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    let stopped = false
    let deleted = false
    const fetch = yield* withApi((request) => {
      const url = new URL(request.url)
      calls.push(`${request.method} ${url.pathname}${url.searchParams.get("resume") === "true" ? " resume" : ""}`)
      if (deleted) return apiError(404)
      if (url.pathname.endsWith("/stop")) {
        stopped = true
        return Response.json({ session: sessionData(id, "stopped"), sandbox: sandboxData(id, { status: "stopped" }) })
      }
      if (request.method === "DELETE") deleted = true
      const status = stopped ? "stopped" : "running"
      return Response.json({
        sandbox: sandboxData(id, { status }),
        session: sessionData(id, status),
        routes: routesOf([])
      })
    })
    const provider = yield* VercelSandboxProvider.make({ ...options, fetch })
    const sandbox = yield* provider.resume(id)
    yield* sandbox.stop
    yield* sandbox.stop
    yield* sandbox.destroy
    yield* sandbox.destroy
    expect(calls.filter((call) => call.includes("/stop"))).toHaveLength(1)
    expect(calls.filter((call) => call.endsWith(" resume"))).toHaveLength(1)
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it("classifies API errors by HTTP status", () => {
  const tags = [400, 401, 403, 404, 409, 429, 500].map(
    (status) => fromVercelError(new APIError(new Response(null, { status }))).reason._tag
  )
  expect(tags).toEqual([
    "InvalidOptionsError",
    "AuthenticationError",
    "AuthenticationError",
    "NotFoundError",
    "AlreadyExistsError",
    "UnavailableError",
    "UnavailableError"
  ])
})

it.effect("preserves authentication failures when the ownership check also fails", () =>
  Effect.gen(function* () {
    const fetch = yield* withApi(() => apiError(401, "invalid_token"))
    const provider = yield* VercelSandboxProvider.make({ ...options, fetch })
    expect((yield* Effect.flip(provider.create({ id }))).reason._tag).toBe("AuthenticationError")
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)
