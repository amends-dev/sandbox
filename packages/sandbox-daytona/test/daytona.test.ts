import { type Network, type Sandbox, type SandboxProvider, Template } from "@amends-dev/sandbox"
import { DaytonaSandboxProvider } from "@amends-dev/sandbox-daytona"
import { Daytona, DaytonaNotFoundError } from "@daytona/sdk"
import { BunServices } from "@effect/platform-bun"
import { afterAll, describe, expect, layer } from "@effect/vitest"
import { Crypto, Data, Effect, Redacted, Ref, Schedule, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { snapshotNameOf } from "../src/internal/snapshots.ts"

/**
 * What the Daytona provider does beyond the conformance suites: what it asks of Daytona, how it
 * prepares each version of a template once, and the network policies Daytona enforces. These
 * create real sandboxes too, so they run only with `AMENDS_TEST_DAYTONA=1` and `DAYTONA_API_KEY`.
 */
const apiKey = Redacted.make(process.env.DAYTONA_API_KEY ?? "")
const timeout = 120_000
const snapshotTimeout = 15 * 60_000

class PrepareFailed extends Data.TaggedError("PrepareFailed") {}

/** Daytona's own client, to look at what the provider asked of it. */
const useDaytona = Effect.acquireDisposable(Effect.sync(() => new Daytona({ apiKey: Redacted.value(apiKey) })))

/** A sandbox `provider` creates, destroyed when the test ends. */
const createSandbox = <E>(
  provider: SandboxProvider.SandboxProvider["Service"],
  options?: SandboxProvider.CreateOptions<E>
) => Effect.acquireRelease(provider.create(options), (sandbox) => Effect.ignore(sandbox.destroy))

/**
 * A version of a template no other test or run prepares, with `prepare` as its preparation, and
 * whose snapshot is deleted when the test ends.
 */
const useTemplate = <E>(prepare: Template.Template<E>["prepare"]) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const daytona = yield* useDaytona
    const template = {
      name: Template.TemplateName.make("daytona-test"),
      identity: yield* crypto.randomUUIDv4(),
      prepare
    }
    const snapshot = yield* snapshotNameOf(template, undefined)
    yield* Effect.addFinalizer(() => Effect.ignore(Effect.tryPromise(() => daytona.snapshot.delete(snapshot))))
    return { template, snapshot }
  })

/** A template that writes `prepared.txt` in the working directory, counting its runs in `runs`. */
const writePrepared = (runs: Ref.Ref<number>) =>
  Effect.gen(function* () {
    yield* Ref.update(runs, (count) => count + 1)
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* spawner.exitCode(ChildProcess.make("sh", ["-c", "echo ready > prepared.txt"]))
  })

const readPrepared = (sandbox: Sandbox.Sandbox["Service"]) =>
  sandbox.fileSystem.readFileString(`${sandbox.workingDirectory}/prepared.txt`)

/** Whether a request from inside `sandbox` reaches `host` over HTTPS within five seconds. */
const reaches = (sandbox: Sandbox.Sandbox["Service"], host: string) =>
  Effect.map(
    sandbox.childProcessSpawner.exitCode(
      ChildProcess.make("curl", ["-sS", "-o", "/dev/null", "-m", "5", `https://${host}`])
    ),
    (exitCode) => exitCode === 0
  )

const reachable = (sandbox: Sandbox.Sandbox["Service"]) =>
  Effect.all(
    { example: reaches(sandbox, "example.com"), npm: reaches(sandbox, "registry.npmjs.org") },
    { concurrency: "unbounded" }
  )

/**
 * What `sandbox` reaches once the policy just set is applied, looking again while it reaches other
 * than `expected`: Daytona applies a policy a moment after it answers.
 */
const reachableOnceApplied = (
  sandbox: Sandbox.Sandbox["Service"],
  expected: { readonly example: boolean; readonly npm: boolean }
) =>
  Effect.repeat(reachable(sandbox), {
    until: ({ example, npm }) => example === expected.example && npm === expected.npm,
    schedule: Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "20 seconds" }))
  })

/**
 * Deletes what the tests' templates leave being made in the background when a test ends: the
 * sandboxes that make their snapshots, and the snapshots. One that Daytona is still making is
 * deleted by the next run.
 */
const deleteTemplateLeftovers = async () => {
  const daytona = new Daytona({ apiKey: Redacted.value(apiKey) })
  try {
    const makers = []
    for await (const sandbox of daytona.list({ labels: { "amends-template": "daytona-test" } })) {
      makers.push(sandbox)
    }
    const { items } = await daytona.snapshot.list({ page: 1, limit: 100 })
    // Daytona refuses to delete a sandbox while it makes a snapshot, which its time limit ends.
    await Promise.allSettled([
      ...makers.map((sandbox) => sandbox.delete()),
      ...items
        .filter((snapshot) => snapshot.name.startsWith("amends-template-daytona-test-"))
        .map((snapshot) => daytona.snapshot.delete(snapshot.name))
    ])
  } finally {
    await daytona[Symbol.asyncDispose]()
  }
}

