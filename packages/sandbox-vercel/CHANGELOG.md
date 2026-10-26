# @amends-dev/sandbox-vercel

## 0.2.1

### Patch Changes

- [#1](https://github.com/amends-dev/sandbox/pull/1) [`44299ff`](https://github.com/amends-dev/sandbox/commit/44299ff36188397f0f6707325e13b9ddb502ba74) Thanks [@saribmah](https://github.com/saribmah)! - Moved to its own repository, [amends-dev/sandbox](https://github.com/amends-dev/sandbox), which its links on npm and its provenance now name.
- Updated dependencies [[`44299ff`](https://github.com/amends-dev/sandbox/commit/44299ff36188397f0f6707325e13b9ddb502ba74)]:
  - @amends-dev/sandbox@0.2.2

## 0.2.0

### Minor Changes

- [#39](https://github.com/amends-dev/amends/pull/39) [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d) Thanks [@saribmah](https://github.com/saribmah)! - Requires Effect 4.0.5 or later.

### Patch Changes

- [#39](https://github.com/amends-dev/amends/pull/39) [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d) Thanks [@saribmah](https://github.com/saribmah)! - Works on Effect 4.0.3 and later, which made `Crypto.randomUUIDv4` a function: 0.1.0 failed there with `randomUUIDv4.pipe is not a function`.

- [#39](https://github.com/amends-dev/amends/pull/39) [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d) Thanks [@saribmah](https://github.com/saribmah)! - A sandbox's `stat` gives `dev`, `ino`, `nlink`, `rdev`, and `blocks` as bigints, as Effect 4.0.5's `FileSystem` does.
- Updated dependencies [[`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d)]:
  - @amends-dev/sandbox@0.2.0
