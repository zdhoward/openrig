// Vibe seat resume — mirrors codex-resume.ts / pi-resume.ts.
//
// Resume is HONEST continuation: relaunch with `vibe --resume <persisted
// session id>` (explicit id only — NEVER bare `--resume`, which opens an
// interactive picker and is forbidden in managed paths; NEVER `-c`, which is
// TTY/recency-scoped). Verification is registry evidence: THIS attempt must
// observe the persisted id become active again in the session store. A
// session that never returns is FAILED loudly (retry_fresh mapping is the
// caller's) — never a silent fresh start.

import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import { shellQuote } from "./shell-quote.js";
import type { ResumeResult } from "./claude-resume.js";
import { vibeAgentProfile } from "./yolo-mode.js";
import { observeVibeAgentProfile } from "../domain/permission-drift.js";
import { VibeSessionStore, type VibeSessionStoreFs } from "./vibe-session-store.js";
import { listVibeProcessRows, pidOwnedByPane, type VibeProcessLister } from "./vibe-pane-process.js";

export { type ResumeResult };

export interface VibeResumeOptions {
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  agentProfileFloor?: string;
  trustManagedCwd?: boolean;
  /** Clock injection for launch-scoped verification (tests). */
  now?: () => string;
  /** Process table for pane-ownership proof of the re-acquired lock (tests). */
  listProcesses?: VibeProcessLister;
}

export class VibeResumeAdapter {
  private store: VibeSessionStore;

  constructor(
    private tmux: TmuxAdapter,
    private fs: VibeSessionStoreFs,
    private paths: { sessionStoreRoot: string },
    private options: VibeResumeOptions = {},
  ) {
    this.store = new VibeSessionStore(fs, paths.sessionStoreRoot);
  }

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === "vibe_session_id" && !!resumeToken;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    model?: string | null,
    resolvedPosture?: "floor" | "full_bypass",
    agentProfile?: string | null,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Vibe resume not available" };
    }
    const sessionId = resumeToken!;

    const profile = vibeAgentProfile(agentProfile ?? undefined, process.env, resolvedPosture, this.options.agentProfileFloor);
    const appliedLaunch = observeVibeAgentProfile(profile);
    const modelPrefix = model?.trim() ? `VIBE_ACTIVE_MODEL=${shellQuote(model.trim())} ` : "";
    const trustArg = (this.options.trustManagedCwd ?? true) ? " --trust" : "";
    const cmd = `${modelPrefix}vibe --agent ${shellQuote(profile)}${trustArg} --resume ${shellQuote(sessionId)}`;

    const textResult = await this.tmux.sendShellCommand(tmuxSessionName, cmd);
    if (!textResult.ok) {
      return { ok: false, code: "resume_failed", message: textResult.message };
    }

    const result = await this.verifyResume(tmuxSessionName, sessionId);
    return result.ok ? { ...result, appliedLaunch } : result;
  }

  // Poll the session registry ONLY for THIS attempt's evidence: the persisted
  // id must come back ACTIVE with a lock acquired after this resume started.
  // A stale pre-existing lock from a still-running process does not prove the
  // resume landed — the acquired_at timestamp scopes the proof (guard fold).
  // The lock must also be held from THIS pane's foreground lineage: another
  // vibe's maintenance sweep can lease the same stored session meanwhile.
  private async verifyResume(tmuxSessionName: string, sessionId: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 250;
    const maxWaitMs = this.options.maxWaitMs ?? 15_000;
    const sleepFn = this.options.sleep ?? sleep;
    const now = this.options.now ?? (() => new Date().toISOString());
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);
    const resumeStartedAt = now();
    const listProcesses = this.options.listProcesses ?? listVibeProcessRows;
    let panePid: number | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const match = this.store.listActiveSessions().find((lock) => lock.sessionId === sessionId);
      if (match && match.acquiredAt >= resumeStartedAt) {
        panePid ??= await this.tmux.getPanePid(tmuxSessionName).catch(() => null);
        if (panePid != null && pidOwnedByPane(await listProcesses(), panePid, match.processId)) {
          return { ok: true };
        }
      }
      if (attempt < attempts - 1) {
        await sleepFn(pollMs);
      }
    }

    return {
      ok: false,
      code: "resume_failed",
      message: "Vibe resume failed: timed out waiting for the persisted session to become active",
    };
  }
}
