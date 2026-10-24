import * as Conformance from "@amends-dev/sandbox/conformance"
import { describe } from "@effect/vitest"
import { fixture, liveEnabled } from "./fixture.ts"

// These allocate paid microVMs and run only when the credentials and explicit opt-in are present.
describe.skipIf(!liveEnabled)("VercelSandboxProvider", () => Conformance.run(fixture))
