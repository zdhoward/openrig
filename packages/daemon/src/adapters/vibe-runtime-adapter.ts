// The Vibe runtime adapter — interactive TUI harness in the seat's tmux pane.
//
// Parity shape: pi/codex (a native long-running TUI harness), per the design
// rulings recorded in GPM #20 (Codex consult):
//   - launch: `vibe` (TUI; NEVER `vibe -p` — one-shot automation, not a seat)
//   - resume: `vibe --resume <uuid>` (explicit id only — the bare form opens
//     an interactive picker, forbidden in managed paths; `-c` is TTY-scoped)
//   - fork: REFUSED — vibe has no fork primitive (the contract's
//     fork-unsupported refusal; same posture as terminal)
//   - skills project to <cwd>/.vibe/skills/<name>/ (vibe-native surface;
//     NEVER also .agents/skills — shared writes create ownership ambiguity)
//   - trust: `--trust` per launch only — the adapter NEVER mutates
//     trusted_folders.toml; a surfaced trust prompt classifies inconclusive
//   - token capture: registry diff over the session store (evidence, not
//     guesswork); ambiguous matches are refused, never resolved by guessing
//
// SECURITY CONTRACT (--trust): trust is not a prompt-suppressor — it loads
// project-level .vibe/ config (skills, agents, hooks, MCP servers, tool
// permission fragments) as executable, security-sensitive content. OpenRig
// Vibe seats therefore MUST run in OpenRig-managed worktrees with
// operator-reviewed projections; never launch a seat against an unreviewed
// repository. (Future policy-axis candidate: trust: managed |
// require-confirmation — not in the first PR.)
// Architecture Rule 1: zero Hono in adapters/.

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import { shellQuote } from "./shell-quote.js";
import { vibeAgentProfile } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { observeVibeAgentProfile } from "../domain/permission-drift.js";
import { VibeSessionStore, type VibeSessionLock } from "./vibe-session-store.js";
import { listVibeProcessRows, pidOwnedByPane, proveVibeInPane, type VibeProcessLister } from "./vibe-pane-process.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

// Launch-capture mutex, keyed by the session-store root (derived from
// VIBE_HOME) — review ruling 1. The registry diff can identify exactly ONE
// newly-appeared session per capture window, so concurrent fresh launches
// must serialize the snapshot→type→capture window ONLY (never the launch
// surface): without this, two parallel seat launches both see two new locks
// and the honest-but-crippling ambiguity refusal fires on every parallel rig
// boot. The gate is released in a finally, so a failed launch never jams the
// next one.
const captureMutexes = new Map<string, Promise<void>>();
async function withCaptureMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = captureMutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  captureMutexes.set(key, gate);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (captureMutexes.get(key) === gate) captureMutexes.delete(key);
  }
}

// Readiness pane markers — TABLE-DRIVEN by design (#20 ruling 5): the auth
// and trust groups are pinned from verified production evidence; the ready
// group is provisional until the prototype run pins exact TUI strings, and
// updating it must only ever touch these patterns, never control flow.
// "Let's get you started" is vibe 2.25.8's first-run onboarding wizard (no
// credentials in VIBE_HOME) — pinned from test/fixtures/vibe/auth-required.txt;
// its "Welcome to Mistral Vibe" banner would otherwise match READY_MARKERS.
const AUTH_FAILURE_MARKERS = ["Not logged in", "Authentication required", "Invalid API key", "Unauthorized", "Let's get you started"];
const TRUST_PROMPT_MARKERS = [/trust/i, /workspace/i, /folder/i, /directory/i];
const READY_MARKERS = [/mistral vibe/i, /\binput\b.*\bprompt\b/i, /ctrl\+.*exit/i];

export interface VibeAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  /** Directory listing for the session-registry reader (capture source). */
  readdir?(dir: string): string[];
}

