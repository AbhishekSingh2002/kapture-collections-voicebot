# Kapture Finance Collections Voicebot — "Maya"

An outbound Voice AI collections agent built for the Kapture AI Delivery Intern take-home assignment.
Maya calls a customer about an overdue EMI, authenticates them before revealing any debt information,
negotiates a resolution, and logs a disposition — all inside fair-collection norms.

**Example call context:** Rahul Sharma · Personal Loan · ₹8,499 overdue · 12 days past due (Account `ACC-88392`).

---

## 1. Project Overview

This repo contains both assignment deliverables:

- **Task 1 — HLD:** [`docs/HLD_Document.md`](docs/HLD_Document.md) + [`docs/System_Architecture.png`](docs/System_Architecture.png) (diagram; [`.mmd`](docs/System_Architecture.mmd) source also included).
- **Task 2 — Working Vapi build:** [`vapi/system_prompt.txt`](vapi/system_prompt.txt), [`vapi/tool_definitions.json`](vapi/tool_definitions.json), and a mock webhook backend in [`mock-server/`](mock-server).

The one non-negotiable design rule everything else hangs off: **Maya cannot say anything about the loan,
EMI, amount, or days overdue until the `verify_customer` tool has returned `verified: true`.** This is
enforced in two layers, not one:
- **Prompt-level:** the system prompt makes disclosure conditional on tool output, never on how the
  conversation "feels."
- **Backend-level (the actual hard gate):** the mock server tracks authentication per call session
  (`CALL_STATE`, keyed by Vapi's call ID) and rejects `log_promise_to_pay`, `send_payment_link`, and
  `escalate_to_agent` outright with a `NOT_AUTHENTICATED` error if `verify_customer` hasn't succeeded for
  that session — regardless of what the LLM sends. This means authentication can't be talked past even in
  principle, not just "the prompt tells it not to." See HLD §5 and `mock-server/server.js`.

---

## 2. Architecture

```
Telephony (PSTN/SIP) → Vapi → Deepgram Nova-2 (STT) → GPT-4o-mini (Orchestrator, temp 0.1)
      → [tools → mock Express webhook] → ElevenLabs/Cartesia (TTS) → Telephony → Customer
```

Full reasoning for each component choice, the latency budget (<1.2s target), the state machine, intents/
entities, tool schemas, and the edge-case matrix are all in [`docs/HLD_Document.md`](docs/HLD_Document.md).

---

## 3. Setup

### 3.1 Mock webhook server

```bash
cd mock-server
npm install
cp .env.example .env    # edit PORT if needed
npm start                # runs on http://localhost:3000 by default
```

Expose it publicly so Vapi can reach it (pick one):

```bash
ngrok http 3000
# or deploy to Render/Vercel and use that URL instead
```

Sanity-check it directly:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"message":{"type":"tool-calls","toolCalls":[{"id":"c1","function":{"name":"verify_customer","arguments":{"account_id":"ACC-88392","verification_code":"1234"}}}]}}'
```

You should get back `{"results":[{"toolCallId":"c1","result":"{\"verified\":true,...}"}]}`. There's also a
`GET /logs` endpoint that dumps everything logged so far, `GET /call-state` to inspect which call sessions
are currently authenticated (useful for proving the auth gate is real, not just prompt talk), and
`GET /health` for a quick liveness check.

**Mock verification codes for account `ACC-88392`:** `1234` or `1995` (last 4 PAN digits / birth year).

**Proving the auth gate is backend-enforced:** try calling `log_promise_to_pay` with a `call_id` that has
never called `verify_customer` — you'll get back `{"success":false,"error":"NOT_AUTHENTICATED",...}"`. Then
call `verify_customer` with the same `call_id` and a valid code, and retry `log_promise_to_pay` — it now
succeeds. This is what makes authentication state-enforced rather than merely suggested in the prompt.

### 3.2 Vapi assistant

