/**
 * Each version of a template, its name and identity, is made once into a Daytona snapshot, which
 * later sandboxes made from it start from. Daytona takes from seconds to several minutes to make a
 * snapshot, and sometimes fails, so no create waits for one: until a version's snapshot is active,
 * each create prepares its own sandbox, and one that finds no snapshot has it made meanwhile.
 *
 * A version is made in a sandbox named as its snapshot, and the name claims it: a create that
 * finds the name taken, on this host or another, leaves the snapshot to the create that took it.
 * That sandbox lives `claimMinutes` at most, so the claim of a host that stopped while making the
 * snapshot lapses.
 *
 * Once a create has made a version's snapshot, it deletes those of the template's other versions
 * that no sandbox has started from for a day. A version that other hosts still start sandboxes
 * from stays, as while hosts are upgraded one by one.
 */

import { SandboxError, type Template } from "@amends-dev/sandbox"
import { type Daytona, type Snapshot, SnapshotState } from "@daytona/sdk"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import { call, sandboxError } from "./call.ts"

/** How many minutes the sandbox making a version's snapshot lives at most, and so claims it. */
export const claimMinutes = 30

/** How long the template's other versions stay after a sandbox last started from them. */
const otherVersionsKeptFor = Duration.days(1)

/**
 * The name of the snapshot of `template`'s version, prepared in a sandbox that started from the
 * snapshot `base`, or from Daytona's default: the template's name, and a digest of the rest.
 */
export const snapshotNameOf = Effect.fnUntraced(function* <E>(
  template: Template.Template<E>,
  base: string | undefined
) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(JSON.stringify([template.identity, base ?? null])))
    .pipe(
      Effect.mapError((cause) => sandboxError(new SandboxError.UnknownError({ description: cause.message }), cause))
    )
  return `${prefixOf(template.name)}${Hex.encode(digest).slice(0, 16)}`
})

/**
 * The name of the active snapshot of `template`'s version, if there is one. If not, starts in
 * `scope` what brings it about: `make`, which makes the snapshot of the name it is given, or
 * succeeds with `false` and makes nothing when another create has claimed the version; activating
 * the snapshot; or deleting one Daytona failed to make, for a later create to make again.
 */
export const findSnapshot = Effect.fn("DaytonaSandboxProvider.findSnapshot")(function* <E>(
  daytona: Daytona,
  scope: Scope.Scope,
  template: Template.Template<E>,
  base: string | undefined,
  make: (name: string) => Effect.Effect<boolean, E | SandboxError.SandboxError>
) {
  const name = yield* snapshotNameOf(template, base)
  const state = yield* call(() => daytona.snapshot.get(name)).pipe(
    Effect.map((snapshot) => Option.some(snapshot.state)),
    Effect.catchReason("SandboxError", "NotFoundError", () => Effect.succeedNone)
  )
  const next = nextStepOf(state)
  if (next === "Use") return Option.some(name)
  if (next !== "Wait") {
    const bringAbout = {
      Make: Effect.flatMap(make(name), (made) =>
        made ? deleteOtherVersions(daytona, template.name, name) : Effect.void
      ),
      Activate: call(() => daytona.snapshot.activate(name)),
      Replace: call(() => daytona.snapshot.delete(name))
    }
    yield* Effect.forkIn(
      Effect.ignore(bringAbout[next], {
        log: "Warn",
        message: `Failed to ${next.toLowerCase()} the snapshot ${name} of the template ${template.name}`
      }),
      scope
    )
  }
  return Option.none<string>()
})

/** What to do about a version's snapshot, in the state Daytona has it in, or when there is none. */
export const nextStepOf = (state: Option.Option<SnapshotState>): "Use" | "Make" | "Activate" | "Replace" | "Wait" => {
  if (Option.isNone(state)) return "Make"
  switch (state.value) {
    case SnapshotState.ACTIVE:
      return "Use"
    // Daytona deactivates a snapshot no sandbox has started from for a while.
    case SnapshotState.INACTIVE:
      return "Activate"
    case SnapshotState.ERROR:
    case SnapshotState.BUILD_FAILED:
      return "Replace"
    // Being made, activated, or removed.
    default:
      return "Wait"
  }
}

/**
 * The snapshots of the template `templateName`'s versions other than `current` that no sandbox has
 * started from, and that were not made, within `otherVersionsKeptFor` before `now`.
 */
export const otherVersionsToDelete = (
  snapshots: ReadonlyArray<Pick<Snapshot, "name" | "createdAt" | "lastUsedAt">>,
  templateName: string,
  current: string,
  now: number
): ReadonlyArray<string> =>
  snapshots
    .filter(
      (snapshot) =>
        snapshot.name !== current &&
        isVersionOf(templateName, snapshot.name) &&
        new Date(snapshot.lastUsedAt ?? snapshot.createdAt).getTime() < now - Duration.toMillis(otherVersionsKeptFor)
    )
    .map((snapshot) => snapshot.name)

/** Deletes the template's other versions `otherVersionsToDelete` names; a failure leaves them. */
const deleteOtherVersions = (daytona: Daytona, templateName: string, current: string) =>
  Effect.gen(function* () {
    const snapshots = yield* listSnapshots(daytona)
    const now = yield* Clock.currentTimeMillis
    yield* Effect.forEach(
      otherVersionsToDelete(snapshots, templateName, current, now),
      (name) => Effect.ignore(call(() => daytona.snapshot.delete(name))),
      { discard: true }
    )
  }).pipe(Effect.ignore)

/** Every snapshot of the organization, a page at a time. */
const listSnapshots = Effect.fnUntraced(function* (daytona: Daytona) {
  const snapshots: Array<Snapshot> = []
  for (let page = 1; ; page++) {
    const { items, totalPages } = yield* call(() => daytona.snapshot.list({ page, limit: 100 }))
    snapshots.push(...items)
    if (page >= totalPages) return snapshots
  }
})

const prefixOf = (templateName: string) => `amends-template-${templateName}-`

/** Whether `snapshotName` names a version of the template `templateName`, and not of another. */
const isVersionOf = (templateName: string, snapshotName: string) =>
  snapshotName.startsWith(prefixOf(templateName)) &&
  /^[0-9a-f]{16}$/.test(snapshotName.slice(prefixOf(templateName).length))
