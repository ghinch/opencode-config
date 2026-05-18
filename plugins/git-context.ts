import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// ─── Types ────────────────────────────────────────────────────────────

interface GitContextOptions {
  include_pr?: boolean
  commit_count?: number
}

interface RecentCommit {
  sha: string
  message: string
  relative_date: string
}

interface PrInfo {
  number: number
  title: string
  state: string
}

interface GitContext {
  is_repo: boolean
  branch: string | null
  remote_branch: string | null
  repo_name: string | null
  remote_url: string | null
  commit_sha: string | null
  staged_count: number | null
  modified_count: number | null
  untracked_count: number | null
  recent_commits: RecentCommit[] | null
  pr_info: PrInfo | null
}

// ─── Non-repo sentinel ─────────────────────────────────────────────────

const NOT_A_REPO: GitContext = {
  is_repo: false,
  branch: null,
  remote_branch: null,
  repo_name: null,
  remote_url: null,
  commit_sha: null,
  staged_count: null,
  modified_count: null,
  untracked_count: null,
  recent_commits: null,
  pr_info: null,
}

// ─── Git helpers (each takes directory, uses Bun.spawnSync with cwd) ──

function isGitRepo(directory: string): boolean {
  const result = Bun.spawnSync(["git", "rev-parse", "--git-dir"], { cwd: directory })
  return result.exitCode === 0
}

function getBranch(directory: string): string | null {
  const result = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: directory })
  if (result.exitCode === 0) {
    const branch = result.stdout?.toString().trim()
    if (branch) return branch
    // Detached HEAD: use short SHA
    const shaResult = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: directory })
    if (shaResult.exitCode === 0) {
      const sha = shaResult.stdout?.toString().trim()
      if (sha) return `(detached at ${sha})`
    }
  }
  return null
}

function getRemoteBranch(directory: string): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: directory })
  if (result.exitCode === 0) {
    const r = result.stdout?.toString().trim()
    return r || null
  }
  return null
}

function getRemoteUrl(directory: string): string | null {
  const result = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: directory })
  if (result.exitCode === 0) {
    const r = result.stdout?.toString().trim()
    return r || null
  }
  return null
}

function getRepoName(directory: string, remoteUrl: string | null): string | null {
  if (remoteUrl) {
    const stripped = remoteUrl.replace(/\.git$/, "")
    // SSH: git@github.com:org/repo → org/repo
    const sshMatch = stripped.match(/^git@[^:]+:(.+)$/)
    if (sshMatch) return sshMatch[1]
    // HTTPS: https://github.com/org/repo → org/repo
    try {
      const url = new URL(stripped)
      const path = url.pathname.replace(/^\//, "")
      if (path) return path
    } catch {
      // Not a parseable URL — try raw string as-is
    }
  }
  // Fallback: basename of directory
  const parts = directory.split("/").filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : null
}

function getCommitSha(directory: string): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: directory })
  if (result.exitCode === 0) {
    const sha = result.stdout?.toString().trim()
    if (sha) return sha.substring(0, 7)
  }
  return null
}

function getStatus(directory: string): {
  staged_count: number
  modified_count: number
  untracked_count: number
} | null {
  const result = Bun.spawnSync(["git", "status", "--short"], { cwd: directory })
  if (result.exitCode !== 0) return null
  const output = result.stdout?.toString().trim()
  if (!output) return { staged_count: 0, modified_count: 0, untracked_count: 0 }

  let staged = 0
  let modified = 0
  let untracked = 0

  for (const line of output.split("\n")) {
    if (line.startsWith("??")) {
      untracked++
      continue
    }
    // XY format: column 1 = index (staging), column 2 = working tree
    const first = line[0]
    const second = line[1]
    if (first && first !== " ") staged++
    if (second && second !== " " && first === " ") modified++
    if (first && first !== " " && second && second !== " ") modified++
  }

  return { staged_count: staged, modified_count: modified, untracked_count: untracked }
}

function getRecentCommits(directory: string, count: number): RecentCommit[] | null {
  const result = Bun.spawnSync(["git", "log", `-${count}`, "--format=%h||%s||%ar"], { cwd: directory })
  if (result.exitCode !== 0) return null
  const output = result.stdout?.toString().trim()
  if (!output) return null

  return output.split("\n").map((line: string) => {
    const parts = line.split("||")
    return {
      sha: parts[0] ?? "",
      message: parts[1] ?? "",
      relative_date: parts[2] ?? "",
    }
  })
}

function getPrInfo(directory: string): PrInfo | null {
  const result = Bun.spawnSync(
    ["gh", "pr", "view", "--json", "number,title,state"],
    { cwd: directory },
  )
  if (result.exitCode !== 0) return null
  try {
    return JSON.parse(result.stdout?.toString().trim() ?? "")
  } catch {
    return null
  }
}

// ─── gatherGitContext ──────────────────────────────────────────────────

