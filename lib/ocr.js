// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-open-code-review Contributors
// Portions derived from alibaba/open-code-review (Apache-2.0) — see NOTICE.

/**
 * Locating and running the Open Code Review CLI (`ocr`).
 *
 * Two decisions here are load-bearing:
 *
 * 1. The native binary is spawned directly, never through npm's `ocr.cmd`
 *    shim. Node refuses to spawn `.cmd`/`.bat` without `shell: true`, and
 *    enabling a shell would put model-supplied refs and paths into a command
 *    line. `scripts/platform.js` in the npm package resolves the same native
 *    path, so spawning it is the supported entry point rather than a
 *    workaround.
 * 2. Nothing is installed implicitly. A missing binary produces an error
 *    naming the exact command to run, because a plugin that silently reaches
 *    the network at tool-call time is a worse failure than one that says what
 *    it needs.
 *
 * @module dsh-open-code-review/ocr
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, delimiter, isAbsolute, join, resolve } from "node:path";

/** The executable basename published by `@alibaba-group/ocr-<platform>-<arch>`. */
export const BINARY_FILENAME = process.platform === "win32" ? "opencodereview.exe" : "opencodereview";

/** `ocr`'s own network-installable package, quoted in every remediation message. */
export const OCR_PACKAGE = "@alibaba-group/open-code-review";

/** 10 MiB, matching the ceiling upstream's own agent integrations enforce. */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Deterministic delegation commands are seconds, not minutes; the LLM path is what is slow. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Raised when no usable `ocr` executable can be found. */
export class OcrNotFoundError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = "OcrNotFoundError";
    this.attempts = attempts;
  }
}

/** Raised when `ocr` was found but did not complete successfully. */
export class OcrExecutionError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "OcrExecutionError";
    this.exitCode = result.exitCode ?? null;
    this.signal = result.signal ?? null;
    this.stdout = result.stdout ?? "";
    this.stderr = result.stderr ?? "";
  }
}

/**
 * The npm platform-package directory for a target, e.g. `ocr-win32-x64`.
 * @param platform - a `process.platform` value.
 * @param arch - a `process.arch` value.
 * @returns the package directory name, or `undefined` when unsupported.
 */
export function platformPackageDir(platform, arch) {
  const supported = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
  const key = `${platform}-${arch}`;
  return supported.includes(key) ? `ocr-${key}` : undefined;
}

/**
 * Candidate native-binary paths inside one directory, most specific first.
 * Covers a node_modules directory, a `.pnpm`-style package root, and the
 * package's own legacy `bin/` layout.
 * @param dir - directory to inspect.
 * @param platform - a `process.platform` value.
 * @param arch - a `process.arch` value.
 * @returns absolute candidate paths, in probe order.
 */
export function binaryCandidatesIn(dir, platform, arch) {
  const pkg = platformPackageDir(platform, arch);
  const candidates = [];
  if (pkg !== undefined) {
    candidates.push(
      join(dir, "node_modules", "@alibaba-group", pkg, "bin", BINARY_FILENAME),
      join(dir, "@alibaba-group", pkg, "bin", BINARY_FILENAME),
    );
  }
  candidates.push(join(dir, "bin", BINARY_FILENAME));
  return candidates;
}

/** A path counts as a usable target only when it is an existing regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Names that can be handed to `spawn` with `shell: false` on this platform. */
const SPAWNABLE_NAMES = process.platform === "win32" ? ["opencodereview.exe", "ocr.exe"] : ["opencodereview", "ocr"];

/** npm's launcher shims. On Windows these are the *only* thing `npm i -g` puts on PATH. */
const SHIM_NAMES = ["ocr.cmd", "ocr.ps1", "ocr"];

/**
 * Search every directory on `PATH` for a usable `ocr`.
 *
 * A shim is treated as a signpost, not a target: npm's `ocr.cmd` cannot be
 * spawned without `shell: true` (Node refuses `.cmd`/`.bat`), and enabling a
 * shell would put model-supplied refs into a command line. So a shim's
 * directory — and that directory's parent, which is the npm layout when the
 * shim sits in a project's `node_modules/.bin` — is probed for the native
 * binary instead. Following the signpost also skips the launcher's background
 * update check, keeping every call deterministic.
 *
 * @param env - the environment providing `PATH`.
 * @param platform - a `process.platform` value.
 * @param arch - a `process.arch` value.
 * @returns the first match, or `undefined`.
 */
function searchPath(env, platform, arch) {
  const pathValue = env.PATH ?? env.Path ?? "";
  if (pathValue.length === 0) return undefined;
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue;
    const hasShim = SHIM_NAMES.some((name) => isFile(join(dir, name)));
    const spawnable = SPAWNABLE_NAMES.map((name) => join(dir, name)).find(isFile);
    if (!hasShim && spawnable === undefined) continue;
    for (const root of [dir, dirname(dir)]) {
      for (const candidate of binaryCandidatesIn(root, platform, arch)) {
        if (isFile(candidate)) return candidate;
      }
    }
    if (spawnable !== undefined) return spawnable;
  }
  return undefined;
}

