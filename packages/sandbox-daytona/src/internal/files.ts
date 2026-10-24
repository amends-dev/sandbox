/**
 * A Daytona sandbox's files, read and written whole through Daytona's file API, so that a read
 * holds the whole file in memory, whatever its size, and otherwise worked on with the sandbox's
 * POSIX tools, one command each, which Daytona runs and answers at once. Paths are the sandbox's;
 * a relative one is resolved against the working directory. A failure is the error the tool's
 * message names, as Effect's own file systems name an `errno`.
 */

import type { Sandbox as DaytonaSandbox } from "@daytona/sdk"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"
import { callPlatform, systemErrorTagOf, toPlatformError } from "./call.ts"
import { quote } from "./shell.ts"

/** Defines `fail path message`, which fails a script with a message of the tools' own. */
const defineFail = `fail() { printf '%s: %s\\n' "$1" "$2" >&2; exit 1; }`

/** Fails a script for a path that does not exist, as the tools would. */
const existing = '[ -e "$1" ] || fail "$1" "No such file or directory"'

/** The flag `flag`, with the space before it, when `condition` holds. */
const when = (condition: boolean | undefined, flag: string) => (condition === true ? ` ${flag}` : "")

/** The file system of `sandbox`, whose relative paths start in `workingDirectory`. */
export const makeFileSystem = (sandbox: DaytonaSandbox, workingDirectory: string): FileSystem.FileSystem => {
  const resolve = (path: string) => (path.startsWith("/") ? path : `${workingDirectory}/${path}`)

  /**
   * Runs `script` in sh with `args` as its positional parameters, the first being the path it works
   * on, and returns what it prints. `fail path message` fails it with a message of the tools' own.
   */
  const run = (method: string, script: string, args: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: () =>
        sandbox.process.executeCommand(
          `sh -c ${quote(`${defineFail}; ${script}`)} sh ${args.map(quote).join(" ")}`,
          undefined,
          // The tools' messages name their errors in English.
          { LC_ALL: "C" }
        ),
      catch: (error) => toPlatformError("FileSystem", method, error, args[0])
    }).pipe(
      Effect.flatMap(({ exitCode, result }) =>
        exitCode === 0
          ? Effect.succeed(result)
          : Effect.fail(
              PlatformError.systemError({
                _tag: systemErrorTagOf(result),
                module: "FileSystem",
                method,
                pathOrDescriptor: args[0],
                description: result.trim()
              })
            )
      )
    )

  const makeTempDirectory: FileSystem.FileSystem["makeTempDirectory"] = (options) =>
    Effect.map(
      run("makeTempDirectory", 'mktemp -d -- "${1:-${TMPDIR:-/tmp}}/${2}XXXXXX"', [
        options?.directory === undefined ? "" : resolve(options.directory),
        options?.prefix ?? ""
      ]),
      withoutNewline
    )

  // A temporary file is made in a temporary directory of its own, as Effect's own file systems do.
  const makeTempFile: FileSystem.FileSystem["makeTempFile"] = (options) =>
    Effect.map(
      run(
        "makeTempFile",
        [
          'directory=$(mktemp -d -- "${1:-${TMPDIR:-/tmp}}/${2}XXXXXX")',
          'mktemp --suffix="$3" -- "$directory/XXXXXXXXXXXX"'
        ].join(" && "),
        [
          options?.directory === undefined ? "" : resolve(options.directory),
          options?.prefix ?? "",
          options?.suffix ?? ""
        ]
      ),
      withoutNewline
    )

  const remove: FileSystem.FileSystem["remove"] = (path, options) =>
    Effect.asVoid(
      run("remove", `rm${when(options?.recursive, "-r")}${when(options?.force, "-f")} -- "$1"`, [resolve(path)])
    )

  return FileSystem.make({
    access: (path, options) =>
      Effect.asVoid(
        run(
          "access",
          [
            existing,
            ...(options?.readable === true ? ['[ -r "$1" ] || fail "$1" "Permission denied"'] : []),
            ...(options?.writable === true ? ['[ -w "$1" ] || fail "$1" "Permission denied"'] : [])
          ].join("; "),
          [resolve(path)]
        )
      ),
    // `--update=none` leaves existing files as they are, as Node's `cp` does without `force`.
    copy: (fromPath, toPath, options) =>
      Effect.asVoid(
        run(
          "copy",
          `cp -RT${when(options?.overwrite !== true, "--update=none")}` +
            `${when(options?.preserveTimestamps, "--preserve=timestamps")} -- "$1" "$2"`,
          [resolve(fromPath), resolve(toPath)]
        )
      ),
    copyFile: (fromPath, toPath) =>
      Effect.asVoid(run("copyFile", 'cp -T -- "$1" "$2"', [resolve(fromPath), resolve(toPath)])),
    chmod: (path, mode) => Effect.asVoid(run("chmod", `chmod ${mode.toString(8)} -- "$1"`, [resolve(path)])),
    chown: (path, uid, gid) => Effect.asVoid(run("chown", `chown ${uid}:${gid} -- "$1"`, [resolve(path)])),
    glob: () => Effect.fail(unsupported("glob", "A Daytona sandbox's files cannot be globbed")),
    link: (fromPath, toPath) => Effect.asVoid(run("link", 'ln -- "$1" "$2"', [resolve(fromPath), resolve(toPath)])),
    makeDirectory: (path, options) => {
      const mode = options?.mode === undefined ? "" : ` -m ${options.mode.toString(8)}`
      return Effect.asVoid(
        run("makeDirectory", `mkdir${when(options?.recursive, "-p")}${mode} -- "$1"`, [resolve(path)])
      )
    },
    makeTempDirectory,
    makeTempDirectoryScoped: (options) =>
      Effect.acquireRelease(makeTempDirectory(options), (directory) =>
        Effect.orDie(remove(directory, { recursive: true }))
      ),
    makeTempFile,
    makeTempFileScoped: (options) =>
      Effect.acquireRelease(makeTempFile(options), (file) =>
        Effect.orDie(remove(file.slice(0, file.lastIndexOf("/")), { recursive: true }))
      ),
    open: () => Effect.fail(unsupported("open", "A Daytona sandbox's files are read and written whole")),
    readDirectory: (path, options) =>
      Effect.map(
        run(
          "readDirectory",
          [
            existing,
            '[ -d "$1" ] || fail "$1" "Not a directory"',
            `cd -- "$1" && find . -mindepth 1${when(options?.recursive !== true, "-maxdepth 1")} -printf '%P\\0'`
          ].join("; "),
          [resolve(path)]
        ),
        // Names end in NUL, which no name holds.
        (names) => names.split("\0").slice(0, -1)
      ),
    readFile: (path) =>
      Effect.map(
        callPlatform("FileSystem", "readFile", () => sandbox.fs.downloadFile(resolve(path)), resolve(path)),
        (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      ),
    readLink: (path) => run("readLink", 'readlink -vn -- "$1"', [resolve(path)]),
    realPath: (path) => Effect.map(run("realPath", 'realpath -e -- "$1"', [resolve(path)]), withoutNewline),
    remove,
    rename: (oldPath, newPath) =>
      Effect.asVoid(run("rename", 'mv -T -- "$1" "$2"', [resolve(oldPath), resolve(newPath)])),
    stat: (path) =>
      Effect.map(
        run("stat", `stat -L -c '%f %s %.9Y %.9X %.9W %d %i %h %u %g %r %o %b' -- "$1"`, [resolve(path)]),
        fileInfoOf
      ),
    // A link's target is kept as given; a relative one is relative to the link's directory.
    symlink: (target, path) => Effect.asVoid(run("symlink", 'ln -s -- "$1" "$2"', [target, resolve(path)])),
    truncate: (path, length) =>
      Effect.asVoid(run("truncate", [existing, `truncate -s ${length ?? 0} -- "$1"`].join("; "), [resolve(path)])),
    utimes: (path, atime, mtime) =>
      Effect.asVoid(
        run("utimes", [existing, 'touch -c -a -d "@$2" -- "$1" && touch -c -m -d "@$3" -- "$1"'].join("; "), [
          resolve(path),
          secondsOf(atime),
          secondsOf(mtime)
        ])
      ),
    watch: () => Stream.fail(unsupported("watch", "A Daytona sandbox's files cannot be watched")),
    writeFile: Effect.fnUntraced(function* (path, data, options) {
      const flag = options?.flag ?? "w"
      if (flag !== "w" && flag !== "w+" && flag !== "wx" && flag !== "wx+") {
        return yield* unsupported("writeFile", `A Daytona sandbox's files are not opened with ${flag}`)
      }
      const resolved = resolve(path)
      // Daytona makes a file's missing directories, and writes over a file it is asked not to,
      // so the directory and the file are checked first, as opening the file would.
      const created = yield* run(
        "writeFile",
        [
          '[ -d "$(dirname -- "$1")" ] || fail "$1" "No such file or directory"',
          ...(flag.startsWith("wx") ? ['[ ! -e "$1" ] || fail "$1" "File exists"'] : []),
          '[ -e "$1" ] || printf created'
        ].join("; "),
        [resolved]
      )
      yield* callPlatform(
        "FileSystem",
        "writeFile",
        () => sandbox.fs.uploadFile(Buffer.from(data.buffer, data.byteOffset, data.byteLength), resolved),
        resolved
      )
      // A mode applies to the file the write creates, as when a file is opened.
      if (options?.mode !== undefined && created === "created") {
        yield* run("writeFile", `chmod ${options.mode.toString(8)} -- "$1"`, [resolved])
      }
    })
  })
}

