import { expect, layer } from "@effect/vitest"
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import * as Sandbox from "../../Sandbox.ts"
import type * as Fixture from "../Fixture.ts"
import { providerForTest } from "./perTest.ts"

/**
 * A command that echoes two lines of its input, then exits without waiting for the input to
 * end.
 */
const echoTwoLines = ChildProcess.make("sh", [
  "-c",
  'IFS= read -r line; printf "%s\\n" "$line"; IFS= read -r line; printf "%s\\n" "$line"'
])

/** Running commands in a sandbox, through its process spawner and beside its files. */
export const processes = <R, E>(fixture: Fixture.Fixture<R, E>) => {
  /** Runs `body` with a new sandbox's files, processes, and paths. */
  const inSandbox = <A, E, R2>(body: (sandbox: Sandbox.Sandbox["Service"]) => Effect.Effect<A, E, R2>) =>
    Effect.gen(function* () {
      const sandboxProvider = yield* providerForTest(fixture)
      const sandbox = yield* sandboxProvider.create()
      return yield* body(sandbox).pipe(Effect.provide(Sandbox.layerServices(sandbox)))
    })

  layer(fixture.layer, { excludeTestServices: true })("sandbox processes", (it) => {
    it.effect(
      "shares files between the sandbox's file system and its processes",
      () =>
        inSandbox((sandbox) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const fromFileSystem = path.join(sandbox.workingDirectory, "from-file-system.txt")
            const fromProcess = path.join(sandbox.workingDirectory, "from-process.txt")

            yield* fs.writeFileString(fromFileSystem, "written by the file system")
            yield* spawner.exitCode(
              ChildProcess.make("sh", ["-c", 'printf "written by a process" > "$1"', "sh", fromProcess])
            )

            expect(yield* spawner.string(ChildProcess.make("cat", [fromFileSystem]))).toBe("written by the file system")
            expect(yield* fs.readFileString(fromProcess)).toBe("written by a process")
          })
        ),
      fixture.timeout
    )

    it.effect(
      "starts commands in the working directory",
      () =>
        inSandbox((sandbox) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

            const directory = yield* spawner.string(ChildProcess.make("pwd", ["-P"]))

            expect(directory.trim()).toBe(yield* fs.realPath(sandbox.workingDirectory))
          })
        ),
      fixture.timeout
    )

    it.effect(
      "starts a command in its cwd, resolved against the working directory when relative",
      () =>
        inSandbox((sandbox) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const nested = path.join(sandbox.workingDirectory, "nested")
            yield* fs.makeDirectory(nested)
            const directoryOf = (cwd: string) =>
              Effect.map(spawner.string(ChildProcess.make("pwd", ["-P"], { cwd })), (output) => output.trim())

            expect(yield* directoryOf("nested")).toBe(yield* fs.realPath(nested))
            expect(yield* directoryOf(nested)).toBe(yield* fs.realPath(nested))
          })
        ),
      fixture.timeout
    )

    it.effect(
      "gives a command only the environment it is given, or the sandbox's with it when extended",
      () =>
        inSandbox(() =>
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            // Prints the greeting, and whether `HOME`, from the sandbox's own environment, is set.
            const printEnvironment = (extendEnv: boolean) =>
              spawner.string(
                ChildProcess.make("/bin/sh", ["-c", 'printf "%s|%s" "$GREETING" "${HOME:+home}"'], {
                  env: { GREETING: "hello" },
                  extendEnv
                })
              )

            expect(yield* printEnvironment(false)).toBe("hello|")
            expect(yield* printEnvironment(true)).toBe("hello|home")
          })
        ),
      fixture.timeout
    )

    it.effect(
      "pipes a command's stdout or stderr into another command's stdin",
      () =>
        inSandbox(() =>
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const writeBoth = ChildProcess.make("sh", ["-c", "echo out; echo err >&2"])
            const pipeInto = (from: "stdout" | "stderr") =>
              spawner.string(writeBoth.pipe(ChildProcess.pipeTo(ChildProcess.make("tr", ["a-z", "A-Z"]), { from })))

            expect(yield* pipeInto("stdout")).toBe("OUT\n")
            expect(yield* pipeInto("stderr")).toBe("ERR\n")
          })
        ),
      fixture.timeout
    )

    it.effect(
      "ends a process that kill ends, which then runs no more and has no exit code",
      () =>
        inSandbox(() =>
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const handle = yield* spawner.spawn(ChildProcess.make("sleep", ["60"]))

            yield* handle.kill()

            expect(yield* handle.isRunning).toBe(false)
            expect(Exit.isFailure(yield* Effect.exit(handle.exitCode))).toBe(true)
          })
        ),
      fixture.timeout
    )

    it.effect(
      "reports a command's exit code and keeps its stderr apart from its stdout",
      () =>
        inSandbox(() =>
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", "echo out; echo err >&2; exit 3"]))

            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode
              ],
              { concurrency: "unbounded" }
            )

            expect({ stdout, stderr, exitCode }).toEqual({
              stdout: "out\n",
              stderr: "err\n",
              exitCode: 3
            })
          })
        ),
      fixture.timeout
    )

    it.effect(
      "gives a command's output byte for byte, with no newline added and bytes that are not text",
      () =>
        inSandbox(() =>
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", "printf 'line\\nno newline\\000\\377'"]))

            const chunks = yield* Stream.runCollect(handle.stdout)

            expect(chunks.flatMap((chunk) => [...chunk])).toEqual([
              ...Array.from("line\nno newline", (character) => character.charCodeAt(0)),
              0,
              255
            ])
          })
        ),
      fixture.timeout
    )

    it.effect(
      "streams a running process's stdin and stdout one line at a time",
      () =>
        inSandbox(() =>
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const handle = yield* spawner.spawn(echoTwoLines)
            const input = yield* Queue.unbounded<string, Cause.Done>()
            yield* Stream.fromQueue(input).pipe(Stream.encodeText, Stream.run(handle.stdin), Effect.forkScoped)
            const output = yield* handle.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.toQueue({ capacity: "unbounded" })
            )

            // Each line comes back while the process still runs, before the next is sent. A
            // process's input may never end, as on some providers, so the command exits by itself.
            yield* Queue.offer(input, "first\n")
            expect(yield* Queue.take(output)).toBe("first")
            yield* Queue.offer(input, "second\n")
            expect(yield* Queue.take(output)).toBe("second")

            expect(yield* handle.exitCode).toBe(0)
          })
        ),
      fixture.timeout
    )
  })
}
