import { Network, Sandbox } from "@amends-dev/sandbox"
import { LocalSandboxProvider } from "@amends-dev/sandbox-local"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Redacted } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const id = Sandbox.SandboxId.make("sandbox-one")
const port = Network.Port.make(3000)

/** A local provider over a temporary directory, with that directory for tests to look into. */
const makeLocalProvider = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  return { directory, sandboxProvider: yield* LocalSandboxProvider.make({ directory }) }
})

const spawnSleep = (sandbox: Sandbox.Sandbox["Service"]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* spawner.spawn(ChildProcess.make("sleep", ["60"]))
  }).pipe(Effect.provide(Sandbox.layerServices(sandbox)))

layer(BunServices.layer)("LocalSandboxProvider", (it) => {
  it.effect("keeps each sandbox's settings and working directory in a directory named by its id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { directory, sandboxProvider } = yield* makeLocalProvider

      const sandbox = yield* sandboxProvider.create({ id, ports: [port] })

      expect(sandbox.workingDirectory).toBe(path.join(directory, id, "workspace"))
      expect(yield* fs.exists(sandbox.workingDirectory)).toBe(true)
      expect(JSON.parse(yield* fs.readFileString(path.join(directory, id, "sandbox.json")))).toEqual({
        ports: [3000]
      })
    })
  )

  it.effect("names a sandbox created without an id with a UUID", () =>
    Effect.gen(function* () {
      const { sandboxProvider } = yield* makeLocalProvider

      const sandbox = yield* sandboxProvider.create()

      expect(sandbox.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })
  )

  it.effect("resolves a relative cwd against the working directory, on both sides of a pipe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { directory, sandboxProvider } = yield* makeLocalProvider
      const sandbox = yield* sandboxProvider.create()
      const workingDirectory = yield* fs.realPath(sandbox.workingDirectory)
      yield* fs.makeDirectory(path.join(workingDirectory, "sub"))

      const [relative, piped, absolute] = yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        return yield* Effect.all([
          spawner.string(ChildProcess.make("pwd", ["-P"], { cwd: "sub" })),
          // The left side prints its directory, and the right side passes it on before its own.
          spawner.string(
            ChildProcess.make("pwd", ["-P"], { cwd: "sub" }).pipe(
              ChildProcess.pipeTo(ChildProcess.make("sh", ["-c", "cat; pwd -P"]))
            )
          ),
          spawner.string(ChildProcess.make("pwd", ["-P"], { cwd: directory }))
        ])
      }).pipe(Effect.provide(Sandbox.layerServices(sandbox)))

      expect(relative).toBe(`${path.join(workingDirectory, "sub")}\n`)
      expect(piped).toBe(`${path.join(workingDirectory, "sub")}\n${workingDirectory}\n`)
      expect(absolute).toBe(`${yield* fs.realPath(directory)}\n`)
    })
  )

  it.effect("stops processes started through another value for the same sandbox", () =>
    Effect.gen(function* () {
      const { sandboxProvider } = yield* makeLocalProvider
      const created = yield* sandboxProvider.create({ id })
      const resumed = yield* sandboxProvider.resume(id)
      const handle = yield* spawnSleep(resumed)

      yield* created.stop

      expect(yield* handle.isRunning).toBe(false)
    })
  )

  it.effect("reaches ports on this machine's loopback address without headers", () =>
    Effect.gen(function* () {
      const { sandboxProvider } = yield* makeLocalProvider
      const sandbox = yield* sandboxProvider.create({ ports: [port] })

      expect(yield* sandbox.endpoint(port, "http")).toEqual({
        url: "http://127.0.0.1:3000",
        headers: {}
      })
    })
  )

  it.effect("accepts only the network policy it already has, allowing everything", () =>
    Effect.gen(function* () {
      const { sandboxProvider } = yield* makeLocalProvider
      const sandbox = yield* sandboxProvider.create()

      yield* sandbox.setNetworkPolicy(Network.NetworkPolicy.cases.AllowAll.make({}))
      const denyAll = yield* Effect.flip(sandbox.setNetworkPolicy(Network.NetworkPolicy.cases.DenyAll.make({})))
      const allowList = yield* Effect.flip(
        sandbox.setNetworkPolicy(
          Network.NetworkPolicy.cases.AllowList.make({
            allowedHosts: ["example.com"],
            allowedCidrs: [],
            deniedCidrs: []
          })
        )
      )

      expect(denyAll.reason._tag).toBe("UnsupportedError")
      expect(allowList.reason._tag).toBe("UnsupportedError")
    })
  )

  it.effect("cannot transform requests", () =>
    Effect.gen(function* () {
      const { sandboxProvider } = yield* makeLocalProvider
      const sandbox = yield* sandboxProvider.create()

      const error = yield* Effect.flip(
        sandbox.setRequestTransformations([
          {
            host: "api.example.com",
            matchHeaders: {},
            setHeaders: { authorization: Redacted.make("Bearer secret") }
          }
        ])
      )

      expect(error.reason._tag).toBe("UnsupportedError")
    })
  )
})
