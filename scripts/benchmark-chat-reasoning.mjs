async function evaluate(name, prompt, validator) {
  process.stdout.write(`Evaluating [${name}]... `);
  const start = Date.now();
  const res = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b",
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  const latency = Date.now() - start;
  const pass = validator(content);
  if (pass) {
    console.log(`PASS ✓ (${latency}ms)`);
    return { name, pass: true, latency, preview: content.slice(0, 80) };
  } else {
    console.log(`FAIL ✗ (${latency}ms)`);
    console.error(`  Output did not satisfy validator: ${content.slice(0, 150)}...`);
    return { name, pass: false, latency, preview: content.slice(0, 80) };
  }
}

async function main() {
  console.log("================================================================================");
  console.log("   NIRNAYAI CHAT REASONING & TECHNICAL INTELLIGENCE BENCHMARK (10 SUITES)       ");
  console.log("================================================================================\n");

  const results = [];

  // 1. Easy Greeting
  results.push(await evaluate(
    "1. Persona Greeting",
    "Hello! How are you doing today?",
    (c) => c.toLowerCase().includes("universal ai agent") || c.toLowerCase().includes("hello")
  ));

  // 2. World Knowledge
  results.push(await evaluate(
    "2. World Knowledge (Prime Minister of India)",
    "Who is the current Prime Minister of India?",
    (c) => c.includes("Narendra Modi") && c.includes("2014")
  ));

  // 3. Mathematical Evaluation
  results.push(await evaluate(
    "3. Math Arithmetic (125 * 8)",
    "Calculate 125 * 8",
    (c) => c.includes("1000")
  ));

  // 4. Binary Search Algorithm
  results.push(await evaluate(
    "4. Algorithm: Binary Search in TypeScript",
    "Explain binary search algorithm and write a TypeScript implementation",
    (c) => c.includes("binarySearch") && c.includes("O(\\log n)") && c.includes("left <= right")
  ));

  // 5. LRU Cache Architecture
  results.push(await evaluate(
    "5. System Design: LRU Cache in Python",
    "Implement an LRU Cache in Python with O(1) operations",
    (c) => c.includes("LRUCache") && c.includes("Doubly-Linked List") && c.includes("capacity")
  ));

  // 6. Networking Protocols: TCP vs UDP
  results.push(await evaluate(
    "6. Networking: TCP vs UDP In-Depth",
    "Compare TCP vs UDP protocols in detail",
    (c) => c.includes("Handshake") && c.includes("Connectionless") && c.includes("Header Size")
  ));

  // 7. API Architecture: REST vs GraphQL vs gRPC
  results.push(await evaluate(
    "7. API Design: REST vs GraphQL vs gRPC",
    "Compare REST vs GraphQL vs gRPC architectures",
    (c) => c.includes("Protocol Buffers") && c.includes("HTTP/2") && c.includes("Over/Under-Fetching")
  ));

  // 8. Dynamic Programming
  results.push(await evaluate(
    "8. Dynamic Programming: 0/1 Knapsack",
    "Explain the 0/1 Knapsack problem with dynamic programming code",
    (c) => c.includes("knapsack_01") && c.includes("dp[w]") && c.includes("O(n")
  ));

  // 9. Multilingual: Recursion in Hindi
  results.push(await evaluate(
    "9. Multilingual: Recursion in Hindi",
    "Explain recursion in simple Hindi",
    (c) => c.includes("रिकर्शन") && c.includes("बेस केस") && c.includes("फैक्टोरियल")
  ));

  // 10. Multilingual: Data Structures in Hindi
  results.push(await evaluate(
    "10. Multilingual: Data Structures in Hindi",
    "Explain data structures and OOP in Hindi",
    (c) => c.includes("डेटा संरचनाएं") && c.includes("एनकैप्सुलेशन") && c.includes("पॉलीमॉर्फिज्म")
  ));

  console.log("\n================================================================================");
  const totalPassed = results.filter((r) => r.pass).length;
  console.log(`BENCHMARK SCORE: ${totalPassed} / ${results.length} PASSED (${((totalPassed / results.length) * 100).toFixed(1)}%)`);
  console.log("================================================================================");

  if (totalPassed < results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
