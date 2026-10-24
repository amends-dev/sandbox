import { Effect } from "effect"

export const credentials = { token: "test-token", teamId: "team_test", projectId: "prj_test" }

export const sessionData = (name: string, status = "running") => ({
  id: `session-${name}`,
  memory: 4096,
  vcpus: 2,
  region: "iad1",
  timeout: 3_600_000,
  status,
  requestedAt: 1,
  createdAt: 1,
  updatedAt: 1,
  cwd: "/vercel/sandbox"
})
export const sandboxData = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  persistent: true,
  currentSessionId: `session-${name}`,
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  ...extra
})
export const routesOf = (ports: ReadonlyArray<number>) =>
  ports.map((port) => ({
    port,
    subdomain: `test-${port}`,
    url: `https://test-${port}.vercel.run`
  }))
export const responseOf = (name: string, extra: Record<string, unknown> = {}, ports: ReadonlyArray<number> = []) => ({
  sandbox: sandboxData(name, extra),
  session: sessionData(name),
  routes: routesOf(ports)
})
export const apiError = (status: number, code = "failed") =>
  Response.json({ error: { code, message: code } }, { status })

/** The real SDK sends every request through a scoped local HTTP API. */
export const withApi = (handler: (request: Request) => Response | Promise<Response>) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })),
    (server) => Effect.promise(() => server.stop(true))
  ).pipe(
    Effect.map((server) => {
      const transport: typeof globalThis.fetch = Object.assign(
        (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
          url.protocol = server.url.protocol
          url.host = server.url.host
          return globalThis.fetch(url, init)
        },
        { preconnect: globalThis.fetch.preconnect }
      )
      return transport
    })
  )

export const commandResponse = (
  request: { command: string; args: Array<string>; wait?: boolean },
  stdout = "",
  stderr = "",
  exitCode = 0
) => {
  const command = {
    id: "command-test",
    name: request.command,
    args: request.args,
    cwd: "/vercel/sandbox",
    sessionId: "session-provider-test",
    exitCode: null,
    startedAt: 1
  }
  return request.wait
    ? new Response(
        [
          { command },
          { stream: "stdout", data: stdout },
          { stream: "stderr", data: stderr },
          { command: { ...command, exitCode } }
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
        { headers: { "content-type": "application/x-ndjson" } }
      )
    : Response.json({ command })
}
