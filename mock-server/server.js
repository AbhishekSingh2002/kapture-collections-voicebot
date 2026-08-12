/**
 * Kapture Finance Collections Voicebot — Mock Webhook Server
 *
 * Handles Vapi tool-call events for:
 *   verify_customer, log_promise_to_pay, send_payment_link,
 *   escalate_to_agent, mark_disposition
 *
 * This is a deliberately simple, in-memory mock — good enough for a
 * one-day take-home demo, NOT a production backend.
 *
 * IMPORTANT: authentication is enforced HERE, not just in the prompt.
 * verify_customer() sets CALL_STATE[callSessionId].authenticated = true,
 * and every protected tool checks that flag before doing anything. If the
 * LLM tries to call a protected tool before verification has succeeded for
 * that call session, the backend rejects it outright — the model cannot
 * talk its way past this.
 */

const express = require('express');
const app = express();
app.use(express.json());

// --- Mock "datastore" -------------------------------------------------
const ACCOUNTS = {
  'ACC-88392': {
    customer_name: 'Rahul Sharma',
    valid_codes: ['1234', '1995'], // last 4 PAN digits OR birth year
    loan_type: 'Personal Loan',
    overdue_amount: 8499,
    dpd: 12,
  },
};

// --- Per-call authentication state -------------------------------------
// Keyed by the Vapi call session ID (message.call.id), NOT the individual
// tool-call ID. This is what makes authentication state-enforced rather
// than prompt-only: it survives across multiple tool calls within the
// same phone call and cannot be reset or spoofed by the LLM's phrasing.
const CALL_STATE = {};

function getCallState(callSessionId) {
  if (!CALL_STATE[callSessionId]) {
    CALL_STATE[callSessionId] = { authenticated: false, account_id: null };
  }
  return CALL_STATE[callSessionId];
}

// --- Deterministic ID counters (per assignment: prefer a deterministic
// mock dataset/behaviour over randomness, for repeatable demos/tests) ---
let ptpCounter = 1000;
let escalationCounter = 1000;
function nextPtpId() {
  ptpCounter += 1;
  return `PTP-${ptpCounter}`;
}
function nextEscalationId() {
  escalationCounter += 1;
  return `ESC-${escalationCounter}`;
}

function maskName(name) {
  if (!name) return name;
  const [first, ...rest] = name.split(' ');
  const lastInitial = rest.length ? rest[rest.length - 1][0] : '';
  return `${first} ${lastInitial}****`.trim();
}

// call logs kept in memory for the demo / observability view
const CALL_LOG = [];
function logEvent(entry) {
  const record = { timestamp: new Date().toISOString(), ...entry };
  CALL_LOG.push(record);
  console.log('[LOG]', JSON.stringify(record));
}

function authError(message) {
  return { success: false, error: 'NOT_AUTHENTICATED', message };
}

// --- Main Vapi webhook --------------------------------------------------
app.post('/webhook', (req, res) => {
  const { message } = req.body || {};

  if (message && message.type === 'tool-calls') {
    const toolCall = message.toolCalls[0];
    const { name, arguments: args } = toolCall.function;
    const toolCallId = toolCall.id;

    // Vapi sends the overall call session under message.call.id. For local
    // curl testing (no real Vapi call object present) we fall back to an
    // explicit call_id in the tool arguments, or a shared 'local-test'
    // session so repeated curl calls in the same test session share state.
    const callSessionId = message.call?.id || args.call_id || 'local-test';
    const state = getCallState(callSessionId);

    console.log(`[Tool Call Received]: ${name} (session=${callSessionId})`, args);

    let result = {};
    const account = ACCOUNTS[args.account_id];

    switch (name) {
      case 'verify_customer': {
        if (!account) {
          result = { verified: false, message: 'Unknown account.' };
          break;
        }
        const verified = account.valid_codes.includes(String(args.verification_code));
        if (verified) {
          state.authenticated = true;
          state.account_id = args.account_id;
        }
        result = verified
          ? { verified: true, customer_name: account.customer_name, message: 'Identity verified successfully.' }
          : { verified: false, message: 'Verification failed. Incorrect code.' };
        logEvent({
          event: 'verify_customer',
          call_session: callSessionId,
          account_id: args.account_id,
          customer_name_masked: maskName(account.customer_name),
          verified,
        });
        break;
      }

      // --- Protected tools: require state.authenticated === true for
      // THIS call session, set only by a successful verify_customer above.
      case 'log_promise_to_pay': {
        if (!state.authenticated || state.account_id !== args.account_id) {
          result = authError('Customer must be authenticated (verify_customer) before logging a promise to pay.');
          logEvent({ event: 'log_promise_to_pay_REJECTED', call_session: callSessionId, account_id: args.account_id });
          break;
        }
        result = {
          success: true,
          ptp_id: nextPtpId(),
          confirmed_date: args.ptp_date,
          amount: args.amount,
        };
        logEvent({ event: 'log_promise_to_pay', call_session: callSessionId, account_id: args.account_id, ptp_date: args.ptp_date, amount: args.amount });
        break;
      }

      case 'send_payment_link': {
        if (!state.authenticated || state.account_id !== args.account_id) {
          result = authError('Customer must be authenticated (verify_customer) before sending a payment link.');
          logEvent({ event: 'send_payment_link_REJECTED', call_session: callSessionId, account_id: args.account_id });
          break;
        }
        result = {
          success: true,
          message: `Payment link sent via ${args.channel} to the registered mobile number.`,
        };
        logEvent({ event: 'send_payment_link', call_session: callSessionId, account_id: args.account_id, channel: args.channel });
        break;
      }

      case 'escalate_to_agent': {
        if (!state.authenticated || state.account_id !== args.account_id) {
          result = authError('Customer must be authenticated (verify_customer) before escalating the case.');
          logEvent({ event: 'escalate_to_agent_REJECTED', call_session: callSessionId, account_id: args.account_id });
          break;
        }
        result = {
          success: true,
          escalation_id: nextEscalationId(),
        };
        logEvent({ event: 'escalate_to_agent', call_session: callSessionId, account_id: args.account_id, reason: args.reason, notes: args.notes || '' });
        break;
      }

      // --- Unprotected: must be callable even pre-authentication, since
      // WRONG_PERSON, DO_NOT_CALL, and NO_RESPONSE can all happen before
      // (or without ever reaching) a successful verify_customer.
      case 'mark_disposition': {
        result = {
          success: true,
          disposition_logged: args.status,
          timestamp: new Date().toISOString(),
        };
        logEvent({ event: 'mark_disposition', call_session: callSessionId, account_id: args.account_id, status: args.status, notes: args.notes || '' });
        break;
      }

      default:
        result = { success: false, message: 'Unknown function call' };
    }

    // Response format required by Vapi for tool-call results
    return res.status(200).json({
      results: [
        {
          toolCallId,
          result: JSON.stringify(result),
        },
      ],
    });
  }

  // Fallback for other Vapi event notifications (status-update, end-of-call-report, etc.)
  if (message && message.type === 'end-of-call-report') {
    console.log('[Call ended]', message.endedReason || '');
    // Clean up state for this call session once it's over.
    const endedSessionId = message.call?.id;
    if (endedSessionId) delete CALL_STATE[endedSessionId];
  }
  return res.status(200).json({ status: 'acknowledged' });
});

// Simple endpoints to eyeball state during the demo / debugging
app.get('/logs', (req, res) => {
  res.status(200).json(CALL_LOG);
});

app.get('/call-state', (req, res) => {
  res.status(200).json(CALL_STATE);
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Kapture Mock Collections Webhook Server running on port ${PORT}`);
});