export interface VibeRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: VibeAdapterFsOps;
  /** <VIBE_HOME>/logs/session — the session-store root used for capture. */
  sessionStoreRoot: string;
  /** Managed-launch agent-profile floor (vibe's --axis). Default accept-edits. */
  agentProfileFloor?: string;
  /** Always trust the seat cwd for this invocation (managed launch law). */
  trustManagedCwd?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Clock injection for launch-scoped capture (tests). */
  now?: () => string;
  /** Process table for pane-ownership proof of a captured lock (tests). */
  listProcesses?: VibeProcessLister;
}

export class VibeRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "vibe";
  private tmux: TmuxAdapter;
  private fs: VibeAdapterFsOps;
  private store: VibeSessionStore;
  private sessionStoreRoot: string;
  private agentProfileFloor: string;
  private trustManagedCwd: boolean;
  private sleep: (ms: number) => Promise<void>;
  private now: () => string;
  private listProcesses: VibeProcessLister;

  constructor(deps: VibeRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sessionStoreRoot = deps.sessionStoreRoot;
    this.store = new VibeSessionStore(
      { readFile: deps.fsOps.readFile, exists: deps.fsOps.exists, readdir: deps.fsOps.readdir },
      deps.sessionStoreRoot,
    );
    this.agentProfileFloor = deps.agentProfileFloor ?? "accept-edits";
    this.trustManagedCwd = deps.trustManagedCwd ?? true;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => new Date().toISOString());
    this.listProcesses = deps.listProcesses ?? listVibeProcessRows;
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".vibe", "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding)) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            // Vibe chain-loads AGENTS.md from the managed cwd (same target
            // as codex); additive managed-block merge, never a replace.
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".vibe", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) {
          failed.push({ path: file.path, error: (err as Error).message });
        }
      }
    }

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the Vibe harness" };
    }
    // Contract rule: mutual exclusivity is refused BEFORE anything is typed.
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }
    // Vibe has NO fork primitive — the honest refusal, never a fake.
    if (opts.forkSource) {
      return {
        ok: false,
        error: `vibe fork: the vibe runtime does not support fork (no native fork primitive); use a fresh launch or an explicit --resume of a persisted session id`,
      };
    }

    const profile = vibeAgentProfile(binding.vibeAgentProfile, process.env, binding.launchPosture, this.agentProfileFloor);
    const appliedLaunch = observeVibeAgentProfile(profile);
    const model = binding.model?.trim();
    // Evidence pin (review ruling 2): VIBE_ACTIVE_MODEL is documented by the
    // CLI's own bundled docs for the pinned install — the vibe skill shipped
    // inside mistral-vibe 2.25.8 lists it under Environment Variables
    // ("VIBE_ACTIVE_MODEL — Override active model"; "any config field can be
    // overridden with the VIBE_ prefix") — and is exercised in production by
    // SkillOpt's VibeCliBackend (skillopt_sleep/backend.py, branch
    // local/vibe-harvest: env["VIBE_ACTIVE_MODEL"] = model).
    const modelPrefix = model ? `VIBE_ACTIVE_MODEL=${shellQuote(model)} ` : "";
    const trustArg = this.trustManagedCwd ? " --trust" : "";
    const cmd = opts.resumeToken
      ? `${modelPrefix}vibe --agent ${shellQuote(profile)}${trustArg} --resume ${shellQuote(opts.resumeToken)}`
      : `${modelPrefix}vibe --agent ${shellQuote(profile)}${trustArg}`;

    if (opts.resumeToken) {
      const validation = validateResumeToken("vibe", opts.resumeToken);
      if (!validation.ok) {
        return { ok: false, error: `vibe resume: ${validation.error}` };
      }
    }

    const sessionName = binding.tmuxSession;

    // Launch-scoped capture under the VIBE_HOME-keyed capture mutex (review
    // ruling 1): the registry diff identifies exactly ONE new session per
    // window, so concurrent fresh launches serialize the snapshot→type→
    // capture window ONLY — never the launch surface. A failed launch
    // releases the gate in the finally.
    return withCaptureMutex(this.sessionStoreRoot, async () => {
      const launchStartedAt = this.now();

      // Snapshot the registry BEFORE typing, then diff.
      const registryBefore = this.store.listRegistry();
      if (registryBefore.malformed.length > 0) {
        return this.registryShapeFailure(registryBefore.malformed[0]!);
      }
      const snapshot = new Set(registryBefore.locks.map((lock) => lock.sessionId));
      // Sessions already persisted before this launch can never be the seat's
      // NEW session — vibe's output-cleanup sweep leases them at startup.
      const storedBefore = this.store.listStoredSessionIds();

      const textResult = await this.tmux.sendShellCommand(sessionName, cmd);
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }

      const capture = await this.waitForSessionCapture(sessionName, snapshot, storedBefore, launchStartedAt, opts.resumeToken ?? undefined);
      if (!capture.ok) return capture.failure;

      return { ok: true, resumeToken: capture.sessionId, resumeType: "vibe_session_id", appliedLaunch };
    });
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    // Guard fold: a dead vibe leaves the pane back at a shell — pane
    // scrollback or a stale lock never makes a stopped seat ready.
    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    // The daemon types launches through a `/bin/sh <script>` wrapper, so a
    // LIVE seat also reads "sh" (live-verified). A shell label is exited only
    // without positive proof: a session lock held from the pane's foreground
    // lineage (same fix class as f8f3aff6 for Codex behind shell wrappers).
    const atShell = SHELL_COMMANDS.has(paneCommand)
      && !(await proveVibeInPane({ target: binding.tmuxSession, tmux: this.tmux, store: this.store, listProcesses: this.listProcesses }));
    if (atShell) {
      return { ready: false, reason: "the pane is back at a shell (vibe process gone)", code: "runtime_exited" };
    }

    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    for (const marker of AUTH_FAILURE_MARKERS) {
      if (paneContent.includes(marker)) {
        return { ready: false, reason: `vibe auth failure in the pane (${marker})`, code: "auth_failure" };
      }
    }
    // Trust prompt: the Claude trust-gate analog — inconclusive, NEVER ready,
    // and the adapter never papers over it by mutating trusted_folders.toml.
    const trustHits = TRUST_PROMPT_MARKERS.filter((re) => re.test(paneContent)).length;
    if (trustHits >= 2) {
      return { ready: false, reason: "vibe trust gate surfaced in the pane (operator decision required)", code: "trust_gate" };
    }
    for (const re of READY_MARKERS) {
      if (re.test(paneContent)) {
        return { ready: true };
      }
    }
    return { ready: false, reason: "vibe has not reported ready yet", code: "awaiting_runtime" };
  }

  /** Positive proof a live vibe holds a session from this pane (optionally
   *  THE recorded session) — for daemon consumers that see the launch
   *  wrapper's shell label (session transport). */
  async provePaneOccupancy(target: string, expectedSessionId?: string | null): Promise<{ panePid: number } | null> {
    return proveVibeInPane({ target, tmux: this.tmux, store: this.store, listProcesses: this.listProcesses, expectedSessionId });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Compat boundary: a malformed registry entry means the Vibe version
   *  moved — attention_required, never a silent "no session" (review
   *  ruling 4). The raw entry name is path-safe (a directory listing entry).
   */
  private registryShapeFailure(entry: { file: string; reason: string }): HarnessLaunchResult {
    return {
      ok: false,
      error: `vibe session registry shape changed (${entry.reason} in ${entry.file}) — verify the session-store compat boundary against the pinned mistral-vibe version`,
      recovery: "attention_required",
    };
  }

  // Capture evidence = a lock that is (a) launch-scoped, (b) held by a process
  // in THIS seat pane's foreground lineage (lock process_id -> pane pid), and,
  // for a fresh launch, (c) not a session persisted before the launch. Locks
  // failing (b)/(c) belong to other vibe processes or to the maintenance
  // sweep and are ignored — never guessed at, never counted as ambiguity.
  private async waitForSessionCapture(
    sessionName: string,
    snapshot: Set<string>,
    storedBefore: Set<string>,
    launchStartedAt: string,
    expectedSessionId?: string,
  ): Promise<{ ok: true; sessionId: string } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    // ~60s: vibe takes ~5s to acquire its session lock on an idle host but was
    // measured at ~18s with 12 seats booting on 2 vCPUs. The loop returns as
    // soon as the lock appears; the bound only delays an honest failure.
    const attempts = 240;
    let panePid: number | null = null;
    const ownedByPane = async (locks: VibeSessionLock[]): Promise<VibeSessionLock[]> => {
      if (locks.length === 0) return [];
      panePid ??= await this.tmux.getPanePid(sessionName).catch(() => null);
      if (panePid == null) return [];
      const rows = await this.listProcesses();
      return locks.filter((lock) => pidOwnedByPane(rows, panePid!, lock.processId));
    };
    for (let attempt = 0; attempt < attempts; attempt++) {
      const registry = this.store.listRegistry();
      if (registry.malformed.length > 0) {
        return {
          ok: false,
          failure: this.registryShapeFailure(registry.malformed[0]!),
        };
      }
      const active = registry.locks;
      if (expectedSessionId) {
        // Resume verification: THIS attempt must observe the persisted id
        // come back active (a lock re-acquired after launch start).
        const candidates = active.filter((lock) => lock.sessionId === expectedSessionId && lock.acquiredAt >= launchStartedAt);
        const [match] = await ownedByPane(candidates);
        if (match) {
          return { ok: true, sessionId: match.sessionId };
        }
      } else {
        const candidates = active.filter((lock) =>
          !snapshot.has(lock.sessionId)
          && lock.acquiredAt >= launchStartedAt
          && !storedBefore.has(lock.sessionId.toLowerCase()));
        const fresh = await ownedByPane(candidates);
        const [first] = fresh;
        if (fresh.length === 1 && first) {
          return { ok: true, sessionId: first.sessionId };
        }
        if (fresh.length > 1) {
          // Ambiguity is refused, never guessed (#20 ruling 6).
          return {
            ok: false,
            failure: {
              ok: false,
              error: "vibe launch: multiple new vibe sessions appeared — ambiguous capture; refusing to guess the seat's session id",
              recovery: "attention_required",
            },
          };
        }
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: expectedSessionId
        ? {
            ok: false,
            error: "vibe resume: timed out waiting for the persisted session to become active — never claim a resume without registry evidence",
            recovery: "retry_fresh",
          }
        : {
            ok: false,
            error: "vibe launch: timed out waiting for the session registry to report the new session",
            recovery: "attention_required",
          },
    };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    if (entry.category === "skill") {
      const targetDir = nodePath.join(binding.cwd, ".vibe", "skills", entry.effectiveId);
      this.fs.mkdirp(targetDir);
      const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;
      if (isDir && this.fs.listFiles) {
        for (const file of this.fs.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
        }
      } else {
        this.fs.writeFile(
          nodePath.join(targetDir, nodePath.basename(entry.absolutePath)),
          this.fs.readFile(entry.absolutePath),
        );
      }
      return true;
    }

    // Plugins / subagents / runtime resources have no vibe projection target
    // at MVP — an honest skip, never a misdelivery.
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // Mirrors the Claude/Codex/Pi adapters: per-seat `rig-role` content is
    // delivered via send_text, never merged into a shared cwd file.
    if (blockId === "rig-role") {
      console.log(
        `[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`
      );
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }
}

/** Launch-id mint kept for parity with the pi adapter's test seam. */
export function newVibeLaunchId(): string {
  return randomUUID();
}
