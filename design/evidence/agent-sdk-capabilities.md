# Claude Agent SDK capability audit

**Package/version audited:** `@anthropic-ai/claude-agent-sdk@0.3.205` (npm `latest`/`next` at the time of audit; published 2026-07-08).  
**CLI version embedded in package metadata:** `claudeCodeVersion 2.1.205`.  
**Peer dependency used for underlying message schemas:** `@anthropic-ai/sdk@0.110.0`.

Sources used most heavily: official Claude Code docs, the published npm package metadata, and the published TypeScript declarations in the SDK package.

---

## Q0 — Conversation-state ownership

**DOES IT EXIST?** **Yes, with one important caveat:** the SDK streams output incrementally, but it does **not** expose a direct “seed this exact transcript array” API on `query()`. The viable DIY path is to own state yourself with streaming output + `continue`/`resume`/`SessionStore`.

**Exact API**
- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query`
- `Options.includePartialMessages?: boolean` to get raw streaming deltas
- `Query` extends `AsyncGenerator<SDKMessage, void>`
- `Query.streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>` for multi-turn streaming input
- `Options.continue?: boolean`
- `Options.resume?: string`
- `Options.forkSession?: boolean`
- `Options.resumeSessionAt?: string`
- `Options.persistSession?: boolean`
- `Options.sessionStore?: SessionStore`
- `SessionStore.load(key): Promise<SessionStoreEntry[] | null>` to resume from a caller-owned store

**What the stream looks like**
- Without partials, the iterator yields complete `SDKMessage` objects such as `SDKAssistantMessage`, `SDKUserMessage`, `SDKResultMessage`, `SDKSystemMessage`, `SDKCompactBoundaryMessage`, etc.
- With `includePartialMessages: true`, it additionally yields `SDKPartialAssistantMessage` / `type: 'stream_event'` events carrying raw Claude API events.
- The docs explicitly say partial output streams include `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, and `message_stop` events.
- Tool-call streaming appears as a `content_block_start` for a `tool_use` block, followed by `input_json_delta` chunks.
- Tool results are represented in the underlying Anthropic message schema (`MessageParam.content` includes `ToolResultBlockParam`).
- Key complete-message shapes:
  - `SDKAssistantMessage = { type: 'assistant'; message: BetaMessage; parent_tool_use_id: string | null; ... }`
  - `SDKUserMessage = { type: 'user'; message: MessageParam; parent_tool_use_id: string | null; tool_use_result?: unknown; shouldQuery?: boolean; ... }`
  - `SDKPartialAssistantMessage = { type: 'stream_event'; event: BetaRawMessageStreamEvent; parent_tool_use_id: string | null; ... }`

**Minimal snippet**
```ts
import { query } from '@anthropic-ai/claude-agent-sdk'

for await (const message of query({
  prompt: 'List the files in this repo',
  options: { includePartialMessages: true, allowedTools: ['Bash', 'Read'] },
})) {
  if (message.type === 'stream_event' && message.event.type === 'content_block_delta') {
    if (message.event.delta.type === 'text_delta') process.stdout.write(message.event.delta.text)
  }
}

// Follow-up in the same persisted session
for await (const message of query({
  prompt: 'Now summarize the risk areas',
  options: { continue: true, allowedTools: ['Read', 'Grep'] },
})) {
  /* ... */
}
```

**Closest workaround if you want full harness-owned history**
- For exact transcript control, implement `SessionStore.load()` and use `resume`, or simply start a fresh `query()` with your own summary in the prompt/system prompt.
- There is **no** public `messages: [...]` option for arbitrary mixed user/assistant/system replay.

**Source URLs**
- https://code.claude.com/docs/en/agent-sdk/streaming-output
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://code.claude.com/docs/en/agent-sdk/session-storage
- https://github.com/anthropics/claude-agent-sdk-typescript
- https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk

---

## Q1 — Session creation & the query loop

**DOES IT EXIST?** **Yes.** `query()` is the main session primitive. For persistent interaction, you keep iterating the returned `Query` object and/or feed more user messages via `streamInput()`. For separate turns across calls, use `continue: true`, `resume`, or `forkSession`.

**Exact API**
- `query({ prompt, options }) => Query`
- `Query` is an async generator and also exposes:
  - `interrupt()`
  - `setPermissionMode(mode)`
  - `setMcpServers(servers)`
  - `streamInput(stream)`
  - `close()`
  - plus inspection methods like `initializationResult()`, `supportedModels()`, `supportedAgents()`, `getContextUsage()`, etc.