const allowList = (
  allowedHosts: ReadonlyArray<string>,
  allowedCidrs: ReadonlyArray<string> = [],
  deniedCidrs: ReadonlyArray<string> = []
): Network.NetworkPolicy => ({ _tag: "AllowList", allowedHosts, allowedCidrs, deniedCidrs })

describe.skipIf(process.env.AMENDS_TEST_DAYTONA !== "1" || process.env.DAYTONA_API_KEY === undefined)(
  "DaytonaSandboxProvider",
  () => {
    afterAll(deleteTemplateLeftovers, 60_000)

    layer(BunServices.layer, { excludeTestServices: true })("in Daytona's cloud", (it) => {
      it.effect(
        "never stops a sandbox on its own, unless the options give an interval",
        () =>
          Effect.gen(function* () {
            const daytona = yield* useDaytona
            const lasting = yield* createSandbox(yield* DaytonaSandboxProvider.make({ apiKey }))
            const stopping = yield* createSandbox(yield* DaytonaSandboxProvider.make({ apiKey, autoStopInterval: 30 }))

            const intervalOf = (sandbox: Sandbox.Sandbox["Service"]) =>
              Effect.map(
                Effect.promise(() => daytona.get(sandbox.id)),
                (found) => found.autoStopInterval
              )

            expect(yield* intervalOf(lasting)).toBe(0)
            expect(yield* intervalOf(stopping)).toBe(30)
          }),
        timeout
      )

      it.effect(
        "makes one snapshot of a version that hosts create sandboxes from, and starts later ones from it",
        () =>
          Effect.gen(function* () {
            const daytona = yield* useDaytona
            const hosts = [
              yield* DaytonaSandboxProvider.make({ apiKey }),
              yield* DaytonaSandboxProvider.make({ apiKey })
            ] as const
            const runs = yield* Ref.make(0)
            const { template, snapshot } = yield* useTemplate(writePrepared(runs))

            // Until the snapshot is made, each sandbox is prepared on its own.
            const first = yield* Effect.all(
              [
                createSandbox(hosts[0], { template }),
                createSandbox(hosts[1], { template }),
                createSandbox(hosts[1], { template })
              ],
              { concurrency: "unbounded" }
            )
            yield* Effect.tryPromise(() => daytona.snapshot.get(snapshot)).pipe(
              Effect.filterOrFail((found) => found.state === "active"),
              Effect.retry(Schedule.spaced("2 seconds"))
            )
            // Three in the sandboxes, and one in the sandbox the snapshot was made of.
            const prepared = yield* Ref.get(runs)
            const later = yield* createSandbox(hosts[0], { template })

            expect(prepared).toBe(4)
            expect(yield* Ref.get(runs)).toBe(4)
            for (const sandbox of [...first, later]) {
              expect(yield* readPrepared(sandbox)).toBe("ready\n")
            }
          }),
        // Daytona takes from seconds to several minutes to make a snapshot.
        snapshotTimeout
      )

      it.effect(
        "leaves neither the sandbox that made a failing template's snapshot nor a snapshot of it",
        () =>
          Effect.gen(function* () {
            const daytona = yield* useDaytona
            const provider = yield* DaytonaSandboxProvider.make({ apiKey })
            const runs = yield* Ref.make(0)
            const { template, snapshot } = yield* useTemplate(
              Effect.andThen(
                Ref.update(runs, (count) => count + 1),
                Effect.fail(new PrepareFailed())
              )
            )

            const error = yield* Effect.flip(provider.create({ template }))
            // Once the template has failed in the sandbox the snapshot was to be made of too, that
            // sandbox goes.
            yield* Ref.get(runs).pipe(
              Effect.filterOrFail((count) => count === 2),
              Effect.retry(Schedule.spaced("1 second"))
            )
            yield* Effect.promise(() =>
              daytona.get(snapshot).then(
                (sandbox): string => sandbox.state ?? "unknown",
                (error: unknown) => {
                  if (error instanceof DaytonaNotFoundError) return "missing"
                  throw error
                }
              )
            ).pipe(
              Effect.filterOrFail((state) => ["missing", "destroying", "destroyed"].includes(state)),
              Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "1 minute" })))
            )
            const snapshotExists = yield* Effect.tryPromise(() => daytona.snapshot.get(snapshot)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false)
            )

            expect(error._tag).toBe("PrepareFailed")
            expect(snapshotExists).toBe(false)
          }),
        timeout
      )

      it.effect(
        "enforces each network policy in place of the one before",
        () =>
          Effect.gen(function* () {
            const sandbox = yield* createSandbox(yield* DaytonaSandboxProvider.make({ apiKey }))

            yield* sandbox.setNetworkPolicy({ _tag: "DenyAll" })
            expect(yield* reachableOnceApplied(sandbox, { example: false, npm: false })).toEqual({
              example: false,
              npm: false
            })

            yield* sandbox.setNetworkPolicy(allowList(["example.com"]))
            expect(yield* reachableOnceApplied(sandbox, { example: true, npm: false })).toEqual({
              example: true,
              npm: false
            })

            yield* sandbox.setNetworkPolicy({ _tag: "AllowAll" })
            expect(yield* reachableOnceApplied(sandbox, { example: true, npm: true })).toEqual({
              example: true,
              npm: true
            })
          }),
        timeout
      )

      it.effect(
        "starts a sandbox created under a network policy with the policy in force",
        () =>
          Effect.gen(function* () {
            const sandbox = yield* createSandbox(yield* DaytonaSandboxProvider.make({ apiKey }), {
              networkPolicy: { _tag: "DenyAll" }
            })

            // Looked at once: the policy applies before the sandbox starts.
            expect(yield* reachable(sandbox)).toEqual({ example: false, npm: false })
          }),
        timeout
      )

      it.effect(
        "prepares a sandbox on its own before its network policy applies",
        () =>
          Effect.gen(function* () {
            const { template } = yield* useTemplate(
              Effect.gen(function* () {
                const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
                const exitCode = yield* spawner.exitCode(
                  ChildProcess.make("curl", ["-sS", "-o", "/dev/null", "-m", "5", "https://registry.npmjs.org"])
                )
                if (exitCode !== 0) return yield* new PrepareFailed()
              })
            )

            const sandbox = yield* createSandbox(yield* DaytonaSandboxProvider.make({ apiKey }), {
              template,
              networkPolicy: { _tag: "DenyAll" }
            })

            expect(yield* reachableOnceApplied(sandbox, { example: false, npm: false })).toEqual({
              example: false,
              npm: false
            })
          }),
        timeout
      )

      it.effect(
        "fails with UnsupportedError for an allow list of both hosts and ranges, or one that denies",
        () =>
          Effect.gen(function* () {
            const sandbox = yield* createSandbox(yield* DaytonaSandboxProvider.make({ apiKey }))

            const both = yield* Effect.flip(sandbox.setNetworkPolicy(allowList(["example.com"], ["1.1.1.1/32"])))
            const denying = yield* Effect.flip(sandbox.setNetworkPolicy(allowList([], ["10.0.0.0/8"], ["10.0.0.1/32"])))

            expect(both.reason._tag).toBe("UnsupportedError")
            expect(denying.reason._tag).toBe("UnsupportedError")
          }),
        timeout
      )

      it.effect(
        "keeps a command's environment out of Daytona's record of its session",
        () =>
          Effect.gen(function* () {
            const daytona = yield* useDaytona
            const sandbox = yield* createSandbox(yield* DaytonaSandboxProvider.make({ apiKey }))

            const { printed, recorded } = yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* sandbox.childProcessSpawner.spawn(
                  ChildProcess.make("sh", ["-c", 'printf %s "$SECRET"'], {
                    env: { SECRET: "kept out of the record" },
                    extendEnv: true
                  })
                )
                const printed = yield* Stream.mkString(Stream.decodeText(handle.stdout))
                // The process's session lasts until the scope closes.
                const found = yield* Effect.promise(() => daytona.get(sandbox.id))
                const sessions = yield* Effect.promise(() => found.process.listSessions())
                const recorded = sessions.flatMap((session) => session.commands.map(({ command }) => command))
                return { printed, recorded }
              })
            )

            expect(printed).toBe("kept out of the record")
            expect(recorded.length).toBeGreaterThan(0)
            expect(recorded.filter((command) => command.includes("kept out of"))).toEqual([])
          }),
        timeout
      )

      it.effect(
        "destroys a sandbox that several callers destroy at once",
        () =>
          Effect.gen(function* () {
            const provider = yield* DaytonaSandboxProvider.make({ apiKey })
            const sandbox = yield* createSandbox(provider)

            yield* Effect.all([sandbox.destroy, sandbox.destroy, sandbox.destroy], {
              concurrency: "unbounded"
            })

            expect((yield* Effect.flip(provider.resume(sandbox.id))).reason._tag).toBe("NotFoundError")
          }),
        timeout
      )
    })
  }
)
