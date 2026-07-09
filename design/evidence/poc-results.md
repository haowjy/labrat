# LabRat Agent SDK spine POC results

**Mode:** VERIFIED-LIVE. `ANTHROPIC_API_KEY` was unset, but Claude Code CLI creds worked (`claude --version` = `2.1.205`). The cheapest SDK auth probe (`prompt: "say ok"`, model alias `sonnet`, no tools) returned `Ok` with `total_cost_usd: 0.000681`.

**Throwaway harness:** `$MERIDIAN_ACTIVE_WORK_DIR/poc/`

- SDK installed: `@anthropic-ai/claude-agent-sdk@0.3.205` (`claudeCodeVersion 2.1.205`)
- Main harness: `poc/live-poc.ts`
- Run log: `poc/live-run.log`
- Structured evidence: `poc/live-results.json`
- Anchors: `poc/anchors/*.md`
- Python state probe: `poc/q5-python-state.sh`, `poc/q5-python-state.log`
- Type check: `cd poc && npx tsc --noEmit` passed

## Q1 — Tool-terminated phase handoff

**Verdict: VERIFIED-LIVE.**

An in-process SDK MCP tool handler can signal completion to the TypeScript orchestrator, and the orchestrator can regain control by breaking the `for await` loop after the tool result is observed. Starting a fresh next-phase `query()` immediately afterward worked.

Critical harness snippet:

```ts
for await (const msg of q) {
  const s = summarizeMessage(msg);
  console.log('PHASE1_STREAM', JSON.stringify(s));
  if (recordPhaseEvents.length > before) {
    console.log('ORCHESTRATOR_BREAK_AFTER_HANDLER', JSON.stringify(recordPhaseEvents.at(-1)));
    break;
  }
}
```

Observed phase-1 evidence:

```text
PHASE1_STREAM ... "DISPLAY_ANCHOR_LINE phase1"
PHASE1_STREAM ... "tool_use","name":"mcp__labrat__record_phase" ...
HANDLER record_phase fired phase=phase1 summary=SUMMARY_TOKEN_visible_to_phase2_lime_4812
HOOK PostToolUse tool_name=mcp__labrat__record_phase tool_use_id=toolu_01V23UxyvSqsc91Sg2iHKPmx has_response=true
PHASE1_STREAM ... "type":"tool_result" ... "recorded phase1; orchestrator may end this phase now"
ORCHESTRATOR_BREAK_AFTER_HANDLER {"phase":"phase1","summary":"SUMMARY_TOKEN_visible_to_phase2_lime_4812"}
```

Control-flow details:

- **Breaking the async iterator:** cleanly returned control; phase 2 started as a separate query and succeeded.
- **Handler return alone:** not terminal. A no-break control continued to the next assistant turn:

```text
CONTROL_STREAM ... tool_result ... recorded control_no_break ...
CONTROL_STREAM ... "CONTROL_AFTER_TOOL"
CONTROL_STREAM ... "num_turns":2 ... "terminal_reason":"completed"
```

- **`query.interrupt()`:** worked when called after the handler/tool result; receipt was `{"still_queued":[]}` and the requested post-tool text did not appear.

```text
INTERRUPT_RECEIPT {"still_queued":[]}
```

**Design impact:** `record_phase` should not rely on a magic terminal tool response. The orchestrator should detect handler/tool completion, then `break` or call `query.interrupt()` and start the next fresh phase.

## Q2 — Session-per-phase with stable prefix

**Verdict: VERIFIED-LIVE.**

