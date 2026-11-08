async function main() {
  console.log("=== MILESTONE-02 LOCAL MODEL INFERENCE & ROUTING TEST ===");

  // 1. Check local model server tags/models
  console.log("[1] Testing Local Model Server API on :11434...");
  const tagsRes = await fetch("http://127.0.0.1:11434/api/tags");
  const tagsData = await tagsRes.json();
  console.log("✓ /api/tags response:", tagsData);

  const modelsRes = await fetch("http://127.0.0.1:11434/v1/models");
  const modelsData = await modelsRes.json();
  console.log("✓ /v1/models response:", modelsData);

  // 2. Check Backend /api/v1/models with authenticated session
  console.log("\n[2] Testing Backend Model Registry (/api/v1/models)...");
  const loginRes = await fetch("http://127.0.0.1:8787/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "operator@local.dev", password: "test-password-1234" }),
  });
  const cookie = loginRes.headers.get("set-cookie");
  const loginData = await loginRes.json();
  const beModelsRes = await fetch("http://127.0.0.1:8787/api/v1/models", {
    headers: {
      cookie,
      "x-csrf-token": loginData.csrfToken,
      "x-project-id": loginData.projects[0].id,
    },
  });
  const beModelsData = await beModelsRes.json();
  console.log("✓ Backend Models:", beModelsData);

  // 3. Test SSE Streaming Response from model server
  console.log("\n[3] Testing SSE Token Streaming from 127.0.0.1:11434...");
  const streamRes = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: [{ role: "user", content: "What is 2 + 2?" }],
      stream: true,
    }),
  });

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
        try {
          const parsed = JSON.parse(line.slice(6));
          const delta = parsed.choices?.[0]?.delta?.content || "";
          fullText += delta;
          chunkCount++;
        } catch {}
      }
    }
  }

  console.log(`✓ Received ${chunkCount} streamed chunks.`);
  console.log(`✓ Full Streamed Content: "${fullText.trim()}"`);

  // Verify anti-mock: ensure answer contains arithmetic 4 and not canned prompt echo
  if (fullText.includes('You said: "What is 2 + 2?"') || fullText.includes("[mock response]")) {
    throw new Error("FAIL: Response contained mock text!");
  }
  if (!fullText.includes("4")) {
    throw new Error("FAIL: Response did not compute arithmetic answer 4");
  }

  console.log("\n🎉 MILESTONE-02 VERIFICATION COMPLETED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("❌ MILESTONE-02 FAILED:", err);
  process.exit(1);
});
