import http from "node:http";

const API_BASE = "http://127.0.0.1:8787";

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, data };
}

async function getJson(path, headers = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...headers },
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, data };
}

function extractCookies(headers) {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  let aipSession = null;
  let aipCsrf = null;
  for (const c of list) {
    const sMatch = c.match(/aip_session=([^;]+)/);
    if (sMatch) aipSession = sMatch[1];
    const cMatch = c.match(/aip_csrf=([^;]+)/);
    if (cMatch) aipCsrf = cMatch[1];
  }
  return { aipSession, aipCsrf };
}

async function streamChatSSE(path, body, headers = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Chat request failed (${res.status}): ${errorText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullAssistantText = "";
  let tokenCount = 0;
  let doneEvent = null;
  const events = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("event:")) {
        const eventType = line.slice(6).trim();
        const nextLine = lines[i + 1]?.trim() || "";
        if (nextLine.startsWith("data:")) {
          i++;
          const dataJson = JSON.parse(nextLine.slice(5).trim());
          events.push({ type: eventType, data: dataJson });

          if (eventType === "token" && dataJson.delta) {
            tokenCount++;
            fullAssistantText += dataJson.delta;
          } else if (eventType === "done") {
            doneEvent = dataJson;
          }
        }
      }
    }
  }

  return { fullAssistantText, tokenCount, doneEvent, events };
}