Phase 2 was a fresh `query()` with the same static `systemPrompt` prefix and `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, plus a dynamic tail containing the prior phase summary. It saw the injected summary and did **not** see the phase-1 user-turn secret.

Observed phase-2 output:

```text
PHASE2_STREAM ... session_id="e1fc44d9-a649-4d56-a3c6-48ec849585ff"
PHASE2_STREAM ... "summary_seen=SUMMARY_TOKEN_visible_to_phase2_lime_4812; phase1_turn_secret=NOT_SEEN"
```

Phase 1 and phase 2 session IDs differed (`3ddb554f-...` vs `e1fc44d9-...`), confirming a fresh session.

Cache fields were visible on the phase-2 result:

```json
{
  "input_tokens": 41,
  "cache_creation_input_tokens": 333,
  "cache_read_input_tokens": 4637,
  "cache_creation": { "ephemeral_1h_input_tokens": 333, "ephemeral_5m_input_tokens": 0 }
}
```

**Design impact:** the session-per-phase compaction approach works; the static prefix produced cache-read tokens on phase 2.

## Q3 — Hooks fire with claimed payloads / anchors

**Verdict: VERIFIED-LIVE.**

Both `MessageDisplay` and `PostToolUse` hooks fired inside the worker session. The `PostToolUse` payload included all required fields: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`.

Observed hook payload excerpt from `live-results.json` / `anchors/63774dba21.md`:

```json
{
  "event": "PostToolUse",
  "tool_name": "mcp__labrat__record_phase",
  "tool_input": { "phase": "phase1", "summary": "SUMMARY_TOKEN_visible_to_phase2_lime_4812" },
  "tool_response": [{ "type": "text", "text": "recorded phase1; orchestrator may end this phase now" }],
  "tool_use_id": "toolu_01V23UxyvSqsc91Sg2iHKPmx",
  "callback_toolUseID": "toolu_01V23UxyvSqsc91Sg2iHKPmx",
  "duration_ms": 5
}
```

Anchor files persisted independently under `poc/anchors/` after the sessions ended:

```text
63774dba21.md  74843a26cc.md  8358294b53.md  99306c5e08.md ...
```

## Q4 — Two concurrent sessions

**Verdict: VERIFIED-LIVE.**

A worker query and reviewer query ran concurrently in one Node process using `Promise.all`. They produced independent session IDs and expected outputs.

Observed evidence:

```text
WORKER_STREAM ... session_id="70d272ad-a23d-4e83-a0b2-f85ad8d3dad2" ... "WORKER_OK"
REVIEWER_STREAM ... session_id="b35200cd-2efb-4497-9dfa-2dc61c71a269" ... "REVIEWER_OK"
CONCURRENT_SUMMARY {"distinct":true}
```

No shared-state clash was observed.

## Q5 — Inter-turn Python state is disk-backed

**Verdict: VERIFIED-LIVE (direct Bash/Python probe).**

The machine Python lacked `numpy`, so I used the existing Claude Science conda Python at `~/.claude-science/conda/envs/claude-science-mcp/bin/python`, which has `numpy 2.5.1`.

Command run: `poc/q5-python-state.sh`

Observed output:

```text
call1_pid 417450 memory_arr [11, 22, 33] wrote /tmp/labrat-poc-x.npy
call2_pid 417474
memory_missing NameError name 'arr' is not defined
disk_loaded [11, 22, 33]
```

This proves each Bash/Python invocation is a fresh process: in-memory `arr` disappeared, but `/tmp/labrat-poc-x.npy` persisted and loaded in the next process.

## Surprises / design changes

1. **Plain tool return is not terminal.** `record_phase` must be treated as a harness signal; the orchestrator must break/interrupt the query loop.
2. **`PostToolUse.tool_response` for this MCP tool arrived as an array of content blocks**, not the entire raw `CallToolResult` wrapper. Anchor code should persist it as `unknown` without over-shaping.
3. **Cache read was observable on phase 2** (`cache_read_input_tokens: 4637`), which is better than just inferred.

## One-glance verdicts

- **Q1:** VERIFIED-LIVE — handler fires; break/interrupt gives control; handler return alone does not terminate.
- **Q2:** VERIFIED-LIVE — fresh session sees injected summary, not prior turns; phase 2 showed cache read.
- **Q3:** VERIFIED-LIVE — hooks fire; required `PostToolUse` fields present; anchors persist to disk.
- **Q4:** VERIFIED-LIVE — concurrent worker/reviewer sessions worked with distinct IDs.
- **Q5:** VERIFIED-LIVE — Python memory does not persist across invocations; disk state does.
