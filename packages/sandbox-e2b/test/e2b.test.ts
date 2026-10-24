import { E2bSandboxProvider } from "@amends-dev/sandbox-e2b"
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Redacted, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { fixture, liveEnabled } from "./fixture.ts"

describe.skipIf(!liveEnabled)("E2B live regressions", () => {
  layer(fixture.layer, { excludeTestServices: true })("filesystem persistence", (it) => {
    it.effect(
      "resumes on another provider and never treats a pre-reboot handle as a running process",
      () =>
        Effect.gen(function* () {
          const firstProvider = yield* fixture.makeProvider
          const sandbox = yield* firstProvider.createScoped()
          const handle = yield* sandbox.childProcessSpawner.spawn(ChildProcess.make("sleep", ["120"]))
          yield* sandbox.fileSystem.writeFileString(`${sandbox.workingDirectory}/persisted.txt`, "retained")
          yield* sandbox.stop
          const nextProvider = yield* E2bSandboxProvider.make({ apiKey: Redacted.make(process.env.E2B_API_KEY ?? "") })
          const resumed = yield* nextProvider.resume(sandbox.id)
          expect(yield* resumed.fileSystem.readFileString(`${resumed.workingDirectory}/persisted.txt`)).toBe("retained")
          expect(yield* handle.isRunning).toBe(false)
          const replacement = yield* resumed.childProcessSpawner.spawn(ChildProcess.make("sleep", ["120"]))
          yield* handle.kill()
          expect(yield* replacement.isRunning).toBe(true)
        }),
      fixture.timeout
    )

    it.effect(
      "delivers EOF and arbitrary bytes through stdin without SDK text decoding",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* fixture.makeProvider
          const sandbox = yield* sandboxProvider.createScoped()
          const bytes = new Uint8Array([0, 255, 128, 10, 65])
          const process = yield* sandbox.childProcessSpawner.spawn(
            ChildProcess.make("cat", [], {
              stdin: Stream.make(bytes)
            })
          )
          const output = yield* Stream.runCollect(process.stdout)
          expect(output.flatMap((chunk) => [...chunk])).toEqual([...bytes])
          expect(yield* process.exitCode).toBe(0)
        }),
      fixture.timeout
    )

    it.effect(
      "enforces deny-all and replaces it with internet access",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* fixture.makeProvider
          const sandbox = yield* sandboxProvider.createScoped({ networkPolicy: { _tag: "DenyAll" } })
          const reaches = sandbox.childProcessSpawner.exitCode(
            ChildProcess.make("curl", ["-sS", "-o", "/dev/null", "--max-time", "5", "https://example.com"])
          )
          expect(yield* reaches).not.toBe(0)
          yield* sandbox.setNetworkPolicy({ _tag: "AllowAll" })
          expect(yield* reaches).toBe(0)
        }),
      fixture.timeout
    )
  })
})
