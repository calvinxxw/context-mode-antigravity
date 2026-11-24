# Antigravity 原生适配开发说明

> 本文档说明在 `calvinxxw/context-mode`（基于上游 `mksglu/context-mode` v2.2.2）上为 **Google Antigravity**（App / CLI `agy` / IDE 共享同一配置体系）完成原生适配的架构设计、协议映射、核心改动与验证方法。

---

## 1. 背景与目标

上游 `context-mode` 曾在 `#1340` / `#1410` 中将 `antigravity` 列入 `UNSUPPORTED_HOSTS`：当用户使用 `agy plugin install` 安装原仓库时，Antigravity 会退回到 `gemini-extension.json` 兼容导入模式，把插件解压到 `~/.gemini/config/plugins/context-mode`，并以插件目录作为 `cwd` 启动 `node server.mjs --agent gemini`。这会导致以下问题：

1. **工作区识别失败（#1410）**：MCP 服务进程默认 `cwd` 指向插件目录，未按 MCP `roots/list` 解析实际项目根目录，触发 `NO_PROJECT` 报错。
2. **Hook 协议不匹配**：Antigravity 的 Hook 采用 camelCase 负载（`hookEventName`、`conversationId`、`toolCall: { id, name, args }`）、顶层命名分组（`{ "context-mode": { "enabled": true, ... } }`）以及与 Gemini CLI / Claude Code 不同的输出 Schema（`decision: "allow" | "deny"`、`injectSteps`）。
3. **原生工具与参数差异**：Antigravity 工具名（`run_command`、`view_file`、`read_file`、`grep_search`、`read_url_content`、`write_to_file`、`replace_file_content`、`multi_replace_file_content`、`write_file`、`edit_file`）及其 PascalCase 参数键（`CommandLine`、`AbsolutePath`、`Path`、`StartLine`、`EndLine`、`Query`、`SearchPath`、`Url`、`TargetFile`）未接入策略引擎。
4. **MCP 工具懒加载开销**：Antigravity 默认以懒加载模式暴露 MCP 工具（需先读取 schema 再经 `call_mcp_tool` 调用），热路径工具无法直接调用。

本次适配的目标是把 `antigravity` 作为 **第 12 个一等原生 Agent** 完整接入 `context-mode`，同时支持：
- **原生插件安装**：`agy plugin install https://github.com/calvinxxw/context-mode`（同时覆盖 Antigravity App、CLI、IDE）。
- **全局 CLI 配置安装**：`context-mode setup --agents antigravity` 与 `context-mode doctor --agents antigravity`。

---

## 2. 架构总览与文件改动清单

### 2.1 契约层与适配器层

| 文件 | 改动说明 |
|---|---|
| `src/core/contracts/agents.ts` | 在 `AGENT_IDS` 中注册 `"antigravity"` 作为第 12 个原生 `AgentId`。 |
| `src/core/contracts/client-map.ts` | 将 MCP `clientInfo.name` 映射 `antigravity` / `antigravity-client` / `antigravity-cli` / `agy` 归一化为 `"antigravity"`。 |
| `src/core/contracts/constants.ts` | 将 `antigravity` 从 `UNSUPPORTED_HOSTS` 移除；新增 `AGENT_HOME_DIR`（`~/.gemini/config`）、`READ_MEDIA_BY_AGENT`（图片+PDF 放行）、`READ_PATH_KEYS`（`AbsolutePath` / `Path`）、`READ_RANGE_KEYS`（`StartLine` / `EndLine`）、`HOOK_FAIL_TOOLS`、`HOOK_HOST_FILE`（`shape: "antigravity"`）、`ANTIGRAVITY_EAGER_TOOLS`、`OWN_MCP_ENTRY`、`UPGRADE_HOST_COMMAND`、`NATIVE_INSTALL`。 |
| `src/adapters/antigravity.ts` | **新增** Antigravity 原生适配器（`decode` / `encode`、工具名与参数归一化、`call_mcp_tool` 解包、全局与插件双 MCP 前缀识别）。 |
| `src/adapters/table.ts` | 在 `ADAPTERS` 声明表中注册 `antigravity` 行，并加入 `RECALL_ROWS`。 |
| `tests/fixtures/host-schemas/antigravity.json` | **新增** 官方 Antigravity Hook 返回值 JSON Schema（覆盖 `PreToolUse`、`PostToolUse`、`SessionStart`、`UserPromptSubmit`、`Stop`）。 |
| `src/core/ops/hook-shape.ts` | 将 `antigravity.json` 注册到 `HOST_SHAPES`，用于编译期/测试期及 fuzz 校验所有 Hook 输出。 |

### 2.2 Hook 运行时、MCP 服务与策略层

