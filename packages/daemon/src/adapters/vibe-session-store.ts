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
// Entries are classified by FILENAME. Vibe's lease directory is shared: the
// unified harness also takes named maintenance leases there (live-verified:
// process-output-cleanup.lock.json, ~400ms, ~20ms after the session lease,
// same process_id). A non-UUID name that matches vibe's own lease-id pattern
// is vibe housekeeping, not a registry entry — reported as `internal`, never
// parsed as a session. A UUID-named entry gets the full strict check (and
// its session_id must match its filename), so the tripwire stays armed for
// real registry entries; any other name is also reported malformed.
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
// vibe/core/session/session_lease.py _SESSION_ID_PATTERN (2.25.8).
const VIBE_LEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOCK_SUFFIX = ".lock.json";

export interface VibeSessionLock {
  sessionId: string;
  acquiredAt: string;
  /** The lease holder's pid (vibe's diagnostic `process_id`); null if absent. */
  processId: number | null;
}

export type VibeRegistryMalformation =
  | "invalid_json" | "missing_session_id" | "invalid_session_id" | "session_id_mismatch" | "unrecognized_lock_name";

export interface VibeSessionRegistry {
  locks: VibeSessionLock[];
  /** Malformed lock entries — the caller must fail LOUD on any of these
   *  (compat boundary): never treat them as "no session". */
  malformed: Array<{ file: string; reason: VibeRegistryMalformation }>;
  /** Vibe's own named (non-UUID) leases, e.g. process-output-cleanup — not sessions. */
  internal: string[];
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
    const internal: string[] = [];
    let entries: string[];
    try {
      entries = this.fs.readdir ? this.fs.readdir(activeDir) : [];
    } catch {
      return { locks, malformed, internal };
    }
    for (const entry of entries) {
      if (!entry.endsWith(LOCK_SUFFIX)) continue;
      const stem = entry.slice(0, -LOCK_SUFFIX.length);
      if (!UUID_RE.test(stem)) {
        if (VIBE_LEASE_ID_RE.test(stem)) internal.push(entry);
        else malformed.push({ file: entry, reason: "unrecognized_lock_name" });
        continue;
      }
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
      if (sessionId.toLowerCase() !== stem.toLowerCase()) {
        malformed.push({ file: entry, reason: "session_id_mismatch" });
        continue;
      }
      const acquiredAt = (parsed as { acquired_at?: unknown }).acquired_at;
      const processId = (parsed as { process_id?: unknown }).process_id;
      locks.push({
        sessionId,
        acquiredAt: typeof acquiredAt === "string" ? acquiredAt : "",
        processId: typeof processId === "number" && Number.isInteger(processId) && processId > 0 ? processId : null,
      });
    }
    locks.sort((a, b) => (a.acquiredAt < b.acquiredAt ? 1 : a.acquiredAt > b.acquiredAt ? -1 : 0));
    return { locks, malformed, internal };
  }

  /** Session ids with a persisted transcript (<root>/unified/<id>/). A lock
   *  on one of these during a fresh launch is an existing session being
   *  opened or maintained (vibe's output-cleanup sweep leases stored
   *  sessions), never the seat's new session. */
  listStoredSessionIds(): Set<string> {
    try {
      const entries = this.fs.readdir ? this.fs.readdir(joinPath(this.root, "unified")) : [];
      return new Set(entries.filter((entry) => UUID_RE.test(entry)).map((entry) => entry.toLowerCase()));
    } catch {
      return new Set();
    }
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
