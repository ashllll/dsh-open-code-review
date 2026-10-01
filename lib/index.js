// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-open-code-review Contributors
// Portions derived from alibaba/open-code-review (Apache-2.0) — see NOTICE.

/**
 * DeepSeek Harness plugin exposing Open Code Review to DSH agents.
 *
 * The plugin is a port of upstream's *delegation* integration, not of the Go
 * review engine. Open Code Review keeps the deterministic half of a review —
 * deciding which files are in scope and which review rules apply to them —
 * and hands the judgement half to the host agent. DSH already has a model, so
 * those two halves join without an OCR LLM endpoint, an API key, or a second
 * provider configuration.
 *
 * Upstream ships this same contract as an opencode plugin, a pair of Claude
 * Code slash commands, and two portable skills. Here it becomes two tools, one
 * health probe, and one skill — the surfaces DSH actually has.
 *
 * @module dsh-open-code-review
 */

import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildRulesArgs, buildScopeArgs, parseDelegateJson, resolveOcr, runOcr } from "./ocr.js";
import { SKILL_NAME, readBundledSkill } from "./skill.js";

/** Cordis plugin name, matching the id in `cordis.patch.yml`. */
export const name = "open-code-review";

/** `tools` is required; the other two carry the plugin's optional surfaces. */
export const inject = ["tools", "systemPrompt", "skills"];

/** The delegation output format this plugin needs; `--format json` landed in 1.9.0. */
const MINIMUM_MINOR_VERSION = [1, 9];

/** Where this file lives, so the bundled skill resolves next to the package. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Prompt sections sort after the built-in tool guidance and before MCP servers. */
const PROMPT_SECTION_ORDER = 3000;

/** Runtime configuration, resolved from the profile's patch row. */
export const Config = z.object({
  ocrPath: z
    .string()
    .default("")
    .description("Explicit path to the ocr executable, or to a directory holding an install. Overrides every other source."),
  vendorDir: z
    .string()
    .default("")
    .description("Plugin-managed install root, searched for a per-platform opencodereview binary before PATH."),
  timeoutMs: z
    .number()
    .default(180_000)
    .description("Wall-clock ceiling for one ocr invocation, in milliseconds."),
});

/**
 * The delegation tools never call a model, so their output is bounded by git,
 * not by tokens. Shared shape keeps the three tools uniform for the model.
 */
const OUTPUT_SHAPE = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: {
      type: "string",
      required: true,
      description: "One-line digest of the result, safe to quote in a summary.",
    },
    output: {
      type: "string",
      required: true,
      description: "The verbatim output of the ocr command.",
    },
  },
};

/** Render both fields; `headline` first so a truncated tail keeps the digest. */
const renderHeadlineAndOutput = (_args, value) => [
  { type: "text", text: `${value.headline}\n\n${value.output}` },
];

/** Descriptions are shared between the tool schema and the prompt section. */
const SCOPE_DESCRIPTION =
  "Determine which changed files Open Code Review considers reviewable, and under which git mode. " +
  "Call this first, before any review, to get the deterministic file selection plus the mode/ref metadata " +
  "needed to fetch diffs. No model is called and no API key is needed. " +
  "Workspace changes are reviewed when neither 'commit' nor 'from'/'to' is given.";

const RULES_DESCRIPTION =
  "Fetch the review rules Open Code Review resolves for specific files, grouped so files sharing a rule " +
  "appear once. Pass the paths returned as reviewable by ocr_review_scope. Use the returned rule text as the " +
  "review checklist for those files. No model is called.";

const HEALTH_DESCRIPTION =
  "Report which Open Code Review executable this plugin resolves, its version, and whether it is new enough " +
  "for delegation. Call it when an ocr tool fails, when results look wrong, or to learn the install command " +
  "on a machine that has no ocr yet.";

/**
 * Resolve the repository a call should operate on.
 * An explicit path wins; a relative one resolves against the session
 * workspace; otherwise the session's own working directory is used.
 * @param requested - the model-supplied `repo`.
 * @param exec - the tool execution context.
 * @returns the absolute repository path, or `undefined` when the session has no cwd.
 */
function resolveRepo(requested, exec) {
  const sessionCwd = exec.agent?.session.header.cwd;
  if (typeof requested === "string" && requested.length > 0) {
    if (isAbsolute(requested)) return requested;
    return sessionCwd === undefined ? requested : resolve(sessionCwd, requested);
  }
  return sessionCwd;
}

