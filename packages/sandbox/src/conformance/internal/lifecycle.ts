import { expect, layer } from "@effect/vitest"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Sandbox from "../../Sandbox.ts"
import * as Template from "../../Template.ts"
import type * as Fixture from "../Fixture.ts"
import { newIdentity, newSandboxId, providerForTest } from "./perTest.ts"

class PrepareFailed extends Data.TaggedError("PrepareFailed") {}

const writeFile = (sandbox: Sandbox.Sandbox["Service"], name: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.writeFileString(path.join(sandbox.workingDirectory, name), content)
  }).pipe(Effect.provide(Sandbox.layerServices(sandbox)))

const readFile = (sandbox: Sandbox.Sandbox["Service"], name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* fs.readFileString(path.join(sandbox.workingDirectory, name))
  }).pipe(Effect.provide(Sandbox.layerServices(sandbox)))

/**
 * Spawns a long command and unreferences its handle, so that the process outlives the scope it
 * spawned in.
 */
const spawnOutliving = (sandbox: Sandbox.Sandbox["Service"]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("sleep", ["60"]))
    // `unref` returns the effect that would reference the process again; nothing here runs it.
    yield* Effect.asVoid(handle.unref)
    return handle
  }).pipe(Effect.scoped, Effect.provide(Sandbox.layerServices(sandbox)))