/**
 * Resolve the `ocr` executable, in precedence order: an explicit `ocrPath`,
 * then the plugin-managed `vendorDir`, then `PATH`.
 *
 * @param options - resolution inputs.
 * @param options.ocrPath - explicit path to the binary, or to a directory holding an install.
 * @param options.vendorDir - plugin-managed install root.
 * @param options.env - environment for the `PATH` search; defaults to `process.env`.
 * @param options.platform - target platform; defaults to `process.platform`.
 * @param options.arch - target architecture; defaults to `process.arch`.
 * @returns the resolved executable path and which source produced it.
 * @throws OcrNotFoundError listing every path that was probed.
 */
export function resolveOcr(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const attempts = [];

  const probe = (candidate, source) => {
    attempts.push(candidate);
    return isFile(candidate) ? { command: candidate, source } : undefined;
  };

  const explicit = options.ocrPath;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    const target = resolve(explicit.trim());
    const direct = probe(target, "ocrPath");
    if (direct !== undefined) return direct;
    // A directory is accepted too, so `ocrPath` can point at an install root.
    if (existsSync(target)) {
      for (const candidate of binaryCandidatesIn(target, platform, arch)) {
        const found = probe(candidate, "ocrPath");
        if (found !== undefined) return found;
      }
    }
    throw new OcrNotFoundError(
      `Open Code Review was not found at the configured ocrPath. Point it at the \`ocr\` executable itself, ` +
        `or at a directory containing an install. Probed:\n  ${attempts.join("\n  ")}`,
      attempts,
    );
  }

  const vendorDir = options.vendorDir;
  if (typeof vendorDir === "string" && vendorDir.trim().length > 0) {
    const root = isAbsolute(vendorDir.trim()) ? vendorDir.trim() : resolve(vendorDir.trim());
    for (const candidate of binaryCandidatesIn(root, platform, arch)) {
      const found = probe(candidate, "vendorDir");
      if (found !== undefined) return found;
    }
  }

  const onPath = searchPath(env, platform, arch);
  if (onPath !== undefined) return { command: onPath, source: "PATH" };

  throw new OcrNotFoundError(
    `Open Code Review (\`ocr\`) is not installed. Install it with either:\n` +
      `  npm install --prefix "<vendorDir>" ${OCR_PACKAGE}    # plugin-managed, recommended\n` +
      `  npm install -g ${OCR_PACKAGE}                        # machine-wide, found on PATH\n` +
      `Probed:\n  ${attempts.length > 0 ? attempts.join("\n  ") : "(no candidate paths; vendorDir was not configured)"}\n` +
      `  (plus \`opencodereview\` and \`ocr\` on PATH)`,
    attempts,
  );
}

/**
 * Validate and build `ocr delegate preview` arguments. Kept pure so the
 * paired-ref and mutually-exclusive rules are testable without spawning.
 * @param input - model-supplied scope options.
 * @returns argv for the delegation preview command.
 */
export function buildScopeArgs(input = {}) {
  const { from, to, commit } = input;
  const hasFrom = typeof from === "string" && from.length > 0;
  const hasTo = typeof to === "string" && to.length > 0;
  if (hasFrom !== hasTo) throw new Error("Both 'from' and 'to' are required for a branch comparison.");
  if (typeof commit === "string" && commit.length > 0 && hasFrom) {
    throw new Error("Use either 'commit' or a 'from'/'to' range, not both.");
  }
  rejectBackgroundConflict(input);

  const args = ["delegate", "preview", "--format", "json"];
  push(args, "--from", from);
  push(args, "--to", to);
  push(args, "--commit", commit);
  push(args, "--exclude", input.exclude);
  // `delegate` registers the same background flags as `review`. The response
  // echoes the sanitised background back, which is how the caller confirms
  // what the host actually received.
  push(args, "--background", input.background);
  push(args, "--background-file", input.backgroundFile);
  return args;
}

/**
 * Validate and build `ocr delegate rule` arguments.
 * @param input - model-supplied rule options; `paths` must be non-empty.
 * @returns argv for the delegation rule command.
 */
export function buildRulesArgs(input = {}) {
  const paths = Array.isArray(input.paths) ? input.paths.filter((p) => typeof p === "string" && p.length > 0) : [];
  if (paths.length === 0) throw new Error("'paths' must list at least one reviewable file path.");
  return ["delegate", "rule", "--format", "json", ...paths];
}

