# dsh-open-code-review

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
brings [Alibaba Open Code Review](https://github.com/alibaba/open-code-review)'s
deterministic review engine to DSH agents.

Open Code Review (OCR) is built on a deliberate split: engineering hard-constrains
what *must not* go wrong — which files are in scope, which rules apply to each —
and a model does the judging. This plugin keeps that split and puts **your DSH
model** on the judging side. OCR's own LLM is never called, so there is no second
provider to configure and **no API key**.

```
ocr_review_scope  →  which changed files are reviewable (deterministic)
ocr_review_rules  →  which review rules apply to those files (deterministic)
       you        →  read the diffs, judge, report with coverage
```

## Requirements

| | |
|---|---|
| `ocr` | **1.9.0 or later** — `--format json` landed in 1.9.0. Verified against 1.12.11 on Windows x64. |
| git | 2.41 or later (OCR reads diffs through git). |
| DSH | Any build with plugin support. Verified on DSH Desktop 0.1.7-rc.2. |

## Install

**1. Install the `ocr` CLI.** The plugin never installs anything by itself.

```sh
npm install --prefix "<DSH_HOME>/open-code-review" @alibaba-group/open-code-review
```

`<DSH_HOME>` is the harness data root (`$env:DSH_HOME`; by default `~/.dsh`, and
`%APPDATA%\dsh-desktop\harness` for DSH Desktop). Installing to that prefix puts
the binary exactly where the plugin's default `vendorDir` looks for it.

A machine-wide `npm install -g @alibaba-group/open-code-review` also works — the
plugin finds it on `PATH`, including by following npm's `ocr.cmd` shim to the
native binary beside it. The plugin-managed prefix is just the more predictable
of the two.

**2. Install the plugin.**

```sh
dsh plugin --profile web add dsh-open-code-review
```

Or, before it is published to npm, straight from this repository:

```sh
dsh plugin --profile web add github:ashllll/dsh-open-code-review
```

A local checkout works too — `dsh plugin --profile web add <abs-path-to-.tgz>`.
Note that pnpm resolves a *relative* tarball path against the current directory,
not the profile, so pass an absolute path.

**3. Refresh the page.** The tools appear as `ocr_review_scope`,
`ocr_review_rules`, and `ocr_health`, and the `open-code-review` skill is added to
the skill catalog.

## What it adds

### Tools

| Tool | Purpose |
|---|---|
| `ocr_review_scope` | Which changed files are reviewable, plus the mode and refs needed to fetch diffs. `commit`, or `from`+`to`, or nothing for workspace changes. |
| `ocr_review_rules` | The review rules OCR resolves for specific paths, grouped so files sharing a rule appear once. Use the rule text as the review checklist. |
| `ocr_health` | Which `ocr` executable was resolved, from where, its version, and whether it is new enough. Also prints the install command when nothing is found. |

### Skill

`open-code-review` carries the full workflow — resolve scope, resolve rules, read
diffs with git, review every file in scope, report with line-level references and
a coverage count. It loads on demand, so the always-present prompt contribution
stays to a few lines.

### A note on the port

Upstream ships this same contract for four other hosts: an
[opencode plugin](https://github.com/alibaba/open-code-review/blob/main/plugins/open-code-review/opencode/open-code-review.ts),
Claude Code and Kimi Code slash commands, and two portable skills. This package is
the DSH-shaped member of that set. Nothing about the OCR engine was reimplemented —
the plugin drives the real `ocr` binary.

## Configuration

The plugin mounts with one patch row and declares three settings:

```yaml
- id: open-code-review
  name: dsh-open-code-review
  config:
    vendorDir: !!js dshHomePath('open-code-review')   # default
    ocrPath: ''                                       # explicit binary or install dir; wins over everything
    timeoutMs: 180000                                 # per-invocation ceiling
```

Write overrides into your profile's own `cordis.patch.yml`
(`<DSH_HOME>/profiles/<name>/cordis.patch.yml`). Note that DSH replaces `config`
wholesale rather than merging, so repeat any field you want to keep. To disable
the plugin without uninstalling it:

```yaml
- id: open-code-review
  disabled: true
```

## Scope

Deliberately **not** ported:

- `ocr review` and `ocr scan` — the LLM-driven pipeline. It needs its own provider
  and API key, which is precisely what delegation exists to avoid. If you want it,
  configure OCR's LLM (`ocr config provider`, `ocr config model`) and call the CLI
  through the `pwsh` tool.
- `ocr viewer`, `ocr session *`, `ocr config *` — interactive or stateful surfaces
  with no useful tool-shaped contract.

Custom rules are still fully available: put a `.opencodereview/rule.json` in the
repository and `ocr_review_rules` resolves it automatically, reporting
`source: project`. See
[OCR's rule documentation](https://github.com/alibaba/open-code-review).

## Security

- **No implicit installs.** The plugin never reaches the network. A missing binary
  fails with the exact command to run.
- **No shell.** `ocr` is spawned with `shell: false` from a resolved native
  executable, so model-supplied refs and paths are never interpolated into a
  command line. npm's `.cmd` shim is treated as a signpost to the native binary
  rather than executed, which also skips the launcher's background update check.
- **Delegation is read-only.** `ocr delegate` writes no session files; it prints a
  JSON document to stdout and exits.
- **Sandbox boundary.** The plugin spawns `ocr` as a child process directly, so
  this call does not pass through DSH's shell sandbox or its approval gate the way
  `pwsh` does. It reads the target git repository — file names, statuses, and the
  resolved rule text, never file contents. Point `repo` at something you are
  willing to have inspected, and disable the plugin on profiles where that is not
  acceptable.
- **Bounded.** A 10 MiB output ceiling, a wall-clock timeout, and process-tree
  termination (including `taskkill /T` on Windows) on timeout or cancellation.

## Development

```sh
node test/smoke.mjs
```

29 checks covering argument building, binary resolution across the npm layouts,
delegation JSON parsing, and frontmatter handling. When an `ocr` binary is
resolvable, it also runs the real thing: `ocr version`, a `delegate preview`
against a throwaway git repository, and a `delegate rule` resolving the Python
ruleset. With no `ocr` present those three are reported as skipped rather than
failing.

## License

Apache-2.0. Derived in part from
[alibaba/open-code-review](https://github.com/alibaba/open-code-review); see
[NOTICE](NOTICE) for exactly what was reused and what changed. Not affiliated with
or endorsed by Alibaba Group.
