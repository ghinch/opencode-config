import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const THRESHOLD       = 6_000;   // chars; output above this triggers summarization
const TAIL_FALLBACK   = 3_000;   // chars kept in tail-truncation fallback
const POLL_MS         = 500;
const TIMEOUT_MS      = 20_000;
const SUMMARIZE_AGENT = "task-output-summarizer";

const inFlight = new Set<string>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Last chronological `agent` field on user messages — typically the routing primary for that turn. */
async function lastUserRoutingAgent(
  client: PluginInput["client"],
  sessionID: string,
  directory: string,
): Promise<string | null> {
  const msgs = await client.session.messages({
    path: { id: sessionID },
    query: { directory, limit: 400 },
  });
  if (msgs.error || !msgs.data?.length) return null;
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
  return last;
}

function tailFallback(original: string, subagent: string, reason: string): string {
  const kept = original.slice(original.length - TAIL_FALLBACK);
  return (
    `[task-output-trim | ${subagent} | summarization ${reason} | ` +
    `showing last ${kept.length} of ${original.length} chars]\n\n…\n\n${kept}`
  );
}

async function summarizeViaSession(
  client: PluginInput["client"],
  directory: string,
  text: string,
): Promise<string | null> {
  let tempID: string | null = null;
  try {
    const created = await client.session.create({ body: {}, query: { directory } });
    if (created.error || !created.data?.id) return null;
    tempID = created.data.id;

    await client.app.log({
      query: { directory },
      body: {
        service: "task-output-trim",
        level: "info",
        message: `Summarizing ${text.length} chars via temp session ${tempID}`,
      },
    });

    const promptResult = await client.session.prompt({
      path: { id: tempID },
      query: { directory },
      body: {
        agent: SUMMARIZE_AGENT,
        parts: [
          {
            type: "text",
            text:
              "The following is the full output from a subagent task. Summarize it concisely.\n\n" +
              "--- OUTPUT ---\n" +
              text,
          },
        ],
      },
    });
    if (promptResult.error) {
      await client.app.log({
        query: { directory },
        body: {
          service: "task-output-trim",
          level: "warn",
          message: `Summarization prompt failed: ${JSON.stringify(promptResult.error)}`,
        },
      });
      return null;
    }

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const msgs = await client.session.messages({
        path: { id: tempID },
        query: { directory, limit: 20 },
      });
      if (msgs.error) return null;
      if (!msgs.data?.length) continue;
      for (let i = msgs.data.length - 1; i >= 0; i--) {
        const msg = msgs.data[i]!;
        const info = msg.info;
        if ("role" in info && info.role === "assistant") {
          const parts = (msg as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
          const text = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n")
            .trim();
          if (text) return text;
        }
      }
    }
    return null; // timed out
  } finally {
    if (tempID) {
      try {
        await client.session.delete({ path: { id: tempID }, query: { directory } });
      } catch {
        /* best effort */
      }
    }
  }
}

const TaskOutputTrimPlugin: Plugin = async ({ client, directory }) => {
  return {
    "tool.execute.after": async (input, output) => {
      // Only intercept Task tool returns
      if (input.tool !== "task") return;

      // Only handle string output
      if (typeof output.output !== "string") return;

      // Skip if below threshold
      if (output.output.length <= THRESHOLD) return;

      // Prevent re-entrant processing of the same call
      if (inFlight.has(input.callID)) return;
      inFlight.add(input.callID);

      try {
        // Only trim in orchestrator sessions
        const routingAgent = await lastUserRoutingAgent(client, input.sessionID, directory);
        if (routingAgent !== "orchestrator") return;

        const subagent: string = (input.args as any)?.subagent_type ?? "unknown-agent";
        const original = output.output;

        try {
          const summary = await summarizeViaSession(client, directory, original);
          if (summary) {
            output.output =
              `[task-output-trim | ${subagent} | summarized ${original.length} → ${summary.length} chars]\n\n` +
              summary;
          } else {
            output.output = tailFallback(original, subagent, "timed out");
          }
        } catch (e) {
          output.output = tailFallback(original, subagent, `failed: ${e}`);
        }
      } finally {
        inFlight.delete(input.callID);
      }
    },
  };
};

export default TaskOutputTrimPlugin;
