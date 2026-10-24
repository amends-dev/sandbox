import { Sandbox, Template } from "@amends-dev/sandbox"
import { SnapshotState } from "@daytona/sdk"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { nextStepOf, otherVersionsToDelete, snapshotNameOf } from "../src/internal/snapshots.ts"

const hour = 60 * 60 * 1000
const now = Date.parse("2026-10-04T12:00:00Z")
const ago = (hours: number) => new Date(now - hours * hour)
const current = "amends-template-opencode-0000000000000000"

describe("Snapshots", () => {
  it("makes a missing snapshot, uses an active one, and waits for one being made or removed", () => {
    expect(nextStepOf(Option.none())).toBe("Make")
    expect(nextStepOf(Option.some(SnapshotState.ACTIVE))).toBe("Use")
    expect(nextStepOf(Option.some(SnapshotState.INACTIVE))).toBe("Activate")
    expect(nextStepOf(Option.some(SnapshotState.ERROR))).toBe("Replace")
    expect(nextStepOf(Option.some(SnapshotState.BUILD_FAILED))).toBe("Replace")
    for (const state of [
      SnapshotState.PENDING,
      SnapshotState.PULLING,
      SnapshotState.BUILDING,
      SnapshotState.SNAPSHOTTING,
      SnapshotState.REMOVING
    ]) {
      expect(nextStepOf(Option.some(state))).toBe("Wait")
    }
  })

  it("deletes the template's other versions that no sandbox started from for a day", () => {
    const snapshots = [
      { name: current, createdAt: ago(48), lastUsedAt: ago(48) },
      {
        name: "amends-template-opencode-1111111111111111",
        createdAt: ago(72),
        lastUsedAt: ago(30)
      },
      { name: "amends-template-opencode-2222222222222222", createdAt: ago(72), lastUsedAt: ago(1) },
      { name: "amends-template-opencode-3333333333333333", createdAt: ago(30), lastUsedAt: null },
      { name: "amends-template-opencode-4444444444444444", createdAt: ago(2), lastUsedAt: null },
      // Another template, whose name starts with this one's.
      {
        name: "amends-template-opencode-extra-5555555555555555",
        createdAt: ago(72),
        lastUsedAt: null
      },
      { name: "open-browser-sandbox:0.4.0", createdAt: ago(72), lastUsedAt: null }
    ]

    expect(otherVersionsToDelete(snapshots, "opencode", current, now)).toEqual([
      "amends-template-opencode-1111111111111111",
      "amends-template-opencode-3333333333333333"
    ])
  })
})

layer(BunServices.layer)("snapshotNameOf", (it) => {
  it.effect("names a version by its template's name and a digest of its identity and base", () =>
    Effect.gen(function* () {
      const template = {
        name: Template.TemplateName.make("opencode"),
        identity: "one",
        prepare: Effect.void
      }

      const name = yield* snapshotNameOf(template, undefined)

      expect(name).toMatch(/^amends-template-opencode-[0-9a-f]{16}$/)
      expect(yield* snapshotNameOf(template, undefined)).toBe(name)
      expect(yield* snapshotNameOf({ ...template, identity: "two" }, undefined)).not.toBe(name)
      expect(yield* snapshotNameOf(template, "daytona-large")).not.toBe(name)
    })
  )

  it.effect("names a version of a template with the longest name as a sandbox can be named", () =>
    Effect.gen(function* () {
      const template = {
        name: Template.TemplateName.make("a".repeat(30)),
        identity: "one",
        prepare: Effect.void
      }

      const name = yield* snapshotNameOf(template, undefined)

      expect(Schema.is(Sandbox.SandboxId)(name)).toBe(true)
    })
  )
})
