/**
 * Kapture Finance Collections Voicebot
 * Mock API Server
 *
 * Endpoints:
 *
 * POST /api/verify_customer
 * POST /api/log_promise_to_pay
 * POST /api/send_payment_link
 * POST /api/escalate_to_agent
 * POST /api/mark_disposition
 *
 * GET /health
 * GET /logs
 * GET /call-state
 */

const express = require("express");

const app = express();

app.use(express.json());


// ============================================================
// MOCK DATABASE
// ============================================================

const ACCOUNTS = {
  "ACC-88392": {
    customer_name: "Rahul Sharma",

    // Valid verification values:
    // Last 4 PAN digits OR birth year
    valid_codes: ["1234", "1995"],

    loan_type: "Personal Loan",

    overdue_amount: 8499,

    dpd: 12,
  },
};


// ============================================================
// PER-CALL AUTHENTICATION STATE
// ============================================================

const CALL_STATE = {};

function getCallState(callSessionId) {
  if (!CALL_STATE[callSessionId]) {
    CALL_STATE[callSessionId] = {
      authenticated: false,
      account_id: null,
    };
  }

  return CALL_STATE[callSessionId];
}


// ============================================================
// DETERMINISTIC ID GENERATORS
// ============================================================

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


// ============================================================
// HELPER FUNCTIONS
// ============================================================

function maskName(name) {
  if (!name) {
    return name;
  }

  const parts = name.split(" ");

  const firstName = parts[0];

  const lastName = parts[parts.length - 1];

  const lastInitial = lastName
    ? lastName.charAt(0)
    : "";

  return `${firstName} ${lastInitial}****`;
}


// ------------------------------------------------------------
// Normalize verification code from speech-to-text
//
// Examples:
//
// "1234"          -> "1234"
// "1234."         -> "1234"
// "1, 2, 3, 4."   -> "1234"
// "1 2 3 4"       -> "1234"
// "1995"          -> "1995"
// ------------------------------------------------------------

function normalizeVerificationCode(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).replace(/\D/g, "");
}


// ------------------------------------------------------------
// Get call/session ID
//
// Kapture may not currently send a call ID in the request body.
// We check several possible locations.
//
// If none exist, use "missing-call-id".
// ------------------------------------------------------------

function getCallSessionId(req) {
  return (
    req.body?.call_id ||
    req.body?.callId ||
    req.body?.session_id ||
    req.body?.sessionId ||
    req.headers["x-call-id"] ||
    req.headers["x-session-id"] ||
    "missing-call-id"
  );
}


// ============================================================
// IN-MEMORY EVENT LOGS
// ============================================================

const CALL_LOG = [];


function logEvent(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  CALL_LOG.push(record);

  console.log("\n[LOG EVENT]");
  console.log(JSON.stringify(record, null, 2));
}


// ============================================================
// AUTH ERROR RESPONSE
// ============================================================

function authError(message) {
  return {
    success: false,

    error: "NOT_AUTHENTICATED",

    message,
  };
}


// ============================================================
// REQUEST LOGGER
// ============================================================

app.use((req, res, next) => {
  console.log("\n=================================================");
  console.log(`[${new Date().toISOString()}]`);
  console.log(`${req.method} ${req.originalUrl}`);

  if (
    req.method === "POST" ||
    req.method === "PUT" ||
    req.method === "PATCH"
  ) {
    console.log("Request Body:");

    console.log(JSON.stringify(req.body, null, 2));
  }

  console.log("=================================================\n");

  next();
});


// ============================================================
// VERIFY CUSTOMER
// ============================================================

