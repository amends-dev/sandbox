import { Network } from "@amends-dev/sandbox"
import { LocalSandboxProvider } from "@amends-dev/sandbox-local"
import * as Conformance from "@amends-dev/sandbox/conformance"
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { NetAddress } from "effect/net"
import { ChildProcess } from "effect/process"

/** A server, run by Bun, that answers each request on `PORT` with its headers. */
const serveHeaders = `Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch: (request) => Response.json(Object.fromEntries(request.headers)),
})`

/**
 * The local provider runs the conformance suites over a temporary directory, which is removed
 * with every sandbox in it when each test ends. Its sandboxes' ports are this machine's, so the
 * network suite takes a port nothing listens on, and serves HTTP with the Bun running the tests.
 */
Conformance.run({
  layer: Layer.merge(BunServices.layer, FetchHttpClient.layer),
  makeProvider: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* LocalSandboxProvider.make({ directory: yield* fs.makeTempDirectoryScoped() })
  }),
  // A server that cannot listen on a free port is a fault of the machine the tests run on.
  freePort: Effect.scoped(
    Effect.flatMap(Effect.orDie(BunHttpServer.make({ hostname: "127.0.0.1", port: 0 })), ({ address }) =>
      NetAddress.isUnixPathAddress(address)
        ? Effect.die("The server listens on no port")
        : Effect.succeed(Network.Port.make(address.port))
    )
  ),
  serveHeaders: (port) =>
    ChildProcess.make(process.execPath, ["-e", serveHeaders], {
      env: { PORT: String(port) },
      extendEnv: true
    })
})