/**
 * Run one delegation command and shape its result for the model.
 * @param argv - the delegation argv, without `--repo`.
 * @param repo - the repository path, when one is known.
 * @param exec - the tool execution context, for cwd and cancellation.
 * @param runner - resolved binary and config.
 * @returns the headline and the verbatim stdout.
 */
async function runDelegation(argv, repo, exec, runner) {
  const args = repo === undefined ? argv : [...argv, "--repo", repo];
  const result = await runOcr(args, {
    command: runner.command,
    cwd: repo ?? process.cwd(),
    timeoutMs: runner.timeoutMs,
    signal: exec.signal,
  });
  return result.stdout;
}

/** Format the scope headline from the parsed preview payload. */
function describeScope(payload) {
  const mode = payload.mode ?? "unknown";
  // Workspace mode has no refs to name, so it is its own target description.
  const target =
    mode === "range"
      ? `range ${payload.from}..${payload.to}`
      : mode === "commit"
        ? `commit ${payload.commit}`
        : mode;
  return (
    `Review scope (${target}): ${payload.reviewable_count} of ${payload.total_files} files reviewable, ` +
    `+${payload.total_insertions}/-${payload.total_deletions}, ${payload.excluded_count} excluded.`
  );
}

/** Format the rules headline from the parsed rule payload. */
function describeRules(payload, pathCount) {
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const sources = [...new Set(groups.map((group) => group.source).filter(Boolean))];
  return `${groups.length} rule group(s) for ${pathCount} file(s), from ${sources.join(", ") || "no"} source(s).`;
}

/** Extract `MAJOR.MINOR` from an `ocr version` banner, or `undefined`. */
function parseVersion(banner) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(banner);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether a parsed version is at or above the delegation `--format json` floor. */
function supportsDelegationJson(version) {
  if (version === undefined) return false;
  const [major, minor] = version;
  const [floorMajor, floorMinor] = MINIMUM_MINOR_VERSION;
  return major > floorMajor || (major === floorMajor && minor >= floorMinor);
}

/** Build the human-readable health report for one resolution outcome. */
function healthReport(resolution, versionBanner) {
  const lines = [`resolved via: ${resolution.source}`, `executable: ${resolution.command}`];
  if (versionBanner === undefined) {
    lines.push("version: (could not be read)");
    return { headline: "Open Code Review is installed but did not report a version.", output: lines.join("\n") };
  }
  lines.push("", versionBanner);
  const version = parseVersion(versionBanner);
  if (supportsDelegationJson(version)) {
    return {
      headline: `Open Code Review ${version?.join(".")} is ready for delegation.`,
      output: lines.join("\n"),
    };
  }
  lines.push(
    "",
    `This plugin needs ${MINIMUM_MINOR_VERSION.join(".")}.0 or later for \`--format json\` on \`ocr delegate\`.`,
    "Upgrade with: npm install -g @alibaba-group/open-code-review",
  );
  return {
    headline: "Open Code Review is too old for delegation.",
    output: lines.join("\n"),
  };
}

