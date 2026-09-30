// The Vibe readiness pane classifier — table-driven markers by design (#20
// ruling 5): auth markers are pinned from verified production evidence;
// ready/trust groups are PROVISIONAL until the prototype run pins exact TUI
// strings. These tests pin the control flow, so a prototype only ever
// updates the marker tables.

import { readFileSync } from "node:fs";
import nodePath from "node:path";
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

// Live-verified shape (mistral-vibe 2.25.8 launched by the daemon): the pane
// foreground is the /bin/sh launch wrapper, so a LIVE seat reads "sh".
describe("vibe checkReady — daemon launch wrapper (live finding)", () => {
  const SESSION = "3961f82a-6eb7-448b-13bc-17e011aad77e";
  const LOCK_PATH = `${STORE_ROOT}/active/${SESSION}.lock.json`;
  const ROWS = [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 200 },
    { pid: 200, ppid: 100, pgid: 200, tpgid: 200 },
    { pid: 201, ppid: 200, pgid: 200, tpgid: 200 },
  ];
  function wrapped(opts: { lockPid?: number | null; pane?: string }) {
    const files: Record<string, string> = opts.lockPid === null ? {} : {
      [LOCK_PATH]: `{"acquired_at":"2026-09-30T14:56:20.976Z","lease_version":1,"process_id":${opts.lockPid ?? 201},"session_id":"${SESSION}"}\n`,
    };
    const tmux = {
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "sh"),
      getPanePid: vi.fn(async () => 100),
      capturePaneContent: vi.fn(async () => opts.pane ?? ""),
    } as unknown as TmuxAdapter;
    return new VibeRuntimeAdapter({
      tmux, sessionStoreRoot: STORE_ROOT, sleep: async () => {}, listProcesses: () => ROWS,
      fsOps: {
        readFile: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
        writeFile: () => {}, mkdirp: () => {},
        exists: (p: string) => p in files,
        readdir: (dir: string) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
      },
    });
  }

  it("a live vibe behind the sh wrapper (its lock held from the pane) is NOT runtime_exited", async () => {
    const r = await wrapped({ pane: fixture("ready.txt") }).checkReady({ ...SEAT });
    expect(r.ready).toBe(true);
  });

  it("an sh label with no pane-held lock is still runtime_exited", async () => {
    const r = await wrapped({ lockPid: null, pane: fixture("ready.txt") }).checkReady({ ...SEAT });
    expect(r.code).toBe("runtime_exited");
  });

  it("an sh label with a lock held OUTSIDE the pane is still runtime_exited", async () => {
    const r = await wrapped({ lockPid: 999, pane: fixture("ready.txt") }).checkReady({ ...SEAT });
    expect(r.code).toBe("runtime_exited");
  });
});

// Real pane captures (test/fixtures/vibe, mistral-vibe 2.25.8) through the
// marker tables: the regression net for the TUI's actual strings.
function fixture(name: string): string {
  return readFileSync(nodePath.join(import.meta.dirname, "fixtures", "vibe", name), "utf-8");
}

describe("vibe checkReady — real 2.25.8 pane fixtures", () => {
  it.each([
    ["ready.txt", true, undefined],
    ["resume-success.txt", true, undefined],
    ["auth-required.txt", false, "auth_failure"],
    ["auth-invalid-key.txt", false, "auth_failure"],
    ["trust-gate.txt", false, "trust_gate"],
  ])("%s -> ready=%s code=%s", async (name, ready, code) => {
    const lines = fixture(name).split("\n");
    const r = await adapterWith(mockTmux({ pane: lines.slice(-40).join("\n") })).checkReady({ ...SEAT });
    expect(r.ready).toBe(ready);
    if (code) expect(r.code).toBe(code);
  });
});
