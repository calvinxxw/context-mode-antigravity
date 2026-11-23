# Install context-mode v2 on Antigravity

## Install

```sh
agy plugin install https://github.com/calvinxxw/context-mode
```

Update:

```sh
context-mode upgrade
```

(For a native plugin install without npm, run `agy plugin uninstall context-mode` followed by `agy plugin install https://github.com/calvinxxw/context-mode`.)

Check: `context-mode doctor`

The plugin brings the MCP server (`mcp_config.json`, run with `--agent antigravity`), the four lifecycle hooks (`hooks.json`), and the skills `/ctx-doctor`, `/ctx-stats` and `/ctx-upgrade`. Antigravity App, Antigravity CLI (`agy`) and Antigravity IDE share the same plugin directory (`~/.gemini/config/plugins/context-mode`), so one install covers all three surfaces. Setup writes nothing when Antigravity lists the plugin as enabled, so no second hook copy runs.

`npm i -g context-mode` also gives the `context-mode` command for doctor.

Setup is the fallback and the repair for what the native step cannot do:

```sh
context-mode setup --agents antigravity
```

With no terminal (a script or CI), add `--yes`: `context-mode setup --yes --agents antigravity`. Without it, setup stops with exit 2.

Restart Antigravity (or start a new CLI session) after the install and after each update.

To do the setup step by hand, run `context-mode setup --print antigravity` and follow what it prints.

## What setup changes (when Antigravity has no context-mode plugin)

- Adds the `context-mode` server to `~/.gemini/config/mcp_config.json` under `mcpServers`, with the five hot-path tools (`ctx_execute`, `ctx_batch`, `ctx_index`, `ctx_search`, `ctx_resume`) marked `eager: true` so Antigravity exposes them directly without lazy-load indirection. Other servers stay.
- Merges the hooks into `~/.gemini/config/hooks.json` under the `context-mode` group (`enabled: true`) for `SessionStart`, `PreInvocation`, `PreToolUse` and `PostToolUse`.
- Writes the skills `/ctx-doctor`, `/ctx-stats` and `/ctx-upgrade` to `~/.gemini/config/skills/<name>/SKILL.md`.
- Effect: a large `run_command`, `view_file` / `read_file` or `read_url_content` call is denied before execution, and the reason names `ctx_execute` or `ctx_index` (deny + redirect). Ranged reads (`StartLine` / `EndLine`), image/PDF reads, and edits pass through.
- Backs up each file first. A failed step is rolled back byte for byte.
- Never edits `AGENTS.md`, `GEMINI.md` or other instruction files.

## Verify

```sh
context-mode doctor --agents antigravity
agy plugin list
```

`context-mode` must be listed as `enabled`. Then run `/ctx-doctor` in Antigravity.

## Remove

```sh
agy plugin uninstall context-mode
```

If you also ran setup, undo it first:

```sh
context-mode setup --remove --agents antigravity
```

It puts each touched file back. To remove the package too, see [Uninstall](./README.md#uninstall).

## Known limits

- Antigravity `PostToolUse` hooks do not receive the tool's stdout or content body, so Context Mode uses deny + redirect (`PreToolUse`) rather than post-execution output replacement.
- `agy plugin` has no `update` subcommand in `agy 1.5.x`; update the native plugin by uninstalling and reinstalling it.
- Native plugin hooks run directly from the staged plugin root with `node ./hook.mjs --agent antigravity`; global setup hooks use the resolved absolute `node` path.

## Report a problem

Run `context-mode doctor --agents antigravity`. A failed check prints a `gh issue create` command and a report file under `~/.context-mode/reports/`. Open the [v2 bug form](https://github.com/mksglu/context-mode/issues/new?template=bug.yml) and paste the report.

## Verified

Tested on Windows 11 (x64), Node 24.22.2, `agy 1.5.14`, clean temporary HOME and local `agy plugin validate`.

| Command | Antigravity version | Date | Result |
|---|---|---|---|
| `agy plugin validate --json ./release-out` | `agy 1.5.14` | 2026-11-23 | Pass: 0 errors, `.antigravity-plugin/plugin.json` recognized (`hooks: 1`, `mcpServers: 1`, `skills: 3`) |
| `agy plugin validate --json .` | `agy 1.5.14` | 2026-11-23 | Pass: 0 errors on repo root |
| `context-mode setup --yes --agents antigravity` | `agy 1.5.14` | 2026-11-23 | Pass: `~/.gemini/config/{mcp_config,hooks}.json` and skills written |
| `context-mode doctor --agents antigravity` | `agy 1.5.14` | 2026-11-23 | Pass |
| `context-mode setup --remove --yes` | `agy 1.5.14` | 2026-11-23 | Pass: files restored |
