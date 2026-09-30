// Vibe context usage: the daemon reads a vibe seat's latest checkpointed
// context size from vibe's unified session store (shapes live-verified on
// mistral-vibe 2.25.8) and normalizes it like the Codex token-count reader.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";

const SESSION = "e5ae285c-56f9-5146-4343-c8517e7bf31d";
const GENERATION = "0000000000000178";

let root: string;
let db: BetterSqlite3.Database;

function writeSession(opts: {
  storeFormat?: string;
  contextTokens?: unknown;
  threshold?: unknown;
  omitCheckpoint?: boolean;
} = {}) {
  const sessionDir = join(root, "unified", SESSION);
  const generationDir = join(sessionDir, "generations", GENERATION);
  mkdirSync(generationDir, { recursive: true });
  writeFileSync(join(sessionDir, "CURRENT"), JSON.stringify({
    generation: GENERATION,
    manifest_sha256: "672fec967c4d08dca6492905b46db92d91e2c0cabdf8f92fcc11bd572b3adee0",
    session_id: SESSION,
    snapshot_sequence: 178,
    store_format: opts.storeFormat ?? "mistral.vibe.unified-session-store/v1",
    store_format_minor: 7,
  }));
  if (!opts.omitCheckpoint) {
    writeFileSync(join(generationDir, "checkpoint.json"),
      JSON.stringify({ last_reported_context_tokens: "contextTokens" in opts ? opts.contextTokens : 20157 }));
  }
  writeFileSync(join(generationDir, "runtime-state.json"), JSON.stringify({
    core_settings: { context: { compaction: { token_threshold: "threshold" in opts ? opts.threshold : 800000 } } },
  }));
}

function store(withRoot = true) {
  return new ContextUsageStore(db, { stateDir: root, ...(withRoot ? { vibeSessionStoreRoot: root } : {}) });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibe-ctx-"));
  db = new BetterSqlite3(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("ContextUsageStore.readVibeAndNormalize", () => {
  it("normalizes the checkpointed context size against vibe's compaction threshold", () => {
    writeSession();
    const usage = store().readVibeAndNormalize({ sessionId: SESSION, sessionName: "build-implementer@factory-rsi" });
    expect(usage).toMatchObject({
      availability: "known",
      source: "vibe_session_checkpoint",
      usedPercentage: 3, // 20157 / 800000 = 2.5% -> rounds to 3
      remainingPercentage: 97,
      contextWindowSize: 800000,
      sessionId: SESSION,
      sessionName: "build-implementer@factory-rsi",
      fresh: true,
    });
    expect(usage.sampledAt).not.toBeNull();
  });

  it("is unknown/no_data before the session has a checkpoint", () => {
    writeSession({ omitCheckpoint: true });
    expect(store().readVibeAndNormalize({ sessionId: SESSION, sessionName: "s" })).toMatchObject({ availability: "unknown", reason: "no_data" });
  });

  it("is unknown/no_data for a session with no unified store (e.g. legacy harness)", () => {
    expect(store().readVibeAndNormalize({ sessionId: SESSION, sessionName: "s" })).toMatchObject({ availability: "unknown", reason: "no_data" });
  });

  it("is unknown/no_data without a recorded session id or when vibe is not configured", () => {
    writeSession();
    expect(store().readVibeAndNormalize({ sessionId: null, sessionName: "s" }).reason).toBe("no_data");
    expect(store(false).readVibeAndNormalize({ sessionId: SESSION, sessionName: "s" }).reason).toBe("no_data");
  });

  it("reports parse_error when vibe's store format changes (compat boundary)", () => {
    writeSession({ storeFormat: "mistral.vibe.unified-session-store/v2" });
    expect(store().readVibeAndNormalize({ sessionId: SESSION, sessionName: "s" })).toMatchObject({ availability: "unknown", reason: "parse_error" });
  });

  it.each([
    ["missing context tokens", { contextTokens: undefined }],
    ["non-numeric context tokens", { contextTokens: "20157" }],
    ["zero threshold", { threshold: 0 }],
    ["missing threshold", { threshold: undefined }],
  ])("reports parse_error for %s", (_label, opts) => {
    writeSession(opts);
    expect(store().readVibeAndNormalize({ sessionId: SESSION, sessionName: "s" }).reason).toBe("parse_error");
  });
});