1. Create a free account at [vapi.ai](https://vapi.ai).
2. **Assistants → Create Assistant → Blank Template.**
3. **Model:** OpenAI `gpt-4o-mini`, temperature `0.1`.
4. **Transcriber:** Deepgram, model `nova-2`, language `en` (or `multi` for the bilingual bonus).
5. **Voice:** ElevenLabs or Cartesia — pick a calm, professional voice.
6. **First message:** `Hello, this is Maya calling from Kapture Finance. Am I speaking with Mr. Rahul Sharma?`
7. Paste the contents of [`vapi/system_prompt.txt`](vapi/system_prompt.txt) into the system prompt field.
8. Under **Tools**, import [`vapi/tool_definitions.json`](vapi/tool_definitions.json) (or add the five
   functions manually) and point every tool's server URL at your ngrok/deployed `/webhook` endpoint.
9. Start a **Web Call** from the Vapi dashboard (fastest for testing) or connect a phone number.

---

## 4. Tool Definitions

Five tools, defined in [`vapi/tool_definitions.json`](vapi/tool_definitions.json) and implemented in
[`mock-server/server.js`](mock-server/server.js):

| Tool | Purpose |
|---|---|
| `verify_customer` | Authenticates the caller before any debt disclosure — the compliance gate for the whole call. |
| `log_promise_to_pay` | Records a confirmed payment date + amount. |
| `send_payment_link` | Mocks sending an SMS/WhatsApp payment link. |
| `escalate_to_agent` | Routes disputes/hardship to a human — the bot never negotiates waivers itself. |
| `mark_disposition` | Logs the final call outcome; every call must end with exactly one of these. |

Full input/output schemas and failure-handling rules are in HLD §4.

---

## 5. System Prompt Explanation

[`vapi/system_prompt.txt`](vapi/system_prompt.txt) encodes a 5-state machine (`INIT → AUTH_PENDING →
AUTHENTICATED/NEGOTIATION → ACTION → CALL_ENDED`) directly into the instructions, with an explicit
"ABSOLUTE RULE" section up top that forbids any debt-related language before a `verified: true` tool
result — regardless of how the customer phrases things or how confident they sound. Each negotiation
branch (PTP / Already Paid / Hardship / Dispute / DNC) is scripted with exactly which tool to call and
what disposition to log, so the model has as little room as possible to freelance on compliance-sensitive
behavior.

---

## 6. Test Cases

[`tests/test_cases.json`](tests/test_cases.json) — 11 cases covering the authentication guardrail (pre-
and post-verification), all required edge cases (DNC, Already Paid, Dispute, Hardship, Wrong Person,
Silence, Hostile Caller), and the bilingual bonus. Each case lists the input sequence, expected behavior,
and pass criteria. Run them by placing the corresponding Vapi web calls and checking the transcript +
`/logs` output against the pass criteria — this is a manual test matrix, not an automated harness (see
Known Limitations).

The mock server's tool handlers were smoke-tested directly with `curl` against all five endpoints
(verify success, verify failure, PTP logging, payment link, escalation, disposition) before wiring up Vapi.

---

## 7. Demo Instructions

Record 2–4 minutes covering:
1. **Happy path:** greeting → identity confirmation → verification (`1234`) → debt disclosure → PTP
   negotiation → `log_promise_to_pay` → `send_payment_link` → `mark_disposition(PTP_AGREED)` → close.
2. **One edge case** — Do Not Call is the clearest one to demo since it shows a hard compliance behavior
   in action, but Already Paid or Dispute work too.

`[Link to demo recording — add before submission]`

---

## 8. Design Choices

- **Vapi** because the assignment specifies it and it removes the need to hand-build telephony/duplex-audio
  plumbing in a one-day window.
- **Deepgram Nova-2** for low-latency, telephony-tuned STT with reasonable Hindi/Hinglish support.
- **GPT-4o-mini at temperature 0.1** to keep the model close to the script — this is a compliance-sensitive
  flow, not a creative one, so low temperature matters more than fluency.
- **ElevenLabs/Cartesia** for natural-sounding TTS, since a robotic voice increases hang-up risk on a
  collections call.
- **Plain Express + in-memory mock data** for the backend — the assignment explicitly says mocked
  endpoints are fine, and a real datastore would be over-engineering for a 24-hour deliverable.
- **Authentication enforced in the backend**, not just the prompt: `verify_customer` sets a per-call-session
  flag the protected tools check before executing (see §5 above and HLD §5). The prompt is the second layer,
  not the only layer.

## 9. What Broke / How I Debugged It

- Early on, the mock server's `/webhook` handler returned a bare JSON object instead of the
  `{"results":[{"toolCallId, result}]}` shape Vapi expects for tool-call responses — Vapi silently ignored
  the tool result until I matched the exact contract. Fixed by checking Vapi's tool-call response docs and
  testing the shape directly with `curl` before wiring up a live call.
- Tested each tool handler in isolation with `curl` payloads shaped like real Vapi `tool-calls` events
  before ever placing a Vapi call — this caught the response-shape bug above without burning call minutes.
- On review, I caught that the backend accepted protected tool calls (`log_promise_to_pay`,
  `send_payment_link`, `escalate_to_agent`) even without a prior successful `verify_customer` for that call
  — the prompt said the right thing, but nothing in code actually stopped it. Fixed by adding a
  `CALL_STATE` map keyed by the Vapi call session ID, set only by a successful `verify_customer`, and
  checked by every protected tool before it runs anything. Verified with `curl`: same call session,
  protected tool before verify → rejected with `NOT_AUTHENTICATED`; after verify → succeeds; a different,
  never-verified session → still rejected. `GET /call-state` makes this inspectable during a demo.
- [Add any Vapi-dashboard-specific issues you hit once you actually configure the live assistant — e.g.
  tool-call webhook auth, voice selection, or STT language settings.]

## 10. Known Limitations

- Authentication state (`CALL_STATE`) lives in a plain in-memory object on a single server process — it
  resets on restart and wouldn't survive scaling to multiple webhook instances. A production version needs
  this in a shared, durable store (e.g. Redis) keyed by call ID.
- The mock backend's account data is in-memory and resets on restart; it's not a real datastore.
- `send_payment_link` is fully mocked — no real SMS/WhatsApp integration.
- Bilingual (Hindi/Hinglish) handling relies on the STT/LLM's native multilingual ability and hasn't been
  stress-tested against heavy code-switching or regional accents.
- No automated test harness — the test matrix in `tests/test_cases.json` is currently run manually against
  live Vapi calls.
- Latency numbers in the HLD are target budgets from the assignment spec, not measured production numbers.

## 11. What I'd Improve With More Time

- Move `CALL_STATE` from an in-memory object to a shared durable store (Redis) so authentication state
  survives restarts and works across multiple webhook instances.
- Real core-banking / LMS integration behind `verify_customer` and `log_promise_to_pay` instead of the
  in-memory mock.
- An automated eval harness that replays the `tests/test_cases.json` scenarios against the Vapi API and
  checks transcripts programmatically for compliance violations (e.g., regex/keyword scan for debt terms
  appearing before a `verify_customer` success event in the call log).
- Proper observability: ship the `/logs` output to a real store and build the metrics listed in HLD §8
  (containment rate, PTP rate, latency, etc.) as an actual dashboard instead of a debug endpoint.

---

## 12. Project Structure

```
kapture-collections-voicebot/
├── README.md                    # this file
├── docs/
│   ├── HLD_Document.md          # Task 1 — full high-level design
│   ├── System_Architecture.png  # architecture/pipeline diagram
│   └── System_Architecture.mmd  # Mermaid sequence diagram source
├── vapi/
│   ├── system_prompt.txt        # production Vapi system prompt for Maya
│   └── tool_definitions.json    # 5 tool schemas registered in Vapi
├── mock-server/
│   ├── package.json
│   ├── server.js                # Express webhook implementing all 5 tools
│   └── .env.example
└── tests/
    └── test_cases.json          # 11-case manual test matrix
```