- Session options:
  - `continue?: boolean`
  - `resume?: string`
  - `forkSession?: boolean`
  - `sessionId?: string`
  - `resumeSessionAt?: string`
  - `persistSession?: boolean`
  - `sessionStore?: SessionStore`

**Can multiple independent sessions run in one Node process?**
- **Yes.** There is no singleton session object in the API. Each `query()` call returns a separate `Query` object, and the docs describe multiple sessions by ID, plus `continue` / `resume` / `fork` across calls.
- This is a reasonable inference from the API shape; I did not find any global session manager or process-wide lock in the public surface.

**Minimal snippet**
```ts
import { query } from '@anthropic-ai/claude-agent-sdk'

const q1 = query({ prompt: 'Analyze this module', options: { allowedTools: ['Read', 'Grep'] } })
const q2 = query({ prompt: 'Review this other module', options: { allowedTools: ['Read', 'Grep'] } })

for await (const msg of q1) console.log('worker', msg.type)
for await (const msg of q2) console.log('reviewer', msg.type)
```

**Source URLs**
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/sdk.d.ts

---

## Q2 — Custom system prompt + prompt caching

**DOES IT EXIST?** **Partly.**
- **Yes**: fully custom system prompts are supported, including a preset form and a `string[]` form.
- **No**: I did **not** find a public Agent SDK API that lets you attach arbitrary `cache_control: { type: 'ephemeral' }` breakpoints to system prompt blocks or other prompt blocks via `query()` options.

**Exact API**
- `Options.systemPrompt?: string | string[] | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean }`
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` exported constant for splitting static vs dynamic sections in a custom `string[]` system prompt
- Docs-level cache optimization for the preset form: `excludeDynamicSections: true`
- Underlying Anthropic SDK types do support `cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' }` on some content block params, but that knob is **not exposed** in the Agent SDK public `query()`/`systemPrompt`/`tool()` surface I inspected.

**Minimal snippet**
```ts
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk'

await query({
  prompt: 'Triage this repo',
  options: {
    systemPrompt: [
      'You are a stable triage agent.',
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      'Use the current repo state and respond briefly.',
    ],
  },
})
```

**Closest workaround**
- Use `systemPrompt: { type: 'preset', preset: 'claude_code', append: '...' , excludeDynamicSections: true }` when you want the cache-friendly path.
- If you need even more control, restart with a fresh session and seed the next phase with your own summary text.

**Source URLs**
- https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/sdk.d.ts
- https://www.npmjs.com/package/@anthropic-ai/sdk

---

## Q3 — Custom (in-process) tools

**DOES IT EXIST?** **Yes.** Custom tools are a first-class feature, and tool handlers run **in-process**.

**Exact API**
- `tool(name, description, inputSchema, handler, extras?)`
  - `inputSchema` is a Zod raw shape in TS
  - `handler(args, extra) => Promise<CallToolResult>`
  - `extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean }`
- `createSdkMcpServer({ name, version?, instructions?, tools?, alwaysLoad? })`
- The return type is `McpSdkServerConfigWithInstance = { type: 'sdk'; name: string; instance: McpServer }`
- Register by passing the server in `options.mcpServers` or later with `queryHandle.setMcpServers(...)`

**Minimal snippet**
```ts
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const state: string[] = []

const recordPhase = tool(
  'record_phase',
  'Persist the current phase summary',
  { phase: z.string(), summary: z.string() },
  async (args) => {
    state.push(`${args.phase}: ${args.summary}`)
    return { content: [{ type: 'text', text: 'recorded' }] }
  }
)

const harnessServer = createSdkMcpServer({
  name: 'labrat',
  version: '1.0.0',
  tools: [recordPhase],
})

for await (const msg of query({
  prompt: 'Record this phase',
  options: {
    mcpServers: { labrat: harnessServer },
    allowedTools: ['mcp__labrat__record_phase'],
  },
})) {
  /* ... */
}
```

**Do handlers run in-process or subprocess?**
- **In-process.** The docs explicitly say the in-process MCP server runs inside your application, not as a separate process. That means the handler can read/write harness state via closure variables or imported modules.

**Source URLs**
- https://code.claude.com/docs/en/agent-sdk/custom-tools
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/sdk.d.ts
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/README.md

---

## Q4 — Compaction control

**DOES IT EXIST?** **No explicit programmatic “compact now” API surfaced in the public TypeScript SDK surface I inspected.**

**What does exist**
- Automatic compaction settings in the settings schema:
  - `autoCompactEnabled?: boolean`
  - `autoCompactWindow?: number`
- Observation points:
  - `PreCompact` / `PostCompact` hooks
  - `SDKCompactBoundaryMessage`
  - status updates with `SDKStatusMessage.status === 'compacting'`
