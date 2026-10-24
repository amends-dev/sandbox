import { Sandbox } from "@amends-dev/sandbox"
import { E2bSandboxProvider } from "@amends-dev/sandbox-e2b"
import { BunCrypto } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { AuthenticationError, InvalidArgumentError, SandboxNotFoundError, ServiceBusyError } from "e2b"
import { Effect, Redacted } from "effect"
import { fromE2bError } from "../src/internal/call.ts"
import { networkSettingsOf } from "../src/internal/network.ts"

const id = Sandbox.SandboxId.make("provider-test")
const apiKey = Redacted.make("test-key")

const withApi = (fetch: (request: Request) => Response | Promise<Response>) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })),
    (server) => Effect.promise(() => server.stop(true))
  )

const listed = (sandboxID: string) => ({
  sandboxID,
  templateID: "base",
  metadata: { "amends-provider": "e2b", "amends-id": id },
  startedAt: "2026-01-01T00:00:00Z",
  endAt: "2026-01-01T01:00:00Z",
  state: "running",
  cpuCount: 2,
  memoryMB: 512,
  envdVersion: "0.5.0"
})

it.effect("rejects invalid options and unrepresentable policies before contacting E2B", () =>
  Effect.gen(function* () {
    let requests = 0
    const server = yield* withApi(() => {
      requests++
      return new Response(null, { status: 500 })
    })
    const sandboxProvider = yield* E2bSandboxProvider.make({ apiKey, apiUrl: server.url.toString() })
    const invalid = yield* Effect.flip(sandboxProvider.create({ providerOptions: { e2b: { timeoutMs: 0 } } }))
    const excess = yield* Effect.flip(sandboxProvider.create({ providerOptions: { e2b: { misspelled: true } } }))
    const denied = yield* Effect.flip(
      sandboxProvider.create({
        networkPolicy: {
          _tag: "AllowList",
          allowedHosts: [],
          allowedCidrs: ["10.0.0.0/8"],
          deniedCidrs: ["10.0.0.1/32"]
        }
      })
    )
    expect([invalid.reason._tag, excess.reason._tag, denied.reason._tag]).toEqual([
      "InvalidOptionsError",
      "InvalidOptionsError",
      "UnsupportedError"
    ])
    expect(requests).toBe(0)
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("reads every metadata page and refuses ambiguous logical IDs without connecting or deleting", () =>
  Effect.gen(function* () {
    const requests: Array<string> = []
    const server = yield* withApi((request) => {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)
      expect(new URLSearchParams(url.searchParams.get("metadata") ?? "").get("amends-id")).toBe(id)
      if (url.searchParams.get("nextToken") === "second") return Response.json([listed("machine-b")])
      return Response.json([listed("machine-a")], { headers: { "x-next-token": "second" } })
    })
    const sandboxProvider = yield* E2bSandboxProvider.make({ apiKey, apiUrl: server.url.toString() })
    const error = yield* Effect.flip(sandboxProvider.resume(id))
    expect(error.reason._tag).toBe("UnknownError")
    expect(error.message).toContain("Conflicting E2B machines")
    expect(requests).toEqual(["GET /v2/sandboxes", "GET /v2/sandboxes"])
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("cleans up only its own allocation when a competing creator becomes visible", () =>
  Effect.gen(function* () {
    let allocated = false
    const deleted: Array<string> = []
    const payloads: Array<unknown> = []
    const server = yield* withApi(async (request) => {
      const url = new URL(request.url)
      if (request.method === "POST") {
        payloads.push(await request.json())
        allocated = true
        return Response.json(
          { sandboxID: "own-machine", envdVersion: "0.5.0", sandboxDomain: "e2b.app" },
          { status: 201 }
        )
      }
      if (request.method === "DELETE") {
        deleted.push(url.pathname)
        return new Response(null, { status: 204 })
      }
      return Response.json(allocated ? [listed("own-machine"), listed("winner-machine")] : [])
    })
    const sandboxProvider = yield* E2bSandboxProvider.make({ apiKey, apiUrl: server.url.toString() })
    const error = yield* Effect.flip(
      sandboxProvider.create({ id, providerOptions: { e2b: { template: "custom", timeoutMs: 90_000 } } })
    )
    expect(error.reason._tag).toBe("AlreadyExistsError")
    expect(deleted).toEqual(["/sandboxes/own-machine"])
    expect(payloads).toEqual([
      expect.objectContaining({
        templateID: "custom",
        timeout: 90,
        autoPause: true,
        autoPauseMemory: false,
        autoResume: { enabled: false },
        network: expect.objectContaining({ allowPublicTraffic: false })
      })
    ])
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("refuses an existing ID without allocating and reports unknown IDs without creating", () =>
  Effect.gen(function* () {
    let existing = true
    const methods: Array<string> = []
    const server = yield* withApi((request) => {
      methods.push(request.method)
      return Response.json(existing ? [listed("existing")] : [])
    })
    const sandboxProvider = yield* E2bSandboxProvider.make({ apiKey, apiUrl: server.url.toString() })
    expect((yield* Effect.flip(sandboxProvider.create({ id }))).reason._tag).toBe("AlreadyExistsError")
    existing = false
    expect((yield* Effect.flip(sandboxProvider.resume(id))).reason._tag).toBe("NotFoundError")
    expect(methods).toEqual(["GET", "GET"])
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("classifies HTTP errors that the SDK exposes as generic SandboxError", () =>
  Effect.gen(function* () {
    const outcomes: Array<string> = []
    for (const status of [403, 404, 400, 409, 429, 500]) {
      const server = yield* withApi(() => Response.json({ message: `Failure ${status}` }, { status }))
      const sandboxProvider = yield* E2bSandboxProvider.make({ apiKey, apiUrl: server.url.toString() })
      const error = yield* Effect.flip(sandboxProvider.resume(id))
      outcomes.push(error.reason._tag)
    }
    expect(outcomes).toEqual([
      "AuthenticationError",
      "NotFoundError",
      "InvalidOptionsError",
      "UnavailableError",
      "UnavailableError",
      "UnavailableError"
    ])
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("recovers a failed allocation response by its unique creation metadata without deleting a competitor", () =>
  Effect.gen(function* () {
    let allocated = false
    const deleted: Array<string> = []
    const server = yield* withApi((request) => {
      const url = new URL(request.url)
      if (request.method === "POST") {
        allocated = true
        return Response.json({ code: 500, message: "response lost after allocation" }, { status: 500 })
      }
      if (request.method === "DELETE") {
        deleted.push(url.pathname)
        return new Response(null, { status: 204 })
      }
      if (!allocated) return Response.json([])
      const metadata = new URLSearchParams(url.searchParams.get("metadata") ?? "")
      expect(metadata.get("amends-creation")).toMatch(/^[a-f0-9-]{36}$/)
      return Response.json([listed("own-machine")])
    })
    const sandboxProvider = yield* E2bSandboxProvider.make({ apiKey, apiUrl: server.url.toString() })
    expect((yield* Effect.flip(sandboxProvider.create({ id }))).reason._tag).toBe("UnavailableError")
    expect(deleted).toEqual(["/sandboxes/own-machine"])
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("replaces network policies without retaining an earlier allow list", () =>
  Effect.gen(function* () {
    expect(
      yield* networkSettingsOf({
        _tag: "AllowList",
        allowedHosts: ["example.com"],
        allowedCidrs: ["1.1.1.1/32"],
        deniedCidrs: []
      })
    ).toEqual({ allowOut: ["example.com", "1.1.1.1/32"], denyOut: ["0.0.0.0/0"] })
    expect(yield* networkSettingsOf({ _tag: "DenyAll" })).toEqual({ allowOut: [], denyOut: ["0.0.0.0/0"] })
    expect(yield* networkSettingsOf({ _tag: "AllowAll" })).toEqual({ allowOut: [], denyOut: [] })
  })
)

it("maps SDK failures without hiding authentication, missing resources or temporary failures", () => {
  expect(fromE2bError(new AuthenticationError("no key")).reason._tag).toBe("AuthenticationError")
  expect(fromE2bError(new SandboxNotFoundError("gone")).reason._tag).toBe("NotFoundError")
  expect(fromE2bError(new InvalidArgumentError("invalid")).reason._tag).toBe("InvalidOptionsError")
  expect(fromE2bError(new ServiceBusyError("busy")).reason._tag).toBe("UnavailableError")
  expect(fromE2bError(new Error("unknown")).reason._tag).toBe("UnknownError")
})
