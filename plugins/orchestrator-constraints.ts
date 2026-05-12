import type { Plugin, PluginInput } from "@opencode-ai/plugin";

// ── Path allowlist for orchestrator read ───────────────────────────

const ALLOWED_READ_PREFIXES = [
  ".opencode/plans/",
  "AGENTS.md",
  ".opencode/",
  ".github/",
];

function isAllowedReadPath(pattern: string | string[] | undefined): boolean {
  if (!pattern) return false;
  const paths = Array.isArray(pattern) ? pattern : [pattern];
  return paths.every((p) =>
    ALLOWED_READ_PREFIXES.some((prefix) => p.startsWith(prefix)),
  );
}

// ── Tools hard-blocked for orchestrator (frontmatter also denies these) ──

const BLOCKED_TOOLS = new Set(["grep", "glob", "bash", "edit", "write"]);

// ── Routing agent detection (cached per session, 30s TTL) ─────────

const sessionAgentCache = new Map<string, { agent: string | null; ts: number }>();
const CACHE_TTL_MS = 30_000;

async function getRoutingAgent(
  client: PluginInput["client"],
  sessionID: string,
  directory: string,
): Promise<string | null> {
  const cached = sessionAgentCache.get(sessionID);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.agent;
  }

  const msgs = await client.session.messages({
    path: { id: sessionID },
    query: { directory, limit: 400 },
  });
  if (msgs.error || !msgs.data?.length) {
    sessionAgentCache.set(sessionID, { agent: null, ts: Date.now() });
    return null;
  }

  let last: string | null = null;
  for (const m of msgs.data) {
    const info = m.info;
    if (
      "role" in info &&
      info.role === "user" &&
      "agent" in info &&
      typeof (info as { agent?: unknown }).agent === "string"
    ) {
      last = (info as { agent: string }).agent;
    }
  }
  sessionAgentCache.set(sessionID, { agent: last, ts: Date.now() });
  return last;
}

// ── Plugin ─────────────────────────────────────────────────────────

const OrchestratorConstraintsPlugin: Plugin = async ({ client, directory }) => {
  return {
    // Primary defense: path-aware permission gating for read
    // Requires orchestrator frontmatter: read: ask
    "permission.ask": async (input, output) => {
      const routingAgent = await getRoutingAgent(
        client,
        input.sessionID,
        directory,
      );
      if (routingAgent !== "orchestrator") return;

      const tool = input.type;

      // Hard-deny grep, glob, bash, edit, write (defense in depth)
      if (BLOCKED_TOOLS.has(tool)) {
        output.status = "deny";
        return;
      }

      // For read: only allow plan files, config, AGENTS.md
      if (tool === "read") {
        if (isAllowedReadPath(input.pattern)) {
          output.status = "allow";
        } else {
          output.status = "deny";
          await client.app
            .log({
              query: { directory },
              body: {
                service: "orchestrator-constraints",
                level: "info",
                message: `Blocked orchestrator read on "${JSON.stringify(input.pattern)}"`,
                extra: { sessionID: input.sessionID, callID: input.callID },
              },
            })
            .catch(() => {});
        }
      }
    },

    // Safety net: block tool calls that somehow bypass permission.ask
    "tool.execute.before": async (input, _output) => {
      const routingAgent = await getRoutingAgent(
        client,
        input.sessionID,
        directory,
      );
      if (routingAgent !== "orchestrator") return;

      if (BLOCKED_TOOLS.has(input.tool)) {
        throw new Error(
          `[orchestrator-constraints] The orchestrator agent cannot use the ${input.tool} tool. ` +
          `Delegate this work to a subagent via Task.`,
        );
      }
      // Note: read is NOT blocked here — permission.ask handles path-aware gating.
    },

    // Clear cache on session lifecycle events
    event: async ({ event: raw }) => {
      const event = raw as { type?: string; properties?: { sessionID?: string } };
      if (
        (event.type === "session.idle" || event.type === "session.deleted") &&
        event.properties?.sessionID
      ) {
        sessionAgentCache.delete(event.properties.sessionID);
      }
    },
  };
};

export default OrchestratorConstraintsPlugin;
