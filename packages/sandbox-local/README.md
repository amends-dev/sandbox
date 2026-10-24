# @amends-dev/sandbox-local

Sandboxes as directories on this machine, for the [`@amends-dev/sandbox`](../sandbox)
contract. Nothing is isolated: a sandbox's processes are this machine's processes, which can read
and write the whole machine and see its environment variables. So it suits development, tests, and
agents you would trust on this machine anyway, and lets code written against the contract run
without a cloud account; [`@amends-dev/sandbox-daytona`](../sandbox-daytona) runs the same code on
machines of their own.

## Install

```sh
bun add @amends-dev/sandbox-local @amends-dev/sandbox effect
```

The provider needs Effect's file system, path, crypto, and process services for this machine, as
`@effect/platform-bun` or `@effect/platform-node` provide them.

## Quick start

`LocalSandboxProvider.layer` provides the contract's `SandboxProvider` service over a directory,
which it creates if it is missing. A program then creates sandboxes, works inside them with Effect's
own `FileSystem` and `ChildProcessSpawner`, and resumes them later by id, as it would on any
provider.

```ts
import { LocalSandboxProvider } from "@amends-dev/sandbox-local"
import { Sandbox, SandboxProvider } from "@amends-dev/sandbox"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const sandboxes = LocalSandboxProvider.layer({ directory: "/var/lib/amends/sandboxes" }).pipe(
  Layer.provide(BunServices.layer)
)

const program = Effect.gen(function* () {
  const sandboxProvider = yield* SandboxProvider.SandboxProvider
  const sandbox = yield* sandboxProvider.create()

  // Commands start in the working directory; file paths are this machine's.
  const greeting = yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* spawner.exitCode(ChildProcess.make("sh", ["-c", "echo hello > greeting.txt"]))
    return yield* fs.readFileString(path.join(sandbox.workingDirectory, "greeting.txt"))
  }).pipe(Effect.provide(Sandbox.layerServices(sandbox)))

  // The directory stays: the provider resumes the sandbox by its id, in this process or another.
  yield* sandbox.stop
  const resumed = yield* sandboxProvider.resume(sandbox.id)
  return { greeting, workingDirectory: resumed.workingDirectory }
}).pipe(Effect.provide(sandboxes))
```

`LocalSandboxProvider.make` makes the provider for code that composes it itself, such as a test
over a temporary directory.

## Sandboxes on disk

Each sandbox is a directory under the provider's directory, named by the sandbox's id, which
`create` picks as a UUID when it is given none; an id whose directory exists fails with
`AlreadyExistsError`. The directory holds `sandbox.json`, the sandbox's settings, which are the
ports it exposes, and `workspace`, the sandbox's files and its working directory. A create that
fails, including when its template fails, removes the directory. `resume` finds a sandbox by its
directory and fails with `NotFoundError` for one that was destroyed, or that another provider
made elsewhere; `destroy` removes the directory.

A template runs on every create: the provider takes no snapshots, so each sandbox is prepared on
its own, and a template that installs much makes every create slow.

## Processes

Processes are this machine's, started by Effect's own spawner with the working directory as their
`cwd`, which a relative `cwd` resolves against. A process ends with the scope that spawned it,
unless its handle's `unref` lets it outlive that scope; it then runs until the sandbox stops.
`stop` and `destroy` end the processes the provider started for the sandbox, through any `Sandbox`
value for it, and wait for each to exit. A provider made again, as when a host restarts, does not
know of processes an earlier one left running.

## Ports and the network

A port is this machine's, so exposing it only records it: `endpoint` gives `http://127.0.0.1` or
`ws://127.0.0.1` at the port, with no headers, and a server in the sandbox is reached by listening
on the loopback interface. The sandbox shares this machine's network, so `setNetworkPolicy` accepts
only `AllowAll`, the policy it has, and `setRequestTransformations` fails with `UnsupportedError`:
nothing stands between the sandbox and the network to enforce a policy or set headers.

## Development

Run the package's tests with `bun run test packages/sandbox-local`: the conformance suites of
`@amends-dev/sandbox` over a temporary directory, and what this provider alone does. `bun run dist check packages/sandbox-local` builds the package as
npm gets it and checks it as a consumer.
