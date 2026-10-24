import { Network } from "@amends-dev/sandbox"
import { VercelSandboxProvider } from "@amends-dev/sandbox-vercel"
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
  makeProvider: VercelSandboxProvider.make({
    token: Redacted.make(process.env.VERCEL_TOKEN ?? ""),
    teamId: process.env.VERCEL_TEAM_ID ?? "",
    projectId: process.env.VERCEL_PROJECT_ID ?? ""
  }),
  freePort: Effect.succeed(Network.Port.make(4500)),
  serveHeaders: (port: Network.Port) => ChildProcess.make("python3", ["-c", serveHeaders, String(port)]),
  timeout: 120_000
}

export const liveEnabled =
  process.env.AMENDS_TEST_VERCEL === "1" &&
  process.env.VERCEL_TOKEN !== undefined &&
  process.env.VERCEL_TEAM_ID !== undefined &&
  process.env.VERCEL_PROJECT_ID !== undefined
