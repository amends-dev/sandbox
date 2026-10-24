/**
 * A Daytona sandbox runs each process in a session of its own, a shell Daytona keeps for the
 * commands sent to it, and ends the process and its children by deleting the session. When the
 * scope that spawned a process closes, its session is deleted, unless its handle was unreferenced;
 * the process then runs until the sandbox stops.
 *
 * A process writes its output to files of its own in the sandbox, which its handle reads as they
 * grow, byte for byte: Daytona's own record of a session's output keeps whole lines, and ends a
 * last line that has no newline with one. Reading an output and awaiting the exit code poll
 * Daytona, a request at a time. Daytona takes a process's input a line at a time and never ends
 * it, so a command that reads its input to the end waits forever.
 *
 * Daytona gives no process ids, so a handle's `pid` numbers the process among those the spawner
 * started, from 1; it is not the process's id in the sandbox. `kill` deletes the process's session,
 * which sends SIGTERM to the process and its children and then SIGKILL, whatever signal it is
 * asked for.
 *
 * Daytona keeps every command line in its record of the session, so a command's environment goes
 * in a script of its own, written through Daytona's file API, which runs the command with it and
 * deletes itself first.
 */

import type { Sandbox as DaytonaSandbox } from "@daytona/sdk"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { callPlatform } from "./call.ts"
import { quote } from "./shell.ts"

/** What became of a process: running, exited with a code, or ended without one. */
type Status = Data.TaggedEnum<{
  Running: {}
  Exited: { readonly exitCode: number }
  /** Killed, as deleting its session does, or ended with its sandbox. */
  Ended: {}
}>
const Status = Data.taggedEnum<Status>()

const isRunning = Status.$is("Running")

/** Polls a process's status quickly at first, then once a second while it runs long. */
const untilExit = Schedule.min([Schedule.exponential("50 millis"), Schedule.spaced("1 second")])

/** How long to wait before reading output again, after `idle` reads found nothing new. */
const delayAfter = (idle: number) => Duration.millis(Math.min(50 * 2 ** idle, 1000))

/** The most of a process's output one read returns, which reads again at once for the rest. */
const readLimit = 1024 * 1024

/** The process spawner of `sandbox`, whose commands start in `workingDirectory`. */
export const makeChildProcessSpawner = Effect.fnUntraced(function* (sandbox: DaytonaSandbox, workingDirectory: string) {
  const crypto = yield* Crypto.Crypto
  // Daytona gives no process ids, so each process is numbered by the spawner that started it.
  const lastPid = yield* Ref.make(0)

  const spawn = Effect.fnUntraced(function* (command: ChildProcess.Command) {
    const unsupported = unsupportedOption(command)
    if (unsupported !== undefined) {
      return yield* PlatformError.badArgument({
        module: "ChildProcess",
        method: "spawn",
        description: unsupported
      })
    }
    const session = `amends-process-${yield* crypto.randomUUIDv4()}`
    const outputDirectory = `/tmp/${session}`
    const referenced = yield* Ref.make(true)
    yield* Effect.acquireRelease(
      callPlatform("ChildProcess", "spawn", () => sandbox.process.createSession(session)),
      // Deletes the session, ending the process, and removes its output, which stays when `kill`
      // has deleted the session already.
      () =>
        Effect.flatMap(Ref.get(referenced), (isReferenced) =>
          isReferenced
            ? Effect.andThen(
                Effect.ignore(callPlatform("ChildProcess", "kill", () => sandbox.process.deleteSession(session))),
                Effect.ignore(
                  callPlatform("ChildProcess", "kill", () =>
                    sandbox.process.executeCommand(`rm -rf ${quote(outputDirectory)}`)
                  )
                )
              )
            : Effect.void
        )
    )
    const environmentScripts = new Map(
      standardCommandsOf(command).flatMap((standard, index) =>
        standard.options.env === undefined ? [] : [[standard, `${outputDirectory}/environment-${index}`] as const]
      )
    )
    // Daytona makes the directory the first script goes in.
    yield* Effect.forEach(
      environmentScripts,
      ([standard, file]) =>
        callPlatform("ChildProcess", "spawn", () =>
          sandbox.fs.uploadFile(Buffer.from(environmentScriptOf(standard)), file)
        ),
      { discard: true }
    )
    // Sessions run the user's shell, zsh on Daytona's own image, whose redirections differ from
    // sh's. The line runs in sh as a child, since Daytona loses the exit code of a command that
    // replaces the session's shell.
    const line = commandLine(command, workingDirectory, environmentScripts)
    const stdoutFile = quote(`${outputDirectory}/stdout`)
    const stderrFile = quote(`${outputDirectory}/stderr`)
    const { cmdId } = yield* callPlatform("ChildProcess", "spawn", () =>
      sandbox.process.executeSessionCommand(session, {
        command: `sh -c ${quote(`mkdir -p ${quote(outputDirectory)} && { ${line}; } >${stdoutFile} 2>${stderrFile}`)}`,
        runAsync: true,
        suppressInputEcho: true
      })
    )

    const readStatus = callPlatform("ChildProcess", "status", () =>
      sandbox.process.getSessionCommand(session, cmdId)
    ).pipe(
      Effect.map(({ exitCode }) => (exitCode === undefined ? Status.Running() : Status.Exited({ exitCode }))),
      Effect.catch((error) => statusAfterFailure(sandbox, error))
    )
    const awaitExit = Effect.repeat(readStatus, {
      until: (status) => !isRunning(status),
      schedule: untilExit
    })

    /**
     * What the process has written to `output` after its first `offset` bytes, up to
     * `readLimit`.
     */
    const readOutput = (output: "stdout" | "stderr", offset: number) =>
      Effect.map(
        callPlatform("ChildProcess", "read", () =>
          sandbox.process.executeCommand(
            `tail -c +${offset + 1} -- ${quote(`${outputDirectory}/${output}`)} 2>/dev/null` +
              ` | head -c ${readLimit} | base64 -w0`
          )
        ),
        ({ result }) => new Uint8Array(Buffer.from(result, "base64"))
      )

    /**
     * What the process writes to `output`, read as it grows, and to the end once the process has
     * ended. While nothing new is written, the file is read again sooner after recent output and
     * once a second after a while.
     */
    const outputOf = (output: "stdout" | "stderr") =>
      Stream.paginate(
        { offset: 0, idle: 0, ended: false },
        Effect.fnUntraced(function* ({ offset, idle, ended }) {
          const bytes = yield* readOutput(output, offset)
          if (bytes.length > 0) {
            return [[bytes], Option.some({ offset: offset + bytes.length, idle: 0, ended })] as const
          }
          if (ended) return [[], Option.none()] as const
          const status = yield* readStatus
          if (isRunning(status)) yield* Effect.sleep(delayAfter(idle))
          // A process that has ended wrote all it will, which one more read finds.
          return [[], Option.some({ offset, idle: idle + 1, ended: !isRunning(status) })] as const
        })
      )

    const input = stdinOf(command)
    const stdin =
      input === "ignore"
        ? Sink.drain
        : sendLines((lines) =>
            callPlatform("ChildProcess", "stdin", () => sandbox.process.sendSessionCommandInput(session, cmdId, lines))
          )
    if (Stream.isStream(input)) yield* Effect.forkScoped(Stream.run(input, stdin))

    const stdout = outputStreamOf(command, "stdout", () => outputOf("stdout"))
    const stderr = outputStreamOf(command, "stderr", () => outputOf("stderr"))

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(yield* Ref.modify(lastPid, (last) => [last + 1, last + 1])),
      exitCode: Effect.flatMap(awaitExit, (status) =>
        Status.$is("Exited")(status)
          ? Effect.succeed(ChildProcessSpawner.ExitCode(status.exitCode))
          : Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "exitCode",
                description: "The process was killed, or ended with its sandbox"
              })
            )
      ),
      isRunning: Effect.map(readStatus, isRunning),
      // Deleting the session sends SIGTERM to the process and its children, then SIGKILL,
      // whatever signal is asked for.
      kill: () =>
        callPlatform("ChildProcess", "kill", () => sandbox.process.deleteSession(session)).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void)
        ),
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