- Session operations that help you emulate compaction:
  - `continue?: boolean`
  - `resume?: string`
  - `forkSession?: boolean`
  - `resumeSessionAt?: string`
  - `SessionStore.load()` / `persistSession: false`

**What I did not find**
- No `query.compact()`, `compactNow()`, `/compact`-style public SDK method, or a documented hook output that forces compaction.
- Hooks can observe compaction, but I found no hook that programmatically triggers it.

**Fallback / viable workaround**
- **Yes, the restart path is viable**: end the current session and start a fresh `query()` seeded with your own summary + the same cache-friendly system prompt prefix.
- If you want to keep a branch, use `forkSession()` or your own `SessionStore` and resume from there.

**Minimal snippet**
```ts
import { forkSession, query } from '@anthropic-ai/claude-agent-sdk'

const { sessionId } = await forkSession(oldSessionId, { upToMessageId: anchorMessageId })

for await (const msg of query({
  prompt: 'Summary of the prior phase: ...',
  options: { resume: sessionId, persistSession: false },
})) {
  /* fresh phase */
}
```

**Source URLs**
- https://code.claude.com/docs/en/agent-sdk/streaming-output
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/sdk.d.ts

---

## Q5 — Hooks / turn interception for anchors

**DOES IT EXIST?** **Yes.** Hooks are exposed and are the cleanest way to build per-turn anchors.

**Exact API**
- `Options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`
- `HOOK_EVENTS` includes:
  - `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`
  - `Notification`, `UserPromptSubmit`, `UserPromptExpansion`
  - `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`
  - `SubagentStart`, `SubagentStop`
  - `PreCompact`, `PostCompact`
  - `PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`
  - `TaskCreated`, `TaskCompleted`
  - `Elicitation`, `ElicitationResult`
  - `ConfigChange`, `InstructionsLoaded`
  - `WorktreeCreate`, `WorktreeRemove`
  - `CwdChanged`, `FileChanged`
  - `MessageDisplay`
- `HookCallback = (input: HookInput, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>`
- `HookCallbackMatcher` supports an optional `matcher: string` and `timeout?: number`

**Payload highlights**
- All hook inputs extend `BaseHookInput`: `session_id`, `transcript_path`, `cwd`, plus optional `prompt_id`, `permission_mode`, `agent_id`, `agent_type`, and `effort`.
- `MessageDisplay`: `turn_id`, `message_id`, `index`, `final`, `delta`
- `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`
- `PostToolUse`: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms?`
- `PostToolBatch`: `tool_calls[]` with `tool_name`, `tool_input`, `tool_use_id`, `tool_response?`
- `UserPromptSubmit`: `prompt`, `session_title?`
- `SessionStart`: `source`, `agent_type?`, `model?`, `session_title?`
- `PreCompact`: `trigger`, `custom_instructions`
- `PostCompact`: `trigger`, `compact_summary`
- `PermissionRequest`: `tool_name`, `tool_input`, `permission_suggestions?`
- `PermissionDenied`: `tool_name`, `tool_input`, `tool_use_id`, `reason`
- `InstructionsLoaded`: `file_path`, `memory_type`, `load_reason`, `globs?`, `trigger_file_path?`, `parent_file_path?`
- `FileChanged`: `file_path`, `event` (`change` | `add` | `unlink`)
- `CwdChanged`: `old_cwd`, `new_cwd`
- `TaskCreated` / `TaskCompleted`: `task_id`, `task_subject`, `task_description?`, `teammate_name?`

**Can a hook read assistant text + tool call + tool result?**
- **Yes, but split across hooks.**
  - Assistant text deltas: `MessageDisplay`
  - Tool call: `PreToolUse`
  - Tool result: `PostToolUse` / `PostToolBatch`
- If you want the full accumulated assistant message object, use the streaming `SDKMessage` iterator too.

**Minimal snippet**
```ts
import { query } from '@anthropic-ai/claude-agent-sdk'

