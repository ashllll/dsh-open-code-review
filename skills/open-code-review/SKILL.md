---
name: open-code-review
description: >
  Run a code review whose scope and rules come from Open Code Review (OCR)
  rather than from your own guesswork. Use when asked to review a diff,
  branch, commit, or the current workspace changes. Delegates deterministic
  file selection and rule resolution to the `ocr_review_scope` and
  `ocr_review_rules` tools, then performs the review with your own judgement.
license: Apache-2.0
compatibility: >
  Requires the `ocr` CLI (>= 1.9.0) and this plugin's tools. Does NOT require
  an OCR LLM endpoint or API key — scope and rule resolution never call a model.
metadata:
  author: alibaba (upstream skill), ported to DeepSeek Harness
  homepage: https://github.com/alibaba/open-code-review
  version: "1.0.0-dsh"
---

# Open Code Review — delegation workflow

> Ported from `plugins/open-code-review/skills/open-code-review-delegate/SKILL.md`
> in [alibaba/open-code-review](https://github.com/alibaba/open-code-review)
> (Apache-2.0). Changed for DSH: the two `ocr delegate` subcommands are reached
> through the `ocr_review_scope` and `ocr_review_rules` tools instead of a shell,
> and diffs are read with DSH's own file and shell tools.

Open Code Review owns the parts of a review that must not go wrong: **which files
are in scope** and **which rules apply to each file**. You own the judgement.
OCR's LLM is never called, so no API key or provider configuration is involved.

## Step 1 — Resolve the review scope

Call **`ocr_review_scope`**. Review the current workspace changes by default, or
pass a target:

| Scenario | Arguments |
|----------|-----------|
| Workspace changes | *(none)* |
| Branch comparison | `from: "main"`, `to: "feature"` |
| Single commit | `commit: "abc123"` |
| Narrow the scope | `exclude: "docs/**,*.lock"` |

The result reports `mode` (`workspace` / `range` / `commit`), the ref metadata
(`from`, `to`, `commit`, `merge_base`), a **reviewable file list**, and an
**excluded file list with a reason for each exclusion**. Treat the reviewable
list as the contract: it is what OCR decided must be reviewed.

## Step 2 — Resolve the rules for those files

Call **`ocr_review_rules`** with the reviewable paths from Step 1. It returns
rule groups: files that share a rule appear together, so you read each rule once.
The rule text is your **review checklist** for those files — read it before
looking at the code, not after.

For large changesets, fetch rules in batches and review each batch before
fetching the next, so the checklist stays in focus.

## Step 3 — Read the diffs yourself

Build the git command from the `mode` and refs that Step 1 returned.

**Range mode** — use `merge_base`:
```
git diff <merge_base>..<to> -- <path>
```

**Commit mode**:
```
git show <commit> -- <path>
```

**Workspace mode** — tracked files, then untracked files:
```
git diff HEAD -- <path>
```
Untracked files have no diff: read the whole file, because all of it is new code.

## Step 4 — Review every file in scope

Build a checklist containing **every** `reviewable_files` entry, keyed on
`(path, status)`. Workspace mode can legitimately report the same path twice
when a staged deletion is followed by an untracked recreation; the pair is two
items, not one.

For each item:

1. Read its diff.
2. Apply the rules from its rule group.
3. Read enough surrounding code to judge it — use the rule text's own
   instructions about confirming context before flagging. A finding you cannot
   substantiate is worse than no finding.
4. Mark it `reviewed`, or `skipped` with a concrete reason.

Only comment on changed lines. Do not stop after the first high-severity
finding, and do not silently drop a file.

## Step 5 — Report findings

Every comment carries:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| path | string | yes | Path relative to the repository root |
| content | string | yes | The issue, stated concretely |
| start_line | integer | no | Start line **in the new file** |
| end_line | integer | no | End line in the new file |
| category | enum | no | bug, security, performance, maintainability, test, style, documentation, other |
| severity | enum | no | critical, high, medium, low |

Line numbers must point at the new file. If you cannot place a finding on a
specific line, report it without line numbers rather than guessing — a wrong
line costs more reviewer trust than no line.

## Step 6 — Account for coverage

Close with the counts. This is what makes the review auditable:

- `total_files` — every file in scope
- `reviewed_files`
- `skipped_files` — each with its reason
- `coverage_rate`

Group findings by severity:

- **Critical / High** — bugs, security issues, data loss risks: always report.
- **Medium** — performance, error handling, maintainability: report with context.
- **Low** — style and minor suggestions: report only when clearly valuable.

Discard likely false positives without commenting on them.

## Step 7 — Fix, when asked

If the request was "review and fix": apply High and Critical fixes directly,
describe the Medium fixes that need a decision, and leave Low items alone unless
they are trivial.

## Gotchas

- **No LLM on the OCR side.** These tools only select files and resolve rules.
  All review intelligence is yours.
- **The scope list is authoritative.** If you think a file was wrongly excluded,
  say so — but review what OCR selected first.
- **`ocr_review_rules` accepts any number of paths.** Fetch per batch rather
  than all at once on a large change.
- **Background context is size-limited.** `backgroundFile` must be at most 1 MiB
  and sanitise to 8000 characters, and the command aborts when either limit is
  exceeded. Never silently truncate: summarise the requirements, constraints,
  and acceptance criteria, write the summary to a new bounded file, and pass
  that instead.
- **Do not run `ocr review` or `ocr llm test`.** Those need an OCR LLM endpoint
  this workflow deliberately does not use. If a tool fails, call `ocr_health`
  and report what it says.
- **Version floor.** `--format json` needs `ocr` 1.9.0 or later. A tool failure
  naming that version means the installed CLI is too old to upgrade with
  `npm install -g @alibaba-group/open-code-review`.
- **Custom rules** live in `<repo>/.opencodereview/rule.json` and are picked up
  automatically. A `source` of `project` or `custom` in a rule group means the
  repository or user overrode the built-in rule — treat it as authoritative for
  that file.
