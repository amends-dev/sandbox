import { Network } from "@amends-dev/sandbox"
import { E2bSandboxProvider } from "@amends-dev/sandbox-e2b"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess } from "effect/process"

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

export const fixture = {
  layer: Layer.merge(BunServices.layer, FetchHttpClient.layer),
  makeProvider: E2bSandboxProvider.make({ apiKey: Redacted.make(process.env.E2B_API_KEY ?? "") }),
  freePort: Effect.succeed(Network.Port.make(4500)),
  serveHeaders: (port: Network.Port) => ChildProcess.make("python3", ["-c", serveHeaders, String(port)]),
  timeout: 120_000
}

export const liveEnabled = process.env.AMENDS_TEST_E2B === "1" && process.env.E2B_API_KEY !== undefined
