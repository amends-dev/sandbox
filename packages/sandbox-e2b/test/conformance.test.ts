import * as Conformance from "@amends-dev/sandbox/conformance"
import { describe } from "@effect/vitest"
import { fixture, liveEnabled } from "./fixture.ts"

describe.skipIf(!liveEnabled)("E2bSandboxProvider", () => Conformance.run(fixture))
