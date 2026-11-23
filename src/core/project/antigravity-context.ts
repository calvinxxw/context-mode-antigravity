// Hook -> MCP server workspace and session handoff for Google Antigravity.
// Antigravity spawns plugin MCP servers with cwd = PLUGIN_ROOT and agy 1.5.x does not advertise MCP roots/list,
// while every Antigravity hook receives the real workspace cwd and conversationId on stdin JSON.
// D-CI-PERF-3: node:fs through getBuiltinModule so hook.mjs adds no static node:fs import overhead.
const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
import { isAbsolute, join } from "node:path";
import {
  ANTIGRAVITY_CONTEXT_FILE,
  ANTIGRAVITY_PLUGIN_ROOT_ENV,
  ATOMIC_RENAME_BUSY_CODES,
  ATOMIC_RENAME_DELAY_MS,
  ATOMIC_RENAME_RETRIES,
  ATOMIC_TMP_MARK,
  ATOMIC_TMP_PREFIX,
} from "../contracts/constants.ts";
import { resolveConfigDir } from "./config-dir.ts";

export interface AntigravityContext {
  cwd: string;
  sessionId: string;
  updatedAt: number;
}

function realOrSame(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function isExcluded(cwd: string, excludeDirs: readonly (string | undefined)[]): boolean {
  const target = realOrSame(cwd);
  for (const dir of excludeDirs) {
    if (dir !== undefined && dir !== "" && realOrSame(dir) === target) return true;
  }
  return false;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code?: unknown }).code) : undefined;
}

/** <dataRoot>/antigravity-context.json, or null when no home/data dir can be resolved. Never throws. */
export function antigravityContextPath(env: NodeJS.ProcessEnv): string | null {
  try {
    return join(resolveConfigDir(env), ANTIGRAVITY_CONTEXT_FILE);
  } catch {
    return null;
  }
}

/** Read the last active Antigravity workspace and session written by hooks; null when absent, corrupt, missing on disk, or excluded. Never throws. */
export function readAntigravityContext(
  env: NodeJS.ProcessEnv,
  excludeDirs: readonly (string | undefined)[] = [],
): AntigravityContext | null {
  try {
    const file = antigravityContextPath(env);
    if (file === null || !fs.existsSync(file)) return null;
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const cwd = typeof rec.cwd === "string" ? rec.cwd : "";
    if (cwd === "" || !isAbsolute(cwd) || !fs.existsSync(cwd)) return null;
    if (isExcluded(cwd, [env[ANTIGRAVITY_PLUGIN_ROOT_ENV], ...excludeDirs])) return null;
    const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
    const updatedAt = typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;
    return { cwd, sessionId, updatedAt };
  } catch {
    return null;
  }
}

/** Atomically record the active Antigravity workspace and conversationId. Skips unchanged writes; never throws. */
export function writeAntigravityContext(
  env: NodeJS.ProcessEnv,
  input: { cwd: string; sessionId: string },
): void {
  try {
    const cwd = input.cwd;
    if (cwd === "" || !isAbsolute(cwd) || !fs.existsSync(cwd)) return;
    if (isExcluded(cwd, [env[ANTIGRAVITY_PLUGIN_ROOT_ENV]])) return;
    const file = antigravityContextPath(env);
    if (file === null) return;
    const existing = readAntigravityContext(env);
    if (existing !== null && existing.cwd === cwd && existing.sessionId === input.sessionId) return;
    const dir = resolveConfigDir(env);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ cwd, sessionId: input.sessionId, updatedAt: Date.now() }) + "\n";
    const tmp = join(dir, `${ATOMIC_TMP_PREFIX}${ANTIGRAVITY_CONTEXT_FILE}${ATOMIC_TMP_MARK}${process.pid}`);
    try {
      fs.writeFileSync(tmp, payload);
      const win = process.platform === "win32";
      for (let attempt = 0; ; attempt += 1) {
        try {
          fs.renameSync(tmp, file);
          break;
        } catch (e) {
          const busy = win && ATOMIC_RENAME_BUSY_CODES.includes(errCode(e) ?? "");
          if (!busy || attempt >= ATOMIC_RENAME_RETRIES) throw e;
          sleepSync(ATOMIC_RENAME_DELAY_MS);
        }
      }
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* leftover tmp file */ }
    }
  } catch {
    // Hooks must stay fail-open: never block the host on handoff write failure.
  }
}
