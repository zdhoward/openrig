// Hermetic tests for the Vibe runtime adapter — no live vibe: command
// construction, registry-diff capture, honest refusals, and projection are
// all fake-backed (mirrors the pi adapter suite). The live legs (exact TUI
// ready strings) are the prototype ticket's contract.
//
// Path discipline: all filesystem keys/expectations are built with
// nodePath.join (same as the adapter), so the suite runs on any platform.

import nodePath from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { VibeRuntimeAdapter, type VibeAdapterFsOps } from "../src/adapters/vibe-runtime-adapter.js";

const STORE_ROOT = "/home/user/.vibe/logs/session";
const ACTIVE = `${STORE_ROOT}/active`;
const SEAT = { cwd: "/workspace/rig", tmuxSession: "devvibe-a@some-rig" };
const UUID_A = "4dd32436-7512-db4b-11ef-7c14fdf5a534";
const UUID_B = "44d32021-c5fc-bd24-6547-416f51de6805";
const T0 = "2026-09-30T10:00:00Z";
const T1 = "2026-09-30T10:00:05Z";
const VIBE_FLOOR_EFFECT = {
  runtime: "vibe",
  axis: "agent_profile",
  state: "observed",
  value: "accept-edits",
} as const;

function lock(sessionId: string, acquiredAt: string): string {
  return JSON.stringify({ acquired_at: acquiredAt, lease_version: 1, process_id: 1, session_id: sessionId });
}

function mockTmux(sent: string[] = [], afterSend?: () => void, sendOk = true) {
  return {
    sendShellCommand: vi.fn(async (_t: string, command: string): Promise<TmuxResult> => {
      sent.push(command);
      if (afterSend) afterSend();
      return sendOk ? { ok: true as const } : { ok: false as const, message: "tmux down" };
    }),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    capturePaneContent: vi.fn(async () => ""),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "python"),
  } as unknown as TmuxAdapter;
}

/** In-memory fs: `files` maps path -> content. Path matching is
 * separator-agnostic (normalized to "/"), so nodePath.join-built adapter
 * paths and literal registry keys coexist on any platform. */
function memFs(files: Record<string, string> = {}) {
  const dirs = new Set<string>([ACTIVE]);
  const norm = (p: string) => p.replace(/\\/g, "/");
  const readdir = (dir: string): string[] =>
    Object.keys(files).filter((f) => norm(f).startsWith(`${norm(dir)}/`)).map((f) => norm(f).slice(norm(dir).length + 1));
  return {
    files,
    readFile: (p: string) => {
      const key = Object.keys(files).find((f) => norm(f) === norm(p));
      if (key === undefined) throw new Error(`ENOENT: ${p}`);
      return files[key]!;
    },
    writeFile: (p: string, c: string) => { files[p] = c; },
    exists: (p: string) =>
      norm(p) in files ||
      Object.keys(files).some((f) => norm(f).startsWith(`${norm(p)}/`)) ||
      [...dirs].some((d) => norm(d) === norm(p)),
    mkdirp: (p: string) => { dirs.add(p); },
    listFiles: (dir: string) => readdir(dir),
    readdir,
  } as VibeAdapterFsOps & { files: Record<string, string> };
}

function adapterWith(fs: VibeAdapterFsOps, tmux: TmuxAdapter) {
  return new VibeRuntimeAdapter({
    tmux, fsOps: fs, sessionStoreRoot: STORE_ROOT,
    sleep: async () => {}, now: () => T1,
  });
}

