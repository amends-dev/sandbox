import { type Network, Sandbox } from "@amends-dev/sandbox"
import { VercelSandboxProvider } from "@amends-dev/sandbox-vercel"
import { BunCrypto } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import { networkPolicyOf, withTransformations } from "../src/internal/network.ts"
import { credentials, responseOf, withApi } from "./api.ts"

const transformation: Network.RequestTransformation = {
  host: "api.example.com",
  pathPrefix: "/v1/",
  matchHeaders: { Authorization: "Bearer placeholder" },
  setHeaders: { authorization: Redacted.make("Bearer secret") }
}

it.effect("builds exact request matchers while retaining denied subnets and replaces or revokes all old rules", () =>
  Effect.gen(function* () {
    const policy = { allow: ["api.example.com", "registry.npmjs.org"], subnets: { deny: ["169.254.169.254/32"] } }
    const result = yield* withTransformations(policy, [transformation])
    expect(result).toEqual({
      allow: {
        "api.example.com": [
          {
            match: {
              path: { startsWith: "/v1/" },
              headers: [{ key: { exact: "authorization" }, value: { exact: "Bearer placeholder" } }]
            },
            transform: [{ headers: { authorization: "Bearer secret" } }]
          }
        ],
        "registry.npmjs.org": []
      },
      subnets: { deny: ["169.254.169.254/32"] }
    })
    expect(yield* withTransformations(result, [])).toEqual({
      allow: { "api.example.com": [], "registry.npmjs.org": [] },
      subnets: policy.subnets
    })
    expect(
      yield* withTransformations(result, [
        {
          host: transformation.host,
          pathPrefix: "/v1/",
          matchHeaders: transformation.matchHeaders,
          setHeaders: { authorization: Redacted.make("replacement") }
        }
      ])
    ).toEqual(
      expect.objectContaining({
        allow: expect.objectContaining({
          "api.example.com": [expect.objectContaining({ transform: [{ headers: { authorization: "replacement" } }] })]
        })
      })
    )
  })
)

it.effect("refuses transformation rules that change access, bypass matching, or overlap on a host", () =>
  Effect.gen(function* () {
    const policies = [
      "allow-all" as const,
      "deny-all" as const,
      { allow: ["other.example.com"] },
      { allow: ["*.example.com"] },
      { allow: ["api.example.com"], subnets: { allow: ["0.0.0.0/0"] } }
    ]
    for (const policy of policies)
      expect((yield* Effect.flip(withTransformations(policy, [transformation]))).reason._tag).toBe("UnsupportedError")
    expect(
      (yield* Effect.flip(withTransformations({ allow: ["api.example.com"] }, [transformation, transformation]))).reason
        ._tag
    ).toBe("UnsupportedError")
    expect(yield* withTransformations("deny-all", [])).toBe("deny-all")
  })
)

it("maps network access without retaining an earlier allow list", () => {
  expect(
    networkPolicyOf({
      _tag: "AllowList",
      allowedHosts: ["api.example.com"],
      allowedCidrs: ["10.0.0.0/8"],
      deniedCidrs: ["10.0.0.1/32"]
    })
  ).toEqual({ allow: ["api.example.com"], subnets: { allow: ["10.0.0.0/8"], deny: ["10.0.0.1/32"] } })
  expect(networkPolicyOf({ _tag: "AllowAll" })).toBe("allow-all")
  expect(networkPolicyOf({ _tag: "DenyAll" })).toBe("deny-all")
})

it.effect(
  "uses control-plane requests for credentials, rejects policy changes with redacted rules, and revokes rules",
  () =>
    Effect.gen(function* () {
      const paths: Array<string> = []
      const updates: Array<unknown> = []
      const id = Sandbox.SandboxId.make("network-test")
      const fetch = yield* withApi(async (request) => {
        const path = new URL(request.url).pathname
        paths.push(path)
        if (request.method === "PATCH")
          updates.push(
            Schema.decodeUnknownSync(Schema.Struct({ networkPolicy: Schema.Unknown }))(await request.json())
              .networkPolicy
          )
        return Response.json(
          responseOf(id, {
            networkPolicy: {
              mode: "custom",
              allowedDomains: ["api.example.com"],
              injectionRules: [{ domain: "api.example.com", headerNames: ["authorization"] }]
            }
          })
        )
      })
      const provider = yield* VercelSandboxProvider.make({
        ...credentials,
        token: Redacted.make(credentials.token),
        fetch
      })
      const sandbox = yield* provider.resume(id)
      expect((yield* Effect.flip(sandbox.setNetworkPolicy({ _tag: "DenyAll" }))).reason._tag).toBe("UnsupportedError")
      expect(updates).toHaveLength(0)
      yield* sandbox.setRequestTransformations([transformation])
      yield* sandbox.setRequestTransformations([])
      expect(updates).toEqual([
        expect.objectContaining({
          allow: {
            "api.example.com": [
              expect.objectContaining({ transform: [{ headers: { authorization: "Bearer secret" } }] })
            ]
          }
        }),
        { allow: { "api.example.com": [] } }
      ])
      expect(paths.every((path) => !path.includes("/fs/") && !path.includes("/cmd"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("never removes unrelated proxy or response rules when replacing transformations", () =>
  Effect.gen(function* () {
    const forward = { allow: { "api.example.com": [{ forwardURL: "https://proxy.example.com" }] } }
    const response = { allow: { "api.example.com": [{ response: { statusCode: 403 } }] } }
    expect((yield* Effect.flip(withTransformations(forward, [transformation]))).reason._tag).toBe("UnsupportedError")
    expect((yield* Effect.flip(withTransformations(response, []))).reason._tag).toBe("UnsupportedError")
  })
)