app.post("/api/verify_customer", (req, res) => {
  const args = req.body || {};

  const callSessionId = getCallSessionId(req);

  const state = getCallState(callSessionId);

  const accountId = args.account_id;

  const rawVerificationCode = args.verification_code;

  const verificationCode =
    normalizeVerificationCode(rawVerificationCode);

  const account = ACCOUNTS[accountId];


  console.log("VERIFY CUSTOMER");
  console.log("Call Session:", callSessionId);
  console.log("Account ID:", accountId);
  console.log("Raw Verification Code:", rawVerificationCode);
  console.log("Normalized Code:", verificationCode);


  // ----------------------------------------------------------
  // Unknown account
  // ----------------------------------------------------------

  if (!account) {
    const result = {
      verified: false,

      message: "Unknown account.",
    };

    logEvent({
      event: "verify_customer",

      call_session: callSessionId,

      account_id: accountId,

      verified: false,

      reason: "UNKNOWN_ACCOUNT",
    });

    return res.status(200).json(result);
  }


  // ----------------------------------------------------------
  // Verify normalized code
  // ----------------------------------------------------------

  const verified =
    account.valid_codes.includes(verificationCode);


  // ----------------------------------------------------------
  // Successful authentication
  // ----------------------------------------------------------

  if (verified) {
    state.authenticated = true;

    state.account_id = accountId;
  }


  // ----------------------------------------------------------
  // Log result
  // ----------------------------------------------------------

  logEvent({
    event: "verify_customer",

    call_session: callSessionId,

    account_id: accountId,

    customer_name_masked:
      maskName(account.customer_name),

    raw_verification_code:
      String(rawVerificationCode || ""),

    normalized_code:
      verificationCode,

    verified,
  });


  // ----------------------------------------------------------
  // API response
  // ----------------------------------------------------------

  return res.status(200).json({
    verified,

    customer_name:
      verified
        ? account.customer_name
        : null,

    message:
      verified
        ? "Identity verified successfully."
        : "Verification failed. Incorrect code.",
  });
});


// ============================================================
// LOG PROMISE TO PAY
// ============================================================

app.post("/api/log_promise_to_pay", (req, res) => {
  const args = req.body || {};

  const callSessionId = getCallSessionId(req);

  const state = getCallState(callSessionId);

  const accountId = args.account_id;


  console.log("LOG PROMISE TO PAY");

  console.log("Call Session:", callSessionId);

  console.log("Authentication State:", state);


  // ----------------------------------------------------------
  // Authentication check
  // ----------------------------------------------------------

  if (
    !state.authenticated ||
    state.account_id !== accountId
  ) {
    const result = authError(
      "Customer must be authenticated before logging a promise to pay."
    );

    logEvent({
      event: "log_promise_to_pay_REJECTED",

      call_session: callSessionId,

      account_id: accountId,

      reason: "NOT_AUTHENTICATED",
    });

    return res.status(403).json(result);
  }


  // ----------------------------------------------------------
  // Create promise to pay
  // ----------------------------------------------------------

  const ptpId = nextPtpId();

  const result = {
    success: true,

    ptp_id: ptpId,

    confirmed_date: args.ptp_date,

    amount: args.amount,

    message: "Promise to pay recorded successfully.",
  };


  logEvent({
    event: "log_promise_to_pay",

    call_session: callSessionId,

    account_id: accountId,

    ptp_id: ptpId,

    ptp_date: args.ptp_date,

    amount: args.amount,
  });


  return res.status(200).json(result);
});


// ============================================================
// SEND PAYMENT LINK
// ============================================================

app.post("/api/send_payment_link", (req, res) => {
  const args = req.body || {};

  const callSessionId = getCallSessionId(req);

  const state = getCallState(callSessionId);

  const accountId = args.account_id;


  console.log("SEND PAYMENT LINK");

  console.log("Call Session:", callSessionId);

  console.log("Authentication State:", state);


  // ----------------------------------------------------------
  // Authentication check
  // ----------------------------------------------------------

  if (
    !state.authenticated ||
    state.account_id !== accountId
  ) {
    const result = authError(
      "Customer must be authenticated before sending a payment link."
    );

    logEvent({
      event: "send_payment_link_REJECTED",

      call_session: callSessionId,

      account_id: accountId,

      reason: "NOT_AUTHENTICATED",
    });

    return res.status(403).json(result);
  }


  const channel =
    args.channel || "SMS";


  const result = {
    success: true,

    message:
      `Payment link sent via ${channel} ` +
      `to the registered mobile number.`,
  };


  logEvent({
    event: "send_payment_link",

    call_session: callSessionId,

    account_id: accountId,

    channel,
  });


  return res.status(200).json(result);
});


