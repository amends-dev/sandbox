import { Network } from "@amends-dev/sandbox"
import { DaytonaSandboxProvider } from "@amends-dev/sandbox-daytona"
import * as Conformance from "@amends-dev/sandbox/conformance"
import { Daytona } from "@daytona/sdk"
import { BunServices } from "@effect/platform-bun"
import { afterAll, describe } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess } from "effect/process"

/**
 * The Daytona provider runs the conformance suites in Daytona's cloud, with the organization of
 * `DAYTONA_API_KEY`. Its sandboxes are real machines that take minutes to test and cost money, so
 * the suites run only with `AMENDS_TEST_DAYTONA=1`.
 */
const apiKey = process.env.DAYTONA_API_KEY

/**
 * A server, run by Python, which Daytona's image has, that answers each request on the port its
 * first argument names with its headers.
 */
const serveHeaders = `
import http.server, json, sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({name.lower(): value for name, value in self.headers.items()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

http.server.HTTPServer(("0.0.0.0", int(sys.argv[1])), Handler).serve_forever()
`

/**
 * Deletes the snapshots of the suites' templates, which name each version anew, so that every run
 * makes snapshots no later run starts from. One a run's test left being made when it ended is
 * deleted by the next run.
 */
const deleteConformanceSnapshots = async () => {
  const daytona = new Daytona({ apiKey: apiKey ?? "" })
  try {
    const { items } = await daytona.snapshot.list({ page: 1, limit: 100 })
    await Promise.allSettled(
      items
        .filter((snapshot) => snapshot.name.startsWith("amends-template-conformance-"))
        .map((snapshot) => daytona.snapshot.delete(snapshot.name))
    )
  } finally {
    await daytona[Symbol.asyncDispose]()
  }
}

describe.skipIf(process.env.AMENDS_TEST_DAYTONA !== "1" || apiKey === undefined)("DaytonaSandboxProvider", () => {
  afterAll(deleteConformanceSnapshots, 60_000)
  Conformance.run({
    layer: Layer.merge(BunServices.layer, FetchHttpClient.layer),
    makeProvider: DaytonaSandboxProvider.make({ apiKey: Redacted.make(apiKey ?? "") }),
    // Each sandbox is a machine of its own, where nothing listens on a port until a test starts it.
    freePort: Effect.succeed(Network.Port.make(4500)),
    // Daytona's preview proxy reaches servers that listen on every interface.
    serveHeaders: (port) => ChildProcess.make("python3", ["-c", serveHeaders, String(port)]),
    timeout: 120_000
  })
})
