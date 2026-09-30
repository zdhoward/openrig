# Vibe Runtime Adapter — verification brief for the Linux host

This file is a self-contained task request. An agent (or human) with shell access to a Linux + tmux host should be able to pick this up with no other context, set the branch up, and prove — or disprove — that the Vibe runtime adapter works, without guessing at what "works" means.

## What this is

This fork (zdhoward/openrig) adds **Mistral Vibe** (the `vibe` CLI) as a fourth native OpenRig runtime, alongside claude-code, codex, and pi. The implementation is complete and unit-tested on branch **`feat/vibe-runtime`**; what is NOT yet done is live verification on a real POSIX host with a real `vibe` binary and real tmux. That is this task.

The adapter (all under `packages/daemon/src/adapters/`):

- `vibe-runtime-adapter.ts` — implements the five-method `RuntimeAdapter` contract (`packages/daemon/src/domain/runtime-adapter.ts`). Launches the vibe TUI in the seat's tmux pane as `vibe --agent '<profile>' --trust` (model, if bound, via a `VIBE_ACTIVE_MODEL='...'` env prefix). Resume is `vibe --resume '<session-uuid>'` — explicit id only; the bare `--resume` (interactive picker) and `-c` (TTY-scoped) forms are forbidden in managed paths. Fork is refused outright (vibe has no fork primitive).
- `vibe-session-store.ts` — pure reader over vibe's session registry (`~/.vibe/logs/session/active/*.lock.json`, each `{ session_id, acquired_at, ... }`). This is the resume-token source of truth: the adapter snapshots the registry before typing the launch command, then polls for ONE new lock. Multiple new locks = refused as ambiguous (never guessed). Malformed lock files (invalid JSON / missing or non-UUID `session_id`) fail LOUD as `attention_required` — by design, that means "vibe's registry layout changed", not "no session".
- `vibe-resume.ts` — resume verification requires the persisted session id to re-acquire an active lock AFTER the resume command was typed (stale pre-existing locks don't count).
- A launch-capture mutex keyed by the session-store root serializes only the snapshot→type→capture window, so concurrent seat launches each capture their own session instead of colliding into the ambiguity refusal.
- Permission axis `agent_profile`: explicit seat profile wins → else YOLO/`full_bypass` = `auto-approve` → else floor `accept-edits`.

Two seams are deliberately PROVISIONAL and are the main thing this task must pin down:

1. **Readiness markers** (`AUTH_FAILURE_MARKERS` / `TRUST_PROMPT_MARKERS` / `READY_MARKERS` tables at the top of `vibe-runtime-adapter.ts`). Auth markers are pinned from real output; the ready/trust groups are guesses. Real risk: vibe is a Textual TUI and may render on the alternate screen, in which case `tmux capture-pane` returns little or nothing and `checkReady` may never report ready. If so, capture the real pane and report it — the likely fix is treating the captured session lock as the ready signal (the adapter already has that data).
2. **Capture timing** — the adapter waits ~15s (60 × 250ms) for the new session lock. If real `vibe` acquires its session lock later than that, launches fail honestly with `attention_required` (safe but unusable until the window is tuned).

## Setup (Linux host)

```bash
git clone https://github.com/zdhoward/openrig.git && cd openrig
git checkout feat/vibe-runtime
npm install
npm run build -w packages/daemon
vibe --version        # must print a version; if missing: uv tool install mistral-vibe
tmux -V               # must print a version
vibe --resume x 2>&1 | head -5   # sanity: the binary runs (it may error on the bad id — that's fine)
```

## Test phase 1 — deterministic suites

```bash
npm run lint
npm test -w packages/daemon
```

**PASS =** `lint` exits 0 and the full daemon suite reports no NEW failures relative to upstream `main` on the same host (run `git stash`/`main` comparison if in doubt; do not chase pre-existing failures that also exist on main — the goal is zero regressions from this branch).

**Also PASS-required:** the five vibe-specific suites must be fully green:

```bash
cd packages/daemon && npx vitest run \
  test/vibe-runtime-adapter.test.ts test/vibe-resume.test.ts \
  test/resume-token-capture-vibe.test.ts test/vibe-readiness-probe.test.ts \
  test/vibe-permission-drift.test.ts
```

## Test phase 2 — live single-seat prototype (the important part)

Do this by hand or by driving the daemon; either way, RECORD EVERYTHING.

1. Create a scratch workspace directory (empty git repo is fine — the adapter's `--trust` makes the seat trust it for the invocation).
2. Launch ONE vibe seat through a rig (simplest: define a rig spec with a single member `runtime: "vibe"`, run `rig up` or the daemon flow you normally use). If wiring a full rig is awkward, the minimal equivalent is: start tmux, then send the adapter's exact launch command in a pane: `vibe --agent 'accept-edits' --trust`, from the workspace cwd.
3. **During and after launch, capture:**
   - `tmux capture-pane -p -t <session>` repeatedly (at launch, +2s, +5s, +10s, after the TUI is clearly up) — save each capture
   - `ls -la ~/.vibe/logs/session/active/` before launch, +2s, +5s, +10s — note when the lock appears and its exact content (`cat` it)
4. Send a simple message to the seat and confirm the harness answers.

**Record, per run:**
- The exact pane text at each timestamp (the fixture set below needs it)
- Whether/when `~/.vibe/logs/session/active/<uuid>.lock.json` appeared, and its exact JSON
- The session id and whether it matches a UUID shape
- What `tmux display-message -p -t <pane> '#{pane_current_command}'` says while the TUI is up (the adapter uses this to detect the pane returning to a shell)

**Repeat the capture for these states** (each is one fixture):
- `ready.txt` — authenticated fresh launch, TUI fully up
- `auth-required.txt` — `unset`/invalidate the Mistral auth (e.g. run with a `VIBE_HOME` pointed at an empty dir with no credentials) and capture the failure output
- `trust-gate.txt` — launch WITHOUT `--trust` from an untrusted folder and capture the trust prompt (do not approve it; capture, then abort)
- `resume-success.txt` — resume a real session id: `vibe --agent 'accept-edits' --trust --resume '<uuid>'`
- `resume-failed.txt` — resume a syntactically valid but nonexistent UUID and capture the error

Save the sanitized fixtures under `packages/daemon/test/fixtures/vibe/` (one file per state, exact pane text) — they become regression tests against the real CLI's output.

**Phase-2 PASS =**
- A fresh seat reaches "ready" as observed by OpenRig (rig status shows the seat ready), OR — if the pane is empty due to alternate-screen rendering — you have the raw captures in hand proving it, and the session lock demonstrably appears (that plus pane-alive is enough evidence to patch the ready path)
- The launch returned a `vibe_session_id` resume token that equals the UUID of the lock that appeared
- The trust-gate run shows the prompt text (fixture saved), and the adapter run WITH `--trust` never shows it
- A bad resume id fails LOUD (an error is shown; the seat does NOT silently start a fresh session)

## Test phase 3 — integration smoke (definition of "working")

Run these ten, in order. PASS = all ten.

1. Fresh vibe seat launches via the daemon
2. OpenRig observes the seat as ready
3. Send a simple message; a response lands in the seat transcript
4. Capture the seat's resume token (rig status / snapshot shows `vibe_session_id`)
5. Snapshot / stop the seat
6. Restore the seat
7. The SAME vibe session resumes (the id from step 4 is what `--resume` got; the transcript continues)
8. An intentionally bad token fails LOUDLY (attention/error state, never silent fresh)
9. A fresh retry happens only as an explicit follow-up action, not automatically
10. TWO vibe seats launch together (parallel) and BOTH capture their own distinct session ids — this validates the capture mutex

## Failure-handling rules for the tester (do not break these)

- The adapter's honesty rules are its core design: failed resume must NEVER become a silent fresh launch; ambiguity must stay a refusal. If a test fails because of these rules firing, the rules are working — report what you saw, do not "fix" by weakening them.
- Do not change the `RuntimeAdapter` contract, the other adapters, or anything under `adapters/` beyond the vibe files without recording why.
- Everything stays inside this fork. Never push to, or open a PR against, `mvschwarz/openrig` (the upstream). Commits go on `feat/vibe-runtime` (or a `feat/vibe-runtime-*` side branch) and nothing else.
- If the registry lock never appears, or its shape differs from `{ session_id, acquired_at, ... }`, that is the compat boundary firing — capture the actual layout verbatim and report it; do not write registry assumptions outside `vibe-session-store.ts`.

## Deliverables (what to hand back)

1. Pass/fail for phase 1 (lint + suite results, with any new-failure diff vs main)
2. The five fixture files with real pane text
3. A per-step log of the phase-3 smoke (ten lines, pass/fail, one sentence each)
4. The raw lock-file content and timing (when the lock appeared post-launch)
5. Any patch needed to the `READY_MARKERS` / `TRUST_PROMPT_MARKERS` tables — patterns only; control flow should not need changes. If the pane is empty in ready state, say so explicitly and include the `pane_current_command` value.
6. A short verdict: "vibe is a working fourth runtime" or the specific blockers found.