| 文件 | 改动说明 |
|---|---|
| `src/core/hooks/fallback.ts` | 增强异常兜底路径：识别 `toolCall.name` / `toolCall.args` 及 `StartLine` / `EndLine` 区间读，确保大文件兜底拦截与放行一致。 |
| `src/core/project/resolve.ts` | 为 `antigravity` 指定工作区解析策略 `spawn-cwd`，配合 MCP `roots/list` 优先获取真实工作区。 |
| `src/core/policy/own-file.ts` | 将 `~/.gemini/config`、`~/.gemini/antigravity`、`~/.gemini/antigravity-cli`、`~/.gemini/antigravity-ide` 加入自身配置目录保护（放行读写自身配置）。 |
| `src/entries/server.ts` | 1）`workspaceCwdOf` 过滤 `process.env.PLUGIN_ROOT`，防止插件目录被误判为项目根目录；2）`dispatch()` 对 `agent === "antigravity"` 主动通过 MCP `roots/list` 解析客户端打开的真实工作区路径（彻底修复 #1410）。 |
| `src/entries/cli.ts` | 在旧版平台名映射中补充 `antigravity` / `antigravity-cli`。 |

### 2.3 诊断（Doctor）、安装器（Setup）与打包（Build）

| 文件 | 改动说明 |
|---|---|
| `src/core/ops/doctor-config.ts` | 解析 Antigravity `hooks.json` 顶层分组结构；检测 `~/.gemini/config/plugins/context-mode` 原生插件及其 `config.json` 启停状态；同时识别全局前缀 `mcp_context-mode_ctx_*` 与插件前缀 `mcp_context-mode_context-mode_ctx_*` 的 matcher。 |
| `src/core/ops/doctor-hook.ts` | 在 `CWD_KEY` 中注册 `antigravity: "cwd"`。 |
| `src/core/ops/detect-v1.ts` | 新增 `scanAntigravity`，扫描 `~/.gemini/config/hooks.json` 与 `~/.gemini/context-mode`。 |
| `src/setup/hook-shapes.ts` | 新增 `antigravityShape`，将 canonical Hook 列表序列化为 Antigravity 顶层分组格式（`SessionStart`/`PreInvocation` 为平铺数组，`PreToolUse`/`PostToolUse` 为 matcher 分组数组）。 |
| `src/setup/hook-sample.ts` | 新增 Antigravity 原生 camelCase `PreToolUse` 测试样本，供 `context-mode doctor` 与 `setup` 端到端探活。 |
| `src/setup/registry.ts` | 新增 `NATIVE_PLUGIN.antigravity`（通过 `agy plugin list --json` 识别原生安装）、加入 `BARE_NODE_ON_WINDOWS`（Windows 全局配置使用 `cmd /c` 包装）、新增 Antigravity `golden()` 样本。 |
| `src/setup/engine.ts` | 新增 `agyJsonState()` 解析 `agy plugin list --json` 输出，判断 `installed` / `disabled` / `absent` 三态。 |
| `build/manifests.ts` | 新增 `antigravityPlugin()`，构建时生成 `.antigravity-plugin/plugin.json`、`mcp_config.json`、`hooks.json` 及 `hooks/antigravity.json`。 |
| `build/main-tree.mjs` | 同步将 `.antigravity-plugin/plugin.json` 以及指向 `plugins/claude-code/{server,hook}.mjs` 的根级 `mcp_config.json` 与 `hooks.json` 写入仓库根目录，使仓库可直接被 `agy plugin install <repo-url>` 安装。 |
| `build/check-removed.mjs` / `build/check-install-docs.mjs` | 将 Antigravity 产物路径纳入仓库门禁白名单，并将 `antigravity` 加入 `NATIVE_HOSTS`。 |

---

## 3. 核心协议与技术设计详解

### 3.1 Antigravity 插件目录布局（多工具仓库共存规范）

根据 Antigravity 官方多工具插件规范，原生清单位于 `.antigravity-plugin/plugin.json`（优先级高于根级 `plugin.json`，不会与 `.claude-plugin/`、`gemini-extension.json` 冲突），且运行时严格从插件根目录读取 `mcp_config.json` 与 `hooks.json`：

```text
<repo-root / release-out>/
├── .antigravity-plugin/
│   └── plugin.json          # Antigravity 原生清单（displayName, suggestedPrompts 等）
├── mcp_config.json          # MCP Server 配置（使用 ${PLUGIN_ROOT} + 5 个热路径工具 eager: true）
├── hooks.json               # 生命周期 Hook（插件模式 cwd=<plugin-root>，必须使用相对路径）
└── skills/
    ├── ctx-doctor/SKILL.md
    ├── ctx-stats/SKILL.md
    └── ctx-upgrade/SKILL.md
```

