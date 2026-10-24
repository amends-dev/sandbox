/**
 * A template prepares a new sandbox, for example by installing an agent and writing its files, so
 * that sandboxes created from it start ready. A provider that can snapshot runs `prepare` once
 * per `identity` and creates later sandboxes from that snapshot; the snapshot replaces the one of
 * an older version of the template, which has the same `name`. A provider that cannot snapshot
 * runs `prepare` on every create. A template also runs in a sandbox prepared before, by its own or
 * another version, when an agent needs it there, and keeps what such a sandbox has.
 *
 * @since 0.1.0
 */

import type * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as Sandbox from "./Sandbox.ts"

/**
 * Names a template across its versions, as `Sandbox.isName` checks, in at most 30 characters, so
 * that a provider can name what it makes of each version after the template, with a prefix and a
 * digest, within the 63 characters of a name.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TemplateName = Schema.String.check(Sandbox.isName, Schema.isMaxLength(30)).pipe(
  Schema.brand("TemplateName")
)

/**
 * @category schemas
 * @since 0.1.0
 */
export type TemplateName = typeof TemplateName.Type

/**
 * What prepares a sandbox, and how a provider tells versions of it apart. `E` is what `prepare`
 * fails with, which `create` fails with too.
 *
 * **Example** (A template that installs a tool)
 *
 * ```ts
 * import { Template } from "@amends-dev/sandbox"
 * import { Effect } from "effect"
 * import { ChildProcess, ChildProcessSpawner } from "effect/process"
 *
 * const version = "3.6.2"
 *
 * const prettier: Template.Template = {
 *   name: Template.TemplateName.make("prettier"),
 *   identity: `prettier-${version}`,
 *   prepare: Effect.gen(function* () {
 *     const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
 *     yield* spawner.exitCode(ChildProcess.make("npm", ["install", "--global", `prettier@${version}`]))
 *   })
 * }
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface Template<E = PlatformError.PlatformError> {
  /**
   * Names the template across its versions, such as the agent it installs. Templates with the same
   * name and another identity are older or newer versions of it.
   */
  readonly name: TemplateName

  /**
   * Names what `prepare` produces: templates with the same identity must prepare the same
   * contents. A provider combines it with its own base image or runtime when it names a snapshot.
   */
  readonly identity: string

  /**
   * Runs inside the sandbox, where `FileSystem`, `Path`, and `ChildProcessSpawner` are the
   * sandbox's: in a new sandbox before `create` returns, and again in one prepared before, by this
   * or another version of the template, as when an agent launches in a sandbox created for
   * another. It leaves such a sandbox ready without redoing what is there. Anything it needs from
   * the host is read beforehand and captured.
   */
  readonly prepare: Effect.Effect<void, E, Sandbox.SandboxServices>
}
