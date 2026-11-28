// Native Google Antigravity adapter (Antigravity App, Antigravity CLI `agy`, Antigravity IDE).
// Contract: https://antigravity.google/docs/hooks.md and https://antigravity.google/docs/build-plugins.md.
// Native events: SessionStart / PreInvocation (-> UserPromptSubmit) / PreToolUse / PostToolUse, plus Stop/PostInvocation.
// Payloads use camelCase (protojson): hookEventName, conversationId, cwd, workspacePaths, lastUserInput, toolCall {id, name, args}, error.
// PostToolUse receives the tool call and optional error (never the tool output) and expects {}, so Antigravity is a deny+redirect host.
import { isAbsolute, resolve } from "node:path";
import type { CanonicalEventName, CanonicalHookEvent, Decision, HookOutput, ToolCall, ToolResultInfo } from "../core/contracts/types.ts";

// Global mcp_config.json eager tool prefix: mcp_<serverName>_<toolName> (https://antigravity.google/docs/mcp.md).
export const TOOL_NAME_PREFIX = "mcp_context-mode_";
// Plugin mcp_config.json namespaces the server as <pluginName>_<serverName> (https://antigravity.google/docs/build-plugins.md).
export const PLUGIN_TOOL_NAME_PREFIX = "mcp_context-mode_context-mode_";
const UNDERSCORE_TOOL_PREFIX = "mcp_context_mode_";

// Native tool names across Antigravity App / IDE (view_file, write_to_file, replace_file_content, multi_replace_file_content)
// and Antigravity CLI (read_file, write_file, edit_file).
export const SHELL_TOOL_NAMES: readonly string[] = Object.freeze(["run_command"]);
export const READ_TOOL_NAMES: readonly string[] = Object.freeze(["view_file", "read_file"]);
export const GREP_TOOL_NAMES: readonly string[] = Object.freeze(["grep_search"]);
export const WEBFETCH_TOOL_NAMES: readonly string[] = Object.freeze(["read_url_content"]);
export const EDIT_TOOL_NAMES: readonly string[] = Object.freeze([
  "write_to_file", "replace_file_content", "multi_replace_file_content", "write_file", "edit_file",
]);
// Companion multi-file edit MCP tools tracked on PostToolUse only (never on PreToolUse so latency stays ~0).
export const POST_EDIT_TOOL_NAMES: readonly string[] = Object.freeze([
  "mcp_agy-fast_fast_apply_edits",
]);
// Antigravity lazy MCP dispatcher matched on PreToolUse so lazy ctx_* tools (ctx_stats, ctx_doctor, ctx_upgrade, ctx_purge)
// refresh antigravity-context.json with the active window's cwd/conversationId immediately before MCP execution.
export const PRE_CONTEXT_TOOL_NAMES: readonly string[] = Object.freeze([
  "call_mcp_tool",
]);

export const EVENT_MAP: Readonly<Record<CanonicalEventName, string>> = Object.freeze({
  SessionStart: "SessionStart",
  UserPromptSubmit: "PreInvocation",
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
});

type Event = CanonicalHookEvent["event"];
const ANTIGRAVITY_EVENTS: Readonly<Record<string, Event>> = {
  SessionStart: "SessionStart",
  PreInvocation: "UserPromptSubmit",
  UserPromptSubmit: "UserPromptSubmit",
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  PostInvocation: "Stop",
  Stop: "Stop",
};

const NATIVE_TO_CANONICAL: Readonly<Record<string, string>> = {
  run_command: "Bash",
  view_file: "Read",
  read_file: "Read",
  grep_search: "Grep",
  read_url_content: "WebFetch",
  write_to_file: "Write",
  write_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  edit_file: "Edit",
  "mcp_agy-fast_fast_apply_edits": "Edit",
  ask_question: "AskUserQuestion",
};

const CALL_MCP_TOOL = "call_mcp_tool";
const OWN_SERVER_NAMES: readonly string[] = ["context-mode", "context-mode_context-mode"];
const OWN_TOOL_PREFIX = "ctx_";
const MCP_PREFIX = "mcp_";
const MCP_SEP = "_";

const EMPTY_JSON: HookOutput = { stdout: "{}", exitCode: 0 };
const ALLOW_PRE_TOOL: HookOutput = { stdout: JSON.stringify({ decision: "allow" }), exitCode: 0 };