/** The file information `stat` prints in the format the file system asks it for. */
const fileInfoOf = (printed: string): FileSystem.File.Info => {
  const [mode, size, mtime, atime, birthtime, dev, ino, nlink, uid, gid, rdev, blksize, blocks] =
    withoutNewline(printed).split(" ")
  const modeBits = Number.parseInt(mode ?? "0", 16)
  return {
    type: fileTypeOf(modeBits),
    mtime: dateOf(mtime),
    atime: dateOf(atime),
    birthtime: dateOf(birthtime),
    dev: BigInt(dev ?? "0"),
    ino: Option.some(BigInt(ino ?? "0")),
    mode: modeBits,
    nlink: Option.some(BigInt(nlink ?? "0")),
    uid: Option.some(Number(uid)),
    gid: Option.some(Number(gid)),
    rdev: Option.some(BigInt(rdev ?? "0")),
    size: ByteSize.bytes(BigInt(size ?? "0")),
    blksize: Option.some(ByteSize.bytes(BigInt(blksize ?? "0"))),
    blocks: Option.some(BigInt(blocks ?? "0"))
  }
}

/** The type a file's mode names in its format bits. */
const fileTypeOf = (mode: number): FileSystem.File.Type => {
  switch (mode & 0o170000) {
    case 0o100000:
      return "File"
    case 0o040000:
      return "Directory"
    case 0o120000:
      return "SymbolicLink"
    case 0o060000:
      return "BlockDevice"
    case 0o020000:
      return "CharacterDevice"
    case 0o010000:
      return "FIFO"
    case 0o140000:
      return "Socket"
    default:
      return "Unknown"
  }
}

/** A time `stat` prints in seconds, which it prints as 0 or `-` when the file system keeps none. */
const dateOf = (seconds: string | undefined): Option.Option<Date> => {
  const value = Number(seconds)
  return Number.isFinite(value) && value > 0 ? Option.some(new Date(value * 1000)) : Option.none()
}

const secondsOf = (time: Date | number) => String(typeof time === "number" ? time : time.getTime() / 1000)

const withoutNewline = (printed: string) => (printed.endsWith("\n") ? printed.slice(0, -1) : printed)

const unsupported = (method: string, description: string) =>
  PlatformError.badArgument({ module: "FileSystem", method, description })
