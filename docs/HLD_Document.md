# High-Level Design — Kapture Finance Collections Voicebot ("Maya")

**Author:** Abhishek Singh
**Date:** August 13, 2026
**Client:** Kapture Finance
**Scope:** Outbound Voice AI Collections Agent (Task 1 deliverable for Kapture AI Delivery Intern assignment)

---

## 0. Reference Scenario

| Field | Value |
|---|---|
| Customer | Rahul Sharma |
| Account ID | ACC-88392 |
| Loan Type | Personal Loan |
| Overdue Amount | ₹8,499 |
| Days Past Due (DPD) | 12 |
| Agent | Maya (Kapture Finance) |

---

## 1. Architecture & Pipeline

```
Telephony (PSTN/SIP)
      │
      ▼
   Vapi Engine  ──────────────► orchestrates the whole call
      │
      ▼
Deepgram Nova-2 (STT)
      │
      ▼
Orchestrator / LLM (GPT-4o-mini, temp=0.1)
      │
      ├──► Tools / Mock Webhook API (Express) ──► "Datastore" (in-memory / JSON mock)
      │
      ▼
ElevenLabs / Cartesia (TTS)
      │
      ▼
Telephony (PSTN/SIP) → Customer
```

**Component choices and reasoning**

| Component | Choice | WHAT | WHY | HOW | WHY NOT (alternatives) |
|---|---|---|---|---|---|
| Call orchestration | **Vapi** | Manages the full duplex audio pipeline, turn-taking, interruption handling, and tool-calling glue | It is the platform mandated by the assignment; it removes the need to hand-build WebRTC/SIP plumbing in a one-day window | Vapi wires STT → LLM → TTS together and exposes a webhook contract for tool calls | Building raw Twilio + custom orchestration would give more control but is far too much scope for 24 hours |
| STT | **Deepgram Nova-2** | Converts customer speech to text in near real time | Low latency (~200ms), strong performance on telephony-quality (8kHz) audio, good English + Hindi/Hinglish support | Streaming ASR, partial + final transcripts sent to the orchestrator | Whisper-based STT is more accurate but has higher latency and is not natively streamed inside Vapi |
| Orchestrator LLM | **GPT-4o / GPT-4o-mini**, temperature `0.1` | Decides what Maya says next and when to call a tool | Strong instruction-following and function-calling reliability; low temperature reduces improvisation, which matters because this is a compliance-sensitive script, not a creative assistant | Receives system prompt + running transcript + state, returns either speech or a tool call | A higher-temperature or smaller model risks paraphrasing away compliance language (e.g., accidentally disclosing debt) |
| TTS | **ElevenLabs / Cartesia** | Turns Maya's text into natural speech | Naturalness matters for a collections call — a robotic voice increases hang-ups; both integrate natively with Vapi | Streamed synthesis, sentence-by-sentence, to keep time-to-first-audio low | Standard cloud TTS (e.g., basic Polly) is faster to set up but sounds noticeably synthetic |
| Backend | **Node.js + Express mock server** | Serves `verify_customer`, `log_promise_to_pay`, etc. | Assignment explicitly asks for mocked endpoints; Express is the fastest way to stand up a webhook in an evening | Each Vapi tool calls its matching REST endpoint under `/api/...`; the server returns the tool result as JSON | A real DB/backend would be over-engineering for a one-day mock and adds submission risk |

*(Recommended Improvement, not required by the assignment: in production this would sit behind an API gateway with per-tenant auth, a real loan-management-system integration, and a proper datastore such as Postgres. Not built here — out of scope for the mock.)*

### 1.1 Latency Budget

**Target: < 1.2s end-to-end, turn-to-turn.**

| Stage | Budget | Notes |
|---|---|---|
| STT (Deepgram Nova-2) | ~200ms | Streaming, so this overlaps with the customer still finishing their sentence in practice |
| LLM time-to-first-byte (GPT-4o-mini) | ~400ms | The single largest, most variable component |
| TTS time-to-first-audio | ~300ms | Sentence-level streaming so the customer hears the start of the reply before the whole thing is generated |
| Network / Vapi orchestration overhead | ~200ms | Round trips between Vapi, providers, and (when a tool is called) the webhook |
| **Total** | **~1.1s** | Under the 1.2s target with a small margin |