function own(p: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(p, key) ? p[key] : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function canonicalName(name: string, args: Record<string, unknown>): string {
  if (name === CALL_MCP_TOOL) {
    const server = str(own(args, "ServerName"));
    const tool = str(own(args, "ToolName"));
    if (server !== undefined && tool !== undefined) {
      if (OWN_SERVER_NAMES.includes(server) && tool.startsWith(OWN_TOOL_PREFIX)) return tool;
      if (server === "agy-fast_fast" && tool === "apply_edits") return "Edit";
      return "mcp:" + server + ":" + tool;
    }
    return name;
  }
  if (name.startsWith(PLUGIN_TOOL_NAME_PREFIX)) return name.slice(PLUGIN_TOOL_NAME_PREFIX.length);
  if (name.startsWith(TOOL_NAME_PREFIX)) return name.slice(TOOL_NAME_PREFIX.length);
  if (name.startsWith(UNDERSCORE_TOOL_PREFIX)) return name.slice(UNDERSCORE_TOOL_PREFIX.length);
  if (Object.hasOwn(NATIVE_TO_CANONICAL, name)) return NATIVE_TO_CANONICAL[name];
  if (!name.startsWith(MCP_PREFIX)) return name;
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf(MCP_SEP);
  if (sep <= 0 || sep === rest.length - 1) return name;
  return "mcp:" + rest.slice(0, sep) + ":" + rest.slice(sep + MCP_SEP.length);
}

/** Extract file paths from agy-fast apply_edits `{ cwd?, edits: [{ path }] }` (supports JSON string edits). */
function extractBatchEditPaths(args: Record<string, unknown>): string[] {
  let editsRaw = own(args, "edits");
  if (typeof editsRaw === "string") {
    try { editsRaw = JSON.parse(editsRaw); } catch { return []; }
  }
  if (!Array.isArray(editsRaw)) return [];
  const baseCwd = str(own(args, "cwd"));
  const paths: string[] = [];
  for (const item of editsRaw) {
    if (!isRecord(item)) continue;
    const rawPath = str(own(item, "path"));
    if (rawPath === undefined) continue;
    const resolved = baseCwd !== undefined && !isAbsolute(rawPath) ? resolve(baseCwd, rawPath) : rawPath;
    if (!paths.includes(resolved)) paths.push(resolved);
  }
  return paths;
}

/** Normalize Antigravity PascalCase tool arguments into the canonical keys decide() and dispatch() read, keeping all original keys. */
function normalizeInput(name: string, canonical: string, args: Record<string, unknown>): Record<string, unknown> {
  const effectiveArgs = name === CALL_MCP_TOOL && isRecord(own(args, "Arguments"))
    ? { ...args, ...(own(args, "Arguments") as Record<string, unknown>) }
    : args;
  if (name === CALL_MCP_TOOL && canonical !== "Edit") return effectiveArgs;
  const out: Record<string, unknown> = { ...effectiveArgs };
  if (canonical === "Bash") {
    const cmd = str(own(effectiveArgs, "CommandLine")) ?? str(own(effectiveArgs, "command"));
    if (cmd !== undefined && own(out, "command") === undefined) out.command = cmd;
    const desc = str(own(effectiveArgs, "toolSummary")) ?? str(own(effectiveArgs, "description"));
    if (desc !== undefined && own(out, "description") === undefined) out.description = desc;
  } else if (canonical === "Read") {
    const fp = str(own(effectiveArgs, "AbsolutePath")) ?? str(own(effectiveArgs, "Path")) ?? str(own(effectiveArgs, "file_path"));
    if (fp !== undefined && own(out, "file_path") === undefined) out.file_path = fp;
    const start = own(effectiveArgs, "StartLine");
    if (start !== undefined && start !== null && own(out, "offset") === undefined) out.offset = start;
    const end = own(effectiveArgs, "EndLine");
    if (end !== undefined && end !== null && own(out, "limit") === undefined) out.limit = end;
  } else if (canonical === "Grep") {
    const pat = str(own(effectiveArgs, "Query")) ?? str(own(effectiveArgs, "Pattern"));
    if (pat !== undefined && own(out, "pattern") === undefined) out.pattern = pat;
    const sp = str(own(effectiveArgs, "SearchPath"));
    if (sp !== undefined && own(out, "path") === undefined) out.path = sp;
  } else if (canonical === "WebFetch") {
    const url = str(own(effectiveArgs, "Url")) ?? str(own(effectiveArgs, "url"));
    if (url !== undefined && own(out, "url") === undefined) out.url = url;
  } else if (canonical === "Write" || canonical === "Edit") {
    const fp = str(own(effectiveArgs, "TargetFile")) ?? str(own(effectiveArgs, "Path")) ?? str(own(effectiveArgs, "file_path"));
    if (fp !== undefined && own(out, "file_path") === undefined) out.file_path = fp;
    const batchPaths = extractBatchEditPaths(effectiveArgs);
    if (batchPaths.length > 0) {
      out.file_paths = batchPaths;
      if (own(out, "file_path") === undefined) out.file_path = batchPaths[0];
    }
  }
  return out;
}

function cwdOf(p: Record<string, unknown>): string {
  const direct = str(own(p, "cwd"));
  if (direct !== undefined) return direct;
  const wsPaths = own(p, "workspacePaths");
  if (Array.isArray(wsPaths)) {
    const first = wsPaths.find((x): x is string => typeof x === "string" && x !== "");
    if (first !== undefined) return first;
  }
  const ws = own(p, "workspace");
  if (isRecord(ws)) {
    const cur = str(own(ws, "current_dir"));
    if (cur !== undefined) return cur;
  }
  return "";
}

function readResult(p: Record<string, unknown>): ToolResultInfo {
  const err = own(p, "error");
  const isError = typeof err === "string" && err !== "";
  const text = isError ? err : "";
  return { isError, bytes: Buffer.byteLength(text), text };
}

export function decode(raw: unknown): CanonicalHookEvent {
  if (!isRecord(raw)) throw new Error("antigravity: hook payload is not a JSON object");
  const native = own(raw, "hookEventName") ?? own(raw, "hook_event_name");
  const event = typeof native === "string" && Object.hasOwn(ANTIGRAVITY_EVENTS, native) ? ANTIGRAVITY_EVENTS[native] : undefined;
  if (event === undefined) throw new Error("antigravity: unknown hook event " + String(native));
  const sessionId = str(own(raw, "conversationId")) ?? str(own(raw, "session_id")) ?? str(own(raw, "sessionId")) ?? "";
  const ev: CanonicalHookEvent = { event, agent: "antigravity", sessionId, cwd: cwdOf(raw) };
  const inv = own(raw, "invocationNum");
  const step = own(raw, "stepIdx");
  if (typeof inv === "number" && Number.isSafeInteger(inv)) ev.turn = inv;
  else if (typeof step === "number" && Number.isSafeInteger(step)) ev.turn = step;
  if (event === "SessionStart") ev.source = "startup";
  if (event === "UserPromptSubmit") {
    const prompt = own(raw, "lastUserInput") ?? own(raw, "prompt");
    if (typeof prompt === "string") ev.prompt = prompt;
  }
  if (event === "PreToolUse" || event === "PostToolUse") {
    const tc = own(raw, "toolCall");
    const call = isRecord(tc) ? tc : undefined;
    const name = String((call ? own(call, "name") : own(raw, "tool_name")) ?? "");
    const rawArgs = call ? own(call, "args") : own(raw, "tool_input");
    const args = isRecord(rawArgs) ? rawArgs : {};
    const canonical = canonicalName(name, args);
    const tool: ToolCall = { name, canonicalName: canonical, input: normalizeInput(name, canonical, args) };
    const id = str(call ? own(call, "id") : own(raw, "tool_use_id"));
    if (id !== undefined) tool.callId = id;
    ev.tool = tool;
  }
  if (event === "PostToolUse") ev.result = readResult(raw);
  return ev;
}

export function encode(ev: CanonicalHookEvent, d: Decision, _extra?: string): HookOutput {
  if (ev.event === "PostToolUse" || ev.event === "Stop") return EMPTY_JSON;
  if (ev.event === "PreToolUse") {
    if (d.kind === "deny") {
      const reason = d.rewritten === undefined ? d.reason : d.rewritten + "\n" + d.reason;
      return { stdout: JSON.stringify({ decision: "deny", reason }), exitCode: 0 };
    }
    return ALLOW_PRE_TOOL;
  }
  if (ev.event === "SessionStart") {
    if (d.kind === "hint") {
      return { stdout: JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: d.text } }] }), exitCode: 0 };
    }
    return EMPTY_JSON;
  }
  if (ev.event === "UserPromptSubmit") {
    if (d.kind === "hint") {
      return { stdout: JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: d.text } }] }), exitCode: 0 };
    }
    if (d.kind === "deny") {
      const reason = d.rewritten === undefined ? d.reason : d.rewritten + "\n" + d.reason;
      return {
        stdout: JSON.stringify({ injectSteps: [{ errorMessage: { userMessage: reason } }], terminationBehavior: "terminate" }),
        exitCode: 0,
      };
    }
    return EMPTY_JSON;
  }
  return EMPTY_JSON;
}
