/** The subset of Vercel's firewall that preserves independent policy and transformation updates. */

import { Network, SandboxError } from "@amends-dev/sandbox"
import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { sandboxError } from "./call.ts"

export const networkPolicyOf = (policy: Network.NetworkPolicy): NetworkPolicy =>
  Network.NetworkPolicy.match(policy, {
    AllowAll: (): NetworkPolicy => "allow-all",
    DenyAll: () => "deny-all",
    AllowList: ({ allowedHosts, allowedCidrs, deniedCidrs }) => ({
      allow: [...allowedHosts],
      subnets: { allow: [...allowedCidrs], deny: [...deniedCidrs] }
    })
  })

export const hasRequestRules = (policy: NetworkPolicy | undefined): boolean =>
  typeof policy === "object" &&
  policy.allow !== undefined &&
  !Array.isArray(policy.allow) &&
  Object.values(policy.allow).some((rules) => rules.length > 0)

const unsupported = (description: string) => sandboxError(new SandboxError.UnsupportedError({ description }))

export const withTransformations = Effect.fnUntraced(function* (
  policy: NetworkPolicy | undefined,
  transformations: ReadonlyArray<Network.RequestTransformation>
) {
  if (policy === undefined || typeof policy === "string") {
    if (transformations.length === 0) return policy ?? "allow-all"
    return yield* unsupported(
      "Vercel attaches transformations to a domain allow list; this mode cannot add rules without changing egress access"
    )
  }
  if (
    policy.allow !== undefined &&
    !Array.isArray(policy.allow) &&
    Object.values(policy.allow).some((rules) => rules.some((rule) => rule.transform === undefined))
  ) {
    return yield* unsupported(
      "Vercel forwarding and response rules must be preserved; replacing transformations cannot remove them"
    )
  }
  const hosts = Array.isArray(policy.allow) ? policy.allow : Object.keys(policy.allow ?? {})
  if (transformations.length > 0 && (policy.subnets?.allow?.length ?? 0) > 0) {
    return yield* unsupported("Vercel allowed subnets bypass request transformations")
  }
  const allow: Record<string, Array<NetworkPolicyRule>> = Object.fromEntries(hosts.map((host) => [host, []]))
  const seen = new Set<string>()
  for (const transformation of transformations) {
    // Exact membership avoids inventing domain wildcard semantics or implicitly allowing a host.
    if (!hosts.includes(transformation.host) || transformation.host.includes("*")) {
      return yield* unsupported("A Vercel transformation requires an exact host already present in the allow list")
    }
    if (seen.has(transformation.host)) {
      return yield* unsupported(
        "Vercel selects the first matching rule; overlapping transformations for one host are unsupported"
      )
    }
    seen.add(transformation.host)
    allow[transformation.host] = [
      {
        match: {
          ...(transformation.pathPrefix === undefined ? {} : { path: { startsWith: transformation.pathPrefix } }),
          headers: Object.entries(transformation.matchHeaders).map(([key, value]) => ({
            key: { exact: key.toLowerCase() },
            value: { exact: value }
          }))
        },
        transform: [
          {
            headers: Object.fromEntries(
              Object.entries(transformation.setHeaders).map(([name, value]) => [name, Redacted.value(value)])
            )
          }
        ]
      }
    ]
  }
  return { allow, ...(policy.subnets === undefined ? {} : { subnets: policy.subnets }) } satisfies NetworkPolicy
})
