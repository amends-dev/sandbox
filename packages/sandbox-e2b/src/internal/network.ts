/** E2B allows destinations before evaluating deny rules; denied exceptions cannot be represented. */

import { Network, SandboxError } from "@amends-dev/sandbox"
import * as Effect from "effect/Effect"
import { sandboxError } from "./call.ts"

export const networkSettingsOf = Network.NetworkPolicy.match({
  AllowAll: () => Effect.succeed({ allowOut: [], denyOut: [] }),
  DenyAll: () => Effect.succeed({ allowOut: [], denyOut: ["0.0.0.0/0"] }),
  AllowList: ({ allowedHosts, allowedCidrs, deniedCidrs }) =>
    deniedCidrs.length > 0
      ? Effect.fail(
          sandboxError(
            new SandboxError.UnsupportedError({ description: "E2B's allow rules override denied CIDR exceptions" })
          )
        )
      : Effect.succeed({ allowOut: [...allowedHosts, ...allowedCidrs], denyOut: ["0.0.0.0/0"] })
})
