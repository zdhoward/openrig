// Hermetic tests for the Vibe resume adapter — registry-evidence verification
// only (mirrors the pi-resume suite). No live vibe.

import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { VibeResumeAdapter } from "../src/adapters/vibe-resume.js";
import type { VibeSessionStoreFs } from "../src/adapters/vibe-session-store.js";

const STORE_ROOT = "/home/user/.vibe/logs/session";
const ACTIVE = `${STORE_ROOT}/active`;
const SEAT = "devvibe-a@some-rig";
const CWD = "/workspace/rig";
const UUID_A = "4dd32436-7512-db4b-11ef-7c14fdf5a534";
const T0 = "2026-09-30T10:00:00Z";
const T1 = "2026-09-30T10:00:05Z";

function lock(sessionId: string, acquiredAt: string): string {
  return JSON.stringify({ acquired_at: acquiredAt, lease_version: 1, process_id: 1, session_id: sessionId });
}

function mockTmux(sent: string[] = [], ok = true) {
  return {
    sendShellCommand: vi.fn(async (_t: string, command: string): Promise<TmuxResult> => {
      sent.push(command);
      return ok ? { ok: true as const } : { ok: false as const, message: "tmux down" };
    }),
  } as unknown as TmuxAdapter;
}

function storeFs(files: Record<string, string>): VibeSessionStoreFs {
  return {
    readFile: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    exists: (p: string) => p in files,
    readdir: (dir: string) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
  };
}

function adapterWith(fs: VibeSessionStoreFs, tmux: TmuxAdapter) {
  return new VibeResumeAdapter(tmux, fs, { sessionStoreRoot: STORE_ROOT }, {
    sleep: async () => {}, now: () => T1,
  });
}

describe("VibeResumeAdapter — canResume", () => {
  it("accepts exactly resumeType vibe_session_id with a token", () => {
    const adapter = adapterWith(storeFs({}), mockTmux());
    expect(adapter.canResume("vibe_session_id", UUID_A)).toBe(true);
    expect(adapter.canResume("vibe_session_id", null)).toBe(false);
    expect(adapter.canResume("codex_id", UUID_A)).toBe(false);
    expect(adapter.canResume(null, UUID_A)).toBe(false);
  });
});

describe("VibeResumeAdapter — resume", () => {
  it("types the EXPLICIT --resume form and returns ok on registry evidence", async () => {
    const sent: string[] = [];
    const fs = storeFs({ [`${ACTIVE}/${UUID_A}.lock.json`]: lock(UUID_A, T1) });
    const result = await adapterWith(fs, mockTmux(sent)).resume(SEAT, "vibe_session_id", UUID_A, CWD);
    expect(sent).toEqual([`vibe --agent 'accept-edits' --trust --resume '${UUID_A}'`]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appliedLaunch).toEqual({
        runtime: "vibe", axis: "agent_profile", state: "observed", value: "accept-edits",
      });
    }
  });

  it("FAILS (never fakes) when the persisted session never becomes active", async () => {
    const sent: string[] = [];
    const fs = storeFs({});
    const result = await adapterWith(fs, mockTmux(sent)).resume(SEAT, "vibe_session_id", UUID_A, CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("resume_failed");
      expect(result.message).toContain("timed out");
    }
  });

  it("a STALE pre-resume lock is not resume evidence (guard fold)", async () => {
    const sent: string[] = [];
    const fs = storeFs({ [`${ACTIVE}/${UUID_A}.lock.json`]: lock(UUID_A, T0) });
    const result = await adapterWith(fs, mockTmux(sent)).resume(SEAT, "vibe_session_id", UUID_A, CWD);
    expect(result.ok).toBe(false);
  });

  it("surfaces a tmux send failure as resume_failed", async () => {
    const sent: string[] = [];
    const fs = storeFs({});
    const result = await adapterWith(fs, mockTmux(sent, false)).resume(SEAT, "vibe_session_id", UUID_A, CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("tmux down");
  });

  it("refuses the wrong resume type outright (no command typed)", async () => {
    const sent: string[] = [];
    const fs = storeFs({});
    const result = await adapterWith(fs, mockTmux(sent)).resume(SEAT, "codex_id", UUID_A, CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no_resume");
    expect(sent).toEqual([]);
  });
});