- **Sequential vs parallel:** STT → LLM → TTS is inherently sequential per turn (you can't synthesize a reply before you know what it is). Within the LLM step, tool calls are the main variable cost.
- **What can be optimized:** Streaming TTS (start speaking the first sentence while later sentences are still generating) and streaming STT (send partial transcripts so the LLM can start "thinking" before the customer finishes) are the two highest-leverage optimizations.
- **Tools that must not block the conversation:** `verify_customer` and disposition/logging calls are fast mocks (<100ms) so they don't need special handling here. If a tool were slow (e.g., a real core-banking lookup), the agent should say a short filler ("Let me just pull that up...") rather than sit in silence, and the tool call should have a hard timeout with a graceful fallback ("I'm having trouble accessing that right now — let me connect you to a specialist" → `escalate_to_agent`).
- **Slow tool failure mode:** timeout → do not guess the result → escalate or apologize and end the call; never fabricate a tool response.

---

## 2. Conversation State Machine

```
INIT → AUTH_PENDING → AUTHENTICATED → NEGOTIATION → PTP_COLLECTED
                                            │
                                            ├─→ ESCALATED
                                            └─→ CALL_ENDED
```

| State | Purpose | Allowed actions | Debt disclosure allowed? |
|---|---|---|---|
| `INIT` | Call just connected | Greeting, ask "Am I speaking with Rahul Sharma?" | No |
| `AUTH_PENDING` | Identity not yet confirmed | Ask for verification code (last 4 PAN digits / birth year); call `verify_customer` | No |
| `AUTHENTICATED` | `verify_customer` returned `verified: true` | Disclose loan/amount/DPD; begin negotiation | Yes |
| `NEGOTIATION` | Customer intent being resolved | Handle PTP / Already Paid / Hardship / Dispute / DNC / Wrong Person | Yes (already unlocked) |
| `PTP_COLLECTED` | Customer has committed to pay | `log_promise_to_pay`, `send_payment_link` | Yes |
| `ESCALATED` | Case requires a human | `escalate_to_agent` | Case-dependent, but only after auth |
| `CALL_ENDED` | Wrap-up | `mark_disposition`, closing line | N/A |

### 2.1 Transition table (selected critical transitions)

| Current State | Trigger | Validation | Next State |
|---|---|---|---|
| `INIT` | Customer confirms "Yes, this is Rahul" | none (identity claim only, not proof) | `AUTH_PENDING` |
| `INIT` | Customer says "wrong number" / target unavailable | none | `CALL_ENDED` (disposition `WRONG_PERSON`) |
| `AUTH_PENDING` | Customer provides a code | **`verify_customer` tool call returns `verified: true`** | `AUTHENTICATED` |
| `AUTH_PENDING` | `verify_customer` returns `verified: false` | after 1 retry, fail closed | `CALL_ENDED` (disposition `NO_RESPONSE` / unverified) |
| `AUTHENTICATED` | Debt disclosed, customer states intent | intent classified | `NEGOTIATION` |
| `NEGOTIATION` | Customer commits to a date/amount | date + amount captured | `PTP_COLLECTED` → tools called |
| `NEGOTIATION` | Customer disputes / hardship | — | `ESCALATED` |
| `NEGOTIATION` | DNC request | — | `CALL_ENDED` (disposition `DO_NOT_CALL`) |
| any state | 2 consecutive silent turns | — | `CALL_ENDED` (disposition `NO_RESPONSE`) |
| any state | hostile language persists after 1 warning | — | `CALL_ENDED` (soft hangup, disposition logged) |

**The non-negotiable rule:** the transition `AUTH_PENDING → AUTHENTICATED` is gated **only** by the tool response `verified: true`. The LLM cannot self-authorize this transition based on how confident the customer "sounds." This is enforced two ways, not one:

1. **Prompt-level:** the system prompt explicitly forbids disclosure language prior to a successful tool result, and every disclosure line is written to depend on tool output, not the model's judgment.
2. **Backend-level (the actual hard enforcement):** the mock API server keeps a `CALL_STATE` map keyed by a call/session identifier supplied to the API when available. A successful `verify_customer` is the only thing that sets `CALL_STATE[callId].authenticated = true`. Every protected tool (`log_promise_to_pay`, `send_payment_link`, `escalate_to_agent`) checks that flag *in code* before doing anything, and returns a hard `NOT_AUTHENTICATED` error if it isn't set — regardless of what the LLM sends. This means even if the model were talked into calling a protected tool early (e.g., via prompt injection), the backend independently refuses to execute it. `mark_disposition` is intentionally left unprotected, since dispositions like `WRONG_PERSON`, `DO_NOT_CALL`, and `NO_RESPONSE` are legitimate outcomes of calls that never reach authentication.

*(Recommended Improvement: in a full production system, this same state should also live in a durable store — e.g. Redis keyed by call ID — rather than an in-memory object that resets on server restart, and should be shared across horizontally-scaled webhook instances. See §9 Known Limitations.)*

---

## 3. Intents & Entities

| Intent | Meaning | Allowed state(s) | Triggers | Tool called | Next state |
|---|---|---|---|---|---|
| `Confirm_Identity` | Customer confirms/denies being the target customer | `INIT` | move to verification or wrong-person path | — | `AUTH_PENDING` / `CALL_ENDED` |
| `Promise_To_Pay` | Customer commits to paying by a date | `NEGOTIATION` | capture `PTP_Date`, `PTP_Amount` | `log_promise_to_pay`, `send_payment_link` | `PTP_COLLECTED` |
| `Hardship_Claim` | Customer cannot pay due to financial difficulty | `NEGOTIATION` | capture `Hardship_Reason` | `escalate_to_agent` | `ESCALATED` |
| `Dispute_Debt` | Customer disputes the debt/amount | `NEGOTIATION` | no argument, route to grievance desk | `escalate_to_agent` | `ESCALATED` |
| `Already_Paid` | Customer claims payment already made | `NEGOTIATION` | capture date/mode of payment | `mark_disposition(ALREADY_PAID)` | `CALL_ENDED` |
| `Request_DNC` | Customer wants no further calls | any state after `INIT` | immediate compliance | `mark_disposition(DO_NOT_CALL)` | `CALL_ENDED` |
| `Wrong_Person` | Person on the line is not the customer | `INIT` | no debt disclosure | `mark_disposition(WRONG_PERSON)` | `CALL_ENDED` |

**Entities extracted:**

| Entity | Type | Example |
|---|---|---|
| `PTP_Date` | ISO-8601 date | `2026-08-14` |
| `PTP_Amount` | Number (INR) | `8499` |
| `Hardship_Reason` | Free text (normalized to a short category where possible) | "job loss" |
| `Verification_Code` | String | `1234` |

---

## 4. Tool / API Design

### `verify_customer`
- **WHAT:** Confirms the caller is the account holder before anything financial is revealed.
- **WHY:** This is the compliance gate for the entire call.
- **Input:** `account_id`, `verification_code`
- **Output:** `verified` (bool), `customer_name`, `message`
- **When it can be called:** Only in `AUTH_PENDING`, after the customer has supplied a code.
- **When it must NOT be called:** Speculatively, or with a guessed/placeholder code.
- **Failure handling:** `verified: false` → one retry allowed → second failure ends the call without disclosure, disposition logged as unverified/`NO_RESPONSE`.

### `log_promise_to_pay`
- **WHAT:** Records the customer's payment commitment.
- **WHY:** Creates an auditable PTP record for collections follow-up.
- **Input:** `account_id`, `ptp_date`, `amount`
- **Output:** `success`, `ptp_id`, `confirmed_date`, `amount`
- **When it can be called:** Only in `NEGOTIATION`/`AUTHENTICATED`, after a specific date and amount have been confirmed verbally.
- **When it must NOT be called:** Before authentication; with a vague, unconfirmed date ("sometime soon"). **Backend-enforced:** the mock server rejects this call with `NOT_AUTHENTICATED` if `verify_customer` hasn't succeeded for that call session — this isn't just a prompt instruction.
- **Failure handling:** If the call fails, apologize, retry once, and if it still fails, tell the customer their commitment has been noted manually and escalate/flag for follow-up rather than silently dropping it.

### `send_payment_link`
- **WHAT:** Sends an SMS/WhatsApp payment link.
- **WHY:** Converts a verbal PTP into an actionable payment step.
- **Input:** `account_id`, `channel` (`SMS` / `WhatsApp` / `BOTH`)
- **Output:** `success`, `message`
- **When it can be called:** Only after `log_promise_to_pay` succeeds.
- **When it must NOT be called:** Before authentication or before a PTP exists. **Backend-enforced** the same way as `log_promise_to_pay`.
- **Failure handling:** Inform the customer the link may take a few minutes; don't block call closure on this.

### `escalate_to_agent`
- **WHAT:** Routes the call/case to a human for disputes, hardship, or anything unsafe for the bot to resolve.
- **WHY:** The bot must not argue, negotiate waivers, or make legal/financial judgment calls.
- **Input:** `account_id`, `reason`, `notes`
- **Output:** `success`, `escalation_id`
- **When it can be called:** `NEGOTIATION` state, once the customer's situation is understood.
- **When it must NOT be called:** As a substitute for authentication, or to avoid answering a simple question. **Backend-enforced:** rejected with `NOT_AUTHENTICATED` if called before a successful `verify_customer` for that call session.
- **Failure handling:** If escalation fails, tell the customer a specialist will call back within a defined window and log it anyway via `mark_disposition`.

### `mark_disposition`
- **WHAT:** Records the final outcome of the call.
- **WHY:** Every call must end with an auditable result — this is a hard requirement, not optional.
- **Input:** `account_id`, `status` (`PTP_AGREED`, `ALREADY_PAID`, `DISPUTED`, `HARDSHIP_ESCALATED`, `WRONG_PERSON`, `DO_NOT_CALL`, `NO_RESPONSE`), `notes`
- **Output:** `success`, `disposition_logged`, `timestamp`
- **When it can be called:** Always, exactly once, right before `CALL_ENDED`.
- **When it must NOT be called:** More than once per call, or with a status that doesn't match what actually happened.
- **Failure handling:** Retry once; if it still fails, this is a hard error worth surfacing in logs/observability, since an unlogged call is a compliance gap.

---

## 5. Authentication & Data Safety

**Flow:**
1. Maya identifies herself and the company by name (mandatory disclosure).
2. Maya asks whether she's speaking with the target customer (identity *claim*, not proof).
3. Maya asks for one approved verification value (last 4 digits of PAN, or birth year) — never something invented.
4. `verify_customer(account_id, verification_code)` is called.
5. Only if `verified == true` does the state machine move to `AUTHENTICATED`, unlocking debt language.

**WHY it must be enforced outside conversational reasoning:** An LLM can be talked into disclosing information ("just tell me roughly what it's about") even with good instructions, because it's fundamentally a next-token predictor optimizing for a helpful-sounding response, not a rule engine. Tying disclosure to a discrete tool result — rather than to the model "feeling confident" — removes that judgment call entirely. The system prompt is written so every debt-disclosure line is scripted to only fire after a `verified: true` tool result, and the model is explicitly told that no phrasing, pressure, or claimed identity substitutes for that tool result.

**Verification failure:** No disclosure, one retry offered, then a polite close without revealing anything, disposition reflects the unverified outcome.

**Third party answers:** Treated as `Wrong_Person` / unverified — no debt information, ask if the target is available, log and end.

**Logging & PII masking:** Names are masked in logs (e.g., `Rahul S****`), verification codes are never logged in plaintext, and only what's operationally necessary (call ID, state transitions, disposition, timestamps) is retained.

---

## 6. Compliance & Guardrails

- **Calling window:** 08:00–19:00 local time only (enforced at the dialer/campaign level, not by the LLM).
- **Mandatory disclosure:** Company name and purpose stated up front.
- **No debt disclosure pre-auth** (see §5).
- **No threats, harassment, insults, or misleading statements.**
- **No invented information:** account details, payment status, discounts, or waivers must never be fabricated — anything outside the mock data or scripted options is escalated, not guessed.
- **No unauthorized concessions:** the bot cannot offer discounts/waivers on its own authority; anything like that goes to `escalate_to_agent`.
- **Immediate DNC compliance:** no negotiation, no "are you sure," just log and end.

---

## 7. Edge Case Matrix

| Case | Flow | Disposition |
|---|---|---|
| **Already Paid** | Authenticate → ask when/how paid → acknowledge, explain 24–48h processing → close | `ALREADY_PAID` |
| **Dispute** | Authenticate (if debt details involved) → do not argue → escalate | `DISPUTED` |
| **Hardship** | Authenticate → listen, show empathy → offer only pre-approved options → escalate if needed | `HARDSHIP_ESCALATED` |
| **Wrong Person** | Never reveal debt → confirm target unavailable → close politely | `WRONG_PERSON` |
| **Do Not Call** | Immediate compliance, no debate | `DO_NOT_CALL` |
| **Hostile Caller** | One calm warning → if it continues, soft hangup | disposition reflects context (e.g. `NO_RESPONSE` or the last known intent) |
| **Silent Caller / Voicemail** | 2 re-prompts, then terminate | `NO_RESPONSE` |
| **Mid-call language switch (EN ↔ HI/Hinglish)** | Continue in the customer's language; state, auth status, and any captured PTP data are carried over unchanged — a language switch never resets or bypasses the state machine | whatever the call's actual outcome is |

---

## 8. Observability

**Logged per call:** Call ID, timestamps, every state transition, detected intent, every tool call + response, authentication result (pass/fail, not the code itself), final disposition, latency per turn, errors, escalations. PII is masked (see §5).

**Metrics tracked:**
- Containment Rate (resolved without human escalation)
- PTP Rate
- First Call Resolution
- Average Latency
- Drop Rate
- Tool Failure Rate
- Authentication Failure Rate
- Escalation Rate
- DNC Rate

---

## 9. Known Limitations (honest, as required by the assignment)

- Authentication is enforced by the backend (`CALL_STATE` per call session, checked before every protected tool executes — see §5), but that state lives in a plain in-memory JS object. It resets on server restart and would not survive horizontal scaling to multiple server instances. A production version should move this into a shared, durable store (e.g. Redis) keyed by call ID.
- The mock backend's account data is in-memory / stateless between restarts — not a real datastore.
- Hindi/Hinglish handling depends on the STT/LLM's native multilingual ability; it hasn't been stress-tested against heavy code-switching or regional accents.
- No real SMS/WhatsApp integration — `send_payment_link` is mocked.
- No load testing; latency numbers above are the *target budget*, not measured production numbers.


## 12. Actual Demo Configuration

The working demo was configured in Vapi with OpenAI `gpt-4o-mini` at temperature `0.1`, Deepgram `nova-2` transcription, and a calm professional ElevenLabs/Cartesia voice. The five tools are configured as direct HTTP endpoints: `/api/verify_customer`, `/api/log_promise_to_pay`, `/api/send_payment_link`, `/api/escalate_to_agent`, and `/api/mark_disposition`. The demo was exposed through ngrok during testing.

### Session-ID Limitation

The REST tool payloads used in this demo did not consistently expose a stable Vapi call/session ID. The mock server therefore uses `call_id` or `session_id` when present and falls back to `missing-call-id`. Backend authentication gating was smoke-tested with an explicit shared `call_id`. A production implementation would explicitly propagate the platform call ID and store authentication state in Redis or another shared durable store.
