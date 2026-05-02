# OpenCode Configuration

This repository contains a curated OpenCode configuration with a multi-agent orchestration system for AI-assisted software development.

## Overview

This configuration provides:

- **Multi-agent orchestration** — Coordinated workflow between planning, implementation, and review agents
- **Specialized subagents** — Domain-specific agents for security, documentation, testing, and code review
- **Custom plugins** — TypeScript plugins for plan approval automation
- **Development skills** — Reusable skill definitions for common development tasks

## Structure

```
.
├── AGENTS.md                 # Global agent rules and delegation guidelines
├── opencode.jsonc            # Main OpenCode configuration
├── agents/                   # Agent definitions
│   ├── build.md             # Primary implementation agent
│   ├── orchestrator.md      # Workflow coordinator
│   ├── plan.md              # Planning agent
│   ├── plan-runner.md       # Plan drafting subagent
│   ├── code-executor.md     # Implementation subagent
│   └── [reviewers].md       # Various review subagents
├── skills/                   # Reusable skill definitions
│   ├── agent-delegation/    # Delegation guidelines
│   ├── task-management/     # Task tracking CLI
│   ├── pythonic-quality/    # Python best practices
│   └── security-investigation/ # Security audit workflows
├── plugins/                  # TypeScript plugins
│   └── plan-post-approval.ts # Automated plan handoff
└── tsconfig.json            # TypeScript configuration
```

## Agents

### Primary Agents

- **orchestrator** — Coordinates multi-phase work via plan files, approval gates, and implementation slices
- **build** — Direct implementation agent for coding work
- **plan** — Produces concrete, evidence-based plans before non-trivial implementation

### Subagents

- **plan-runner** — Drafts implementation plans under `.opencode/plans/`
- **code-executor** — Implements scoped coding tasks with minimal diffs
- **test-verifier** — Validates changes via tests, lint, and typecheck
- **code-reviewer** — Reviews diffs for correctness and maintainability
- **docs-reviewer** — Checks documentation impact of changes
- **security-reviewer** — Identifies security risks in code
- **spec-critic** — Challenges plans before coding starts
- **api-docs-researcher** — Researches external API documentation
- **host-security-investigator** — Assesses hosting and infrastructure security

## Plugins

### Plan Post-Approval

`plugins/plan-post-approval.ts` automates the handoff after a plan is approved:

- Extracts plan file paths from approval questions
- Triggers context compaction via summarize API
- Delegates to the configured handoff agent (default: `build`)
- Implements retry logic with exponential backoff for resilience

## Skills

- **agent-delegation** — Decision table for routing work to appropriate subagents
- **task-management** — CLI for tracking feature subtasks with dependencies
- **pythonic-quality** — Pythonic idioms, SOLID design, and Liskov-safe patterns
- **security-investigation** — Comprehensive security audit orchestration
- **skill-creator** — Guide for creating effective skills

## Installation

1. Install [OpenCode](https://opencode.ai)
2. Clone this repository to your OpenCode config directory:
   ```bash
   git clone <repo-url> ~/.config/opencode
   ```
3. Install dependencies:
   ```bash
   cd ~/.config/opencode && npm install
   ```

## Usage

The orchestrator agent is configured as the default. Start OpenCode and describe your task — the system will automatically route planning to `plan-runner`, gate approvals via `question`, and delegate implementation to `code-executor`.

## Configuration

Key settings in `opencode.jsonc`:

- `default_agent: "orchestrator"` — Sets the orchestrator as the entry point
- `permission.bash` — Fine-grained shell command permissions with safe defaults
- `agent.*.permission` — Subagent-specific tool permissions

## License

See individual skill directories for license information.
