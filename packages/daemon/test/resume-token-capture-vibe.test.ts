// The Vibe arm of the shared resume-token derive helper (mirrors
// resume-token-capture-pi.test.ts). Pins: the capture path CAPTURES (not
// skips) a valid registry session id, and that malformed values stay honest
// skips with no token fabrication.

import { describe, it, expect } from "vitest";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";

const SESSION = "devvibe-seat@some-rig";
const UUID_A = "4dd32436-7512-db4b-11ef-7c14fdf5a534";

function vibeStore(result: { ok: true; sessionId: string } | { ok: false; reason: string }) {
  return {
    readNewestActiveSession: () => result,
  };
}

describe("deriveResumeToken — vibe", () => {
  it("CAPTURES (not skips) a valid registry session id", async () => {
    const r = await deriveResumeToken(
      { runtime: "vibe", sessionName: SESSION },
      { vibeSessionStore: vibeStore({ ok: true, sessionId: UUID_A }) },
    );
    expect(r.outcome).toBe("captured");
    if (r.outcome === "captured") {
      expect(r.resumeType).toBe("vibe_session_id");
      expect(r.token).toBe(UUID_A);
    }
  });

  it("trims whitespace from the registry value before validating", async () => {
    const r = await deriveResumeToken(
      { runtime: "vibe", sessionName: SESSION },
      { vibeSessionStore: vibeStore({ ok: true, sessionId: `  ${UUID_A}\n` }) },
    );
    expect(r.outcome).toBe("captured");
    if (r.outcome === "captured") expect(r.token).toBe(UUID_A);
  });

  it("is a silent noop when the vibe session-store dep is absent", async () => {
    const r = await deriveResumeToken({ runtime: "vibe", sessionName: SESSION }, {});
    expect(r.outcome).toBe("noop");
  });

  it("skips honestly when the registry read fails (missing)", async () => {
    const r = await deriveResumeToken(
      { runtime: "vibe", sessionName: SESSION },
      { vibeSessionStore: vibeStore({ ok: false, reason: "missing_sidecar" }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "missing_sidecar" });
  });

  it("maps a registry parse failure to the parse_error skip reason", async () => {
    const r = await deriveResumeToken(
      { runtime: "vibe", sessionName: SESSION },
      { vibeSessionStore: vibeStore({ ok: false, reason: "parse_error" }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "parse_error" });
  });

  it("skips (never persists) a non-UUID session id", async () => {
    const r = await deriveResumeToken(
      { runtime: "vibe", sessionName: SESSION },
      { vibeSessionStore: vibeStore({ ok: true, sessionId: "not-a-uuid" }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "invalid_token" });
  });

  it("skips an empty registry value as missing", async () => {
    const r = await deriveResumeToken(
      { runtime: "vibe", sessionName: SESSION },
      { vibeSessionStore: vibeStore({ ok: true, sessionId: "   " }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "missing_sidecar" });
  });
});
