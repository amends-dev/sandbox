/**
 * The test suites every sandbox provider runs against itself, so that code written against
 * `SandboxProvider` and `Sandbox` works the same on each. A provider's tests call `run` with a
 * `Fixture`, which makes the provider and gives what the suites cannot assume of every provider,
 * such as how to serve HTTP on a port. They need `@effect/vitest`, an optional peer dependency of
 * this package, which only a provider's tests install.
 *
 * The suites run on the live clock, as a provider takes real time. Each test names the sandboxes
 * and templates it creates as no other test or run does, and destroys its sandboxes when it ends,
 * so that the suites can run against a provider other runs share, such as one account on a hosted
 * platform.
 *
 * @since 0.1.0
 */

import type { Fixture } from "./Fixture.ts"
import { lifecycle } from "./internal/lifecycle.ts"
import { network } from "./internal/network.ts"
import { processes } from "./internal/processes.ts"

export type {
  /**
   * What a provider's tests give the suites, re-exported so they need only this module.
   *
   * @category testing
   * @since 0.1.0
   */
  Fixture
} from "./Fixture.ts"

/**
 * Runs every suite against the provider `fixture` makes, in the test file that calls it.
 *
 * **Example** (A provider's conformance test)
 *
 * ```ts
 * import { Network, SandboxProvider } from "@amends-dev/sandbox"
 * import * as Conformance from "@amends-dev/sandbox/conformance"
 * import { Effect, Scope } from "effect"
 * import { FetchHttpClient } from "effect/http"
 * import { ChildProcess } from "effect/process"
 *
 * declare const makeProvider: Effect.Effect<SandboxProvider.SandboxProvider["Service"], never, Scope.Scope>
 * declare const freePort: Effect.Effect<Network.Port>
 *
 * // Answers each request on `PORT` with its headers, which the network suite checks.
 * const serveHeaders = `Bun.serve({
 *   port: Number(process.env.PORT),
 *   fetch: (request) => Response.json(Object.fromEntries(request.headers)),
 * })`
 *
 * Conformance.run({
 *   layer: FetchHttpClient.layer,
 *   makeProvider,
 *   freePort,
 *   serveHeaders: (port) =>
 *     ChildProcess.make("bun", ["-e", serveHeaders], {
 *       env: { PORT: String(port) },
 *       extendEnv: true
 *     }),
 *   timeout: 60_000
 * })
 * ```
 *
 * @category testing
 * @since 0.1.0
 */
export const run = <R, E>(fixture: Fixture<R, E>) => {
  lifecycle(fixture)
  processes(fixture)
  network(fixture)
}
