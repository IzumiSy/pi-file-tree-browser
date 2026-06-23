---
name: publish-browser-results
description: Investigate a codebase task, narrow findings to a short curated list of relevant file locations, and publish them to the file browser with set_file_browser_results so the user can inspect and pin them.
---

# Publish Browser Results

Use this skill when the user would benefit from browsing a curated shortlist of relevant code locations in the file browser instead of only reading an inline explanation.

This skill assumes the `set_file_browser_results` tool is available from the paired file browser extension.

## When to use

Use this skill when:
- the user asks where to look in the codebase
- the task involves multiple plausible files or call sites
- the user wants to inspect, compare, or pin candidate locations
- you are triaging a bug, tracing a flow, or surfacing implementation options

Do not use this skill when:
- there is only one obvious file/location and no browsing benefit
- you have not yet narrowed the search enough
- the result list would be noisy or speculative

## Goal

Produce a small, curated result set that the user can open in `/files-result`.

The result set should help the user inspect the code, not dump every possible match.

## Workflow

1. Investigate first.
   - Use normal tools such as `read`, `bash`, `rg`, `grep`, or repository-aware search.
   - Trace shared callers before concluding.
   - Prefer root-cause locations over symptom-only matches.

2. Narrow to a shortlist.
   - Prefer 3 to 10 results.
   - Hard cap: 20 unless the user explicitly wants a broad sweep.
   - Include only locations that are likely relevant.

3. Publish once.
   - Call `set_file_browser_results` once near the end of the turn.
   - Do not spam incremental updates while still exploring.

4. Explain briefly.
   - Tell the user that results were published to `/files-result`.
   - Summarize what the shortlist represents.

## Result quality rules

Each result should be one of:
- the likely root-cause implementation
- an important caller
- a shared helper or type definition
- an alternative implementation site worth comparing
- a config or test file directly relevant to the issue

Avoid:
- duplicate entries for the same exact range
- low-signal files
- broad "just in case" noise
- huge unsorted dumps

## How to choose line ranges

- Include `startLine` when you know the relevant entry point.
- Include `endLine` only when the range is small and meaningful.
- Prefer tight ranges around a function, branch, or block.
- If unsure, publish just the file path.

Good:
- one function
- one branch handling an error
- one shared helper definition

Bad:
- half the file
- arbitrary giant ranges
- ranges chosen without inspecting content

## Reason field

Use a short `reason` so the user can scan the list quickly.

Good examples:
- `shared auth guard`
- `maps backend error to UI message`
- `main caller of retry helper`
- `parses config and applies default`

Keep reasons short, concrete, and distinct.

## Tool contract

Call `set_file_browser_results` with:
- `title`: short label for the result set
- `results`: curated items with:
  - `path`
  - optional `startLine`
  - optional `endLine`
  - optional `reason`

## Preferred behavior

- Prefer a single final call per turn.
- Prefer relative paths when practical.
- Prefer exact files over directories.
- Prefer root-cause and shared-flow locations over leaf noise.

## Response pattern

After publishing results, tell the user:
- what the shortlist represents
- that it is available in `/files-result`
- what to inspect first

Example phrasing:
- `関連候補を /files-result に出しました。まずは auth.ts と session.ts の共有分岐を見るのが近道です。`
- `実装候補を /files-result にまとめました。必要ならそこから pin してください。`

## Fallback

If `set_file_browser_results` is unavailable, continue normally:
- give the shortlist inline
- mention that browser publishing was not available