/** Run body with env overrides applied for the WHOLE launch call. */
async function withEnv(env: Record<string, string>, body: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { await body(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

describe("vibe-runtime-adapter — launch command shape", () => {
  it("fresh launch types the TUI command with the agent-profile floor and --trust", async () => {
    const sent: string[] = [];
    const fs = memFs();
    const tmux = mockTmux(sent, () => {
      (fs as unknown as { files: Record<string, string> }).files[`${ACTIVE}/${UUID_A}.lock.json`] = lock(UUID_A, T1);
    });
    const adapter = adapterWith(fs, tmux);
    const result = await adapter.launchHarness({ ...SEAT }, { name: "seat-a" });
    expect(sent).toEqual([`vibe --agent 'accept-edits' --trust`]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resumeToken).toBe(UUID_A);
  });

  it("threads binding.model as the VIBE_ACTIVE_MODEL env prefix", async () => {
    const sent: string[] = [];
    const fs = memFs();
    const tmux = mockTmux(sent, () => {
      (fs as unknown as { files: Record<string, string> }).files[`${ACTIVE}/${UUID_A}.lock.json`] = lock(UUID_A, T1);
    });
    const adapter = adapterWith(fs, tmux);
    const result = await adapter.launchHarness({ ...SEAT, model: "mistral-medium-3.5" }, { name: "seat-a" });
    expect(sent[0]).toContain(`VIBE_ACTIVE_MODEL='mistral-medium-3.5' vibe`);
    expect(result.ok).toBe(true);
  });

  it("YOLO forces the auto-approve agent profile", async () => {
    const sent: string[] = [];
    const fs = memFs();
    const adapter = adapterWith(fs, mockTmux(sent));
    await withEnv({ OPENRIG_YOLO: "1" }, async () => {
      await adapter.launchHarness({ ...SEAT }, { name: "seat-a" });
    });
    expect(sent[0]).toContain(`--agent 'auto-approve'`);
  });

  it("an explicit per-seat vibeAgentProfile wins over floor and YOLO", async () => {
    const sent: string[] = [];
    const fs = memFs();
    const adapter = adapterWith(fs, mockTmux(sent));
    await withEnv({ OPENRIG_YOLO: "1" }, async () => {
      await adapter.launchHarness({ ...SEAT, vibeAgentProfile: "plan" }, { name: "seat-a" });
    });
    expect(sent[0]).toContain(`--agent 'plan'`);
  });

  it("resume types the EXPLICIT --resume <uuid> form (never a picker, never -c)", async () => {
    const sent: string[] = [];
    const fs = memFs();
    // The persisted session's lock re-appears AFTER the command lands.
    const tmux = mockTmux(sent, () => {
      (fs as unknown as { files: Record<string, string> }).files[`${ACTIVE}/${UUID_A}.lock.json`] = lock(UUID_A, T1);
    });
    const adapter = adapterWith(fs, tmux);
    const result = await adapter.launchHarness({ ...SEAT }, { name: "seat-a", resumeToken: UUID_A });
    expect(sent).toEqual([`vibe --agent 'accept-edits' --trust --resume '${UUID_A}'`]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe(UUID_A);
      expect(result.resumeType).toBe("vibe_session_id");
      expect(result.appliedLaunch).toEqual(VIBE_FLOOR_EFFECT);
    }
  });
});

describe("vibe-runtime-adapter — honest refusals (contract)", () => {
  it("refuses resumeToken + forkSource together BEFORE typing anything", async () => {
    const sent: string[] = [];
    const fs = memFs();
    const adapter = adapterWith(fs, mockTmux(sent));
    const result = await adapter.launchHarness({ ...SEAT }, {
      name: "seat-a", resumeToken: UUID_A, forkSource: { kind: "native_id", value: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mutually exclusive");
    expect(sent).toEqual([]);
  });

  it("refuses forkSource outright — vibe has no fork primitive", async () => {
    const sent: string[] = [];
    const fs = memFs();
    const adapter = adapterWith(fs, mockTmux(sent));
    const result = await adapter.launchHarness({ ...SEAT }, {
      name: "seat-a", forkSource: { kind: "native_id", value: UUID_A },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not support fork");
    expect(sent).toEqual([]);
  });

  it("refuses a malformed resume token before typing", async () => {
    const sent: string[] = [];
    const fs = memFs();
    const adapter = adapterWith(fs, mockTmux(sent));
    const result = await adapter.launchHarness({ ...SEAT }, { name: "seat-a", resumeToken: "not-a-uuid" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("vibe resume:");
    expect(sent).toEqual([]);
  });

  it("refuses launch without a bound tmux session", async () => {
    const fs = memFs();
    const adapter = adapterWith(fs, mockTmux());
    const result = await adapter.launchHarness({ cwd: "/x" }, { name: "seat-a" });
    expect(result.ok).toBe(false);
  });
});

describe("vibe-runtime-adapter — registry-diff token capture", () => {
  it("captures the single NEW session lock as the resume token", async () => {
    const sent: string[] = [];
    const fs = memFs({ [`${ACTIVE}/old.lock.json`]: lock(UUID_B, "2026-09-29T09:00:00Z") });
    const tmux = mockTmux(sent, () => {
      (fs as unknown as { files: Record<string, string> }).files[`${ACTIVE}/${UUID_A}.lock.json`] = lock(UUID_A, T1);
    });
    const adapter = adapterWith(fs, tmux);
    const result = await adapter.launchHarness({ ...SEAT }, { name: "seat-a" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe(UUID_A);
      expect(result.resumeType).toBe("vibe_session_id");
    }
  });

  it("ignores pre-existing locks acquired before this launch (launch scoping)", async () => {
    const sent: string[] = [];
    const fs = memFs({ [`${ACTIVE}/${UUID_A}.lock.json`]: lock(UUID_A, "2026-09-29T09:00:00Z") });
    const adapter = adapterWith(fs, mockTmux(sent));
    const result = await adapter.launchHarness({ ...SEAT }, { name: "seat-a" });
    // Stale-only registry: no NEW session within the window -> honest timeout.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("timed out");
      expect(result.recovery).toBe("attention_required");
    }
  });

  it("REFUSES an ambiguous capture (multiple new sessions), never guesses", async () => {
    const sent: string[] = [];
    const fs = memFs();
    const tmux = mockTmux(sent, () => {
      const files = (fs as unknown as { files: Record<string, string> }).files;
      files[`${ACTIVE}/${UUID_A}.lock.json`] = lock(UUID_A, T1);
      files[`${ACTIVE}/${UUID_B}.lock.json`] = lock(UUID_B, T1);
    });
    const adapter = adapterWith(fs, tmux);
    const result = await adapter.launchHarness({ ...SEAT }, { name: "seat-a" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ambiguous");
      expect(result.recovery).toBe("attention_required");
    }
  });

  it("resume verification requires the persisted id re-acquired AFTER launch start", async () => {
    const sent: string[] = [];
    const fs = memFs({ [`${ACTIVE}/${UUID_A}.lock.json`]: lock(UUID_A, "2026-09-29T09:00:00Z") });
    const adapter = adapterWith(fs, mockTmux(sent));
    const result = await adapter.launchHarness({ ...SEAT }, { name: "seat-a", resumeToken: UUID_A });
    // Lock is stale (pre-launch): no registry evidence -> honest retry_fresh hint.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("never claim a resume");
      expect(result.recovery).toBe("retry_fresh");
    }
  });
});

describe("vibe-runtime-adapter — projection + delivery", () => {
  it("projects skills to <cwd>/.vibe/skills/<id>/ (vibe-native target, never .agents)", async () => {
    const fs = memFs({ [nodePath.join("/packs", "skill-a", "SKILL.md")]: "skill-body" });
    const adapter = adapterWith(fs, mockTmux());
    const result = await adapter.project({
      entries: [{
        category: "skill", classification: "project",
        effectiveId: "skill-a", absolutePath: nodePath.join("/packs", "skill-a"),
      }],
    } as never, { ...SEAT });
    expect(result.projected).toEqual(["skill-a"]);
    const files = (fs as unknown as { files: Record<string, string> }).files;
    expect(files[nodePath.join(SEAT.cwd, ".vibe", "skills", "skill-a", "SKILL.md")]).toBe("skill-body");
  });

  it("delivers startup guidance via the AGENTS.md managed-block merge", async () => {
    const fs = memFs({ [nodePath.join("/packs", "openrig-start.md")]: "startup-guidance" });
    const adapter = adapterWith(fs, mockTmux());
    const result = await adapter.deliverStartup([{
      path: "openrig-start.md", absolutePath: nodePath.join("/packs", "openrig-start.md"), ownerRoot: "/packs",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"],
    }], { ...SEAT });
    expect(result.delivered).toBe(1);
    const agents = (fs as unknown as { files: Record<string, string> }).files[nodePath.join(SEAT.cwd, "AGENTS.md")];
    expect(agents).toContain("startup-guidance");
  });

  it("lists installed skills from <cwd>/.vibe/skills (per-file entries, codex semantics)", async () => {
    const fs = memFs({ [nodePath.join(SEAT.cwd, ".vibe", "skills", "skill-a", "SKILL.md")]: "x" });
    const adapter = adapterWith(fs, mockTmux());
    const installed = await adapter.listInstalled({ ...SEAT });
    expect(installed).toEqual([
      {
        effectiveId: "skill-a/SKILL.md",
        category: "skill",
        installedPath: nodePath.join(SEAT.cwd, ".vibe", "skills", "skill-a", "SKILL.md"),
      },
    ]);
  });
});
describe("vibe-runtime-adapter — capture mutex (review ruling 1)", () => {
  it("two CONCURRENT fresh launches each capture their own session (no ambiguity refusal)", async () => {
    const fs = memFs();
    let sendCount = 0;
    const sent: string[] = [];
    const tmux = mockTmux(sent, () => {
      sendCount += 1;
      const files = (fs as unknown as { files: Record<string, string> }).files;
      // Seat 1's vibe acquires session A, then seat 2's acquires session B.
      const id = sendCount === 1 ? UUID_A : UUID_B;
      files[`${ACTIVE}/${id}.lock.json`] = lock(id, T1);
    });
    const adapter = adapterWith(fs, tmux);
    const [r1, r2] = await Promise.all([
      adapter.launchHarness({ ...SEAT, tmuxSession: "seat-1" }, { name: "seat-1" }),
      adapter.launchHarness({ ...SEAT, tmuxSession: "seat-2" }, { name: "seat-2" }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.resumeToken).toBe(UUID_A);
      expect(r2.resumeToken).toBe(UUID_B);
    }
  });

  it("a FAILED launch releases the capture mutex for the next launch", async () => {
    const fs = memFs();
    const sent: string[] = [];
    let sendOk = false;
    const tmux = {
      sendShellCommand: vi.fn(async (_t: string, command: string): Promise<TmuxResult> => {
        sent.push(command);
        if (sendOk) {
          (fs as unknown as { files: Record<string, string> }).files[`${ACTIVE}/${UUID_A}.lock.json`] = lock(UUID_A, T1);
        }
        return sendOk ? { ok: true as const } : { ok: false as const, message: "tmux down" };
      }),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      capturePaneContent: vi.fn(async () => ""),
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "python"),
    } as unknown as TmuxAdapter;
    const adapter = adapterWith(fs, tmux);
    const failed = await adapter.launchHarness({ ...SEAT }, { name: "seat-a" });
    expect(failed.ok).toBe(false);
    sendOk = true;
    const next = await adapter.launchHarness({ ...SEAT }, { name: "seat-a" });
    expect(next.ok).toBe(true);
  });
});

describe("vibe-runtime-adapter — registry compat boundary (review ruling 4)", () => {
  it("a malformed lock (invalid JSON) fails LOUD with attention_required, never silently \"no session\"", async () => {
    const fs = memFs({ [`${ACTIVE}/broken.lock.json`]: "{not json" });
    const adapter = adapterWith(fs, mockTmux());
    const result = await adapter.launchHarness({ ...SEAT }, { name: "seat-a" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("registry shape changed");
      expect(result.error).toContain("invalid_json");
      expect(result.recovery).toBe("attention_required");
    }
  });

  it("a lock missing session_id fails loud as a shape change", async () => {
    const fs = memFs({ [`${ACTIVE}/nosession.lock.json`]: JSON.stringify({ acquired_at: T1 }) });
    const adapter = adapterWith(fs, mockTmux());
    const result = await adapter.launchHarness({ ...SEAT }, { name: "seat-a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("missing_session_id");
  });

  it("a lock whose session_id is not a UUID fails loud as a shape change", async () => {
    const fs = memFs({ [`${ACTIVE}/weird.lock.json`]: JSON.stringify({ acquired_at: T1, session_id: "not-a-uuid" }) });
    const adapter = adapterWith(fs, mockTmux());
    const result = await adapter.launchHarness({ ...SEAT }, { name: "seat-a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid_session_id");
  });
});
