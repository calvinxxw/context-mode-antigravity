// Hook -> MCP server workspace and session handoff for Google Antigravity.
// Antigravity spawns plugin MCP servers with cwd = PLUGIN_ROOT and agy 1.5.x does not advertise MCP roots/list,
// while every Antigravity hook receives the real workspace cwd and conversationId on stdin JSON.
// D-CI-PERF-3: node:fs through getBuiltinModule so hook.mjs adds no static node:fs import overhead.
const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
import { isAbsolute, join, relative } from "node:path";
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

export interface ReadAntigravityContextOptions {
  /** Known workspace path (e.g. from MCP roots/list or spawn cwd); looks up its dedicated session in byCwd. */
  preferCwd?: string;
  /** Optional absolute file/dir path from tool input (e.g. ctx_execute(file) or ctx_index(path)) to pin the matching workspace. */
  inputPath?: string;
  /** Override current timestamp (ms) for deterministic testing. */
  now?: number;
}

interface StoredContextFile {
  cwd: string;
  sessionId: string;
  updatedAt: number;
  lastTool?: AntigravityContext;
  byCwd?: Record<string, AntigravityContext>;
}

const MAX_BY_CWD_ENTRIES = 32;
// Freshness window for PreToolUse own-tool handoff: takes precedence over idle PreInvocation/SessionStart in another window.
const LAST_TOOL_FRESH_MS = 10000;

function realOrSame(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function normKey(p: string): string {
  const real = realOrSame(p);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function isExcluded(cwd: string, excludeDirs: readonly (string | undefined)[]): boolean {
  const target = normKey(cwd);
  for (const dir of excludeDirs) {
    if (dir !== undefined && dir !== "" && normKey(dir) === target) return true;
  }
  return false;
}

function isPathInside(rootDir: string, targetPath: string): boolean {
  const rel = relative(normKey(rootDir), normKey(targetPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code?: unknown }).code) : undefined;
}

function parseEntry(raw: unknown, excludeDirs: readonly (string | undefined)[]): AntigravityContext | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const cwd = typeof rec.cwd === "string" ? rec.cwd : "";
  if (cwd === "" || !isAbsolute(cwd) || !fs.existsSync(cwd)) return null;
  if (isExcluded(cwd, excludeDirs)) return null;
  const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
  const updatedAt = typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;
  return { cwd, sessionId, updatedAt };
}

