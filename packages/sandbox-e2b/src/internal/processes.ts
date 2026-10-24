/**
 * E2B commands run in their own process groups. Output is read from files byte for byte because
 * the SDK decodes stdout and stderr as UTF-8. Closing a referenced process scope kills its group;
 * an unreferenced process remains until the sandbox stops. Polling reads output without retaining
 * an unbounded SDK event stream or buffering all output on the host.
 */

import { SandboxNotFoundError, SandboxNotRunningError, type Sandbox as E2bSandbox } from "e2b"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { callPlatform } from "./call.ts"
import { quote } from "./shell.ts"

type Status = Data.TaggedEnum<{
  Running: {}
  Exited: { readonly exitCode: number }
  Ended: {}
}>
const Status = Data.taggedEnum<Status>()
const isRunning = Status.$is("Running")
const untilExit = Schedule.min([Schedule.exponential("50 millis"), Schedule.spaced("1 second")])
const delayAfter = (idle: number) => Duration.millis(Math.min(50 * 2 ** idle, 1000))
const readLimit = 1024 * 1024

export const makeChildProcessSpawner = Effect.fnUntraced(function* (sandbox: E2bSandbox, workingDirectory: string) {
  const crypto = yield* Crypto.Crypto

  const spawn = Effect.fnUntraced(function* (command: ChildProcess.Command) {
    const unsupported = unsupportedOption(command)
    if (unsupported !== undefined) {
      return yield* PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: unsupported })
    }
    const directory = `/tmp/amends-process-${yield* crypto.randomUUIDv4()}`
    const referenced = yield* Ref.make(true)
    const killed = yield* Ref.make(false)
    const execute = (method: string, script: string) =>
      callPlatform("ChildProcess", method, () => sandbox.commands.run(script))
    const remove = Effect.asVoid(execute("cleanup", `rm -rf -- ${quote(directory)}`))
    // Every scratch file is owned by this process scope, including failures before spawn returns.
    yield* Effect.acquireRelease(execute("spawn", `mkdir -m 700 -- ${quote(directory)}`), () =>
      Effect.flatMap(Ref.get(referenced), (value) => (value ? Effect.ignore(remove) : Effect.void))
    )
    const environmentScripts = new Map(
      standardCommandsOf(command).flatMap((standard, index) =>
        standard.options.env === undefined ? [] : [[standard, `${directory}/environment-${index}`] as const]
      )
    )
    yield* Effect.forEach(
      environmentScripts,
      ([standard, file]) =>
        callPlatform("ChildProcess", "spawn", () => sandbox.files.write(file, environmentScriptOf(standard))),
      { discard: true }
    )
    const line = commandLine(command, workingDirectory, environmentScripts)
    const body = [
      `cat /proc/sys/kernel/random/boot_id > ${quote(`${directory}/boot`)}`,
      `printf '%s' "$$" > ${quote(`${directory}/pid`)}`,
      `{ ${line}; } >${quote(`${directory}/stdout`)} 2>${quote(`${directory}/stderr`)}`,
      `printf '%s' "$?" >${quote(`${directory}/exit`)}`
    ].join("; ")
    // A filesystem-only resume may reuse a PID. Old handles must never signal a new process.
    const sameBoot = `cmp -s /proc/sys/kernel/random/boot_id ${quote(`${directory}/boot`)}`
    const input = stdinOf(command)
    const killGroup = Effect.gen(function* () {
      yield* execute(
        "kill",
        `if ${sameBoot} && [ -f ${quote(`${directory}/pid`)} ]; then ` +
          `group=$(cat ${quote(`${directory}/pid`)}); ` +
          // A live leader must still be our unique shell. An exited leader can leave children
          // in the group, whose group ID Linux reserves until the last member has left.
          `if [ ! -e "/proc/$group/cmdline" ] || ` +
          `tr '\\0' '\\n' <"/proc/$group/cmdline" | grep -Fq -- ${quote(directory)}; then ` +
          `kill -KILL -- -"$group" 2>/dev/null || true; fi; fi`
      )
      yield* Ref.set(killed, true)
    }).pipe(
      Effect.catchIf(
        (error) =>
          error.reason.cause instanceof SandboxNotRunningError || error.reason.cause instanceof SandboxNotFoundError,
        () => Effect.void
      )
    )
    const process = yield* Effect.acquireRelease(
      callPlatform("ChildProcess", "spawn", () =>
        sandbox.commands.run(`exec setsid -w sh -c ${quote(body)}`, {
          background: true,
          stdin: input !== "ignore",
          timeoutMs: 0,
          cwd: workingDirectory
        })
      ),
      (handle) =>
        Effect.gen(function* () {
          if (yield* Ref.get(referenced)) {
            yield* Effect.ignore(killGroup)
            // If starting failed before the group wrote its marker, terminate the SDK process.
            yield* callPlatform("ChildProcess", "cleanup", () => sandbox.files.exists(`${directory}/pid`)).pipe(
              Effect.flatMap((ready) =>
                ready ? Effect.void : callPlatform("ChildProcess", "kill", () => handle.kill())
              ),
              Effect.ignore
            )
          }
          yield* Effect.ignore(callPlatform("ChildProcess", "disconnect", () => handle.disconnect()))
        })
    )
    // The group leader may be a child of setsid. Wait for its marker before callers can kill it.
    yield* callPlatform("ChildProcess", "spawn", () => sandbox.files.exists(`${directory}/pid`)).pipe(
      Effect.repeat({
        until: (ready) => ready,
        schedule: Schedule.spaced("10 millis").pipe(Schedule.upTo({ duration: "1 second" }))
      }),
      Effect.flatMap((ready) =>
        ready
          ? Effect.void
          : Effect.fail(
              PlatformError.systemError({
                _tag: "TimedOut",
                module: "ChildProcess",
                method: "spawn",
                description: "E2B process group did not start"
              })
            )
      )
    )
    // Detach the SDK event reader; status and output below remain available through sandbox APIs.
    yield* callPlatform("ChildProcess", "disconnect", () => process.disconnect())

    const readStatus = Effect.gen(function* () {
      if (yield* Ref.get(killed)) return Status.Ended()
      const info = yield* callPlatform("ChildProcess", "status", () => sandbox.getInfo())
      if (info.state !== "running") return Status.Ended()
      const result = yield* execute(
        "status",
        `if ! ${sameBoot}; then printf ended; elif [ -f ${quote(`${directory}/exit`)} ]; then ` +
          `cat ${quote(`${directory}/exit`)}; elif kill -0 -- -$(cat ${quote(`${directory}/pid`)}) 2>/dev/null; then ` +
          `printf running; else printf ended; fi`
      )
      if (result.stdout === "running") return Status.Running()
      if (result.stdout === "ended") return Status.Ended()
      const exitCode = Number(result.stdout)
      return Number.isInteger(exitCode) ? Status.Exited({ exitCode }) : Status.Ended()
    }).pipe(
      Effect.catchIf(
        (error) =>
          error.reason.cause instanceof SandboxNotFoundError || error.reason.cause instanceof SandboxNotRunningError,
        () => Effect.succeed(Status.Ended())
      )
    )
    const awaitExit = Effect.repeat(readStatus, { until: (status) => !isRunning(status), schedule: untilExit })
    const readOutput = (output: "stdout" | "stderr", offset: number) =>
      Effect.map(
        execute(
          "read",
          `tail -c +${offset + 1} -- ${quote(`${directory}/${output}`)} 2>/dev/null` +
            ` | head -c ${readLimit} | base64 -w0`
        ),
        ({ stdout }) => new Uint8Array(Buffer.from(stdout, "base64"))
      )
    const outputOf = (output: "stdout" | "stderr") =>
      Stream.paginate(
        { offset: 0, idle: 0, ended: false },
        Effect.fnUntraced(function* ({ offset, idle, ended }) {
          const bytes = yield* readOutput(output, offset)
          if (bytes.length > 0)
            return [[bytes], Option.some({ offset: offset + bytes.length, idle: 0, ended })] as const
          if (ended) return [[], Option.none()] as const
          const status = yield* readStatus
          if (isRunning(status)) yield* Effect.sleep(delayAfter(idle))
          return [[], Option.some({ offset, idle: idle + 1, ended: !isRunning(status) })] as const
        })
      )
    const stdin =
      input === "ignore"
        ? Sink.drain
        : Sink.forEach((bytes: Uint8Array) =>
            callPlatform("ChildProcess", "stdin", () => sandbox.commands.sendStdin(process.pid, bytes))
          ).pipe(
            Sink.mapEffect(() => callPlatform("ChildProcess", "stdin", () => sandbox.commands.closeStdin(process.pid)))
          )
    if (Stream.isStream(input)) yield* Effect.forkScoped(Stream.run(input, stdin))
    const stdout = outputStreamOf(command, "stdout", () => outputOf("stdout"))
    const stderr = outputStreamOf(command, "stderr", () => outputOf("stderr"))
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(process.pid),
      exitCode: Effect.flatMap(awaitExit, (status) =>
        Status.$is("Exited")(status)
          ? Effect.succeed(ChildProcessSpawner.ExitCode(status.exitCode))
          : Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "exitCode",
                description: "The process was killed or ended with its sandbox"
              })
            )
      ),
      isRunning: Effect.map(readStatus, isRunning),
      kill: () => killGroup,
      stdin,
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.as(Ref.set(referenced, false), Ref.set(referenced, true))
    })
  })
  return ChildProcessSpawner.make(spawn)
})

