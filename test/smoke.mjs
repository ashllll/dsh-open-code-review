// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-open-code-review Contributors

/**
 * The smallest check that catches real breakage: `node test/smoke.mjs`.
 *
 * Covers the pure logic that decides what gets executed — argument building,
 * binary resolution, and output parsing — plus the bundled skill's frontmatter
 * handling. `lib/index.js` is syntax-checked here and exercised for real by
 * mounting the plugin in DSH, which is the only place its peer dependencies
 * exist.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINARY_FILENAME,
  OcrExecutionError,
  OcrNotFoundError,
  buildRulesArgs,
  buildScopeArgs,
  parseDelegateJson,
  platformPackageDir,
  resolveOcr,
  runOcr,
} from "../lib/ocr.js";
import { SKILL_RELATIVE_PATH, readBundledSkill, stripFrontmatter } from "../lib/skill.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let checks = 0;
/** Run one assertion and count it. */
function check(name, run) {
  run();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

/** Assert that a call throws, and return the error for further assertions. */
function throws(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

process.stdout.write("argument building\n");

check("workspace scope needs no refs", () => {
  assert.deepEqual(buildScopeArgs({}), ["delegate", "preview", "--format", "json"]);
});

check("a range passes both refs", () => {
  assert.deepEqual(buildScopeArgs({ from: "main", to: "feature" }), [
    "delegate",
    "preview",
    "--format",
    "json",
    "--from",
    "main",
    "--to",
    "feature",
  ]);
});

check("a lone ref is rejected rather than silently narrowed", () => {
  assert.match(throws(() => buildScopeArgs({ from: "main" })).message, /Both 'from' and 'to'/);
  assert.match(throws(() => buildScopeArgs({ to: "feature" })).message, /Both 'from' and 'to'/);
});

check("a commit cannot be combined with a range", () => {
  assert.match(throws(() => buildScopeArgs({ commit: "abc", from: "main", to: "x" })).message, /not both/);
});

check("background and backgroundFile are mutually exclusive", () => {
  assert.match(throws(() => buildScopeArgs({ background: "x", backgroundFile: "y" })).message, /not both/);
});

check("background reaches the CLI", () => {
  const args = buildScopeArgs({ background: "add rate limiting" });
  assert.deepEqual(args.slice(-2), ["--background", "add rate limiting"]);
});

check("rules require at least one path", () => {
  assert.match(throws(() => buildRulesArgs({ paths: [] })).message, /at least one/);
  assert.match(throws(() => buildRulesArgs({})).message, /at least one/);
});

check("rules pass every path through", () => {
  assert.deepEqual(buildRulesArgs({ paths: ["a.py", "b/c.go"] }), [
    "delegate",
    "rule",
    "--format",
    "json",
    "a.py",
    "b/c.go",
  ]);
});

process.stdout.write("octet output parsing\n");

check("valid delegation JSON parses", () => {
  assert.deepEqual(parseDelegateJson('{"mode":"workspace","reviewable_files":[]}', "delegate preview"), {
    mode: "workspace",
    reviewable_files: [],
  });
});

check("empty output is an error, not an empty result", () => {
  const error = throws(() => parseDelegateJson("   ", "delegate preview"));
  assert.ok(error instanceof OcrExecutionError);
  assert.match(error.message, /produced no output/);
});

check("text output names the version floor instead of throwing a bare SyntaxError", () => {
  const error = throws(() => parseDelegateJson("# Files (2 reviewable / 3 total)", "delegate preview"));
  assert.match(error.message, /1\.9\.0/);
});

process.stdout.write("binary resolution\n");

check("the platform package name is derived from platform and arch", () => {
  assert.equal(platformPackageDir("win32", "x64"), "ocr-win32-x64");
  assert.equal(platformPackageDir("linux", "arm64"), "ocr-linux-arm64");
  assert.equal(platformPackageDir("sunos", "sparc"), undefined);
});

check("a vendorDir install is found in the npm layout", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-resolve-"));
  try {
    const bin = join(root, "node_modules", "@alibaba-group", platformPackageDir(process.platform, process.arch), "bin");
    mkdirSync(bin, { recursive: true });
    const executable = join(bin, BINARY_FILENAME);
    writeFileSync(executable, "");
    assert.deepEqual(resolveOcr({ vendorDir: root, env: {} }), { command: executable, source: "vendorDir" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("an explicit ocrPath wins over the vendorDir", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-explicit-"));
  try {
    const executable = join(root, BINARY_FILENAME);
    writeFileSync(executable, "");
    assert.deepEqual(resolveOcr({ ocrPath: executable, vendorDir: "C:\\nope", env: {} }), {
      command: executable,
      source: "ocrPath",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("a bad ocrPath is reported as a bad ocrPath, not a missing install", () => {
  const error = throws(() => resolveOcr({ ocrPath: join(tmpdir(), "definitely-absent-ocr"), env: {} }));
  assert.ok(error instanceof OcrNotFoundError);
  assert.match(error.message, /configured ocrPath/);
});

check("a missing install names the install commands and everything probed", () => {
  const error = throws(() => resolveOcr({ vendorDir: join(tmpdir(), "absent-vendor-dir"), env: {} }));
  assert.ok(error instanceof OcrNotFoundError);
  assert.match(error.message, /npm install --prefix/);
  assert.match(error.message, /npm install -g @alibaba-group\/open-code-review/);
  assert.match(error.message, /absent-vendor-dir/);
});

check("PATH is searched for the native binary, never npm's .cmd shim", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-path-"));
  try {
    const executable = join(root, BINARY_FILENAME);
    writeFileSync(executable, "");
    // A `.cmd` shim in the same directory must not be chosen: Node cannot spawn
    // it without `shell: true`, and enabling a shell would expose model input.
    writeFileSync(join(root, "ocr.cmd"), "@echo off\r\n");
    assert.deepEqual(resolveOcr({ env: { PATH: root } }), { command: executable, source: "PATH" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("a global npm install is followed from its .cmd shim to the native binary", () => {
  const prefix = mkdtempSync(join(tmpdir(), "ocr-global-"));
  try {
    // `npm i -g` on Windows puts only ocr.cmd at the prefix root; the native
    // binary lives in the platform package beside it.
    writeFileSync(join(prefix, "ocr.cmd"), "@echo off\r\n");
    const bin = join(prefix, "node_modules", "@alibaba-group", platformPackageDir(process.platform, process.arch), "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, BINARY_FILENAME), "");
    assert.deepEqual(resolveOcr({ env: { PATH: prefix } }), {
      command: join(bin, BINARY_FILENAME),
      source: "PATH",
    });
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

check("a project-local install is followed out of node_modules/.bin", () => {
  const project = mkdtempSync(join(tmpdir(), "ocr-local-"));
  try {
    const binDir = join(project, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "ocr.cmd"), "@echo off\r\n");
    const bin = join(project, "node_modules", "@alibaba-group", platformPackageDir(process.platform, process.arch), "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, BINARY_FILENAME), "");
    assert.deepEqual(resolveOcr({ env: { PATH: binDir } }), {
      command: join(bin, BINARY_FILENAME),
      source: "PATH",
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

check("an unrelated PATH entry costs no lookup and is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-unrelated-"));
  try {
    assert.equal(throws(() => resolveOcr({ env: { PATH: root } })).name, "OcrNotFoundError");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Lay out the platform package the way npm and pnpm both do. */
function installPlatformBinary(nodeModules) {
  const bin = join(nodeModules, "@alibaba-group", platformPackageDir(process.platform, process.arch), "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, BINARY_FILENAME);
  writeFileSync(executable, "");
  return executable;
}

check("a hoisted dependency beside the package is found", () => {
  // npm, and a hoisted pnpm layout: <profile>/node_modules/@scope/pkg, with the
  // binary as a sibling under the same node_modules. This is what a plugin
  // install produces, so it must resolve with no other configuration.
  const profile = mkdtempSync(join(tmpdir(), "ocr-hoisted-"));
  try {
    const packageRoot = join(profile, "node_modules", "@ashllll", "dsh-open-code-review");
    mkdirSync(packageRoot, { recursive: true });
    const executable = installPlatformBinary(join(profile, "node_modules"));
    assert.deepEqual(resolveOcr({ packageRoot, env: {} }), { command: executable, source: "dependency" });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

check("a pnpm-nested dependency inside the package is found", () => {
  const profile = mkdtempSync(join(tmpdir(), "ocr-nested-"));
  try {
    const packageRoot = join(profile, "node_modules", ".pnpm", "dsh-open-code-review@0.1.0", "node_modules", "dsh-open-code-review");
    mkdirSync(packageRoot, { recursive: true });
    const executable = installPlatformBinary(join(packageRoot, "node_modules"));
    assert.deepEqual(resolveOcr({ packageRoot, env: {} }), { command: executable, source: "dependency" });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

check("the bundled dependency wins over PATH but loses to an explicit ocrPath", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-order-"));
  try {
    const packageRoot = join(root, "node_modules", "dsh-open-code-review");
    mkdirSync(packageRoot, { recursive: true });
    const bundled = installPlatformBinary(join(root, "node_modules"));

    const pathDir = join(root, "path");
    mkdirSync(pathDir, { recursive: true });
    const onPath = join(pathDir, BINARY_FILENAME);
    writeFileSync(onPath, "");

    assert.deepEqual(resolveOcr({ packageRoot, env: { PATH: pathDir } }), {
      command: bundled,
      source: "dependency",
    });
    assert.deepEqual(resolveOcr({ packageRoot, ocrPath: onPath, env: { PATH: pathDir } }), {
      command: onPath,
      source: "ocrPath",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

process.stdout.write("bundled skill\n");

check("frontmatter is stripped and the body kept", () => {
  const body = stripFrontmatter("---\nname: x\ndescription: >\n  folded\n---\n\n# Title\n\nBody\n");
  assert.equal(body, "# Title\n\nBody");
});

check("markdown without frontmatter is untouched", () => {
  assert.equal(stripFrontmatter("# Title\n\nBody\n"), "# Title\n\nBody");
});

check("a horizontal rule later in the body is not mistaken for frontmatter", () => {
  assert.equal(stripFrontmatter("# Title\n\n---\n\nBody\n"), "# Title\n\n---\n\nBody");
});

check("the shipped SKILL.md parses to a body with no frontmatter left", () => {
  const body = readBundledSkill(PACKAGE_ROOT);
  assert.ok(body.length > 500, `expected a substantial skill body, got ${body.length} chars`);
  assert.ok(!body.startsWith("---"), "frontmatter leaked into the skill body");
  assert.match(body, /ocr_review_scope/);
  assert.match(body, /ocr_review_rules/);
});

check("the skill path matches the file on disk", () => {
  assert.equal(SKILL_RELATIVE_PATH, join("skills", "open-code-review", "SKILL.md"));
});

process.stdout.write("plugin entry\n");

check("lib/index.js parses as an ES module", () => {
  const result = spawnSync(process.execPath, ["--check", join(PACKAGE_ROOT, "lib", "index.js")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `node --check failed:\n${result.stderr}`);
});

process.stdout.write("live binary (skipped when ocr is absent)\n");

// The spawn path is the part unit checks cannot reach: an npm `.cmd` shim would
// fail here while every assertion above still passes. Run it for real when a
// binary is resolvable, and say so plainly when it is not.
let live;
try {
  live = resolveOcr({
    vendorDir: process.env.OCR_VENDOR_DIR ?? "",
    packageRoot: PACKAGE_ROOT,
    env: process.env,
  });
} catch {
  live = undefined;
}

if (live === undefined) {
  process.stdout.write("  --  no ocr on this machine; install it to exercise the spawn path\n");
} else {
  const result = await runOcr(["version"], { command: live.command, timeoutMs: 30_000 });
  check(`ocr version runs from ${live.source}`, () => {
    assert.match(result.stdout, /open-code-review v?\d+\.\d+\.\d+/);
  });

  // A throwaway repository, so the check proves the argv this plugin builds is
  // accepted and returns the documented schema — not merely that a binary ran.
  const repo = mkdtempSync(join(tmpdir(), "ocr-repo-"));
  try {
    const git = (...args) => {
      const run = spawnSync("git", ["-c", "user.email=smoke@example.invalid", "-c", "user.name=smoke", ...args], {
        cwd: repo,
        encoding: "utf8",
      });
      assert.equal(run.status, 0, `git ${args.join(" ")} failed:\n${run.stderr}`);
    };
    git("init", "-q");
    writeFileSync(join(repo, "sample.py"), "def f(items=[]):\n    return items\n");
    git("add", "sample.py");
    git("commit", "-qm", "initial");
    writeFileSync(join(repo, "sample.py"), "def f(items=[]):\n    return len(items)\n");

    const preview = await runOcr(["delegate", "preview", "--format", "json", "--repo", repo], {
      command: live.command,
      cwd: repo,
      timeoutMs: 60_000,
    });
    check("delegate preview returns the documented schema", () => {
      const payload = parseDelegateJson(preview.stdout, "delegate preview");
      assert.equal(payload.schema_version, "1");
      assert.equal(payload.mode, "workspace");
      assert.deepEqual(
        payload.reviewable_files.map((file) => file.path),
        ["sample.py"],
      );
    });

    const rules = await runOcr(["delegate", "rule", "--format", "json", "sample.py", "--repo", repo], {
      command: live.command,
      cwd: repo,
      timeoutMs: 60_000,
    });
    check("delegate rule resolves the Python ruleset for the file", () => {
      const payload = parseDelegateJson(rules.stdout, "delegate rule");
      assert.equal(payload.schema_version, "1");
      assert.ok(payload.groups.length > 0, "expected at least one rule group");
      assert.deepEqual(payload.groups[0].files, ["sample.py"]);
      assert.match(payload.groups[0].pattern, /py/);
      assert.ok(payload.groups[0].rule.length > 100, "expected substantial rule text");
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

process.stdout.write(`\n${checks} checks passed\n`);
