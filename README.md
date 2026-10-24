# sandbox

Sandboxes that agents work in, for [Effect](https://effect.website). A sandbox is an isolated
machine that code runs in: its files and processes are Effect's own `FileSystem` and
`ChildProcessSpawner`, so Effect code that uses them runs inside the sandbox unchanged. A provider
creates sandboxes on one platform, and code written against the contract runs on any of them.

| Package                                                   | What it is                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| [`@amends-dev/sandbox`](packages/sandbox)                 | The contract every provider implements, and its conformance suites  |
| [`@amends-dev/sandbox-local`](packages/sandbox-local)     | Sandboxes as directories on this machine, for development and tests |
| [`@amends-dev/sandbox-daytona`](packages/sandbox-daytona) | Sandboxes on Daytona                                                |
| [`@amends-dev/sandbox-e2b`](packages/sandbox-e2b)         | Sandboxes on E2B                                                    |
| [`@amends-dev/sandbox-vercel`](packages/sandbox-vercel)   | Sandboxes on Vercel                                                 |

```sh
bun add @amends-dev/sandbox @amends-dev/sandbox-local effect
```

The [contract's guide](packages/sandbox/README.md) shows a program that creates a sandbox and
runs code in it, and how to [write a provider](packages/sandbox/README.md#writing-a-provider).
[`@amends-dev/harness`](https://github.com/amends-dev/harness) runs agents in these sandboxes.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setting up, the checks every change passes, and
releases. Report a vulnerability as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
