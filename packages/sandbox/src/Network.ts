/**
 * What a sandbox exposes to the network and what it may reach: its ports and how to reach them,
 * the outbound network policy, and request transformations, which set headers on outbound
 * requests after they leave the sandbox so that credentials never enter it.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * A TCP port a sandbox exposes, from 1 to 65535.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(Schema.brand("Port"))

/**
 * @category schemas
 * @since 0.1.0
 */
export type Port = typeof Port.Type

/**
 * The kind of connection an endpoint is for; its URL uses the secure scheme when the provider
 * serves one.
 *
 * @category schemas
 * @since 0.1.0
 */
export const EndpointProtocol = Schema.Literals(["http", "ws"])

/**
 * @category schemas
 * @since 0.1.0
 */
export type EndpointProtocol = typeof EndpointProtocol.Type

/**
 * How to reach a sandbox port from outside: the URL, and any headers the provider requires.
 *
 * **Details**
 *
 * A request to the URL with those headers reaches the server with the request's other headers
 * intact, `Authorization` included.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Endpoint = Schema.Struct({
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.Redacted(Schema.String))
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Endpoint extends Schema.Schema.Type<typeof Endpoint> {}

/**
 * Which outbound destinations the sandbox may reach.
 *
 * **Details**
 *
 * `AllowList` allows the listed hosts and CIDR ranges, and `deniedCidrs` overrides both, for
 * example to block a cloud metadata address inside an allowed range.
 *
 * **Example** (Allowing one registry and a private network, except its metadata address)
 *
 * ```ts
 * import { Network } from "@amends-dev/sandbox"
 *
 * const policy = Network.NetworkPolicy.cases.AllowList.make({
 *   allowedHosts: ["registry.npmjs.org"],
 *   allowedCidrs: ["10.0.0.0/8"],
 *   deniedCidrs: ["169.254.169.254/32"]
 * })
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const NetworkPolicy = Schema.TaggedUnion({
  AllowAll: {},
  DenyAll: {},
  AllowList: {
    allowedHosts: Schema.Array(Schema.String),
    allowedCidrs: Schema.Array(Schema.String),
    deniedCidrs: Schema.Array(Schema.String)
  }
})

/**
 * @category schemas
 * @since 0.1.0
 */
export type NetworkPolicy = typeof NetworkPolicy.Type

/**
 * Sets `setHeaders` on outbound HTTPS requests to `host` whose path starts with `pathPrefix` and
 * that carry every header in `matchHeaders` with exactly that value.
 *
 * **Details**
 *
 * The sandbox holds only a placeholder credential, matched here, and the real value is set outside
 * it.
 *
 * **Example** (Giving a sandbox an API key it never sees)
 *
 * ```ts
 * import { Network } from "@amends-dev/sandbox"
 * import type { Redacted } from "effect"
 *
 * declare const apiKey: Redacted.Redacted<string>
 *
 * const anthropicKey: Network.RequestTransformation = {
 *   host: "api.anthropic.com",
 *   matchHeaders: { "x-api-key": "placeholder" },
 *   setHeaders: { "x-api-key": apiKey }
 * }
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const RequestTransformation = Schema.Struct({
  host: Schema.String,
  pathPrefix: Schema.optionalKey(Schema.String),
  matchHeaders: Schema.Record(Schema.String, Schema.String),
  setHeaders: Schema.Record(Schema.String, Schema.Redacted(Schema.String))
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface RequestTransformation extends Schema.Schema.Type<typeof RequestTransformation> {}
