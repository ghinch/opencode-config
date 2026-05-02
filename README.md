# OpenCode Agent Orchestrator

A lightweight OpenCode configuration that implements a practical orchestrator pattern for AI-assisted software development.

The goal is to get the benefits of a multi-agent workflow - planning, execution, review, and security checks - without turning the setup into a complex agent framework or adding excessive token overhead.

## Why this exists

Single-agent workflows are often enough for small tasks, but they tend to become less reliable as work gets larger or more ambiguous. Common issues include:

- Planning and implementation getting mixed together
- Repeated context consuming unnecessary tokens
- Reviews being skipped or performed inconsistently
- Security, documentation, and testing concerns being handled too late
- Large tasks producing broad, hard-to-review diffs
- Inefficient token usage when the same model is applied to tasks of varying complexity

This repository provides a small orchestrator-based pattern that keeps the workflow structured while remaining easy to inspect, modify, and run.

## What this provides

- **A very simple orchestrator pattern** - A central agent coordinates planning, approval, implementation, and review phases that you can build upon and customize as needed.
- **Scoped subagents** - Specialized agents handle planning, execution, testing, documentation, security, and code review
- **Token-conscious delegation** - Subagents receive focused tasks instead of the full problem context whenever possible
- **Approval-gated planning** - Non-trivial work is planned before implementation starts
- **Minimal framework overhead** - The system is implemented as OpenCode configuration, agent prompts, skills, and a small plugin
- **Reusable development skills** - Shared skill definitions for delegation, task management, Python quality, and security investigation

## Design goals

This project is intentionally small. It is not trying to be a general-purpose agent platform.

It aims to:

- Keep orchestration understandable
- Reduce unnecessary context passed between agents
- Preserve code quality through explicit planning and review steps
- Make agent responsibilities clear
- Avoid excessive automation that hides what is happening
- Provide a useful starting point for customizing OpenCode workflows
- Sync the improvements on my own personal workflow.

## How the workflow works

The default entry point is the `orchestrator` agent.

For non-trivial tasks, the workflow typically follows this pattern:

1. **Orchestrator receives the user request**
2. **Planning is delegated** to a planning subagent
3. **A concrete plan is written** under `.opencode/plans/`
4. **The user approves or rejects the plan**
5. **Implementation is delegated** in scoped slices
6. **Review agents validate the result** for correctness, tests, documentation impact, and security concerns

This keeps the main agent focused on coordination instead of forcing one large prompt/session to handle every phase of the task.

## Structure

```text
.
├── AGENTS.md                 # Global agent rules and delegation guidelines
├── LICENSE
├── README.md
├── opencode.jsonc            # Main OpenCode configuration
├── package.json              # Plugin / tooling dependencies
├── package-lock.json
├── tsconfig.json             # TypeScript configuration (plugins)
├── tui.json                  # TUI settings (if used)
├── command/                  # Optional OpenCode command hooks (may be empty)
├── .opencode/
│   ├── package.json          # Additional deps used under `.opencode` (SDK / plugins)
│   ├── package-lock.json
│   └── plans/                # Concrete plans (plan-runner / approval flow)
├── agents/                   # Agent definitions
│   ├── orchestrator.md       # Workflow coordinator
│   ├── build.md              # Primary implementation agent
│   ├── plan.md               # Planning agent
│   ├── plan-runner.md        # Plan drafting subagent
│   ├── code-explorer.md      # Read-only codebase exploration
│   ├── code-executor.md      # Implementation subagent
│   ├── api-docs-researcher.md
│   ├── spec-critic.md
│   ├── test-verifier.md
│   ├── code-reviewer.md
│   ├── docs-reviewer.md
│   ├── security-reviewer.md
│   └── host-security-investigator.md
├── skills/                   # Reusable skill definitions
│   ├── agent-delegation/
│   ├── context7/
│   ├── gitnexus-cli/
│   ├── gitnexus-debugging/
│   ├── gitnexus-exploring/
│   ├── gitnexus-guide/
│   ├── gitnexus-impact-analysis/
│   ├── gitnexus-pr-review/
│   ├── gitnexus-refactoring/
│   ├── pythonic-quality/
│   ├── security-investigation/
│   ├── skill-creator/
│   └── task-management/
└── plugins/
    └── plan-post-approval.ts # Automated plan handoff
```