/** `--background` and `--background-file` are mutually exclusive in the CLI. */
function rejectBackgroundConflict(input) {
  const hasInline = typeof input.background === "string" && input.background.length > 0;
  const hasFile = typeof input.backgroundFile === "string" && input.backgroundFile.length > 0;
  if (hasInline && hasFile) throw new Error("Use either 'background' or 'backgroundFile', not both.");
}

/** Append `flag value` only when the value is a non-empty string. */
function push(args, flag, value) {
  if (typeof value === "string" && value.length > 0) args.push(flag, value);
}

/**
 * Parse a delegation command's stdout as JSON, failing with the command name
 * and a stdout head rather than a bare `SyntaxError`.
 * @param stdout - captured standard output.
 * @param command - the subcommand, for the error message.
 * @returns the parsed payload.
 */
export function parseDelegateJson(stdout, command) {
  const text = stdout.trim();
  if (text.length === 0) throw new OcrExecutionError(`ocr ${command} produced no output.`, { exitCode: 0 });
  try {
    return JSON.parse(text);
  } catch {
    throw new OcrExecutionError(
      `ocr ${command} did not return JSON. This plugin requires Open Code Review 1.9.0 or later, where ` +
        `\`--format json\` was added. Run \`ocr version\` to check, then upgrade with ` +
        `\`npm install -g ${OCR_PACKAGE}\`.\nFirst 500 bytes:\n${text.slice(0, 500)}`,
      { exitCode: 0, stdout: text },
    );
  }
}

/**
 * Run `ocr` to completion, capturing stdout and stderr.
 *
 * The child is detached so a timeout or abort can terminate its whole process
 * tree — `ocr` fans out to git and, in LLM mode, to HTTP workers, and killing
 * only the direct child would leave those running.
 *
 * @param args - argv after the executable.
 * @param options - execution inputs.
 * @param options.command - the resolved executable path.
 * @param options.cwd - working directory for the child.
 * @param options.timeoutMs - wall-clock ceiling; `null` disables it.
 * @param options.maxOutputBytes - combined stdout+stderr ceiling.
 * @param options.signal - caller cancellation.
 * @param options.env - child environment; defaults to `process.env`.
 * @returns captured streams and the exit code.
 * @throws OcrExecutionError on non-zero exit, timeout, abort, or output overflow.
 */
export function runOcr(args, options) {
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: true,
      windowsHide: true,
    });
    child.stdin?.end();

    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let settled = false;
    let closed = false;
    let timer;
    let forceKillTimer;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const collected = () => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
      stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
    });

    /** Terminate the child and everything it started. */
    const killTree = (signal) => {
      if (closed || child.pid === undefined) return;
      if (process.platform === "win32") {
        // Node maps `child.kill` to an abrupt TerminateProcess on Windows and
        // cannot reach grandchildren, so `taskkill /T` is the tree kill.
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const terminate = () => {
      if (closed) return;
      killTree("SIGTERM");
      forceKillTimer = setTimeout(() => killTree("SIGKILL"), 3_000);
    };

    const collect = (chunks, chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        terminate();
        finish(() =>
          rejectPromise(
            new OcrExecutionError(`Open Code Review output exceeded the ${maxOutputBytes}-byte safety limit.`, {
              exitCode: null,
            }),
          ),
        );
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk) => collect(stdoutChunks, chunk));
    child.stderr.on("data", (chunk) => collect(stderrChunks, chunk));

    child.on("error", (error) => {
      const message =
        error.code === "ENOENT"
          ? `Failed to start Open Code Review at ${options.command}: the file no longer exists.`
          : `Failed to start Open Code Review at ${options.command}: ${error.message}`;
      finish(() => rejectPromise(new OcrExecutionError(message, { exitCode: null })));
    });

    child.on("close", (exitCode, signal) => {
      closed = true;
      finish(() => {
        const streams = collected();
        if (exitCode === 0) {
          resolvePromise({ ...streams, exitCode });
          return;
        }
        // A signal kill reports a null exit code; naming the signal keeps it
        // distinguishable from a genuine exit 1 that wrote no output.
        const cause = signal ? `was terminated by signal ${signal}` : `exited with code ${exitCode ?? 1}`;
        rejectPromise(
          new OcrExecutionError(streams.stderr || streams.stdout || `Open Code Review ${cause}.`, {
            exitCode,
            signal,
            ...streams,
          }),
        );
      });
    });

    const onAbort = () => {
      terminate();
      finish(() => rejectPromise(new OcrExecutionError("Open Code Review was cancelled.", { exitCode: null })));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        terminate();
        finish(() =>
          rejectPromise(
            new OcrExecutionError(`Open Code Review timed out after ${Math.round(timeoutMs / 1000)} seconds.`, {
              exitCode: null,
            }),
          ),
        );
      }, timeoutMs);
    }

    if (options.signal?.aborted) onAbort();
  });
}
