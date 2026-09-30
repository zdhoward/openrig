// The vibe permission-drift axis (agent_profile) + the launch-profile mapping
// (yolo-mode vibeAgentProfile) + the vibe_session_id token validation floor.

import { describe, it, expect } from "vitest";
import { observeVibeAgentProfile } from "../src/domain/permission-drift.js";
import { vibeAgentProfile } from "../src/adapters/yolo-mode.js";
import { resumeTypeForRuntime, validateResumeToken } from "../src/domain/resume-token-validation.js";

const UUID_A = "4dd32436-7512-db4b-11ef-7c14fdf5a534";

describe("permission drift — vibe agent_profile axis", () => {
  it("observes the applied agent profile on the agent_profile axis", () => {
    expect(observeVibeAgentProfile("accept-edits")).toEqual({
      runtime: "vibe",
      axis: "agent_profile",
      state: "observed",
      value: "accept-edits",
    });
  });
});

describe("yolo-mode — vibeAgentProfile mapping (#20 ruling 7)", () => {
  it("defaults to the accept-edits floor", () => {
    expect(vibeAgentProfile(undefined, {})).toBe("accept-edits");
  });

  it("honors a configured floor override", () => {
    expect(vibeAgentProfile(undefined, {}, undefined, "plan")).toBe("plan");
  });

  it("an explicit per-seat profile wins (validated charset)", () => {
    expect(vibeAgentProfile("smart-approve", { OPENRIG_YOLO: "1" })).toBe("smart-approve");
  });

  it("throws on an invalid profile charset — never passes garbage to the pane", () => {
    expect(() => vibeAgentProfile("ask; rm -rf /", {})).toThrow("Invalid Vibe agent profile");
  });

  it("YOLO env forces auto-approve", () => {
    expect(vibeAgentProfile(undefined, { OPENRIG_YOLO: "1" })).toBe("auto-approve");
  });

  it("a resolved full_bypass posture forces auto-approve in BOTH directions", () => {
    expect(vibeAgentProfile(undefined, {}, "full_bypass")).toBe("auto-approve");
    expect(vibeAgentProfile(undefined, {}, "floor")).toBe("accept-edits");
  });
});

describe("resume-token-validation — vibe_session_id floor", () => {
  it("maps the vibe runtime to the vibe_session_id resume type", () => {
    expect(resumeTypeForRuntime("vibe")).toBe("vibe_session_id");
    expect(resumeTypeForRuntime("terminal")).toBeNull();
  });

  it("accepts a well-formed session UUID", () => {
    const r = validateResumeToken("vibe", UUID_A);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resumeType).toBe("vibe_session_id");
      expect(r.token).toBe(UUID_A);
    }
  });

  it("rejects malformed ids with an error that NEVER quotes the token", () => {
    for (const bad of ["not-a-uuid", "4dd32436-7512-db4b-11ef-7c14fdf5a53", `${UUID_A}x`, "'; drop table users;"]) {
      const r = validateResumeToken("vibe", bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toContain(bad);
    }
  });

  it("rejects empty and non-string tokens", () => {
    expect(validateResumeToken("vibe", "  ").ok).toBe(false);
    expect(validateResumeToken("vibe", undefined).ok).toBe(false);
  });
});