## Agents

### Primary agents (Strong models) - Currently Using Kimi K2.6/DeepSeek V4 Pro/GLM 5.1

- **orchestrator** - Coordinates multi-phase work through plan files, approval gates, and implementation slices
- **build** - OpenCode Default Agent
- **plan** - OpenCode Default Agent

### Subagents (Cheap models) - Currently Using DeepSeek V4 Flash

- **plan-runner** - Drafts implementation plans under `.opencode/plans/`
- **code-executor** - Implements scoped coding tasks with minimal diffs
- **test-verifier** - Validates changes through tests, linting, and type checking
- **code-reviewer** - Reviews diffs for correctness, maintainability, and implementation risk
- **docs-reviewer** - Checks whether documentation needs to be updated
- **security-reviewer** - Identifies security risks in application code
- **spec-critic** - Challenges plans before coding starts
- **api-docs-researcher** - Researches external API documentation
- **host-security-investigator** - Assesses hosting and infrastructure security concerns

## When to use this

This configuration is useful when you want:

- More structure than a single-agent coding workflow
- Planning before implementation
- Smaller, easier-to-review diffs
- Separate review passes for tests, docs, code quality, and security
- A multi-agent setup that is still simple enough to understand and modify

It may be unnecessary for very small edits where a direct `build` agent is faster and cheaper.

## Plugins

### Plan post-approval handoff

`plugins/plan-post-approval.ts` automates the handoff after a plan is approved through `PlanApprove`.

It:

- Extracts plan file paths from approval questions
- Uses the last user message `agent` field as routing context
- Hands off `plan` sessions to `build` after idle using `session.summarize` and `session.prompt`
- Avoids duplicate Phase B automation for `orchestrator` sessions when `agent.orchestrator.plan_post_approval_handoff_agent` is set to `orchestrator`
- Falls back to `plan_post_approval_handoff_agent` from `opencode.jsonc`, under `agent.orchestrator` or root configuration
- Retries `session.prompt` with backoff

## Skills

- **agent-delegation** - Decision table for routing work to the appropriate subagent
- **task-management** - CLI for tracking feature subtasks with dependencies
- **pythonic-quality** - Pythonic idioms, SOLID design, and Liskov-safe patterns
- **security-investigation** - Security audit orchestration
- **skill-creator** - Guide for creating effective skills

## Installation

1. Install [OpenCode](https://opencode.ai)

2. Clone this repository to your OpenCode config directory:

   ```bash
   git clone <repo-url> ~/.config/opencode
   ```

3. Install dependencies:

   ```bash
   cd ~/.config/opencode
   npm install
   ```

## Usage

Start OpenCode and describe your task.

The `orchestrator` agent is configured as the default entry point. For simple tasks, the system can proceed directly. For larger or riskier tasks, it routes work through planning, approval, implementation, and review phases.

The intended flow is:

```text
user request
   ↓
orchestrator
   ↓
plan-runner / plan
   ↓
user approval
   ↓
code-executor / build
   ↓
review subagents
```

## Configuration

Key settings in `opencode.jsonc`:

- **`default_agent: "orchestrator"`** - Sets the orchestrator as the default entry point
- **`permission`** - Provides a minimal deny-by-default workspace baseline; each agent declares its tool policy in `agents/<id>.md` frontmatter
- **`agent.*.model`** - Configures model selection for primary agents and selected subagents
- **`reasoningEffort`**, **`textVerbosity`**, and **`temperature`** - Tune agent behavior where needed
- **`agent.orchestrator.plan_post_approval_handoff_agent`** - Controls post-approval routing for the plan handoff plugin
