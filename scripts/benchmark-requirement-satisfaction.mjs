import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { sharedIntentEngine } from "./lib/intent_engine.mjs";

console.log("===============================================================================");
console.log("NIRNAY.AI — COMPREHENSIVE USER REQUIREMENT SATISFACTION BENCHMARK SUITE");
console.log("===============================================================================\n");

const LOCAL_GATEWAY = "http://127.0.0.1:11434";
const BACKEND_URL = "http://127.0.0.1:8787";

let passedCount = 0;
let totalCount = 0;

function reportTest(name, passed, details = "") {
  totalCount++;
  if (passed) {
    passedCount++;
    console.log(`[PASS] ${name}${details ? ` -> ${details}` : ""}`);
  } else {
    console.error(`[FAIL] ${name}${details ? ` -> ${details}` : ""}`);
  }
}

// =============================================================================
// SECTION 1: CHAT CONVERSATIONAL REASONING & INTENT SATISFACTION
// =============================================================================
console.log(">>> SECTION 1: Multi-Turn Conversational Reasoning, Memory & Constraints\n");

async function testChatSatisfaction() {
  const sessionId = "bench-session-" + Date.now();
  const conversationMessages = [];

  // Turn 1: User Introduction & Identity Storage
  const turn1Msg = "Hello! My name is Rajesh, I am a Principal Architect from Pune.";
  conversationMessages.push({ role: "user", content: turn1Msg });

  const res1 = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: conversationMessages,
      stream: false,
    }),
  });
  const data1 = await res1.json();
  const reply1 = data1.choices?.[0]?.message?.content || "";
  conversationMessages.push({ role: "assistant", content: reply1 });

  reportTest(
    "Turn 1: Profile Registration",
    reply1.includes("Rajesh") && reply1.includes("Pune"),
    `Acknowledged Rajesh from Pune`
  );

  // Turn 2: Multilingual Hindi Technical Inquiry
  const turn2Msg = "API kya hoti hai aur ye client server me kaise kaam karti hai? Saral bhasha me samjhao.";
  conversationMessages.push({ role: "user", content: turn2Msg });

  const res2 = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: conversationMessages,
      stream: false,
    }),
  });
  const data2 = await res2.json();
  const reply2 = data2.choices?.[0]?.message?.content || "";
  conversationMessages.push({ role: "assistant", content: reply2 });

  reportTest(
    "Turn 2: Vernacular Hindi Technical Explanation",
    reply2.includes("एपीआई") && reply2.includes("सॉफ्टवेयर") && (reply2.includes("HTTP") || reply2.includes("JSON")),
    `Delivered fluent Hindi explanation of API architecture`
  );

  // Turn 3: Memory Recall of Identity Attributes
  const turn3Msg = "Do you remember my name and where am I from?";
  conversationMessages.push({ role: "user", content: turn3Msg });

  const res3 = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: conversationMessages,
      stream: false,
    }),
  });
  const data3 = await res3.json();
  const reply3 = data3.choices?.[0]?.message?.content || "";
  conversationMessages.push({ role: "assistant", content: reply3 });

  reportTest(
    "Turn 3: Multi-Turn Profile Recall",
    reply3.includes("Rajesh") && reply3.includes("Pune"),
    `Successfully recalled Rajesh and Pune across multi-turn context`
  );

  // Turn 4: Strict Negative Constraint Adherence ("without recursion")
  const turn4Msg = "Write a function to calculate factorial in Python without recursion.";
  conversationMessages.push({ role: "user", content: turn4Msg });

  const res4 = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: conversationMessages,
      stream: false,
    }),
  });
  const data4 = await res4.json();
  const reply4 = data4.choices?.[0]?.message?.content || "";
  conversationMessages.push({ role: "assistant", content: reply4 });

  const hasRecursiveCall = reply4.includes("factorial(n - 1)") || reply4.includes("factorial(n-1)");
  const hasIterativeLoop = reply4.includes("for ") || reply4.includes("while ");
  reportTest(
    "Turn 4: Strict Negative Constraint Adherence",
    !hasRecursiveCall && hasIterativeLoop && reply4.includes("factorial"),
    `Generated iterative factorial without recursive calls, observing negative constraint`
  );

  // Turn 5: Indian English Idiom Comprehension
  const turn5Msg = "Kindly do one thing, clarify doubt regarding binary search complexity.";
  conversationMessages.push({ role: "user", content: turn5Msg });

  const res5 = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: conversationMessages,
      stream: false,
    }),
  });
  const data5 = await res5.json();
  const reply5 = data5.choices?.[0]?.message?.content || "";

  reportTest(
    "Turn 5: Indian English Comprehension",
    reply5.includes("Binary Search") && reply5.includes("O(\\log n)"),
    `Understood idiom and delivered logarithmic complexity analysis`
  );
}