/**
 * Sends what is written a line at a time, as Daytona takes input, which ends each send with a
 * newline; a last line without one gets one when the writing ends.
 */
const sendLines = (send: (lines: string) => Effect.Effect<void, PlatformError.PlatformError>) =>
  Sink.suspend(() => {
    const decoder = new TextDecoder()
    let pending = ""
    return Sink.forEach((chunk: Uint8Array) => {
      pending += decoder.decode(chunk, { stream: true })
      const lastNewline = pending.lastIndexOf("\n")
      if (lastNewline === -1) return Effect.void
      const lines = pending.slice(0, lastNewline)
      pending = pending.slice(lastNewline + 1)
      return send(lines)
    }).pipe(
      Sink.mapEffect(() => {
        pending += decoder.decode()
        return pending === "" ? Effect.void : send(pending)
      })
    )
  })

/**
 * The status of a process Daytona failed to report on: ended when its session is gone, as killing
 * it deletes the session, or when its sandbox no longer runs, which answers nothing of its
 * processes.
 */
const statusAfterFailure = (sandbox: DaytonaSandbox, error: PlatformError.PlatformError) =>
  Predicate.isTagged(error.reason, "NotFound")
    ? Effect.succeed(Status.Ended())
    : Effect.tryPromise(() => sandbox.refreshData()).pipe(
        Effect.map(() => sandbox.state === "started"),
        Effect.orElseSucceed(() => false),
        Effect.flatMap((started) => (started ? Effect.fail(error) : Effect.succeed(Status.Ended())))
      )

/** Why Daytona cannot run `command` as asked, or `undefined` when it can. */
const unsupportedOption = (command: ChildProcess.Command): string | undefined => {
  if (ChildProcess.isPipedCommand(command)) {
    const { from = "stdout", to = "stdin" } = command.options
    if (from.startsWith("fd") || to !== "stdin") {
      return "A Daytona sandbox pipes only stdout, stderr, or both into stdin"
    }
    return unsupportedOption(command.left) ?? unsupportedOption(command.right)
  }
  const { additionalFds = {}, stdout, stderr } = command.options
  if (Object.keys(additionalFds).length > 0) {
    return "A Daytona sandbox gives processes no file descriptors beyond stdin, stdout, and stderr"
  }
  const streams = [stdinOf(command), outputOptionOf(stdout), outputOptionOf(stderr)]
  if (streams.some((stream) => stream === "inherit" || stream === "overlapped")) {
    return "A process in a Daytona sandbox cannot share the host's standard streams"
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
