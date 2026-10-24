import { Sandbox } from "@amends-dev/sandbox"
import { VercelSandboxProvider } from "@amends-dev/sandbox-vercel"
import { BunCrypto } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Effect, Exit, Redacted, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { apiError, commandResponse, credentials, responseOf, withApi } from "./api.ts"

const commandInput = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  wait: Schema.optionalKey(Schema.Boolean),
  cwd: Schema.optionalKey(Schema.String),
  attachStdin: Schema.optionalKey(Schema.Boolean)
})
const stdinInput = Schema.Struct({ data: Schema.optionalKey(Schema.String), close: Schema.optionalKey(Schema.Boolean) })
const bytes = new Uint8Array([0, 255, 128, 10, 65])

it.effect("uses detached SDK commands, streams binary stdin with EOF and preserves stdout bytes", () =>
  Effect.gen(function* () {
    const id = Sandbox.SandboxId.make("process-test")
    const commands: Array<typeof commandInput.Type> = []
    const writes: Array<number> = []
    const closed = Promise.withResolvers<void>()
    const fetch = yield* withApi(async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/fs/read"))
        return new Response("4321", { headers: { "content-type": "application/octet-stream" } })
      if (path.endsWith("/stdin")) {
        const input = Schema.decodeUnknownSync(stdinInput)(await request.json())
        if (input.data !== undefined) writes.push(...Buffer.from(input.data, "base64"))
        if (input.close === true) closed.resolve()
        return Response.json({
          bytesWritten: writes.length,
          command: {
            id: "command-test",
            name: "setsid",
            args: [],
            cwd: "/vercel/sandbox",
            sessionId: "session-process-test",
            exitCode: null,
            startedAt: 1
          }
        })
      }
      if (path.endsWith("/cmd")) {
        const input = Schema.decodeUnknownSync(commandInput)(await request.json())
        commands.push(input)
        const script = input.args.join(" ")
        const stdout = script.startsWith("-c cat ")
          ? "4321"
          : script.includes("tail -c +1 ") && script.includes("/stdout")
            ? Buffer.from(bytes).toString("base64")
            : script.includes("printf running")
              ? "0"
              : ""
        return commandResponse({ ...input, args: [...input.args] }, stdout)
      }
      return Response.json(responseOf(id))
    })
    const provider = yield* VercelSandboxProvider.make({
      ...credentials,
      token: Redacted.make(credentials.token),
      fetch
    })
    const sandbox = yield* provider.resume(id)
    const process = yield* sandbox.childProcessSpawner.spawn(
      ChildProcess.make("cat", [], { cwd: "nested", stdin: Stream.make(bytes) })
    )
    yield* Effect.promise(() => closed.promise)
    const output = yield* Stream.runCollect(process.stdout)
    expect(writes).toEqual([...bytes])

    expect(output.flatMap((chunk) => [...chunk])).toEqual([...bytes])
    expect(yield* process.exitCode).toBe(0)
    expect(process.pid).toBe(4321)
    const detached = commands.find((command) => command.command === "setsid")
    expect(detached?.attachStdin).toBe(true)
    expect(detached?.wait).toBeUndefined()
    expect(detached?.args.join(" ")).toContain("cd '/vercel/sandbox/nested'")
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("does not resume stopped sessions when checking or killing an old process", () =>
  Effect.gen(function* () {
    const id = Sandbox.SandboxId.make("old-process")
    let stopped = false
    let resumes = 0
    const fetch = yield* withApi(async (request) => {
      const url = new URL(request.url)
      if (url.searchParams.get("resume") === "true") resumes++
      if (url.pathname.includes("/sessions/") && stopped) return apiError(410, "sandbox_stopped")
      if (url.pathname.endsWith("/fs/read"))
        return new Response("4321", { headers: { "content-type": "application/octet-stream" } })
      if (url.pathname.endsWith("/cmd")) {
        const input = Schema.decodeUnknownSync(commandInput)(await request.json())
        return commandResponse(
          { ...input, args: [...input.args] },
          input.args.join(" ").startsWith("-c cat ") ? "4321" : ""
        )
      }
      return Response.json(responseOf(id))
    })
    const provider = yield* VercelSandboxProvider.make({
      ...credentials,
      token: Redacted.make(credentials.token),
      fetch
    })
    const sandbox = yield* provider.resume(id)
    const process = yield* sandbox.childProcessSpawner.spawn(ChildProcess.make("sleep", ["60"]))
    stopped = true
    expect(yield* process.isRunning).toBe(false)
    expect(Exit.isFailure(yield* Effect.exit(process.exitCode))).toBe(true)
    yield* process.kill()
    expect(resumes).toBe(1)
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("reads binary files through the session and maps a missing file to NotFound", () =>
  Effect.gen(function* () {
    let missing = false
    const fetch = yield* withApi((request) => {
      if (new URL(request.url).pathname.endsWith("/fs/read"))
        return missing
          ? apiError(404)
          : new Response(bytes, { headers: { "content-type": "application/octet-stream" } })
      return Response.json(responseOf("files"))
    })
    const provider = yield* VercelSandboxProvider.make({
      ...credentials,
      token: Redacted.make(credentials.token),
      fetch
    })
    const sandbox = yield* provider.resume(Sandbox.SandboxId.make("files"))
    expect([...(yield* sandbox.fileSystem.readFile("binary"))]).toEqual([...bytes])
    missing = true
    expect((yield* Effect.flip(sandbox.fileSystem.readFile("binary"))).reason._tag).toBe("NotFound")
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)

it.effect("fails setup when remote commands fail instead of starting a process with missing scratch files", () =>
  Effect.gen(function* () {
    const commands: Array<string> = []
    const fetch = yield* withApi(async (request) => {
      if (new URL(request.url).pathname.endsWith("/cmd")) {
        const input = Schema.decodeUnknownSync(commandInput)(await request.json())
        commands.push(input.command)
        return commandResponse({ ...input, args: [...input.args] }, "", "mkdir: Permission denied", 1)
      }
      return Response.json(responseOf("setup-fails"))
    })
    const provider = yield* VercelSandboxProvider.make({
      ...credentials,
      token: Redacted.make(credentials.token),
      fetch
    })
    const sandbox = yield* provider.resume(Sandbox.SandboxId.make("setup-fails"))
    const error = yield* Effect.flip(sandbox.childProcessSpawner.spawn(ChildProcess.make("echo", ["hello"])))
    expect(error.message).toContain("Permission denied")
    expect(commands).not.toContain("setsid")
  }).pipe(Effect.scoped, Effect.provide(BunCrypto.layer))
)
