const http = require('http');

async function testQuery(title, prompt, model = "qwen2.5:7b", history = []) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model,
      stream: false,
      messages: [
        ...history,
        { role: "user", content: prompt }
      ]
    });

    const req = http.request({
      hostname: "127.0.0.1",
      port: 11434,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, title, prompt, response: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, title, prompt, raw: data });
        }
      });
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function run() {
  console.log("=== VERIFYING REAL INTELLIGENCE CHAT QUERIES ===");

  const q1 = await testQuery("1. Greeting", "how are you");
  console.log("\n[1. Greeting] 'how are you':\nStatus:", q1.status);
  console.log("Answer:", q1.response.choices?.[0]?.message?.content);

  const q2 = await testQuery("2. Math", "What is 2 + 2?");
  console.log("\n[2. Math] 'What is 2 + 2?':\nStatus:", q2.status);
  console.log("Answer:", q2.response.choices?.[0]?.message?.content);

  const q3 = await testQuery("3. C++ Code", 'return "hello world" in c++ language');
  console.log("\n[3. C++ Code] 'return \"hello world\" in c++ language':\nStatus:", q3.status);
  console.log("Answer:", q3.response.choices?.[0]?.message?.content);

  const q4 = await testQuery("4. Hindi Recursion", "Explain recursion in simple Hindi.");
  console.log("\n[4. Hindi Recursion] 'Explain recursion in simple Hindi.':\nStatus:", q4.status);
  console.log("Answer:", q4.response.choices?.[0]?.message?.content);

  const q5 = await testQuery("5. Python String Reverse", "Write a Python function to reverse a string.");
  console.log("\n[5. Python String Reverse] 'Write a Python function to reverse a string.':\nStatus:", q5.status);
  console.log("Answer:", q5.response.choices?.[0]?.message?.content);

  const q6 = await testQuery(
    "6. Contextual Follow-up",
    "can you show another way to do it?",
    "qwen2.5:7b",
    [
      { role: "user", content: "Write a Python function to reverse a string." },
      { role: "assistant", content: q5.response.choices?.[0]?.message?.content || "" }
    ]
  );
  console.log("\n[6. Contextual Follow-up] 'can you show another way to do it?':\nStatus:", q6.status);
  console.log("Answer:", q6.response.choices?.[0]?.message?.content);

  const q7 = await testQuery("7. Invalid Model Request", "Hello", "non-existent-70b");
  console.log("\n[7. Invalid Model Request] model='non-existent-70b':\nStatus:", q7.status);
  console.log("Error:", q7.response.error);
}

run().catch(console.error);