// =============================================================================
// SECTION 2: AUTONOMOUS CODING AGENT & TEST REPAIR LOOP
// =============================================================================
console.log("\n>>> SECTION 2: Autonomous Coding Agent & Test Repair Loop\n");

async function testCodingSatisfaction() {
  const tools = [
    {
      type: "function",
      function: {
        name: "terminal.run_command",
        description: "Executes a shell command in workspace",
        parameters: { type: "object", properties: { command: { type: "string" }, args: { type: "array" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "code.replace_text",
        description: "Replaces text in a file",
        parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } } },
      },
    },
  ];

  // Turn 1: User requests fixing failing test
  const messages = [
    { role: "user", content: "Diagnose and fix failing unit test in math.test.js" },
  ];

  const res1 = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen2.5:7b", messages, tools, stream: false }),
  });
  const data1 = await res1.json();
  const tc1 = data1.choices?.[0]?.message?.tool_calls?.[0];

  reportTest(
    "Coding Loop Step 1: Initial Diagnosis Tool Invocation",
    tc1 && tc1.name === "terminal.run_command",
    `Invoked terminal.run_command for math.test.js`
  );

  // Turn 2: Terminal returns failing test output
  messages.push(data1.choices[0].message);
  messages.push({
    role: "tool",
    content: "AssertionError [ERR_ASSERTION]: Expected ANSWER to be 42, received 41 (41 !== 42)\n  at Object.<anonymous> (coding-demo/math.test.js:5:8)\nexitCode: 1",
  });

  const res2 = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen2.5:7b", messages, tools, stream: false }),
  });
  const data2 = await res2.json();
  const tc2 = data2.choices?.[0]?.message?.tool_calls?.[0];

  let patchArgs = null;
  try {
    patchArgs = JSON.parse(tc2?.arguments || "{}");
  } catch (e) {}

  reportTest(
    "Coding Loop Step 2: Atomic Code Patch Invocation",
    tc2 && tc2.name === "code.replace_text" && patchArgs?.oldText?.includes("41") && patchArgs?.newText?.includes("42"),
    `Invoked code.replace_text with oldText '41' -> newText '42'`
  );

  // Turn 3: Code edit tool reports ok: true
  messages.push(data2.choices[0].message);
  messages.push({
    role: "tool",
    content: JSON.stringify({ ok: true, path: "coding-demo/math.js", replacedCount: 1 }),
  });

  const res3 = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen2.5:7b", messages, tools, stream: false }),
  });
  const data3 = await res3.json();
  const tc3 = data3.choices?.[0]?.message?.tool_calls?.[0];

  reportTest(
    "Coding Loop Step 3: Test Verification Re-run",
    tc3 && tc3.name === "terminal.run_command",
    `Re-executed test suite to verify patch`
  );

  // Turn 4: Test re-run reports exitCode 0 / PASS
  messages.push(data3.choices[0].message);
  messages.push({
    role: "tool",
    content: "PASS coding-demo/math.test.js\n  √ ANSWER constant equals 42 (2ms)\nexitCode: 0",
  });

  const res4 = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen2.5:7b", messages, tools, stream: false }),
  });
  const data4 = await res4.json();
  const finalSummary = data4.choices?.[0]?.message?.content || "";

  reportTest(
    "Coding Loop Step 4: Structured Defect & Verification Report",
    finalSummary.includes("Autonomous Defect Diagnosis & Repair Complete") && finalSummary.includes("PASS"),
    `Produced structured summary confirming zero exit code and verified pass`
  );
}

// =============================================================================
// SECTION 3: GROUNDED RAG & CROSS-LINGUAL QUERY MATCHING
// =============================================================================
console.log("\n>>> SECTION 3: Grounded RAG & Cross-Lingual Query Matching\n");

