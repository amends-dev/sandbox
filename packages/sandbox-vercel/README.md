# @amends-dev/sandbox-vercel

[Vercel Sandbox](https://vercel.com/docs/sandbox) implements the
[`@amends-dev/sandbox`](../sandbox/README.md) contract through the pinned
`@vercel/sandbox` 3.8.0 SDK. It belongs in an adapter because the portable contract must not
install Vercel's SDK or depend on a Node-compatible runtime.

```ts
import { VercelSandboxProvider } from "@amends-dev/sandbox-vercel"
import { BunServices } from "@effect/platform-bun"
import { Effect, Redacted } from "effect"

const program = Effect.scoped(
  Effect.gen(function* () {
    const provider = yield* VercelSandboxProvider.make({
      token: Redacted.make("your-vercel-token"),
      teamId: "team_your-team",
      projectId: "prj_your-project"
    })
    const sandbox = yield* provider.createScoped()
    yield* sandbox.fileSystem.writeFileString(`${sandbox.workingDirectory}/hello.txt`, "hello")
  })
).pipe(Effect.provide(BunServices.layer))
```

`make` requires Effect's `Crypto` service. `layer` delegates to it and provides
`SandboxProvider`. Token, team, and project are explicit; the adapter does not use ambient OIDC
credentials. An optional `fetch` replaces the SDK's transport for proxies and tests.
The [local host](https://github.com/amends-dev/amends/tree/main/hosts/local#readme) installs the `vercel` integration and supplies these
settings from a workspace connection.

## Lifecycle and preparation

The logical sandbox ID is the Vercel sandbox name within the configured project. Vercel reserves
names atomically, so creating an existing name fails with `AlreadyExistsError`. Resuming asks for
that exact name with `resume: true`; it never creates one. Use a dedicated project or names that
do not collide with other applications.

New sandboxes are persistent, with a one-hour running timeout by default. A stop, including the
provider's automatic timeout, snapshots the filesystem and ends the current VM's processes. Resume
restores the files into a new session. The adapter keeps one snapshot with no expiration; destroy
also asks Vercel to delete orphan snapshots. Snapshot retention consumes Vercel storage until
destroy. File and process handles remain bound to the session they came from: an old process
handle cannot restart a stopped VM or signal a process in a replacement session.

`Options.image` selects a Vercel Container Registry image; omitted, the SDK uses its managed
universal image. `Options.timeoutMs` changes the running timeout. A creation can override them:

```ts
import { SandboxProvider } from "@amends-dev/sandbox"
import { Effect } from "effect"

const createConfigured = Effect.gen(function* () {
  const provider = yield* SandboxProvider.SandboxProvider
  return yield* provider.create({
    providerOptions: { vercel: { image: "my-project-image:v1", timeoutMs: 900_000 } }
  })
})
```

Unknown or malformed Vercel options fail before allocation. Account plan limits still apply.
Images must contain the Linux POSIX tools used by the adapter: `sh`, `setsid`, GNU coreutils,
`find`, `grep`, and `/proc`. The managed universal image is the default reference image.

A template prepares every newly allocated sandbox; template identities are not cached as shared
prepared snapshots. Preparation has internet access and completes before the requested network
policy is applied. A failed or interrupted preparation deletes its allocation. An allocation
attempt has a unique Vercel tag so a failed SDK response can be reconciled without deleting a
competing creator's sandbox. If Vercel is unreachable during that reconciliation, cleanup cannot
be confirmed and the original typed failure is preserved.

## Files, processes, and ports

Files use the session's binary file API and POSIX tools. Relative paths resolve against the
session's working directory (normally `/vercel/sandbox`). Reads and writes hold a whole file in
memory. `open`, file watching, globbing, and write modes other than `w`, `w+`, `wx`, and `wx+` return
an explicit platform error. Exclusive writes check existence first; they are not atomic across
concurrent remote writers.

Commands run in separate process groups and expose streamed stdin, stdout, stderr, exit codes,
kill, and unref. Finite stdin streams deliver EOF, including the harness bridge's initial line.
Output is polled from per-command files in bounded chunks and transferred as base64 because the
SDK's logs decode UTF-8 and would corrupt arbitrary bytes. Process scopes clean up their group
and scratch files; unreferenced commands retain those files until the sandbox is destroyed.
Inherited host streams and additional file descriptors are unsupported.

Ports can be exposed after creation, up to Vercel's 15-port limit. Each lookup refreshes the
provider's routes, so another handle sees newly exposed ports. Updates within one provider are
serialized; concurrent independent hosts should coordinate changes to the same sandbox.
Endpoints use HTTPS or WSS and have no provider authentication headers: Vercel exposes these
routes publicly. The served application must authenticate requests; Amends harness bridges use
their own token. Caller headers, including `Authorization`, are preserved.

## Network rules

`AllowAll`, `DenyAll`, and allow lists with allowed hosts, allowed CIDRs, and denied CIDRs map to
Vercel's firewall. Denied CIDRs override both allowed domains and ranges. Vercel domain matching
uses TLS SNI; plaintext HTTP requires allowed IP ranges. See the provider's
[firewall semantics](https://vercel.com/docs/sandbox/concepts/firewall).

Request transformations are supported for exact hosts already in a domain allow list, with no
allowed CIDRs and at most one rule per host. Matching preserves the path prefix and every exact
header value; secret replacement headers go only to Vercel's control plane, never to sandbox
files or commands. An empty replacement removes all transformations.

Other combinations return `UnsupportedError` before mutation. Vercel's allowed CIDRs bypass
transformation rules, and its rule map also allows the named domains, so those combinations
cannot preserve this contract safely. The adapter owns its firewall configuration; policies edited
outside it are unsupported because the SDK omits some native rule types on reads. Surfaced
forwarding or direct-response rules cause transformation replacement to fail. Vercel redacts
persisted secret headers on reads; while request rules
exist, `setNetworkPolicy` therefore refuses to discard or resend them. Clear transformations,
change the policy, then supply the new complete transformation set. Coordinate these operations
with other hosts changing the same sandbox.

## Verification

```sh
bun run --filter @amends-dev/sandbox-vercel typecheck
bun run test packages/sandbox-vercel/test
```

Normal tests run the real pinned SDK against scoped local HTTP APIs, checking its request and
response formats, lifecycle cleanup, ports, transformation payloads, binary transport, and
session-bound process handles. They do not allocate Vercel resources.

The shared conformance suites and live regressions allocate paid Vercel sandboxes only when all
credentials and the explicit opt-in are present:

```sh
AMENDS_TEST_VERCEL=1 \
VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... \
bun run test packages/sandbox-vercel/test
```

Live regressions cover persistence across providers, old process handles after resume, binary
stdin with EOF, and actual deny-all enforcement. Without those credentials, cloud behavior is
not verified by the local API tests.
