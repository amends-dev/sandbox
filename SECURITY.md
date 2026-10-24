# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through GitHub: on the repository's **Security** tab, choose
**Report a vulnerability**. Do not open a public issue or pull request for it.

Say what is affected, such as a package and its version, how to reproduce it, and what an attacker
could do with it. We will confirm we received it, keep you told as we investigate and fix it, and
publish a security advisory once a fix is released, crediting you if you would like.

## Supported versions

These packages are in early development. Fixes go into `main` and the next release of each
package; earlier releases do not receive them.

## Scope

Reports are welcome for every package in this repository.

Some behavior is by design, and is not a vulnerability:

- **Local sandboxes isolate nothing.** A sandbox from `@amends-dev/sandbox-local` is a directory on
  your machine, and its processes run as you, on your network.
- **What a hosted platform isolates is the platform's.** A Daytona, E2B, or Vercel sandbox is as
  isolated as that platform makes it; report a weakness in its isolation to the platform.

A vulnerability in Effect, a platform's client, or another dependency belongs with that project.
Tell us too when it affects these packages in a way of its own.

## Running sandboxes

- Keep each platform's API key or token secret; whoever holds it can create and reach the account's
  sandboxes.
- Give code you would not run on your own machine a hosted provider's sandbox, not a local one.