> **关键约束**：
> - `mcp_config.json` 中 `args` 支持 `${PLUGIN_ROOT}` 展开，且 Antigravity 会向 MCP 进程注入 `PLUGIN_ROOT` 环境变量。
> - `hooks.json` 中插件 Hook 启动时 `cwd` 固定为插件根目录，且**不展开** `${PLUGIN_ROOT}`，因此必须使用相对路径：`node ./hook.mjs --agent antigravity`（release 包）或 `node ./plugins/claude-code/hook.mjs --agent antigravity`（仓库根目录）。
> - `timeout` 单位为**秒**（默认 `5`）。

### 3.2 Hook 生命周期与 I/O 协议映射

| 内部 Canonical 事件 | Antigravity 原生事件 | Hook 结构形态 | 返回值格式 |
|---|---|---|---|
| `SessionStart` | `SessionStart` | 平铺数组 `[{type, command, timeout}]` | `{"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}` 或 `{}` |
| `UserPromptSubmit` | `PreInvocation` | 平铺数组 `[{type, command, timeout}]` | 注入提示时返回 `injectSteps`，拒绝时返回 `{"decision":"deny","reason":"..."}` |
| `PreToolUse` | `PreToolUse` | Matcher 分组 `[{matcher, hooks:[...]}]` | 放行 `{"decision":"allow"}`；拦截 `{"decision":"deny","reason":"..."}` |
| `PostToolUse` | `PostToolUse` | Matcher 分组 `[{matcher, hooks:[...]}]` | `{}`（仅记录工具错误与操作日志） |
| `Stop` | `Stop` / `PostInvocation` | 平铺数组（可选解码支持） | `{}` |

**为什么采用 Deny + Redirect（`D`）而非 Post-Replace（`R`）？**
Antigravity 的 `PostToolUse` 负载仅包含 `toolCall: { id, name, args }` 与可选的 `error`，**不包含工具执行后的输出文本**，因此无法在 `PostToolUse` 中替换大输出。适配器设置 `hasReplace = false`，策略引擎自动在 `PreToolUse` 阶段拦截大文件整读、`curl`/`wget`、`read_url_content` 及高输出构建/日志命令，并返回清晰的 `reason` 引导模型改用 `ctx_execute` 或 `ctx_index` + `ctx_search`。

### 3.3 原生工具与参数归一化（`src/adapters/antigravity.ts`）

Antigravity App/IDE 与 CLI 存在两套并存的工具名（如 `view_file` 与 `read_file`、`write_to_file`/`replace_file_content`/`multi_replace_file_content` 与 `write_file`/`edit_file`），且内置工具参数采用 **PascalCase**。适配器在 `decode()` 中做统一归一化：