function readRawFile(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  try {
    const file = antigravityContextPath(env);
    if (file === null || !fs.existsSync(file)) return null;
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** <dataRoot>/antigravity-context.json, or null when no home/data dir can be resolved. Never throws. */
export function antigravityContextPath(env: NodeJS.ProcessEnv): string | null {
  try {
    return join(resolveConfigDir(env), ANTIGRAVITY_CONTEXT_FILE);
  } catch {
    return null;
  }
}

/**
 * Read the active Antigravity workspace and session written by hooks, avoiding multi-window clobbering:
 * 1. Exact workspace match in `byCwd` when `preferCwd` is known;
 * 2. Longest containing workspace in `byCwd` when `inputPath` is an absolute path inside a known workspace;
 * 3. Fresh `lastTool` stamp written by PreToolUse on own ctx_* tools (beats idle SessionStart/PreInvocation from other windows);
 * 4. Top-level `{ cwd, sessionId, updatedAt }` fallback (backward compatible).
 * Never throws.
 */
export function readAntigravityContext(
  env: NodeJS.ProcessEnv,
  excludeDirs: readonly (string | undefined)[] = [],
  opts: ReadAntigravityContextOptions = {},
): AntigravityContext | null {
  try {
    const rec = readRawFile(env);
    if (rec === null) return null;
    const allExcluded = [env[ANTIGRAVITY_PLUGIN_ROOT_ENV], ...excludeDirs];
    const byCwdEntries: AntigravityContext[] = [];
    if (typeof rec.byCwd === "object" && rec.byCwd !== null && !Array.isArray(rec.byCwd)) {
      for (const v of Object.values(rec.byCwd as Record<string, unknown>)) {
        const parsed = parseEntry(v, allExcluded);
        if (parsed !== null) byCwdEntries.push(parsed);
      }
    }

    if (opts.preferCwd !== undefined && opts.preferCwd !== "" && isAbsolute(opts.preferCwd)) {
      const wantKey = normKey(opts.preferCwd);
      const hit = byCwdEntries.find((e) => normKey(e.cwd) === wantKey);
      if (hit !== undefined) return hit;
    }

    if (opts.inputPath !== undefined && opts.inputPath !== "" && isAbsolute(opts.inputPath)) {
      let best: AntigravityContext | null = null;
      let bestLen = -1;
      for (const entry of byCwdEntries) {
        if (isPathInside(entry.cwd, opts.inputPath)) {
          const len = normKey(entry.cwd).length;
          if (len > bestLen || (len === bestLen && best !== null && entry.updatedAt > best.updatedAt)) {
            best = entry;
            bestLen = len;
          }
        }
      }
      if (best !== null) return best;
    }

    const now = opts.now ?? Date.now();
    const lastTool = parseEntry(rec.lastTool, allExcluded);
    if (lastTool !== null && now - lastTool.updatedAt <= LAST_TOOL_FRESH_MS) {
      return lastTool;
    }

    return parseEntry(rec, allExcluded);
  } catch {
    return null;
  }
}

/** Atomically record the active Antigravity workspace and conversationId (with per-workspace byCwd map and PreToolUse lastTool). Never throws. */
export function writeAntigravityContext(
  env: NodeJS.ProcessEnv,
  input: { cwd: string; sessionId: string; isOwnToolCall?: boolean },
): void {
  try {
    const cwd = input.cwd;
    if (cwd === "" || !isAbsolute(cwd) || !fs.existsSync(cwd)) return;
    if (isExcluded(cwd, [env[ANTIGRAVITY_PLUGIN_ROOT_ENV]])) return;
    const file = antigravityContextPath(env);
    if (file === null) return;
    const now = Date.now();
    const prev = readRawFile(env);
    const excludeOwn = [env[ANTIGRAVITY_PLUGIN_ROOT_ENV]];
    const byCwd: Record<string, AntigravityContext> = {};
    if (prev !== null && typeof prev.byCwd === "object" && prev.byCwd !== null && !Array.isArray(prev.byCwd)) {
      for (const v of Object.values(prev.byCwd as Record<string, unknown>)) {
        const entry = parseEntry(v, excludeOwn);
        if (entry !== null) byCwd[normKey(entry.cwd)] = entry;
      }
    } else if (prev !== null) {
      const legacy = parseEntry(prev, excludeOwn);
      if (legacy !== null) byCwd[normKey(legacy.cwd)] = legacy;
    }

    const entry: AntigravityContext = { cwd, sessionId: input.sessionId, updatedAt: now };
    const key = normKey(cwd);
    const prevEntry = byCwd[key];
    const prevTop = prev !== null ? parseEntry(prev, excludeOwn) : null;
    const prevLastTool = prev !== null ? parseEntry(prev.lastTool, excludeOwn) : null;

    // Skip unchanged non-tool writes to minimize disk churn, but always stamp fresh updatedAt for own ctx_* PreToolUse calls.
    if (
      input.isOwnToolCall !== true
      && prevTop !== null && prevTop.cwd === cwd && prevTop.sessionId === input.sessionId
      && prevEntry !== undefined && prevEntry.sessionId === input.sessionId
    ) {
      return;
    }

    byCwd[key] = entry;
    const pruned = Object.entries(byCwd)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_BY_CWD_ENTRIES);
    const nextByCwd: Record<string, AntigravityContext> = Object.fromEntries(pruned);

    const doc: StoredContextFile = {
      cwd,
      sessionId: input.sessionId,
      updatedAt: now,
      byCwd: nextByCwd,
      ...(input.isOwnToolCall === true ? { lastTool: entry } : prevLastTool !== null ? { lastTool: prevLastTool } : {}),
    };

    const dir = resolveConfigDir(env);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(doc) + "\n";
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