/** Why E2B cannot run `command` as asked, or `undefined` when it can. */
const unsupportedOption = (command: ChildProcess.Command): string | undefined => {
  if (ChildProcess.isPipedCommand(command)) {
    const { from = "stdout", to = "stdin" } = command.options
    if (from.startsWith("fd") || to !== "stdin") {
      return "A E2B sandbox pipes only stdout, stderr, or both into stdin"
    }
    return unsupportedOption(command.left) ?? unsupportedOption(command.right)
  }
  const { additionalFds = {}, stdout, stderr } = command.options
  if (Object.keys(additionalFds).length > 0) {
    return "A E2B sandbox gives processes no file descriptors beyond stdin, stdout, and stderr"
  }
  const streams = [stdinOf(command), outputOptionOf(stdout), outputOptionOf(stderr)]
  if (streams.some((stream) => stream === "inherit" || stream === "overlapped")) {
    return "A process in a E2B sandbox cannot share the host's standard streams"
  }
  return undefined
}

/**
 * The sh line that runs `command` in `workingDirectory`, or in the directory its `cwd` names,
 * resolved against `workingDirectory`, each command of a pipe in a subshell of its own. A command
 * given an environment runs through the script `environmentScripts` names for it.
 */
const commandLine = (
  command: ChildProcess.Command,
  workingDirectory: string,
  environmentScripts: ReadonlyMap<ChildProcess.StandardCommand, string>
): string => {
  if (ChildProcess.isPipedCommand(command)) {
    const from = command.options.from ?? "stdout"
    const redirect = from === "stdout" ? "" : from === "all" ? " 2>&1" : " 2>&1 >/dev/null"
    const left = commandLine(command.left, workingDirectory, environmentScripts)
    const right = commandLine(command.right, workingDirectory, environmentScripts)
    return `${left}${redirect} | ${right}`
  }
  const { cwd, shell, stdout, stderr } = command.options
  const directory = cwd === undefined ? workingDirectory : cwd.startsWith("/") ? cwd : `${workingDirectory}/${cwd}`
  const program =
    shell === undefined || shell === false
      ? [command.command, ...command.args]
      : [shell === true ? "/bin/sh" : shell, "-c", [command.command, ...command.args].join(" ")]
  const redirects = [
    stdinOf(command) === "ignore" ? " </dev/null" : "",
    outputOptionOf(stdout) === "ignore" ? " >/dev/null" : "",
    outputOptionOf(stderr) === "ignore" ? " 2>/dev/null" : ""
  ].join("")
  const environmentScript = environmentScripts.get(command)
  const words = [...(environmentScript === undefined ? [] : ["sh", environmentScript]), ...program].map(quote).join(" ")
  return `(cd ${quote(directory)} && exec ${words}${redirects})`
}

