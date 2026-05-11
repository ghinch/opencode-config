/**
 * Tests for task-output-trim config loading logic.
 *
 * Run: bun run plugins/task-output-trim.test.ts
 *
 * This file is self-contained — it re-implements the config loading logic
 * locally rather than importing from the plugin, so the plugin can keep
 * a clean default-only export surface for OpenCode's plugin loader.
 */

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Re-implementation of config loading logic (mirrors task-output-trim.ts)
// Update here if the plugin's loadTrimConfig logic changes.
// ---------------------------------------------------------------------------

interface TrimConfig {
  model: { providerID: string; modelID: string };
  summarize: string[] | null;
}

const DEFAULT_MODEL: TrimConfig["model"] = { providerID: "opencode-go", modelID: "deepseek-v4-pro" };
const DEFAULT_SUMMARIZE_AGENTS = ["code-explorer", "test-verifier", "api-docs-researcher"];

let cachedTrimConfig: TrimConfig | null = null;

function clearTrimConfigCache(): void {
  cachedTrimConfig = null;
}

async function loadTrimConfig(client: any, directory: string): Promise<TrimConfig> {
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
      model = { providerID: modelSpec.slice(0, idx), modelID: modelSpec.slice(idx + 1) };
    } else {
      client.app.log({
        query: { directory },
        body: { service: "task-output-trim", level: "warn", message: `Invalid model spec "${modelSpec}" — missing "/". Using default.` },
      }).catch(() => {});
    }
  }

  // Parse allowlist
  let summarize: string[] | null = null;
  if (summarizeList === undefined) {
    summarize = DEFAULT_SUMMARIZE_AGENTS;
  } else if (Array.isArray(summarizeList) && summarizeList.length > 0) {
    summarize = summarizeList.filter((s): s is string => typeof s === "string");
  }

  cachedTrimConfig = { model, summarize };
  return cachedTrimConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockClient(configData: unknown): any {
  return {
    config: {
      get: async (_params: any) => {
        if (configData === undefined) {
          return { error: new Error("not found"), data: null };
        }
        return { error: null, data: configData };
      },
    },
    app: { log: async (_params: any) => {} },
  };
}

// ===========================================================================
// Caching
// ===========================================================================
{
  clearTrimConfigCache();
  let callCount = 0;
  const client: any = {
    config: {
      get: async (_params: any) => {
        callCount++;
        return { error: null, data: { agent: { "task-output-trim": { model: "a/b" } } } };
      },
    },
    app: { log: async (_params: any) => {} },
  };

  const r1 = await loadTrimConfig(client, "/tmp/test-cache");
  const r2 = await loadTrimConfig(client, "/tmp/test-cache");
  assert.equal(callCount, 1, "config.get should only be called once");
  assert.deepEqual(r1, r2);
  console.log("PASS: caching works");
}

// ===========================================================================
// Default config when config.get returns error
// ===========================================================================
{
  clearTrimConfigCache();
  const result = await loadTrimConfig(mockClient(undefined), "/tmp/test");
  assert.deepEqual(result, { model: DEFAULT_MODEL, summarize: null });
  console.log("PASS: default config on error");
}

// ===========================================================================
// Default config when config.get returns null data
// ===========================================================================
{
  clearTrimConfigCache();
  const result = await loadTrimConfig(mockClient(null), "/tmp/test");
  assert.deepEqual(result, { model: DEFAULT_MODEL, summarize: null });
  console.log("PASS: default config on null data");
}

// ===========================================================================
// Model spec parsing (valid "providerID/modelID")
// ===========================================================================
{
  clearTrimConfigCache();
  const result = await loadTrimConfig(
    mockClient({ agent: { "task-output-trim": { model: "custom-provider/custom-model" } } }),
    "/tmp/test",
  );
  assert.deepEqual(result.model, { providerID: "custom-provider", modelID: "custom-model" });
  console.log("PASS: model spec parsing");
}

// ===========================================================================
// Model spec with no slash falls back to default
// ===========================================================================
{
  clearTrimConfigCache();
  const result = await loadTrimConfig(
    mockClient({ agent: { "task-output-trim": { model: "no-slash-here" } } }),
    "/tmp/test",
  );
  assert.deepEqual(result.model, DEFAULT_MODEL);
  console.log("PASS: model spec missing slash uses default");
}

// ===========================================================================
// Summarize allowlist parsing
// ===========================================================================
{
  clearTrimConfigCache();
  const result = await loadTrimConfig(
    mockClient({ agent: { "task-output-trim": { summarize: ["code-explorer", "test-verifier"] } } }),
    "/tmp/test",
  );
  assert.deepEqual(result.summarize, ["code-explorer", "test-verifier"]);
  console.log("PASS: summarize allowlist parsing");
}

// ===========================================================================
// Empty summarize array → null (no filtering)
// ===========================================================================
{
  clearTrimConfigCache();
  const result = await loadTrimConfig(
    mockClient({ agent: { "task-output-trim": { summarize: [] } } }),
    "/tmp/test",
  );
  assert.strictEqual(result.summarize, null);
  console.log("PASS: empty summarize array becomes null");
}

// ===========================================================================
// Both model and summarize
// ===========================================================================
{
  clearTrimConfigCache();
  const result = await loadTrimConfig(
    mockClient({ agent: { "task-output-trim": { model: "my-provider/my-model", summarize: ["agent-a", "agent-b"] } } }),
    "/tmp/test",
  );
  assert.deepEqual(result.model, { providerID: "my-provider", modelID: "my-model" });
  assert.deepEqual(result.summarize, ["agent-a", "agent-b"]);
  console.log("PASS: model + summarize together");
}

// ===========================================================================
// Default summarize agents when config has no "summarize" key
// ===========================================================================
{
  clearTrimConfigCache();
  const result = await loadTrimConfig(
    mockClient({ agent: { "task-output-trim": { model: "a/b" } } }),
    "/tmp/test",
  );
  assert.deepEqual(result.summarize, DEFAULT_SUMMARIZE_AGENTS);
  console.log("PASS: default summarize agents on missing key");
}

// ===========================================================================
// Default summarize agents when task-output-trim section is missing
// ===========================================================================
{
  clearTrimConfigCache();
  const result = await loadTrimConfig(mockClient({ agent: {} }), "/tmp/test");
  assert.deepEqual(result.summarize, DEFAULT_SUMMARIZE_AGENTS);
  console.log("PASS: default summarize agents on missing section");
}

console.log("\nAll tests passed ✅");
