// Vibe pane-ownership proof — ties a session-registry lock to ONE seat pane.
//
// Every vibe lease diagnostic records the holder's pid (`process_id`). A lock
// belongs to a seat only when that pid is a live process in the seat pane's
// FOREGROUND lineage (a descendant of the pane pid, in the pane's foreground
// process group). This is the evidence that keeps capture honest when other
// vibe processes (another seat, or the maintenance sweep of any vibe) lease
// sessions in the same shared registry during a launch window.
//
// Vibe rewrites its argv/comm to "Vibe CLI" (live-verified, 2.25.8), so the
// shared native-process lister (single-token ucomm) cannot see it and argv
// cannot carry the resume token; the lock's pid is the identity instead.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VibeProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
}

export type VibeProcessLister = () => VibeProcessRow[] | Promise<VibeProcessRow[]>;

export async function listVibeProcessRows(): Promise<VibeProcessRow[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,pgid=,tpgid="], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
    return stdout.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tpgid: Number(match[4]) }] : [];
    });
  } catch {
    return [];
  }
}

/** True only when `pid` is a descendant of `panePid` in the pane's foreground
 *  process group. Unknown pids, missing rows, or a background job are false. */
export function pidOwnedByPane(rows: VibeProcessRow[], panePid: number, pid: number | null): boolean {
  if (pid == null || pid === panePid) return false;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const root = byPid.get(panePid);
  const target = byPid.get(pid);
  if (!root || !target || root.tpgid <= 0 || target.pgid !== root.tpgid) return false;
  const visited = new Set<number>();
  let current: VibeProcessRow | undefined = target;
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    if (current.ppid === panePid) return true;
    current = byPid.get(current.ppid);
  }
  return false;
}