// ============================================================
// ESCALATE TO AGENT
// ============================================================

app.post("/api/escalate_to_agent", (req, res) => {
  const args = req.body || {};

  const callSessionId = getCallSessionId(req);

  const state = getCallState(callSessionId);

  const accountId = args.account_id;


  console.log("ESCALATE TO AGENT");

  console.log("Call Session:", callSessionId);

  console.log("Authentication State:", state);


  // ----------------------------------------------------------
  // Authentication check
  // ----------------------------------------------------------

  if (
    !state.authenticated ||
    state.account_id !== accountId
  ) {
    const result = authError(
      "Customer must be authenticated before escalating to an agent."
    );

    logEvent({
      event: "escalate_to_agent_REJECTED",

      call_session: callSessionId,

      account_id: accountId,

      reason: "NOT_AUTHENTICATED",
    });

    return res.status(403).json(result);
  }


  const escalationId =
    nextEscalationId();


  const result = {
    success: true,

    escalation_id:
      escalationId,

    message:
      "Case successfully escalated to an agent.",
  };


  logEvent({
    event: "escalate_to_agent",

    call_session: callSessionId,

    account_id: accountId,

    escalation_id:
      escalationId,

    reason:
      args.reason,

    notes:
      args.notes || "",
  });


  return res.status(200).json(result);
});


// ============================================================
// MARK DISPOSITION
//
// This endpoint is intentionally NOT protected.
//
// Dispositions such as:
//
// WRONG_PERSON
// DO_NOT_CALL
// NO_RESPONSE
//
// can occur before authentication.
// ============================================================

app.post("/api/mark_disposition", (req, res) => {
  const args = req.body || {};

  const callSessionId = getCallSessionId(req);


  console.log("MARK DISPOSITION");

  console.log("Call Session:", callSessionId);


  const result = {
    success: true,

    disposition_logged:
      args.status,

    timestamp:
      new Date().toISOString(),

    message:
      "Disposition recorded successfully.",
  };


  logEvent({
    event: "mark_disposition",

    call_session: callSessionId,

    account_id:
      args.account_id || null,

    status:
      args.status,

    notes:
      args.notes || "",
  });


  return res.status(200).json(result);
});


// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {
  return res.status(200).json({
    status: "ok",

    service:
      "Kapture Finance Collections API Server",
  });
});


// ============================================================
// VIEW LOGS
// ============================================================

app.get("/logs", (req, res) => {
  return res.status(200).json(CALL_LOG);
});


// ============================================================
// VIEW CALL AUTHENTICATION STATE
// ============================================================

app.get("/call-state", (req, res) => {
  return res.status(200).json(CALL_STATE);
});


// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  return res.status(200).json({
    service:
      "Kapture Finance Collections Mock API Server",

    endpoints: [
      "POST /api/verify_customer",
      "POST /api/log_promise_to_pay",
      "POST /api/send_payment_link",
      "POST /api/escalate_to_agent",
      "POST /api/mark_disposition",
      "GET /health",
      "GET /logs",
      "GET /call-state",
    ],
  });
});


// ============================================================
// START SERVER
// ============================================================

const PORT =
  process.env.PORT || 3000;


app.listen(PORT, () => {
  console.log("\n=================================================");

  console.log(
    `Kapture Mock Collections API Server running on port ${PORT}`
  );

  console.log(
    `Health: http://localhost:${PORT}/health`
  );

  console.log(
    `Logs: http://localhost:${PORT}/logs`
  );

  console.log(
    `Call State: http://localhost:${PORT}/call-state`
  );

  console.log("\nAPI Tool Endpoints:");

  console.log(
    "POST /api/verify_customer"
  );

  console.log(
    "POST /api/log_promise_to_pay"
  );

  console.log(
    "POST /api/send_payment_link"
  );

  console.log(
    "POST /api/escalate_to_agent"
  );

  console.log(
    "POST /api/mark_disposition"
  );

  console.log("=================================================\n");
});