function gatherGitContext(directory: string, options: GitContextOptions): GitContext {
  try {
    if (!isGitRepo(directory)) return NOT_A_REPO

    const remoteUrl = getRemoteUrl(directory)
    const repoName = getRepoName(directory, remoteUrl)
    const status = getStatus(directory)
    const recentCommits = getRecentCommits(directory, options.commit_count ?? 5)

    let prInfo: PrInfo | null = null
    if (options.include_pr !== false) {
      prInfo = getPrInfo(directory)
    }

    return {
      is_repo: true,
      branch: getBranch(directory),
      remote_branch: getRemoteBranch(directory),
      repo_name: repoName,
      remote_url: remoteUrl,
      commit_sha: getCommitSha(directory),
      staged_count: status?.staged_count ?? null,
      modified_count: status?.modified_count ?? null,
      untracked_count: status?.untracked_count ?? null,
      recent_commits: recentCommits,
      pr_info: prInfo,
    }
  } catch {
    return NOT_A_REPO
  }
}

// ─── formatGitContext ──────────────────────────────────────────────────

function formatGitContext(ctx: GitContext): string {
  if (!ctx.is_repo) return ""

  const lines: string[] = []

  // Branch (with optional upstream tracking)
  if (ctx.branch) {
    const branchLine = ctx.remote_branch
      ? `- **Branch:** \`${ctx.branch}\` (tracking \`${ctx.remote_branch}\`)`
      : `- **Branch:** \`${ctx.branch}\``
    lines.push(branchLine)
  }

  // Repository name
  if (ctx.repo_name) {
    lines.push(`- **Repository:** ${ctx.repo_name}`)
  }

  // Remote URL
  if (ctx.remote_url) {
    lines.push(`- **Remote:** ${ctx.remote_url}`)
  }

  // Commit SHA
  if (ctx.commit_sha) {
    lines.push(`- **Commit:** \`${ctx.commit_sha}\``)
  }

  // Working tree status — show only non-zero counts, or "clean"
  const hasStatus =
    ctx.staged_count !== null ||
    ctx.modified_count !== null ||
    ctx.untracked_count !== null

  if (hasStatus) {
    const parts: string[] = []
    if (ctx.staged_count && ctx.staged_count > 0) parts.push(`${ctx.staged_count} staged`)
    if (ctx.modified_count && ctx.modified_count > 0) parts.push(`${ctx.modified_count} modified`)
    if (ctx.untracked_count && ctx.untracked_count > 0) parts.push(`${ctx.untracked_count} untracked`)
    if (parts.length > 0) {
      lines.push(`- **Status:** ${parts.join(", ")}`)
    } else {
      lines.push(`- **Status:** clean`)
    }
  }

  // Recent commits
  if (ctx.recent_commits && ctx.recent_commits.length > 0) {
    lines.push("")
    lines.push("**Recent commits:**")
    for (const commit of ctx.recent_commits) {
      const msg =
        commit.message.length > 72
          ? commit.message.slice(0, 72) + "…"
          : commit.message
      lines.push(`  \`${commit.sha}\` ${msg}`)
    }
  }

  // Pull request info
  if (ctx.pr_info) {
    lines.push("")
    lines.push(
      `**Pull Request:** #${ctx.pr_info.number} — "${ctx.pr_info.title}" (${ctx.pr_info.state})`,
    )
  }

  if (lines.length === 0) return ""

  return "## Git Context\n" + lines.join("\n") + "\n"
}

// ─── Plugin factory ────────────────────────────────────────────────────

const GitContextPlugin: Plugin = async ({ directory }, options) => {
  const raw = (options ?? {}) as Record<string, unknown>
  const opts: GitContextOptions = {
    include_pr:
      typeof raw.include_pr === "boolean" ? raw.include_pr : true,
    commit_count: Math.min(
      typeof raw.commit_count === "number" ? raw.commit_count : 5,
      20,
    ),
  }

  return {
    // Register a callable tool so the LLM can query git context live
    tool: {
      current_git_context: tool({
        description:
          "Returns the current git working environment context: branch, repo, status, recent commits, and PR info. Uses the plugin's configured options.",
        args: {},
        execute: async (_args, ctx) => {
          const gitCtx = gatherGitContext(ctx.directory, opts)
          return formatGitContext(gitCtx)
        },
      }),
    },

    // Inject git context into system prompt at session start
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const ctx = gatherGitContext(directory, opts)
        const block = formatGitContext(ctx)
        if (!block) return
        if (output.system.length > 0) {
          output.system[output.system.length - 1] += "\n\n" + block
        } else {
          output.system.push(block)
        }
      } catch {
        // silent
      }
    },

    // Refresh git context on compaction
    "experimental.session.compacting": async (_input, output) => {
      try {
        const ctx = gatherGitContext(directory, opts)
        const block = formatGitContext(ctx)
        if (!block) return
        output.context.push(block)
      } catch {
        // silent
      }
    },
  }
}

export default GitContextPlugin