| 类别 | Antigravity 工具名 | 参数归一化映射 |
|---|---|---|
| Shell | `run_command` | `CommandLine` → `command` |
| 文件读取 | `view_file`, `read_file` | `AbsolutePath` / `Path` → `file_path`；`StartLine` → `offset`；`EndLine` → `limit` |
| 搜索 | `grep_search` | `Query` → `pattern`；`SearchPath` → `path` |
| 网页抓取 | `read_url_content` | `Url` → `url` |
| 文件编辑 | `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `write_file`, `edit_file` | `TargetFile` / `Path` / `AbsolutePath` → `file_path` |
| 懒加载 MCP | `call_mcp_tool` | 当 `ServerName === "context-mode"` 或 `ServerName.endsWith("_context-mode")` 时解包 `ToolName` + `Arguments` |

**MCP 工具名前缀双形态**：
- 全局 `~/.gemini/config/mcp_config.json`：`mcp_context-mode_<tool>`
- 插件 `~/.gemini/config/plugins/context-mode/mcp_config.json`：`mcp_context-mode_context-mode_<tool>`

适配器 `isOwnTool()`、`stripOwnTool()` 与 `doctor-config.ts` 的 matcher 校验均同时兼容两种前缀。

### 3.4 MCP 懒加载优化（Eager Tools）

Antigravity 支持在 `mcp_config.json` 的 server 配置下声明 `"tools": { "<name>": { "eager": true } }`，将高频工具直接注入模型的首轮工具列表而无需通过 `call_mcp_tool` 二次加载。
本次将 5 个核心热路径工具设为 `eager: true`：
- `ctx_execute`
- `ctx_batch`
- `ctx_index`
- `ctx_search`
- `ctx_resume`

其余 4 个低频运维工具（`ctx_stats`、`ctx_doctor`、`ctx_upgrade`、`ctx_purge`）保持默认懒加载，从而兼顾上下文节省与热路径零额外往返。

### 3.5 工作区路径解析、会话连续性与插件工具名前缀

当 Antigravity (`agy 1.5.x`) 以插件形式启动 `server.mjs --agent antigravity` 时，子进程 `cwd` 固定为 `~/.gemini/config/plugins/context-mode`（`PLUGIN_ROOT`），且尚未向 MCP Server 提供 `roots/list`；而生命周期 Hook（`SessionStart`、`PreInvocation`、`PreToolUse`、`PostToolUse`）每次都会在 stdin JSON 中携带真实的 `cwd`、`workspacePaths` 与 `conversationId`。本次通过三层机制解决：

1. **三层工作区解析（`src/entries/server.ts` + `src/core/project/antigravity-context.ts`）**：
   - 优先级 1：若客户端支持 MCP `roots/list` 并返回有效根目录，直接使用 `fromRoots`；
   - 优先级 2：`workspaceCwdOf()` 过滤 `PLUGIN_ROOT` 与脚本目录后，若 `spawn-cwd` 为合法工作区，直接使用；
   - 优先级 3：回退读取 `<DATA_ROOT>/antigravity-context.json`（由 `SessionStart`、`PreInvocation` 及 `ctx_*` 的 `PreToolUse` 原子写入，跳过普通 `run_command`/`read_file` 探活以避免污染与 D5 耗时波动）。若尚无交接文件则保持 `NO_PROJECT` 优雅降级。
2. **会话 ID（`conversationId`）桥接**：当 MCP 请求未通过 `_meta` / 环境变量提供 `sessionId` 且交接文件的 `cwd` 与当前解析工作区一致时，MCP Server 复用 Hook 记录的 `conversationId`，使 `ctx_resume`、`ctx_stats` 与 `ctx_search(scope:"session")` 与 Hook 日志无缝打通。
3. **插件工具名前缀动态适配（`src/core/hooks/dispatch.ts` + `fallback.ts`）**：Antigravity 启动插件 Hook 时注入 `PLUGIN_ROOT` 环境变量。检测到 `PLUGIN_ROOT` 非空时自动采用 `mcp_context-mode_context-mode_` 前缀，全局安装（无 `PLUGIN_ROOT`）保持 `mcp_context-mode_`。
4. **`PreInvocation` 重复提示去重（`src/core/hooks/dispatch.ts` + `src/core/compaction/candidates.ts`）**：Antigravity 的 `PreInvocation` 在单轮多步工具调用的每次模型调用前都会触发且 `lastUserInput` 不变。Hook 写入阶段跳过空白及与同会话最新一条 `prompt` 相同的重复文本，同时在 `buildCandidates()` 渲染层折叠连续重复的 `prompt` 行，避免挤占 `ctx_resume` 2048 B 预算。
5. **Windows GBK / UTF-8 沙箱防乱码（`src/core/sandbox/decode.ts` + `execute.ts` / `batch.ts` / `run-wrapper.ts`）**：沙箱环境变量统一注入 `PYTHONUTF8=1` 与 `PYTHONIOENCODING=utf-8`，PowerShell 预置无 BOM UTF-8 输入/输出/管道编码，并在 Windows 侧对 `stdout`/`stderr` 采用严格 UTF-8 优先、GB18030/GBK 整块与逐行回退解码（Linux/macOS 保持零开销直通 UTF-8）。

---

## 4. 本地构建与验证步骤

```sh
# 1. 生成内嵌提示词并进行 TypeScript 类型检查
node build/build.mjs --generated-only
npm run typecheck

# 2. 构建发布产物并同步仓库根目录的原生插件文件
node build/build.mjs --out release-out --version 2.2.2
node build/main-tree.mjs --pkg release-out --repo . --version 2.2.2

# 3. 使用官方 Antigravity CLI 校验插件清单、MCP 配置、Hooks 与 Skills
agy plugin validate --json ./release-out
agy plugin validate --json .

# 4. 运行单元测试与门禁检查
node --test tests/*.test.mjs
node scripts/ci-gs4-lint.mjs
node build/check-readme.mjs
node build/check-install-docs.mjs
node build/check-secrets.mjs
node build/check-prompt-static.mjs
node build/prompt-lint.mjs --out release-out
node build/check-removed.mjs

# 5. 运行 E2E 安装与 Hook 往返套件
node e2e/cases/run.mjs --milestone M7
```

---

## 5. 安装与使用快速参考

- **原生插件安装（推荐，App / CLI / IDE 通用）**：
  ```sh
  agy plugin install https://github.com/calvinxxw/context-mode
  ```
- **全局 CLI 配置安装（回退或修复）**：
  ```sh
  context-mode setup --agents antigravity
  context-mode doctor --agents antigravity
  ```
- **在会话中校验**：执行 `/ctx-doctor` 或 `/ctx-stats`。