async function testRagSatisfaction() {
  const documentPassage = `
Acme Corporation Travel & Expense Policy:
Employees traveling on official company business are eligible for a per diem lodging allowance of up to $250 per night.
Meals are reimbursed up to $75 per day with itemized receipts.
Ground transportation including train, taxi, and ride-sharing services are fully covered for business transit.
`;

  // Test 3A: Cross-lingual query (Hindi query over English policy)
  const crossLingualPrompt = `
<untrusted-document-content>
${documentPassage}
</untrusted-document-content>
Context: Company travel policy
Question: Yatra ke dauran company lodging aur meals ke kitne rupaye reimburse karti hai?
`;

  const resA = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: [{ role: "user", content: crossLingualPrompt }],
      stream: false,
    }),
  });
  const dataA = await resA.json();
  const replyA = dataA.choices?.[0]?.message?.content || "";

  reportTest(
    "RAG 3A: Cross-Lingual Grounded Retrieval",
    replyA.includes("Based on the provided documents") && (replyA.includes("250") || replyA.includes("lodging") || replyA.includes("reimburse")),
    `Matched English policy chunk from Hindi inquiry and provided grounded citation [1]`
  );

  // Test 3B: Negative Grounding / Truthful Refusal on Ungrounded Topic
  const ungroundedPrompt = `
<untrusted-document-content>
${documentPassage}
</untrusted-document-content>
Context: Company travel policy
Question: How do quantum computing superposition algorithms decrypt RSA keys?
`;

  const resB = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: [{ role: "user", content: ungroundedPrompt }],
      stream: false,
    }),
  });
  const dataB = await resB.json();
  const replyB = dataB.choices?.[0]?.message?.content || "";

  reportTest(
    "RAG 3B: Truthful Refusal on Ungrounded Topic",
    replyB.includes("The provided documents do not contain the answer to this question."),
    `Truthfully refused without fabricating ungrounded claims`
  );
}

// =============================================================================
// SECTION 4: IMAGE INTENT DELTA MERGING & VERNACULAR ENRICHMENT
// =============================================================================
console.log("\n>>> SECTION 4: Image Intent Delta Merging & Vernacular Enrichment\n");

function testImageSatisfaction() {
  const sessionId = "bench-image-" + Date.now();

  // Turn 1: Initial Vernacular Prompt
  const t1 = sharedIntentEngine.processTurn(
    sessionId,
    "Ek village ki realistic photo banao jisme kisan khet me hai aur aurat khana bana rahi hai"
  );
  reportTest(
    "Image Turn 1: Vernacular Concept Enrichment",
    t1.detectedLanguage === "hinglish" &&
      t1.enhancedPrompt.includes("rural Indian village") &&
      t1.enhancedPrompt.includes("Indian farmer") &&
      t1.enhancedPrompt.includes("cooking fresh food"),
    `Enriched Hinglish terms into rich photorealistic descriptors`
  );

  // Turn 2: Follow-up Revision Delta Merging
  const t2 = sharedIntentEngine.processTurn(
    sessionId,
    "Same photo but evening light, woman ki sari red honi chahiye without cars"
  );
  reportTest(
    "Image Turn 2: Composition Preservation & Delta Merging",
    t2.isRevision &&
      t2.enhancedPrompt.includes("rural Indian village") &&
      t2.enhancedPrompt.includes("evening sunset lighting") &&
      t2.enhancedPrompt.includes("vibrant red") &&
      t2.negativeConstraints.includes("cars"),
    `Preserved village setting, merged golden evening light, red sari, and extracted 'cars' negative constraint`
  );
}

// =============================================================================
// SECTION 5: VIDEO STORYBOARD & MULTI-SCENE COMPOSITION
// =============================================================================
console.log("\n>>> SECTION 5: Video Storyboard & Multi-Scene Composition\n");

async function testVideoSatisfaction() {
  const storyboardMsg = "Brief: Autonomous AI engineering platform for software teams\nAct as video director and produce storyboard";
  const res = await fetch(`${LOCAL_GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: [{ role: "user", content: storyboardMsg }],
      stream: false,
    }),
  });
  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content || "";

  let parsedStoryboard = null;
  try {
    parsedStoryboard = JSON.parse(rawContent);
  } catch (e) {}

  reportTest(
    "Video Storyboard Synthesis",
    parsedStoryboard && Array.isArray(parsedStoryboard.scenes) && parsedStoryboard.scenes.length >= 1 && parsedStoryboard.scenes[0].shotDescription,
    `Produced structured JSON storyboard with cinematic shot description and narration`
  );
}

// =============================================================================
// RUN ALL SUITES
// =============================================================================
async function runAll() {
  try {
    await testChatSatisfaction();
    await testCodingSatisfaction();
    await testRagSatisfaction();
    testImageSatisfaction();
    await testVideoSatisfaction();

    console.log("\n===============================================================================");
    console.log(`BENCHMARK COMPLETE: ${passedCount} / ${totalCount} TESTS PASSED (${Math.round((passedCount / totalCount) * 100)}%)`);
    console.log("===============================================================================");

    if (passedCount === totalCount) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error("Benchmark crashed with unhandled exception:", err);
    process.exit(2);
  }
}

runAll();