async function run() {
  console.log("=== MILESTONE 8: REAL AI INTELLIGENCE ACCEPTANCE TEST SUITE ===\n");

  // Step 1: Authentication / Session Setup
  const email = `test-user-${Date.now()}@example.com`;
  const password = "ValidPassword123!@#Secure";

  console.log(`[1] Signing up test account: ${email}`);
  const signup = await postJson("/api/v1/auth/signup", {
    email,
    password,
    displayName: "Verification User",
    projectName: "Universal Agent Project",
  });

  if (signup.status !== 201) {
    console.error("Signup failed:", signup.data);
    process.exit(1);
  }

  const { aipSession, aipCsrf } = extractCookies(signup.headers);
  const csrfToken = signup.data.csrfToken || aipCsrf;
  const projectId = signup.data.defaultProjectId;

  console.log(`✓ Signed up successfully. ProjectId: ${projectId}`);
  console.log(`✓ Session token: ${aipSession ? "acquired" : "MISSING"}, CSRF token: ${csrfToken ? "acquired" : "MISSING"}\n`);

  const authHeaders = {
    Cookie: `aip_session=${aipSession}; aip_csrf=${csrfToken}`,
    "x-csrf-token": csrfToken,
    "x-project-id": projectId,
  };

  // Step 2: Probe GET /api/v1/models
  console.log("[2] Inspecting GET /api/v1/models...");
  const modelsRes = await getJson(`/api/v1/models?projectId=${projectId}`, authHeaders);
  console.log(`✓ Status: ${modelsRes.status}`);
  console.log(`✓ Active Default Model:`, modelsRes.data.default);
  console.log(`✓ Registered Models:`, JSON.stringify(modelsRes.data.models, null, 2));

  const defaultModel = modelsRes.data.models.find((m) => m.isDefault);
  if (!defaultModel) {
    console.error("FAIL: No default model found!");
    process.exit(1);
  }
  if (defaultModel.isMock) {
    console.error("FAIL: Default model is still marked as mock!");
    process.exit(1);
  }
  console.log(`✓ VERIFIED: Default model is REAL/LOCAL (${defaultModel.provider}/${defaultModel.model}), NOT A MOCK!\n`);

  // Step 3: Execute Required Acceptance Prompts
  const testCases = [
    {
      name: "Greeting & Persona ('hi')",
      prompt: "hi",
      assertions: (text) => {
        if (text.includes("[mock response")) return "Contains canned mock text";
        if (text.includes('You said: "hi"')) return "Echoes user prompt";
        if (!text.toLowerCase().includes("hello") && !text.toLowerCase().includes("agent")) {
          return "Did not provide an intelligent greeting";
        }
        return null;
      },
    },
    {
      name: "Factual Query ('Prime minister of india')",
      prompt: "Prime minister of india",
      assertions: (text) => {
        if (text.includes("[mock response")) return "Contains canned mock text";
        if (text.includes('You said: "Prime minister of india"')) return "Echoes user prompt";
        if (!text.includes("Narendra Modi")) return "Did not name Narendra Modi";
        return null;
      },
    },
    {
      name: "Multilingual Technical Query ('Explain quantum computing in simple Hindi')",
      prompt: "Explain quantum computing in simple Hindi",
      assertions: (text) => {
        if (text.includes("[mock response")) return "Contains canned mock text";
        if (text.includes('You said:')) return "Echoes user prompt";
        if (!text.includes("क्वांटम") || !text.includes("क्यूबिट")) {
          return "Did not answer in Hindi with quantum computing concepts";
        }
        return null;
      },
    },
    {
      name: "Model Comparison ('Compare ChatGPT, Gemini, and Claude')",
      prompt: "Compare ChatGPT, Gemini, and Claude across strengths, context window, and architecture",
      assertions: (text) => {
        if (text.includes("[mock response")) return "Contains canned mock text";
        if (text.includes('You said:')) return "Echoes user prompt";
        if (!text.includes("ChatGPT") || !text.includes("Gemini") || !text.includes("Claude")) {
          return "Missing model comparison details";
        }
        return null;
      },
    },
  ];

  let passedAll = true;
  const results = [];

  for (const tc of testCases) {
    console.log(`------------------------------------------------------------`);
    console.log(`TEST: ${tc.name}`);
    console.log(`User Prompt: "${tc.prompt}"`);

    const t0 = Date.now();
    const { fullAssistantText, tokenCount, doneEvent } = await streamChatSSE(
      "/api/v1/chat",
      {
        projectId,
        messages: [{ role: "user", content: tc.prompt }],
      },
      authHeaders
    );
    const latencyMs = Date.now() - t0;

    console.log(`\nStream Metrics: ${tokenCount} tokens streamed in ${latencyMs}ms (${(tokenCount / (latencyMs / 1000)).toFixed(1)} tokens/sec)`);
    console.log(`Provider Used: ${doneEvent?.provider} | Model: ${doneEvent?.model}`);
    console.log(`Assistant Response:\n${fullAssistantText}\n`);

    const err = tc.assertions(fullAssistantText);
    if (err) {
      console.error(`✗ FAILED ASSERTION: ${err}`);
      passedAll = false;
      results.push({ name: tc.name, status: "FAIL", error: err });
    } else {
      console.log(`✓ PASSED: Genuine intelligent AI response verified without mock text.`);
      results.push({ name: tc.name, status: "PASS", tokens: tokenCount, latencyMs });
    }
  }

  // Step 4: Multi-turn Context Memory Test
  console.log(`------------------------------------------------------------`);
  console.log(`TEST: Multi-Turn Conversation Memory Context`);

  console.log(`Turn 1: "Hello, my name is Saurabh Kumar and I am leading the AI agent platform development."`);
  const turn1 = await streamChatSSE(
    "/api/v1/chat",
    {
      projectId,
      messages: [
        { role: "user", content: "Hello, my name is Saurabh Kumar and I am leading the AI agent platform development." },
      ],
    },
    authHeaders
  );
  console.log(`Turn 1 Response:\n${turn1.fullAssistantText}\n`);

  console.log(`Turn 2: "What is my name?"`);
  const turn2 = await streamChatSSE(
    "/api/v1/chat",
    {
      projectId,
      conversationId: turn1.doneEvent?.conversationId,
      messages: [
        { role: "user", content: "Hello, my name is Saurabh Kumar and I am leading the AI agent platform development." },
        { role: "assistant", content: turn1.fullAssistantText },
        { role: "user", content: "What is my name?" },
      ],
    },
    authHeaders
  );
  console.log(`Turn 2 Response:\n${turn2.fullAssistantText}\n`);

  if (turn2.fullAssistantText.includes("Saurabh")) {
    console.log(`✓ PASSED: Multi-turn context memory correctly recalled name 'Saurabh'!`);
    results.push({ name: "Multi-Turn Context Memory", status: "PASS" });
  } else {
    console.error(`✗ FAILED: Did not recall name 'Saurabh' from previous turn!`);
    passedAll = false;
    results.push({ name: "Multi-Turn Context Memory", status: "FAIL", error: "Did not recall name" });
  }

  console.log(`============================================================`);
  console.log(`SUMMARY OF REAL AI VERIFICATION:`);
  console.table(results);

  if (passedAll) {
    console.log(`\n🎉 ALL REAL AI INTELLIGENCE ACCEPTANCE TESTS PASSED WITH 100% SUCCESS!`);
  } else {
    console.error(`\n❌ SOME TESTS FAILED`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