/** Creating, resuming, stopping, and destroying sandboxes, and preparing them with templates. */
export const lifecycle = <R, E>(fixture: Fixture.Fixture<R, E>) =>
  layer(fixture.layer, { excludeTestServices: true })("sandbox lifecycle", (it) => {
    it.effect(
      "resumes a sandbox with the id, working directory, and ports it was created with",
      () =>
        Effect.gen(function* () {
          const port = yield* fixture.freePort
          const sandboxProvider = yield* providerForTest(fixture)
          const id = yield* newSandboxId
          const created = yield* sandboxProvider.create({ id, ports: [port] })
          const resumed = yield* sandboxProvider.resume(id)

          // Reaching the port fails with `NotFoundError` unless the sandbox exposes it.
          yield* resumed.endpoint(port, "http")

          expect(created.id).toBe(id)
          expect(resumed.id).toBe(id)
          expect(resumed.workingDirectory).toBe(created.workingDirectory)
        }),
      fixture.timeout
    )

    it.effect(
      "picks a different id for each sandbox created without one",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const first = yield* sandboxProvider.create()
          const second = yield* sandboxProvider.create()

          expect(first.id).not.toBe(second.id)
        }),
      fixture.timeout
    )

    it.effect(
      "destroys a sandbox created in a scope when the scope closes",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const id = yield* newSandboxId

          const workingDirectory = yield* Effect.scoped(
            Effect.map(sandboxProvider.createScoped({ id }), (sandbox) => sandbox.workingDirectory)
          )

          expect(workingDirectory).not.toBe("")
          expect((yield* Effect.flip(sandboxProvider.resume(id))).reason._tag).toBe("NotFoundError")
          expect((yield* sandboxProvider.create({ id })).id).toBe(id)
        }),
      fixture.timeout
    )

    it.effect(
      "ignores the provider options of other providers",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)

          const sandbox = yield* sandboxProvider.create({
            providerOptions: { "conformance-other-provider": { anything: true } }
          })

          expect((yield* sandboxProvider.resume(sandbox.id)).id).toBe(sandbox.id)
        }),
      fixture.timeout
    )

    it.effect(
      "fails with AlreadyExistsError for an id in use and keeps that sandbox",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const id = yield* newSandboxId
          const existing = yield* sandboxProvider.create({ id })
          yield* writeFile(existing, "kept.txt", "kept")

          const error = yield* Effect.flip(sandboxProvider.create({ id }))

          expect(error.reason._tag).toBe("AlreadyExistsError")
          expect(yield* readFile(yield* sandboxProvider.resume(id), "kept.txt")).toBe("kept")
        }),
      fixture.timeout
    )

    it.effect(
      "fails with NotFoundError when resuming an unknown id, without creating it",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const id = yield* newSandboxId

          const error = yield* Effect.flip(sandboxProvider.resume(id))

          expect(error.reason._tag).toBe("NotFoundError")
          // The id is still free, so resuming created nothing under it.
          expect((yield* sandboxProvider.create({ id })).id).toBe(id)
        }),
      fixture.timeout
    )

    it.effect(
      "cannot resume a destroyed sandbox, and destroying it again succeeds",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const id = yield* newSandboxId
          const sandbox = yield* sandboxProvider.create({ id })

          yield* sandbox.destroy
          yield* sandbox.destroy
          const error = yield* Effect.flip(sandboxProvider.resume(id))

          expect(error.reason._tag).toBe("NotFoundError")
        }),
      fixture.timeout
    )

    it.effect(
      "stops a sandbox twice, and resumes it with its files, where processes run again",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const id = yield* newSandboxId
          const sandbox = yield* sandboxProvider.create({ id })
          yield* writeFile(sandbox, "kept.txt", "kept")

          yield* sandbox.stop
          yield* sandbox.stop
          const resumed = yield* sandboxProvider.resume(id)
          const read = yield* Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            return yield* spawner.string(ChildProcess.make("cat", ["kept.txt"]))
          }).pipe(Effect.provide(Sandbox.layerServices(resumed)))

          expect(yield* readFile(resumed, "kept.txt")).toBe("kept")
          expect(read).toBe("kept")
        }),
      fixture.timeout
    )

    it.effect(
      "ends the sandbox's running processes when it stops",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const sandbox = yield* sandboxProvider.create()
          const handle = yield* Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            return yield* spawner.spawn(ChildProcess.make("sleep", ["60"]))
          }).pipe(Effect.provide(Sandbox.layerServices(sandbox)))

          yield* sandbox.stop

          expect(yield* handle.isRunning).toBe(false)
        }),
      fixture.timeout
    )

    it.effect(
      "ends a process that outlived the scope that spawned it when the sandbox stops",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const sandbox = yield* sandboxProvider.create()

          const handle = yield* spawnOutliving(sandbox)
          const outlived = yield* handle.isRunning
          yield* sandbox.stop

          expect(outlived).toBe(true)
          expect(yield* handle.isRunning).toBe(false)
        }),
      fixture.timeout
    )

    it.effect(
      "ends a process that outlived the scope that spawned it when it is destroyed",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const sandbox = yield* sandboxProvider.create()

          const handle = yield* spawnOutliving(sandbox)
          yield* sandbox.destroy

          expect(yield* handle.isRunning).toBe(false)
        }),
      fixture.timeout
    )

    it.effect(
      "runs the template inside the sandbox before create returns",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)

          const sandbox = yield* sandboxProvider.create({
            template: {
              name: Template.TemplateName.make("conformance-prepared"),
              identity: yield* newIdentity("prepared"),
              prepare: Effect.gen(function* () {
                const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
                yield* spawner.exitCode(ChildProcess.make("sh", ["-c", "echo ready > prepared.txt"]))
              })
            }
          })

          expect(yield* readFile(sandbox, "prepared.txt")).toBe("ready\n")
        }),
      fixture.timeout
    )

    it.effect(
      "fails create with the template's own error, leaving no sandbox behind",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const id = yield* newSandboxId

          const error = yield* Effect.flip(
            sandboxProvider.create({
              id,
              template: {
                name: Template.TemplateName.make("conformance-failing"),
                identity: yield* newIdentity("failing"),
                prepare: Effect.fail(new PrepareFailed())
              }
            })
          )

          expect(error._tag).toBe("PrepareFailed")
          expect((yield* Effect.flip(sandboxProvider.resume(id))).reason._tag).toBe("NotFoundError")
          expect((yield* sandboxProvider.create({ id })).id).toBe(id)
        }),
      fixture.timeout
    )

    it.effect(
      "leaves no sandbox behind when create is interrupted",
      () =>
        Effect.gen(function* () {
          const sandboxProvider = yield* providerForTest(fixture)
          const id = yield* newSandboxId
          const preparing = yield* Deferred.make<void>()
          const creating = yield* Effect.forkChild(
            sandboxProvider.create({
              id,
              template: {
                name: Template.TemplateName.make("conformance-endless"),
                identity: yield* newIdentity("endless"),
                prepare: Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never))
              }
            })
          )

          yield* Deferred.await(preparing)
          yield* Fiber.interrupt(creating)

          expect((yield* Effect.flip(sandboxProvider.resume(id))).reason._tag).toBe("NotFoundError")
          expect((yield* sandboxProvider.create({ id })).id).toBe(id)
        }),
      fixture.timeout
    )
  })
