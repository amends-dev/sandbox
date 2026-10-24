/**
 * What the suites make of a fixture for each test: a provider that destroys the sandboxes the test
 * created when it ends, and names no other test or run uses.
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Random from "effect/Random"
import * as Sandbox from "../../Sandbox.ts"
import * as SandboxProvider from "../../SandboxProvider.ts"
import type * as Fixture from "../Fixture.ts"

/**
 * The fixture's provider for one test, which destroys every sandbox the test created with it when
 * the test ends.
 */
export const providerForTest = <R, E>(fixture: Fixture.Fixture<R, E>) =>
  Effect.gen(function* () {
    const sandboxProvider = yield* fixture.makeProvider
    const created = new Set<Sandbox.Sandbox["Service"]["id"]>()
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        created,
        (id) =>
          sandboxProvider.resume(id).pipe(
            Effect.flatMap((sandbox) => sandbox.destroy),
            Effect.ignore
          ),
        { concurrency: "unbounded", discard: true }
      )
    )
    return SandboxProvider.make({
      create: (options) =>
        Effect.tap(sandboxProvider.create(options), (sandbox) => Effect.sync(() => created.add(sandbox.id))),
      resume: sandboxProvider.resume
    })
  })

/** A name no other test or run uses, starting with `prefix`. */
const uniqueName = (prefix: string) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const random = yield* Random.nextIntBetween(0, 2 ** 31)
    return `${prefix}-${now.toString(36)}-${random.toString(36)}`
  })

/** An id for a sandbox that no other test or run uses. */
export const newSandboxId = Effect.map(uniqueName("conformance"), (name) => Sandbox.SandboxId.make(name))

/** An identity for a template that no other test or run prepares. */
export const newIdentity = (name: string) => uniqueName(`conformance-${name}`)
