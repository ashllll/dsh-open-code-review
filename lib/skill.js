// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-open-code-review Contributors

/**
 * Loading the skill this package bundles.
 *
 * Kept free of DSH imports so the frontmatter handling is testable without a
 * running harness — `lib/index.js` cannot be imported outside DSH because its
 * `@deepseek-ai/*` peer dependencies only exist there.
 *
 * @module dsh-open-code-review/skill
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The bundled skill's directory name and registered skill name. */
export const SKILL_NAME = "open-code-review";

/** Where the bundled skill lives, relative to the package root. */
export const SKILL_RELATIVE_PATH = join("skills", SKILL_NAME, "SKILL.md");

/**
 * Drop a leading YAML frontmatter block.
 *
 * `ctx.skills.register` takes a skill *body*, but the bundled file is a
 * conventional `SKILL.md` whose frontmatter makes it loadable by the
 * filesystem skill provider too. The block is discarded rather than parsed:
 * upstream's frontmatter uses folded scalars, and parsing them would mean a
 * YAML dependency for metadata this plugin already states in code.
 *
 * @param markdown - raw `SKILL.md` contents.
 * @returns the body, with any frontmatter and surrounding whitespace removed.
 */
export function stripFrontmatter(markdown) {
  return markdown.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
}

/**
 * Read the bundled skill body from a package root.
 * @param packageRoot - absolute path to the package root.
 * @returns the skill body, ready for `ctx.skills.register`.
 */
export function readBundledSkill(packageRoot) {
  return stripFrontmatter(readFileSync(join(packageRoot, SKILL_RELATIVE_PATH), "utf8"));
}
