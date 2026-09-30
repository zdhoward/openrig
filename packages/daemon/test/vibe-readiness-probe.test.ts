// The Vibe readiness pane classifier — table-driven markers by design (#20
// ruling 5): auth markers are pinned from verified production evidence;
// ready/trust groups are PROVISIONAL until the prototype run pins exact TUI
// strings. These tests pin the control flow, so a prototype only ever
// updates the marker tables.

import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { VibeRuntimeAdapter, type VibeAdapterFsOps } from "../src/adapters/vibe-runtime-adapter.js";

const STORE_ROOT = "/home/user/.vibe/logs/session";
const SEAT = { cwd: "/workspace/rig", tmuxSession: "devvibe-a@some-rig" };

function mockTmux(opts: {
  alive?: boolean;
  paneCommand?: string | null;
  pane?: string | null;
}) {
  return {
    hasSession: vi.fn(async () => opts.alive ?? true),
    getPaneCommand: vi.fn(async () => opts.paneCommand ?? "python"),
    capturePaneContent: vi.fn(async () => opts.pane ?? ""),
  } as unknown as TmuxAdapter;
}

function adapterWith(tmux: TmuxAdapter) {
  const fs = {
    readFile: () => { throw new Error("ENOENT"); },
    writeFile: () => {},
    exists: () => false,
    mkdirp: () => {},
  } as VibeAdapterFsOps;
  return new VibeRuntimeAdapter({
    tmux, fsOps: fs, sessionStoreRoot: STORE_ROOT, sleep: async () => {},
  });
}

describe("vibe checkReady — the pane classifier", () => {
  it("refuses readiness without a bound tmux session", async () => {
    const r = await adapterWith(mockTmux({})).checkReady({ cwd: "/x" });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("No tmux session bound");
  });

  it("reports the dead-tmux case", async () => {
    const r = await adapterWith(mockTmux({ alive: false })).checkReady({ ...SEAT });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("not responsive");
  });

  it("treats a pane back at the shell as runtime_exited (guard fold)", async () => {
    const r = await adapterWith(mockTmux({ paneCommand: "bash", pane: "Mistral Vibe ready" })).checkReady({ ...SEAT });
    expect(r.ready).toBe(false);
    expect(r.code).toBe("runtime_exited");
  });

  it("classifies auth failure markers from the pane", async () => {
    for (const marker of ["Not logged in", "Authentication required", "Invalid API key", "Unauthorized"]) {
      const r = await adapterWith(mockTmux({ pane: `Error: ${marker}` })).checkReady({ ...SEAT });
      expect(r.ready).toBe(false);
      expect(r.code).toBe("auth_failure");
    }
  });

  it("classifies a trust-gate prompt as trust_gate — inconclusive, NEVER ready", async () => {
    const r = await adapterWith(mockTmux({
      pane: "Do you want to trust this workspace folder? [y/N]",
    })).checkReady({ ...SEAT });
    expect(r.ready).toBe(false);
    expect(r.code).toBe("trust_gate");
  });

  it("reports ready on a provisional ready marker", async () => {
    const r = await adapterWith(mockTmux({ pane: "Mistral Vibe 2.25.8 — type a prompt" })).checkReady({ ...SEAT });
    expect(r.ready).toBe(true);
  });

  it("reports awaiting_runtime for an empty pane (TUI booting)", async () => {
    const r = await adapterWith(mockTmux({ pane: "" })).checkReady({ ...SEAT });
    expect(r.ready).toBe(false);
    expect(r.code).toBe("awaiting_runtime");
  });
});
