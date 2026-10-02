// project-memory-core: the pure helpers of plugins/project-memory.ts.
//
// They live OUTSIDE the plugin module on purpose. OpenCode's plugin loader calls EVERY exported function of a
// plugin file as a plugin factory and pushes whatever it returns into the hooks list; a helper that returned null
// (observationStatus on the plugin input) put a null hook there, and the loader's config-hook loop then died with
// "null is not an object (evaluating 'N.config')" on every OpenCode start (2026-09-16 16:16 EDT:
// "Unexpected server error", Provider.list failed with a null config). A plugin file exports its factory only.

const SECRET = /(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;

/** True when a note carries something that looks like a credential; such a note is dropped, never sent or recorded.
 *  Sync, single-argument and defensive on purpose: OpenCode's loader calls EVERY export of a plugin module as a
 *  plugin factory with the plugin input, and an export that throws there kills the whole file (seen in a sibling plugin). */
export function hasSecret(note: unknown): boolean {
  return SECRET.test(String(note ?? ""));
}

// Memory self-events are excluded from capture: the model reading or writing memory is not a project fact.
/** True when a command or a tool output is about the memory system itself. Same defensive export shape as above. */
export function isSelfEvent(text: unknown): boolean {
  return /project_memory|memory_bootstrap|\/v1\/adapter\//i.test(String(text ?? ""));
}

/**
 * The gateway's `observation_status` on a checkpoint/finish reply - `retained`, `accepted-pending`, `unavailable`,
 * `rejected` or `absent` - or null when the reply does not carry the field (an older gateway). A value outside that
 * set is still recorded verbatim rather than dropped: a receipt that names an unknown status is diagnosable, one
 * that silently omits it is not. Same defensive export shape as the helpers above.
 */
export function observationStatus(reply: unknown): string | null {
  const value = (reply as any)?.observation_status;
  return typeof value === "string" && value ? value.slice(0, 40) : null;
}

/** git's own success line, `[branch 0a1b2c3] subject`. Its presence is how this repo proves a commit exited 0. */
export function commitSha(output: unknown): string {
  const m = /\[[\w./-]+\s+([0-9a-f]{7,40})\]/.exec(String(output ?? ""));
  return m ? m[1] : "";
}

/** Paths out of `git show --stat` (` backend/a.py | 2 +-`), renames reduced to their destination. */
export function statPaths(stat: unknown): string[] {
  const out: string[] = [];
  for (const line of String(stat ?? "").split(/\r?\n/)) {
    const m = /^ (.+?)\s+\|\s+(?:\d+|Bin)\b/.exec(line);
    if (!m) continue;
    let p = m[1].trim();
    if (p.includes("=>")) p = p.slice(p.lastIndexOf("=>") + 2).trim().replace(/[{}]/g, "").replace(/\/{2,}/g, "/");
    if (p) out.push(p);
  }
  return out;
}