/**
 * Register the three delegation tools, the workflow skill, and a short prompt
 * section on the calling context.
 * @param ctx - registrant context carrying the tool, prompt, and skill registries.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
  const settings = {
    ocrPath: config.ocrPath ?? "",
    vendorDir: config.vendorDir ?? "",
    timeoutMs: config.timeoutMs ?? 180_000,
    // Makes the bundled platform binary findable without a manual install.
    packageRoot: PACKAGE_ROOT,
  };

  /**
   * Resolve the binary once per call rather than once per mount: an operator
   * who installs `ocr` or edits `ocrPath` should not have to restart the host
   * to be believed.
   */
  const runner = () => ({ ...resolveOcr(settings), timeoutMs: settings.timeoutMs });

  ctx.systemPrompt.section({
    name: "tool:open-code-review",
    order: PROMPT_SECTION_ORDER,
    text:
      "`ocr_review_scope` and `ocr_review_rules` come from Open Code Review and need no API key: they decide " +
      "which changed files are reviewable and which rules apply, and you perform the review with your own " +
      "judgement. For a code review, call `ocr_review_scope` first, then `ocr_review_rules` for the reviewable " +
      "paths, then read the diffs yourself and account for every file in scope. `ocr_health` reports the " +
      "resolved executable and its version.",
  });

  ctx.tools.register(
    defineTool({
      name: "ocr_review_scope",
      description: SCOPE_DESCRIPTION,
      parameters: {
        commit: {
          type: "string",
          description: "Review one commit against its parent. Cannot be combined with 'from'/'to'.",
        },
        from: {
          type: "string",
          description: "Base ref for a branch comparison. Must be paired with 'to'.",
        },
        to: {
          type: "string",
          description: "Target ref for a branch comparison. Must be paired with 'from'.",
        },
        exclude: {
          type: "string",
          description: "Comma-separated gitignore-style patterns to exclude, merged with the ruleset's own excludes.",
        },
        background: {
          type: "string",
          description: "Business or requirement context the change is supposed to satisfy.",
        },
        backgroundFile: {
          type: "string",
          description:
            "Path to a Markdown file holding the background. Relative paths resolve against the repository. " +
            "Cannot be combined with 'background'. The file must be at most 1 MiB and sanitise to 8000 characters.",
        },
        repo: {
          type: "string",
          description: "Repository to inspect. Defaults to the session working directory.",
        },
      },
      output: { schema: OUTPUT_SHAPE, render: renderHeadlineAndOutput },
      async execute(args, exec) {
        // Validate before resolving the binary, so a malformed request reports
        // the malformed request rather than a missing install.
        const argv = buildScopeArgs(args);
        const repo = resolveRepo(args.repo, exec);
        const stdout = await runDelegation(argv, repo, exec, runner());
        const payload = parseDelegateJson(stdout, "delegate preview");
        return { headline: describeScope(payload), output: stdout };
      },
      presentCall: (args) => ({
        card: "generic",
        title: "Open Code Review: resolve scope",
        kind: "other",
        rawInput: args,
      }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "ocr_review_rules",
      description: RULES_DESCRIPTION,
      parameters: {
        paths: {
          type: "array",
          required: true,
          items: { type: "string" },
          description: "Reviewable file paths, relative to the repository root, exactly as ocr_review_scope reported them.",
        },
        repo: {
          type: "string",
          description: "Repository the paths belong to. Defaults to the session working directory.",
        },
      },
      output: { schema: OUTPUT_SHAPE, render: renderHeadlineAndOutput },
      async execute(args, exec) {
        const argv = buildRulesArgs(args);
        const repo = resolveRepo(args.repo, exec);
        const stdout = await runDelegation(argv, repo, exec, runner());
        const payload = parseDelegateJson(stdout, "delegate rule");
        return { headline: describeRules(payload, args.paths.length), output: stdout };
      },
      presentCall: (args) => ({
        card: "generic",
        title: `Open Code Review: resolve rules for ${args.paths?.length ?? 0} file(s)`,
        kind: "other",
        rawInput: args,
      }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "ocr_health",
      description: HEALTH_DESCRIPTION,
      parameters: {},
      output: { schema: OUTPUT_SHAPE, render: renderHeadlineAndOutput },
      async execute(_args, exec) {
        let resolution;
        try {
          resolution = runner();
        } catch (error) {
          // A missing binary is the single most likely failure this tool
          // exists to explain, so it is reported as a result rather than thrown.
          return { headline: "Open Code Review is not installed.", output: String(error.message ?? error) };
        }
        try {
          const { stdout } = await runOcr(["version"], {
            command: resolution.command,
            cwd: process.cwd(),
            timeoutMs: 30_000,
            signal: exec.signal,
          });
          return healthReport(resolution, stdout);
        } catch (error) {
          return {
            headline: "Open Code Review is installed but could not be run.",
            output: `resolved via: ${resolution.source}\nexecutable: ${resolution.command}\n\n${String(error.message ?? error)}`,
          };
        }
      },
      presentCall: () => ({
        card: "generic",
        title: "Open Code Review: check install",
        kind: "other",
      }),
    }),
  );

  // The skill carries the review workflow in full so the prompt section above
  // can stay short. A packaging mistake that drops it must not take the tools
  // down with it, because DSH's boot is all-or-nothing.
  try {
    ctx.skills.register({
      name: SKILL_NAME,
      description:
        "Run a code review driven by Open Code Review: resolve the deterministic review scope and rule set with " +
        "ocr_review_scope and ocr_review_rules, review each file with your own judgement, and report findings " +
        "with exact file and line references and full coverage accounting.",
      content: readBundledSkill(PACKAGE_ROOT),
    });
  } catch (error) {
    ctx.logger?.warn?.(
      `open-code-review: the bundled skill could not be loaded, so only the tools are available: ${String(error.message ?? error)}`,
    );
  }
}