/** The commands `command` runs, in order: itself, or each command of its pipe. */
const standardCommandsOf = (command: ChildProcess.Command): ReadonlyArray<ChildProcess.StandardCommand> =>
  ChildProcess.isPipedCommand(command)
    ? [...standardCommandsOf(command.left), ...standardCommandsOf(command.right)]
    : [command]

/**
 * A script that deletes itself, then runs the command its arguments name with `command`'s
 * environment: only `env`, without `extendEnv`, or the sandbox's own with `env` over it. An
 * undefined value unsets the variable.
 */
const environmentScriptOf = (command: ChildProcess.StandardCommand) => {
  const entries = Object.entries(command.options.env ?? {})
  const set = entries.flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${value}`]))
  const unset = entries.flatMap(([name, value]) => (value === undefined ? ["-u", name] : []))
  const words = ["env", ...(command.options.extendEnv === true ? unset : ["-i"]), ...set]
  return `rm -f -- "$0"\nexec ${words.map(quote).join(" ")} "$@"\n`
}

/** The input of the first command `command` runs. */
const stdinOf = (command: ChildProcess.Command): ChildProcess.CommandInput => {
  if (ChildProcess.isPipedCommand(command)) return stdinOf(command.left)
  const { stdin } = command.options
  if (stdin === undefined) return "pipe"
  return typeof stdin === "string" || Stream.isStream(stdin) ? stdin : stdin.stream
}

const outputOptionOf = (
  option: ChildProcess.CommandOutput | ChildProcess.StdoutConfig | undefined
): ChildProcess.CommandOutput => {
  if (option === undefined) return "pipe"
  return typeof option === "string" || Sink.isSink(option) ? option : (option.stream ?? "pipe")
}

/**
 * The handle's stream of what the last command `command` runs writes to `output`: nothing when it
 * is ignored, and passed through the sink the command gives for it.
 */
const outputStreamOf = (
  command: ChildProcess.Command,
  output: "stdout" | "stderr",
  stream: () => Stream.Stream<Uint8Array, PlatformError.PlatformError>
): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
  if (ChildProcess.isPipedCommand(command)) return outputStreamOf(command.right, output, stream)
  const option = outputOptionOf(command.options[output])
  if (option === "ignore") return Stream.empty
  return Sink.isSink(option) ? Stream.transduce(stream(), option) : stream()
}
