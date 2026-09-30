// Vibe session-store reader — the launch-scoped resume-token source of truth.
//
// VIBE INTERNAL COMPATIBILITY BOUNDARY.
// Verified against mistral-vibe v2.25.8 (lock.json: { acquired_at,
// session_id, lease_version, process_id }). Do not spread registry-layout
// assumptions outside this module. Malformed entries are REPORTED (never
// silently skipped): callers fail LOUD (attention_required) on any registry
// shape change — a malformed entry means the Vibe version moved and this
// boundary must be re-verified, not that "no session" exists.
//
// Vibe has no --session-id launch flag: it mints a session UUID at start and
// maintains a live-session registry at <VIBE_HOME>/logs/session/active/
// (<uuid>.lock / <uuid>.lock.json). This module is a PURE,
// dependency-injected reader over that registry — no writes, no launch, no
// pane scraping. The adapter snapshots the registry before a launch and
// diffs after, so the token it persists is identified by registry EVIDENCE,
// never guessed (the honest-capture rule; mirrors codex's pid-keyed-log
// capture posture).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VibeSessionLock {
  sessionId: string;
  acquiredAt: string;
}

export type VibeRegistryMalformation = "invalid_json" | "missing_session_id" | "invalid_session_id";

export interface VibeSessionRegistry {
  locks: VibeSessionLock[];
  /** Malformed lock entries — the caller must fail LOUD on any of these
   *  (compat boundary): never treat them as "no session". */
  malformed: Array<{ file: string; reason: VibeRegistryMalformation }>;
}

export interface VibeSessionStoreFs {
  readFile(path: string): string;
  exists(path: string): boolean;
  readdir?(dir: string): string[];
}

export class VibeSessionStore {
  constructor(
    private fs: VibeSessionStoreFs,
    /** <VIBE_HOME>/logs/session — the session-store root. */
    private root: string,
  ) {}

  /** Full registry read: parsed locks (newest-first by acquired_at) plus
   *  every malformed entry, surfaced for loud failure upstream. */
  listRegistry(): VibeSessionRegistry {
    const activeDir = joinPath(this.root, "active");
    const locks: VibeSessionLock[] = [];
    const malformed: Array<{ file: string; reason: VibeRegistryMalformation }> = [];
    let entries: string[];
    try {
      entries = this.fs.readdir ? this.fs.readdir(activeDir) : [];
    } catch {
      return { locks, malformed };
    }
    for (const entry of entries) {
      if (!entry.endsWith(".lock.json")) continue;
      const lockPath = joinPath(activeDir, entry);
      if (!this.fs.exists(lockPath)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.fs.readFile(lockPath));
      } catch {
        malformed.push({ file: entry, reason: "invalid_json" });
        continue;
      }
      const record = parsed as { session_id?: unknown };
      const sessionId = typeof record.session_id === "string" ? record.session_id.trim() : "";
      if (!sessionId) {
        malformed.push({ file: entry, reason: "missing_session_id" });
        continue;
      }
      if (!UUID_RE.test(sessionId)) {
        malformed.push({ file: entry, reason: "invalid_session_id" });
        continue;
      }
      const acquiredAt = (parsed as { acquired_at?: unknown }).acquired_at;
      locks.push({
        sessionId,
        acquiredAt: typeof acquiredAt === "string" ? acquiredAt : "",
      });
    }
    locks.sort((a, b) => (a.acquiredAt < b.acquiredAt ? 1 : a.acquiredAt > b.acquiredAt ? -1 : 0));
    return { locks, malformed };
  }

  /** Active-session locks, parsed and sorted newest-first by acquired_at. */
  listActiveSessions(): VibeSessionLock[] {
    return this.listRegistry().locks;
  }

  /** Whether a session id currently holds an active lock. */
  sessionActive(sessionId: string): boolean {
    const lockPath = joinPath(this.root, "active", `${sessionId}.lock.json`);
    if (this.fs.exists(lockPath)) return true;
    const legacy = joinPath(this.root, "active", `${sessionId}.lock`);
    return this.fs.exists(legacy);
  }
}

// Minimal path join (POSIX separators match the tmux/POSIX host law; the
// daemon drives POSIX seats).
function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}
