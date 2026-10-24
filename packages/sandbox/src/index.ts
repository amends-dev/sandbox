/**
 * Sandboxes that agents work in: the contract every sandbox provider implements, with Effect's own
 * file system and processes inside. `SandboxProvider` creates and resumes sandboxes on one
 * platform, `Sandbox` is one of them, `Template` prepares new ones, `Network` is what a sandbox
 * exposes and may reach, and `SandboxError` is what operations on a sandbox fail with.
 *
 * @since 0.1.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * @since 0.1.0
 */
export * as Network from "./Network.ts"

/**
 * @since 0.1.0
 */
export * as Sandbox from "./Sandbox.ts"

/**
 * @since 0.1.0
 */
export * as SandboxError from "./SandboxError.ts"

/**
 * @since 0.1.0
 */
export * as SandboxProvider from "./SandboxProvider.ts"

/**
 * @since 0.1.0
 */
export * as Template from "./Template.ts"
