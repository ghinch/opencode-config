---
name: agent-delegation
description: "Use when the primary agent must decide whether to delegate via the Task tool, which subagent id to call, and how to keep child-session prompts small. Use when multiple subagents could apply, or before large read-only review, verification, security review, or external doc research."
---

# Subagent delegation (OpenCode)

Must respect `permission.task` on the active primary agent (`build` vs `plan` vs `orchestrator` have different allowlists). The `plan` agent cannot invoke `test-verifier`, `code-reviewer`, `security-reviewer`, or `docs-reviewer` via Task. The `plan` agent **may** invoke `host-security-investigator` when it appears in `permission.task` (read-only hosting and service investigation). The **`orchestrator`** agent drives Task `plan-runner`, `code-executor`, and the usual reviewers per its prompt; it does not implement code directly.

## Decision table

| Situation                                                | Subagent id           | Notes                                              |
| -------------------------------------------------------- | --------------------- | -------------------------------------------------- |
| Fast repo discovery, find symbols/files, read-only       | `explore`             | Prefer over spelunking in the primary thread       |
| Broader multi-step research or exploration with tools     | `general`             | When `explore` is not enough (not on `plan`/`orchestrator` allowlists unless added) |
| Plan file draft for orchestrator flow (then parent gates approval) | `plan-runner` | Writes `.opencode/plans/`; does not emit PlanApprove |
| Scoped implementation slice delegated by orchestrator     | `code-executor`      | Mirrors build-style edits for one slice; no final repo reviewers |
| Challenge a plan before coding                           | `spec-critic`         | Ambiguous, architectural, multi-module work        |
| Official docs / API / migration facts before coding      | `api-docs-researcher` | Third-party SDKs, frameworks, rate limits, auth    |
| After implementation: tests, lint, typecheck, acceptance | `test-verifier`       | Requires evidence; never claim pass without output |
| Auth, secrets, input validation, shell/network safety    | `security-reviewer`   | Overlap with sensitive code paths                  |
| Hosting posture, exposed services, TLS, IaC, containers (read-only) | `host-security-investigator` | Not for app code review; SSH/scp/rsync need approval per invocation |
| Pre-merge quality: correctness, fit, regressions         | `code-reviewer`       | Meaningful diffs                                   |
| Docs impact: README, env, CLI, public API, setup         | `docs-reviewer`       | User-visible behavior changed                      |

## Gold rule: minimal child prompt

Every Task invocation should include:

1. **Goal** in one or two sentences.
2. **Scope**: exact paths, commit/diff, or “read-only” constraints already known to the parent.
3. **Expected return shape**: use the numbered sections that agent’s system prompt requires (e.g. blocking vs non-blocking lists).

Do not paste the entire parent conversation into the subagent unless necessary.

## When not to delegate

- Single trivial edit or one obvious tool call.
- User asked explicitly for a single-thread reply.
- Subagent is denied for the current primary (`permission.task`).

## Anti-patterns (avoid)

- Do **not** call `code-reviewer` until there is a **stable diff** (known paths / commit / clear scope); reviewing “what we might do” wastes context.
- Do **not** call `test-verifier` without **repo root**, **expected commands** (or confirmation to discover them from project docs), and **what “done” means** (acceptance criteria).
- Do **not** chain multiple heavy subagents in parallel on the same prompt without a reason; finish one feedback cycle first.
- Do **not** use long `@` lists for subagents that are **`hidden: true`**; use **Task** instead so permissions and tool contracts stay clear.

## Definitions location

Global defaults live under `~/.config/opencode/agents/<id>.md`. Project overrides: `.opencode/agents/<id>.md`.
