import fs from "fs";
import path from "path";

async function main() {
  console.log("=== TESTING REAL CODING AGENT WORKSPACE FIX LOOP ===");

  // 1. Login
  const loginRes = await fetch("http://127.0.0.1:8787/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "operator@local.dev", password: "test-password-1234" }),
  });
  const cookies = loginRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const loginData = await loginRes.json();
  const csrf = loginData.csrfToken;
  const project = loginData.projects[0].id;
  console.log("✓ Logged in. Project:", project);

  // 2. Seed failing test fixture (ANSWER = 41)
  console.log("\n1. Seeding failing test fixture with defect (ANSWER = 41)...");
  const mathJs = "const ANSWER = 41;\nmodule.exports = { ANSWER };\n";
  const mathTestJs =
    'const assert = require("assert");\nconst { ANSWER } = require("./math");\nassert.strictEqual(ANSWER, 42, "Expected ANSWER to be 42");\nconsole.log("PASS");\n';

  await fetch("http://127.0.0.1:8787/api/v1/workspace/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies,
      "x-csrf-token": csrf,
      "x-project-id": project,
    },
    body: JSON.stringify({ path: "coding-demo/math.js", content: mathJs }),
  });

  await fetch("http://127.0.0.1:8787/api/v1/workspace/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies,
      "x-csrf-token": csrf,
      "x-project-id": project,
    },
    body: JSON.stringify({ path: "coding-demo/math.test.js", content: mathTestJs }),
  });
  console.log("✓ Failing fixture seeded.");

  // 3. Launch coding agent task
  console.log("\n2. Launching 'fix_failing_test' coding task...");
  const createRes = await fetch("http://127.0.0.1:8787/api/v1/agent/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies,
      "x-csrf-token": csrf,
      "x-project-id": project,
    },
    body: JSON.stringify({
      taskType: "fix_failing_test",
      input: { testDir: "coding-demo", testFile: "math.test.js" },
    }),
  });
  const createData = await createRes.json();
  const taskId = createData.task?.id;
  console.log("  Task created. Status:", createRes.status, "Task ID:", taskId);

  // 4. Poll task state until terminal
  console.log("\n3. Polling task state until COMPLETED...");
  let terminalState = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const taskRes = await fetch(`http://127.0.0.1:8787/api/v1/agent/tasks/${taskId}`, {
      headers: { Cookie: cookies, "x-project-id": project },
    });
    const taskDetail = await taskRes.json();
    const state = taskDetail.task?.state;
    console.log(`  Poll ${i + 1}: State = ${state}`);
    if (state && ["COMPLETED", "FAILED", "CANCELLED"].includes(state.toUpperCase())) {
      terminalState = state.toUpperCase();
      break;
    }
  }

  console.log("✓ Terminal State reached:", terminalState);

  // 5. Read back workspace file via /api/v1/workspace/file?path=...
  console.log("\n4. Verifying workspace file on disk...");
  const fileCheckRes = await fetch(
    `http://127.0.0.1:8787/api/v1/workspace/file?path=${encodeURIComponent("coding-demo/math.js")}`,
    { headers: { Cookie: cookies, "x-project-id": project } }
  );
  const fileData = await fileCheckRes.json();
  const content = fileData.content || "";
  console.log("  Content of coding-demo/math.js after repair:");
  console.log("  ---------------------------------------------");
  console.log("  " + content.trim());
  console.log("  ---------------------------------------------");

  const isRepaired = content.includes("42") && !content.includes("41");
  console.log("  Was '41' successfully replaced by '42'?:", isRepaired);

  if (terminalState === "COMPLETED" && isRepaired) {
    console.log("\n🎉 REAL CODING AGENT WORKSPACE FIX LOOP VERIFIED 100% SUCCESSFUL!");
  } else {
    console.error("\n❌ Coding agent verification failed.");
    process.exitCode = 1;
  }
}

main().catch(console.error);
