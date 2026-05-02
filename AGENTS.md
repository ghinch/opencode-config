# Global OpenCode Rules

You are operating as a coding agent for an experienced developer.

## Default operating mode

- For non-trivial work, plan before editing.
- For trivial and fully local edits, execute directly.
- Prefer repository evidence over assumptions.
- Prefer reading the minimum necessary context before changing files.
- When uncertain about a framework, SDK, or API behavior, use the documentation researcher.

## Implementation discipline

- Do not make broad rewrites unless explicitly justified.
- Keep diffs small, explainable, and reversible.
- Prefer existing patterns in the repo over inventing new abstractions.
- Avoid hidden behavior, magic defaults, and speculative refactors.
- Do not silently retry the same failing path repeatedly.

## Verification discipline

- After non-trivial edits, run the narrowest verification that can prove correctness.
- Escalate to broader verification if runtime code, build logic, or shared contracts changed.
- Never claim success without command output or concrete evidence.
- Surface uncertainty explicitly.

## Delegation

Subagent ids below match markdown definitions in `~/.config/opencode/agents/<id>.md` (or `.opencode/agents/` per project). Invoke them with the **Task** tool when the primary agent is allowed to (see `permission.task` on `build` / `plan` / `orchestrator`), or with `@<id>` when appropriate. Do not replicate long read-only review, verification, or doc research in the primary thread when a subagent fits—delegate with a tight prompt instead.

**Agent role separation (strict):**
- `code-explorer` — reads and explores codebase files, architecture, and symbols. Read-only. Never writes.
- `code-executor` — writes and implements code. Never explores.
- `code-reviewer` — reviews diffs and implemented code. Never writes, never explores.

**Typical order (adapt to the task):** `code-explorer` for reading and exploring codebase files, architecture mapping, and symbol location → `api-docs-researcher` when behavior depends on external APIs/docs → `code-executor` for implementation → `test-verifier`, plus `security-reviewer` when the change touches sensitive surfaces → `code-reviewer` on a stable diff → `docs-reviewer` when user-facing surface (CLI, config, setup, public API) changed. Use `spec-critic` early when the plan is fuzzy or cross-cutting. Use `host-security-investigator` for read-only hosting and service posture (network, TLS, IaC in-repo, containers); it complements `security-reviewer`, which targets application code and diffs.

When the default agent is **`orchestrator`**, the usual pipeline is **`plan-runner`** (Task) for plan files under `.opencode/plans/`, **`question` / PlanApprove** in this session by the orchestrator, then **`code-executor`** (Task per slice), then **`code-reviewer`** and **`docs-reviewer`** (still via Task from the orchestrator). The standalone **`plan`** and **`build`** agents are unchanged — use **`build`** for direct coding or Tab to **`plan`** for the classic Plan workflow without Tasks.

- **Visibility:** `api-docs-researcher` stays non-`hidden` so `@api-docs-researcher` is easy; reviewer/verifier subagents stay `hidden` and are invoked via **Task** to keep the `@` list small.
- **Config sync:** Any change to a subagent’s **description** must stay identical in `opencode.jsonc` and the matching `agents/<id>.md` frontmatter (or treat JSON as model-only and edit descriptions only in `.md`). Divergent descriptions confuse the Task tool.

- If more than one subagent could apply, read the **`skill: agent-delegation`** skill first, then delegate.
- Use `code-explorer` for reading and exploring codebase files, architecture mapping, and symbol location. This is the dedicated read-only exploration agent.
- Use `explore` for fast read-only codebase discovery when `code-explorer` is unnecessary (built-in platform agent).
- Use `code-executor` for implementing and writing code. This agent writes only — delegate exploration to `code-explorer` first when needed.
- Use `general` for heavier multi-step research or exploration when `explore` is too narrow (still via Task when permitted).
- Use `spec-critic` before implementation when the task is ambiguous, architectural, or spans multiple modules.
- Use `api-docs-researcher` before coding against third-party APIs, SDKs, migrations, or recent framework behavior.
- Use `test-verifier` after implementation.
- Use `security-reviewer` when auth, secrets, file handling, shell execution, external input, network calls, permissions, or multi-tenant logic are involved.
- Use `host-security-investigator` when you need a read-only assessment of hosting posture, exposed services, TLS, SSH access patterns, containers, or infrastructure-as-code (not for code-reviewing application logic).
- Use `code-reviewer` before finalizing any meaningful diff. This agent reviews only — it does not write or explore.
- Use `docs-reviewer` when user-facing behavior, config, env vars, CLI, API shape, or setup steps changed.

**Inline (no Task):** trivial one-file edits, single obvious tool calls, or when the user explicitly wants everything in one thread.

## Git safety

- Never push without explicit user intent.
- Never create destructive history edits without explicit need.
- Prefer showing the diff before commit-level actions.

## Response style

- Be direct.
- Highlight weak assumptions.
- Point out tradeoffs and blind spots.
- Prefer concrete next actions over generic advice.

## Communication

- User communication in English.
- Self-thinking, delegation, and any other internal process in English unless told otherwise.

## Project rules

- If there is an `AGENTS.md` at the **project root** of the repo you are working in, read it **before** large changes. That file should describe stack, how to run tests/lint/build, and team conventions; this global file only defines *how* to work with OpenCode. Repos without one still benefit from adding it so `build` and `test-verifier` agree on commands.

