# Demo Runbook — From Code to a Real Vapi Call

This is the exact sequence to take this project from "code complete" to "submission complete": get the
mock server public, wire it into a real Vapi assistant, run the security-critical test, and record the
two required demo paths. Budget ~20–30 minutes if nothing goes wrong, more if this is your first time in
the Vapi dashboard.

---

## Step 0 — Prerequisites

- [ ] Node.js v18+ installed locally
- [ ] A free account at [vapi.ai](https://vapi.ai)
- [ ] `ngrok` installed ([ngrok.com/download](https://ngrok.com/download)) — or a Render/Vercel account if
      you'd rather deploy instead of tunnel
- [ ] A screen recorder ready (Loom, OBS, or even QuickTime/Zoom)

---

## Step 1 — Run the mock server locally

```bash
cd mock-server
npm install
npm start
```

You should see:
```
Kapture Mock Collections Webhook Server running on port 3000
```

**Sanity check before doing anything else** — confirm the auth gate works locally:

```bash
# Should be REJECTED (no verify_customer yet for this call_id)
curl -s -X POST http://localhost:3000/api/verify_customer -H "Content-Type: application/json" \
  -d '{"message":{"type":"tool-calls","toolCalls":[{"id":"t1","function":{"name":"log_promise_to_pay","arguments":{"account_id":"ACC-88392","ptp_date":"2026-08-14","amount":8499,"call_id":"smoke-test"}}}]}}'
# Expect: {"success":false,"error":"NOT_AUTHENTICATED",...}

# Verify, then retry — should now SUCCEED
curl -s -X POST http://localhost:3000/api/verify_customer -H "Content-Type: application/json" \
  -d '{"message":{"type":"tool-calls","toolCalls":[{"id":"t2","function":{"name":"verify_customer","arguments":{"account_id":"ACC-88392","verification_code":"1234","call_id":"smoke-test"}}}]}}'

curl -s -X POST http://localhost:3000/api/verify_customer -H "Content-Type: application/json" \
  -d '{"message":{"type":"tool-calls","toolCalls":[{"id":"t3","function":{"name":"log_promise_to_pay","arguments":{"account_id":"ACC-88392","ptp_date":"2026-08-14","amount":8499,"call_id":"smoke-test"}}}]}}'
# Expect: {"success":true,"ptp_id":"PTP-1001",...}
```

If both checks match, the backend is proven correct **before** you spend any Vapi call minutes on it.

---

## Step 2 — Expose it publicly

**Option A — ngrok (fastest for a demo):**
```bash
ngrok http 3000
```
Copy the `https://xxxx.ngrok-free.app` URL it prints. Keep this terminal window open for the whole demo —
closing it kills the tunnel.

**Option B — Render/Vercel (more durable, survives your laptop sleeping):**
Deploy the `mock-server/` folder as a standard Node web service; use the resulting `https://your-app.onrender.com`
URL the same way below.

**Test the public URL works** before touching Vapi:
```bash
curl https://YOUR_PUBLIC_URL/health
# Expect: {"status":"ok"}
```

---

## Step 3 — Point the tool definitions at your real URL

In `vapi/tool_definitions.json`, every tool has a placeholder:
```json
"server": { "url": "https://paralyze-daringly-coleslaw.ngrok-free.dev/api/verify_customer" }
```

Replace all five occurrences with your real URL from Step 2. Fastest way:

```bash
cd vapi
sed -i 's|https://paralyze-daringly-coleslaw.ngrok-free.dev/api/verify_customer|https://YOUR_ACTUAL_URL/webhook|g' tool_definitions.json
grep -c "YOUR_ACTUAL_URL" tool_definitions.json   # sanity check it applied
```

(On macOS, `sed -i ''` needs the empty string argument: `sed -i '' 's|...|...|g' tool_definitions.json`.)

---

## Step 4 — Create and configure the Vapi assistant

1. Log into the [Vapi dashboard](https://dashboard.vapi.ai).
2. **Assistants → Create Assistant → Blank Template.**
3. **Model tab:**
   - Provider: OpenAI
   - Model: `gpt-4o-mini` (or `gpt-4o`)
   - Temperature: `0.1`
   - System prompt: paste the entire contents of `vapi/system_prompt.txt`
4. **Transcriber tab:**
   - Provider: Deepgram
   - Model: `nova-2`
   - Language: `en` (switch to `multi` if you're doing the Hindi/Hinglish bonus)
5. **Voice tab:**
   - Provider: ElevenLabs or Cartesia
   - Pick a calm, professional voice
6. **First message:** `Hello, this is Maya calling from Kapture Finance. Am I speaking with Mr. Rahul Sharma?`
7. **Tools / Functions tab:** import `vapi/tool_definitions.json` directly if Vapi supports bulk import, or
   add the five functions manually, one at a time, matching name/parameters/server URL exactly.
8. **Save.**

---

## Step 5 — Prove the integration actually works end to end

Start a **Web Call** from the Vapi dashboard (fastest — no phone number needed) and watch two things at
once: the call transcript, and your ngrok terminal / `GET https://YOUR_PUBLIC_URL/logs` for incoming tool
calls.

**Minimum viable integration test (matches TC-001/TC-002):**
1. Say: *"Hi, who is this?"* → Maya should identify herself and Kapture Finance, no debt mentioned.
2. Say: *"Yes, this is Rahul. How much do I owe?"* → **Maya must not disclose the amount.** This is the
   single most important thing to verify — if this fails, stop and fix the prompt before recording anything.
3. Give the verification code: *"My PAN digits are 1234"* → confirm in your terminal that `verify_customer`
   hit your webhook and returned `verified: true`.
4. Confirm Maya now discloses ₹8,499 / 12 days overdue.

If step 2 leaks debt info, the fix is almost always tightening the system prompt's early branches (STATE 0)
— check that the "who is this" and "how much do I owe" phrasing isn't being treated as a green light.

---

## Step 6 — Record the two required demo paths

**Recording 1 — Happy path (PTP):**
1. Confirm identity → verify (`1234`) → debt disclosed
2. "I'll pay this Friday" → confirm `log_promise_to_pay` and `send_payment_link` both fire (check `/logs`)
3. Maya confirms and closes → confirm `mark_disposition(PTP_AGREED)` fired

**Recording 2 — Edge case (Do Not Call recommended):**
1. Confirm identity → verify → debt disclosed
2. "Stop calling me, put me on your do-not-call list."
3. Confirm Maya complies immediately, no debate, and `mark_disposition(DO_NOT_CALL)` fires
4. Call ends within 1 turn of the request

Keep each recording to 2–4 minutes. Loom's "Screen + Cam" is fine — you don't need editing, just narrate
briefly at the start what you're about to show ("this is the happy path PTP flow...").

---

## Step 7 — Final submission checklist

- [ ] Backend auth-gate smoke test passed locally (Step 1)
- [ ] Public webhook URL live and reachable (`/health` returns 200)
- [ ] `tool_definitions.json` has the real URL, not the placeholder
- [ ] Vapi assistant configured with prompt, model, transcriber, voice, and all 5 tools
- [ ] Pre-auth debt question correctly refused in a live call
- [ ] Post-auth debt disclosure correct in a live call
- [ ] Happy-path PTP recording done, tool calls confirmed via `/logs`
- [ ] Edge-case (DNC) recording done, `mark_disposition(DO_NOT_CALL)` confirmed via `/logs`
- [ ] README, HLD, system prompt, tool JSON, test cases all in the final zip
- [ ] No secrets committed (check `.env` isn't in the zip, only `.env.example`)

Once all of these are checked, you're at the "working, defensible build" bar the assignment is asking for
— not a polished production system, but a real one that runs and that you can explain line by line.