for await (const msg of query({
  prompt: 'Refactor this module',
  options: {
    includeHookEvents: true,
    hooks: {
      MessageDisplay: [{ hooks: [async (input) => { console.log(input.delta); return {}; }] }],
      PreToolUse: [{ hooks: [async (input) => { console.log(input.tool_name, input.tool_input); return {}; }] }],
      PostToolUse: [{ hooks: [async (input) => { console.log(input.tool_response); return {}; }] }],
    },
  },
})) {
  /* ... */
}
```

**Source URLs**
- https://code.claude.com/docs/en/agent-sdk/hooks
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/sdk.d.ts

---

## Q6 — Loading skills / filesystem context / Bash / file tools

**DOES IT EXIST?** **Yes, but as filesystem-backed configuration, not as a programmatic skill registry.**

**Exact API**
- `Options.skills?: string[] | 'all'`
- `Options.settingSources?: ('user' | 'project' | 'local')[]`
- `Options.plugins?: SdkPluginConfig[]` where local plugins are `{ type: 'local'; path: string; skipMcpDiscovery?: boolean }`
- `queryHandle.reloadSkills()` / `queryHandle.reloadPlugins()`
- `Options.tools?: string[] | { type: 'preset'; preset: 'claude_code' }`
- `Options.allowedTools?: string[]`
- `Options.disallowedTools?: string[]`
- `Options.permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`
- `Options.sandbox?: SandboxSettings`
- `Settings.permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; defaultMode?: ... }`
- `Options.allowDangerouslySkipPermissions?: boolean` when using `bypassPermissions`

**What the docs say about skills**
- Skills are `SKILL.md` files under `.claude/skills/` and are discovered from filesystem settings.
- There is **no programmatic API** to register a Skill directly; skills are loaded from disk and filtered with `skills`.
- If you set `settingSources`, include `'user'` and/or `'project'` to keep skill discovery.
- Plugins are local filesystem directories that can bundle skills, agents, hooks, and MCP servers.

**Built-in tools relevant to a LabRat harness**
- The docs explicitly list built-ins like `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, and `AskUserQuestion`.
- That means the worker can run Bash commands, write analysis code, and edit files without inventing a separate Python tool.

**Minimal snippet**
```ts
import { query } from '@anthropic-ai/claude-agent-sdk'

for await (const message of query({
  prompt: 'Process this PDF and summarize it',
  options: {
    cwd: '/repo',
    settingSources: ['user', 'project'],
    skills: 'all',
    plugins: [{ type: 'local', path: './my-plugin' }],
    allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
    permissionMode: 'dontAsk',
  },
})) {
  /* ... */
}
```

**Source URLs**
- https://code.claude.com/docs/en/agent-sdk/skills
- https://code.claude.com/docs/en/agent-sdk/plugins
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/sdk.d.ts

---

## Q7 — Model + pricing sanity

**DOES IT EXIST?** **The SDK exists, but the exact model-id question is only partially confirmed.**

**What is confirmed**
- `Options.model?: string` is a free-form string and **defaults to the CLI default model**; the SDK does not pin a single Sonnet id in the public API.
- The current package examples and type comments reference `claude-sonnet-5`.
- The type comment for `ModelInfo.resolvedModel` says the alias `sonnet` resolves to `claude-sonnet-5` in this package version.

**What I could not confirm**
- I did **not** find `claude-sonnet-4-6` in the current package docs I inspected.
- So: the SDK itself does not block that string, but the current published docs I checked do **not** confirm it as the current documented Sonnet id.

**Minimal snippet**
```ts
import { query } from '@anthropic-ai/claude-agent-sdk'

for await (const message of query({
  prompt: 'Review this repo',
  options: { model: 'claude-sonnet-5', allowedTools: ['Read', 'Grep'] },
})) {
  /* ... */
}
```

**Source URLs**
- https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- https://github.com/anthropics/claude-agent-sdk-typescript
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/sdk.d.ts

---

## Design implications

### Supported directly
- **Turn-hook anchors:** yes. `MessageDisplay` + tool hooks give you enough to index per-turn content yourself.
- **In-process stateful tools:** yes. `tool()` + `createSdkMcpServer()` are explicitly in-process and closure-friendly.
- **Conversation streaming / observation:** yes. `includePartialMessages` plus the `SDKMessage` iterator gives you live deltas.
- **Fresh-session restart:** yes. `continue`, `resume`, `forkSession`, and `SessionStore` make restart/branch workflows straightforward.

### Requires workaround
- **Programmatic compaction trigger:** no explicit API. Use automatic compaction settings only, or emulate compaction by starting a fresh session / resuming from a fork with your own summary.
- **Arbitrary transcript seeding API:** no direct `messages: [...]` history injection. Use `SessionStore.load()` for resume, or restart with summary text and the same cached system prompt prefix.
- **Direct cache-breakpoint control on prompt blocks:** no public Agent SDK knob found. Use `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and/or `excludeDynamicSections` instead.

### Bottom line for LabRat
The DIY architecture is viable:
1. observe streamed output yourself,
2. persist anchors yourself,
3. restart / resume sessions yourself,
4. use in-process MCP tools for stateful harness commands.

The main gaps are exactly the ones you flagged: no explicit compact-now API, and no direct public cache_control knob in the Agent SDK surface.
