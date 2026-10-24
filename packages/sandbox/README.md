# @amends-dev/sandbox

Sandboxes that agents work in. A sandbox is an isolated machine that code runs in: its files and
processes are Effect's own `FileSystem` and `ChildProcessSpawner`, so any Effect code that uses
them runs inside the sandbox once `Sandbox.layerServices` provides them. The `Sandbox` service
adds what Effect has no service for: the sandbox's identity, its ports, its network, and its
lifecycle. A `SandboxProvider` creates sandboxes on one platform, such as this machine or Daytona,
and resumes the ones it created before, so code that creates sandboxes does not depend on which.
The package depends only on Effect.

## Install

```sh
bun add @amends-dev/sandbox effect
```

Add a provider for each platform you run sandboxes on, such as `@amends-dev/sandbox-local` for this
machine or `@amends-dev/sandbox-daytona`. [`@amends-dev/harness`](https://github.com/amends-dev/harness) runs agents in them.

## Quick start

A program asks for the `SandboxProvider` service and creates a sandbox. Effect code works inside
it once `Sandbox.layerServices` provides the sandbox's services. The sandbox outlives the program:
stopping it keeps its files, and the provider resumes it later by its id.

```ts
import { Network, Sandbox, SandboxProvider } from "@amends-dev/sandbox"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// From a provider, such as @amends-dev/sandbox-local for this machine or
// @amends-dev/sandbox-daytona.
declare const sandboxes: Layer.Layer<SandboxProvider.SandboxProvider>

const program = Effect.gen(function* () {
  const sandboxProvider = yield* SandboxProvider.SandboxProvider
  const sandbox = yield* sandboxProvider.create({ ports: [Network.Port.make(3000)] })

  // Commands start in the working directory; file paths are absolute.
  const greeting = yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* spawner.exitCode(ChildProcess.make("sh", ["-c", "echo hello > greeting.txt"]))
    return yield* fs.readFileString(path.join(sandbox.workingDirectory, "greeting.txt"))
  }).pipe(Effect.provide(Sandbox.layerServices(sandbox)))

  // The sandbox outlives this program: stop it now, and resume it by its id later.
  yield* sandbox.stop
  const resumed = yield* sandboxProvider.resume(sandbox.id)
  const endpoint = yield* resumed.endpoint(Network.Port.make(3000), "http")
  return { greeting, url: endpoint.url }
}).pipe(Effect.provide(sandboxes))
```

## The modules

| Module            | What it holds                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `SandboxProvider` | The service that creates sandboxes on one platform, from a template, and resumes them by id.    |
| `Sandbox`         | One sandbox: its files, processes, ports, network, and lifecycle, and `layerServices`.          |
| `Template`        | Prepares a new sandbox, as by installing an agent, once per version where a provider snapshots. |
| `Network`         | Ports and how to reach them, the outbound network policy, and request transformations.          |
| `SandboxError`    | The error every operation on a sandbox fails with, and its reasons.                             |

## Files and processes

Inside a sandbox, files are Effect's `FileSystem` and processes are its `ChildProcessSpawner`, so
code written against them, and Effect's `ChildProcess` commands, run in any sandbox. File paths
are absolute, such as ones joined onto `workingDirectory`; what a relative path refers to differs
between providers. A command starts in the working directory unless it sets a `cwd`, which a
relative one resolves against, and gets the environment it is given, or the sandbox's with it when
it extends the environment. File and process operations fail with Effect's `PlatformError`, as
they do anywhere.

A process ends with the scope that spawned it, unless its handle's `unref` lets it outlive that
scope, as a server that keeps running after the host lets go does; it then runs until the sandbox
stops.

## Lifetime

A sandbox runs until `stop` or `destroy`, not until a scope closes. `stop` ends every process in
it and keeps its files, and `resume` starts it again with them; `destroy` deletes it. For work that
must leave no sandbox behind, `createScoped` creates one that is destroyed when the scope closes,
as `makeTempDirectoryScoped` makes a directory that is removed. Both succeed
again on a sandbox already stopped or destroyed, and resuming a destroyed or unknown id fails with
`NotFoundError`. A create that fails, including when its template fails or it is interrupted,
leaves no sandbox behind. Every `Sandbox` value for one sandbox, created or resumed, works on the
same files, processes, and ports. What only one platform takes, such as the snapshot a sandbox on
Daytona starts from, goes in `providerOptions` under the provider's id: a provider decodes its own
entry, ignores the others, and fails with `InvalidOptionsError` for one it cannot take.

An id passes `Sandbox.isName`: letters, digits, `-`, and `_`, starting with a letter or digit, at
most 63 characters, so that any provider can use it as a directory name or in a URL.

## Templates

A `Template` prepares a new sandbox, for example by installing an agent, so that sandboxes created
from it start ready. Its `prepare` runs inside the new sandbox, with the sandbox's services; its
`name` holds across versions, and its `identity` names what `prepare` produces. A provider that
can snapshot, as Daytona can, prepares once per identity and creates later sandboxes from the
snapshot; one that cannot runs `prepare` on every create. `prepare` also runs in a sandbox prepared
before, by this or another version of the template, as when an agent launches in a sandbox created
for another, and leaves it ready without redoing what is there. The documentation of `Template`
shows one that installs a tool.

## Ports and the network

A sandbox exposes the `ports` it was created with, and `exposePorts` exposes more later where the
provider allows it. `endpoint` gives how to reach a port from outside: a URL for HTTP or
WebSocket, and any headers the provider requires; a request with them reaches the server with the
request's other headers intact. A `NetworkPolicy` says what the sandbox may reach outbound, from
`AllowAll` to `DenyAll` and an `AllowList` of hosts and CIDR ranges; a sandbox starts under the
policy `create` is given. A `RequestTransformation` sets headers on outbound requests after they
leave the sandbox, so that the sandbox holds only a placeholder credential and never the real one;
`setRequestTransformations` replaces the set, so passing one without a credential revokes it.
A provider that cannot enforce a policy or transform requests, as the local one cannot, fails with
`UnsupportedError`, and `create` under a policy it cannot enforce creates nothing.

## Errors

Every operation on a sandbox fails with `SandboxError`, which names the provider and holds a
reason: `AuthenticationError`, `NotFoundError`, `AlreadyExistsError`, `InvalidOptionsError`,
`UnsupportedError`, `UnavailableError`, or `UnknownError`. Each says whether trying again may
succeed, as `isRetryable`, and `Effect.catchReason("SandboxError", "NotFoundError", ...)` recovers
from one reason. File and process operations inside a sandbox fail with Effect's `PlatformError`.

## Writing a provider

Implement `create`, which prepares a new sandbox with its template under its network policy and
removes what it made when that fails, and `resume`, which reattaches to a sandbox by its id and
starts it again if it was stopped; `SandboxProvider.make` builds the service from them. Each
returns a `Sandbox` whose `fileSystem` and `childProcessSpawner` are the sandbox's. A provider's
layer takes the platform's settings, such as credentials or a root directory, and `create` decodes
its own entry of `providerOptions` with a schema of what it takes per sandbox, ignoring the entries
of others.

Then run the conformance suites in `@amends-dev/sandbox/conformance` against it, so that code
written against the contract works the same on each provider. A test file calls `run` with a
`Fixture`: how to make the provider for one test, a free port, a command that serves HTTP on a port,
and a layer with what those need and the HTTP client the suites reach ports with. The suites need
`@effect/vitest`, an optional peer dependency that only a provider's tests install. The
documentation of `run` shows such a test file.
[`@amends-dev/sandbox-local`](../sandbox-local) and
[`@amends-dev/sandbox-daytona`](../sandbox-daytona),
[`@amends-dev/sandbox-e2b`](../sandbox-e2b), and
[`@amends-dev/sandbox-vercel`](../sandbox-vercel) are the providers in this repository.
Each adapter's guide records the operations its platform supports and the limitations of its
lifecycle, network policies, and file and process services.

## Development

Run the package's tests with `bun run test packages/sandbox`; each provider runs the conformance
suites in its own tests. `bun run dist check packages/sandbox`
builds the package as npm gets it and checks it as a consumer.

## Inspiration

The contract is modelled on the sandboxes of Vercel's
[AI SDK Harnesses](https://ai-sdk.dev/docs/ai-sdk-harnesses): a sandbox's files and processes, the
ports and network policy a provider may offer, and templates that prepare a sandbox for an agent.
