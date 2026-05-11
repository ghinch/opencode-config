import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const THRESHOLD       = 6_000;   // chars; output above this triggers summarization
const TAIL_FALLBACK   = 3_000;   // chars kept in tail-truncation fallback

interface TrimConfig {
  model: { providerID: string; modelID: string };
  summarize: string[] | null;   // null = all agents are summarized
}

const DEFAULT_MODEL: TrimConfig["model"] = { providerID: "opencode-go", modelID: "deepseek-v4-pro" };
const DEFAULT_SUMMARIZE_AGENTS = ["code-explorer", "test-verifier", "api-docs-researcher"];

let cachedTrimConfig: TrimConfig | null = null;

async function loadTrimConfig(
  client: PluginInput["client"],
  directory: string,
): Promise<TrimConfig> {
  if (cachedTrimConfig) return cachedTrimConfig;

  const config = await client.config.get({ query: { directory } });
  if (config.error || !config.data) {
    cachedTrimConfig = { model: DEFAULT_MODEL, summarize: null };
    return cachedTrimConfig;
  }

  const raw = config.data.agent?.["task-output-trim"];
  const modelSpec: string | undefined = raw?.model;
  const summarizeList: unknown = raw?.summarize;

  // Parse model
  let model = DEFAULT_MODEL;
  if (typeof modelSpec === "string") {
    const idx = modelSpec.indexOf("/");
    if (idx !== -1) {
      model = {
        providerID: modelSpec.slice(0, idx),
        modelID: modelSpec.slice(idx + 1),
      };
    } else {
      client.app.log({
        query: { directory },
        body: {
          service: "task-output-trim",
          level: "warn",
          message: `Invalid model spec "${modelSpec}" — missing "/". Using default.`,
        },
      }).catch(() => {});
    }
  }

  // Parse allowlist
  let summarize: string[] | null = null;
  if (summarizeList === undefined) {
    // No key in config → use default agents
    summarize = DEFAULT_SUMMARIZE_AGENTS;
  } else if (Array.isArray(summarizeList) && summarizeList.length > 0) {
    summarize = summarizeList.filter((s): s is string => typeof s === "string");
  }
  // else: summarize remains null (explicit empty array → no filtering = all agents)

  cachedTrimConfig = { model, summarize };
  return cachedTrimConfig;
}

const inFlight = new Set<string>();

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

/** Extract the body text from a markdown file with YAML frontmatter (delimited by ---). */
function extractMdBody(filePath: string): string {
  const raw = readFileSync(filePath, "utf-8");
  const firstDelim = raw.indexOf("---");
  if (firstDelim === -1) return raw.trim();
  const secondDelim = raw.indexOf("---", firstDelim + 3);
  if (secondDelim === -1) return raw.trim();
  return raw.slice(secondDelim + 3).trim();
}

let cachedSystemPrompt: string | null = null;

/** Load the summarizer system prompt from disk, caching the result. */
function loadSystemPrompt(directory: string): string {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  try {
    const filePath = resolve(directory, "agents", "task-output-summarizer.md");
    cachedSystemPrompt = extractMdBody(filePath);
    return cachedSystemPrompt;
  } catch {
    cachedSystemPrompt =
      "You are a subagent-output summarizer for an OpenCode orchestrator. The orchestrator uses your summaries to decide next steps without reading verbose task output.\n\nExtract and return only what the orchestrator needs:\n\n**Status** — succeeded / failed / partial (one line)\n**Key findings** — What was discovered, changed, or verified. Include exact file paths.\n**Errors (verbatim)** — Copy exact error messages, stack traces, and exit codes. Do not paraphrase.\n**Decisions made** — Choices the subagent made that affect downstream work (e.g., library chosen, approach taken, workarounds applied).\n**Next actions** — What the orchestrator should do based on this output.\n\nRules: Omit verbose logs, shell noise, unchanged listings, and redundant reasoning. Target 200–400 words; go shorter when possible. Never invent findings. If the output is short enough to read as-is, say \"[output retained in full]\" instead.";
    return cachedSystemPrompt;
  }
}

async function summarizeViaSession(
  client: PluginInput["client"],
  directory: string,
  text: string,
  config: TrimConfig,
): Promise<string | null> {
  let tempID: string | null = null;
  try {
    const created = await client.session.create({ body: {}, query: { directory } });
    if (created.error || !created.data?.id) {
      await client.app.log({
        query: { directory },
        body: {
          service: "task-output-trim",
          level: "error",
          message: `session.create failed: ${JSON.stringify(created.error ?? "no id returned")}`,
        },
      }).catch(() => {});
      return null;
    }
    tempID = created.data.id;

    await client.app.log({
      query: { directory },
      body: {
        service: "task-output-trim",
        level: "info",
        message: `Summarizing ${text.length} chars via temp session ${tempID}`,
      },
    });

    const prompt = await client.session.prompt({
      path: { id: tempID },
      query: { directory },
      body: {
        model: config.model,
        tools: {},
        system: loadSystemPrompt(directory),
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

    if (prompt.error) {
      await client.app.log({
        query: { directory },
        body: {
          service: "task-output-trim",
          level: "warn",
          message: `session.prompt failed: ${JSON.stringify(prompt.error)}`,
        },
      });
      return null;
    }

    // Extract text from assistant reply in the response
    // session.prompt() may return an array of messages OR a single message object
    const response = prompt.data;
    if (!response) {
      await client.app.log({
        query: { directory },
        body: {
          service: "task-output-trim",
          level: "warn",
          message: "session.prompt returned null/undefined data",
        },
      }).catch(() => {});
      return null;
    }

    // Helper to extract text parts from a message-like object
    const extractText = (msg: any): string | null => {
      const parts = msg?.parts;
      if (!Array.isArray(parts)) return null;
      const text = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text ?? "")
        .join("\n")
        .trim();
      return text || null;
    };

    // Case 1: response is an array of messages
    if (Array.isArray(response)) {
      for (let i = response.length - 1; i >= 0; i--) {
        const msg = response[i]!;
        const info = msg.info;
        if (info && typeof info === "object" && "role" in info && info.role === "assistant") {
          const text = extractText(msg);
          if (text) return text;
        }
      }
    } else if (typeof response === "object" && response !== null) {
      // Case 2: response is a single message object { info, parts }
      const info = (response as any).info;
      if (info && typeof info === "object" && "role" in info && info.role === "assistant") {
        const text = extractText(response);
        if (text) return text;
      }
      // Case 3: response has parts directly (no info wrapper)
      const text = extractText(response);
      if (text) return text;
    }

    await client.app.log({
      query: { directory },
      body: {
        service: "task-output-trim",
        level: "warn",
        message: "No assistant text found in session.prompt response",
        extra: {
          tempID,
          dataType: typeof response,
          isArray: Array.isArray(response),
        },
      },
    }).catch(() => {});
    return null;
  } catch (e) {
    await client.app.log({
      query: { directory },
      body: {
        service: "task-output-trim",
        level: "error",
        message: `summarizeViaSession threw: ${e}`,
      },
    }).catch(() => {});
    return null;
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

        const trimConfig = await loadTrimConfig(client, directory);
        if (trimConfig.summarize !== null && !trimConfig.summarize.includes(subagent)) {
          return; // not in allowlist — leave output unchanged
        }

        const original = output.output;

        try {
          const summary = await summarizeViaSession(client, directory, original, trimConfig);
          if (summary) {
            output.output =
              `[task-output-trim | ${subagent} | summarized ${original.length} → ${summary.length} chars]\n\n` +
              summary;
          } else {
            output.output = tailFallback(original, subagent, "summarization failed (check server logs)");
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
