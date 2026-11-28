import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildMatcher } from "../build/manifests.ts";
import { decode, POST_EDIT_TOOL_NAMES } from "../src/adapters/antigravity.ts";
import { getAdapter } from "../src/adapters/table.ts";
import { ANTIGRAVITY_EXEC_TIMEOUT_MS } from "../src/core/contracts/constants.ts";
import { handleHook } from "../src/core/hooks/dispatch.ts";
import { readSessionEvents } from "../src/core/journal/read.ts";
import { composeMatcher } from "../src/core/ops/doctor-config.ts";
import { decide } from "../src/core/policy/decide.ts";
import { resolveProject } from "../src/core/project/resolve.ts";
import { closeDb, openDb } from "../src/core/store/db.ts";
import { ctxExecute } from "../src/core/tools/execute.ts";

function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-agy-compat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("Antigravity × agy-fast compatibility patches", () => {
  test("Patch A: PostToolUse matcher includes agy-fast apply_edits while PreToolUse stays narrow", () => {
    const row = getAdapter("antigravity");
    const preBuild = buildMatcher(row, "PreToolUse");
    const postBuild = buildMatcher(row, "PostToolUse");
    const preDoctor = composeMatcher(row, "PreToolUse");
    const postDoctor = composeMatcher(row, "PostToolUse");

    assert.equal(preBuild, preDoctor);
    assert.equal(postBuild, postDoctor);
    for (const toolName of POST_EDIT_TOOL_NAMES) {
      assert.equal(new RegExp(preBuild).test(toolName), false, `PreToolUse must skip ${toolName}`);
      assert.equal(new RegExp(postBuild).test(toolName), true, `PostToolUse must track ${toolName}`);
    }
  });

  test("Patch A: decode maps agy-fast apply_edits (eager and lazy) to Edit with resolved file_paths", () => {
    const workDir = path.resolve(tmpdir(), "proj-demo");
    const eager = decode({
      hookEventName: "PostToolUse",
      conversationId: "conv-1",
      cwd: workDir,
      toolCall: {
        name: "mcp_agy-fast_fast_apply_edits",
        args: {
          cwd: workDir,
          edits: [
            { path: "src/a.ts", hunks: [{ target: "x", replacement: "y" }] },
            { path: "src/b.ts", hunks: [{ target: "1", replacement: "2" }] },
          ],
        },
      },
    });
    assert.equal(eager.tool?.canonicalName, "Edit");
    assert.deepEqual(eager.tool?.input.file_paths, [
      path.resolve(workDir, "src/a.ts"),
      path.resolve(workDir, "src/b.ts"),
    ]);
    assert.equal(eager.tool?.input.file_path, path.resolve(workDir, "src/a.ts"));

    const lazy = decode({
      hookEventName: "PostToolUse",
      conversationId: "conv-1",
      cwd: workDir,
      toolCall: {
        name: "call_mcp_tool",
        args: {
          ServerName: "agy-fast_fast",
          ToolName: "apply_edits",
          Arguments: {
            cwd: workDir,
            edits: JSON.stringify([{ path: "src/c.ts", hunks: [] }]),
          },
        },
      },
    });
    assert.equal(lazy.tool?.canonicalName, "Edit");
    assert.deepEqual(lazy.tool?.input.file_paths, [path.resolve(workDir, "src/c.ts")]);
  });

  test("Patch A: PostToolUse journals every file edited by apply_edits and skips dryRun", async (t) => {
    const work = tmp(t);
    const dataDir = tmp(t);
    const env = { ...process.env, CONTEXT_MODE_DATA_DIR: dataDir };
    const sessionId = "agy-batch-edit-session";

    await handleHook("antigravity", {
      hookEventName: "PostToolUse",
      conversationId: sessionId,
      cwd: work,
      toolCall: {
        name: "mcp_agy-fast_fast_apply_edits",
        args: {
          cwd: work,
          edits: [
            { path: "a.mjs", hunks: [{ target: "a", replacement: "b" }] },
            { path: "b.mjs", hunks: [{ target: "c", replacement: "d" }] },
          ],
        },
      },
    }, env);

    // dryRun must NOT add edit rows
    await handleHook("antigravity", {
      hookEventName: "PostToolUse",
      conversationId: sessionId,
      cwd: work,
      toolCall: {
        name: "mcp_agy-fast_fast_apply_edits",
        args: {
          cwd: work,
          dryRun: true,
          edits: [{ path: "dry.mjs", hunks: [] }],
        },
      },
    }, env);

    const project = resolveProject("antigravity", { env, cwd: work, argv: [] });
    // Wait briefly for detached journal write to flush
    let edits = [];
    for (let i = 0; i < 20; i++) {
      const db = await openDb(project);
      try {
        edits = readSessionEvents(db, sessionId).filter((e) => e.kind === "edit").map((e) => e.path);
      } finally {
        closeDb(db);
      }
      if (edits.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(edits.sort(), [path.resolve(work, "a.mjs"), path.resolve(work, "b.mjs")].sort());
  });

  test("Patch B: ctx_execute preserves partial stdout before timeout and defines 150s Antigravity cap", async (t) => {
    assert.equal(ANTIGRAVITY_EXEC_TIMEOUT_MS, 150000);
    const work = tmp(t);
    const dataDir = tmp(t);
    const env = { ...process.env, CONTEXT_MODE_DATA_DIR: dataDir };
    const project = resolveProject("antigravity", { env, cwd: work, argv: [] });

    const reply = await ctxExecute.handler(
      {
        language: "javascript",
        code: 'console.log("PARTIAL_OK_LINE"); setTimeout(() => console.log("LATE"), 10000);',
        timeoutMs: 400,
      },
      {
        project,
        agent: "antigravity",
        sessionId: "timeout-partial-test",
        signal: new AbortController().signal,
      },
    );
    assert.equal(reply.isError, true);
    assert.ok(reply.text.includes("400"), reply.text);
    assert.ok(reply.text.includes("PARTIAL_OK_LINE"), reply.text);
  });

  test("Patch C: Antigravity PreToolUse allows loopback HTTP probes while denying external HTTP", (t) => {
    const work = tmp(t);
    const agyRow = getAdapter("antigravity");
    const codexRow = getAdapter("codex");

    const allowCurl = decide(
      decode({
        hookEventName: "PreToolUse",
        conversationId: "c1",
        cwd: work,
        toolCall: { name: "run_command", args: { CommandLine: "curl http://127.0.0.1:3888/api/health" } },
      }),
      agyRow,
      [],
      work,
    );
    assert.equal(allowCurl.kind, "allow");

    const allowInline = decide(
      decode({
        hookEventName: "PreToolUse",
        conversationId: "c1",
        cwd: work,
        toolCall: { name: "run_command", args: { CommandLine: "node -e \"fetch('http://localhost:3888/api/bootstrap')\"" } },
      }),
      agyRow,
      [],
      work,
    );
    assert.equal(allowInline.kind, "allow");

    const denyExternal = decide(
      decode({
        hookEventName: "PreToolUse",
        conversationId: "c1",
        cwd: work,
        toolCall: { name: "run_command", args: { CommandLine: "curl https://example.com/data.json" } },
      }),
      agyRow,
      [],
      work,
    );
    assert.equal(denyExternal.kind, "deny");

    const denyMixed = decide(
      decode({
        hookEventName: "PreToolUse",
        conversationId: "c1",
        cwd: work,
        toolCall: { name: "run_command", args: { CommandLine: "curl http://127.0.0.1:3888/ && curl https://example.com/" } },
      }),
      agyRow,
      [],
      work,
    );
    assert.equal(denyMixed.kind, "deny");

    // Non-antigravity host keeps strict upstream behavior
    const codexDeny = decide(
      {
        event: "PreToolUse",
        agent: "codex",
        sessionId: "c2",
        cwd: work,
        tool: { name: "Bash", canonicalName: "Bash", input: { command: "curl http://127.0.0.1:3888/" } },
      },
      codexRow,
      [],
      work,
    );
    assert.equal(codexDeny.kind, "deny");
  });
});
