import { DaytonaSandboxProvider } from "@amends-dev/sandbox-daytona"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, Redacted } from "effect"

layer(BunServices.layer)("DaytonaSandboxProvider.providerOptions", (it) => {
  it.effect("fails with InvalidOptionsError for options Daytona does not take, asking nothing", () =>
    Effect.gen(function* () {
      // Nothing listens here, so a create that asked Daytona would fail with UnavailableError.
      const sandboxProvider = yield* DaytonaSandboxProvider.make({
        apiKey: Redacted.make("secret-key"),
        apiUrl: "http://127.0.0.1:1/api"
      })

      const error = yield* Effect.flip(sandboxProvider.create({ providerOptions: { daytona: { snapshot: 42 } } }))

      expect(error.reason._tag).toBe("InvalidOptionsError")
    })
  )
})
