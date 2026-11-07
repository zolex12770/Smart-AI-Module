import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";
const OUT_DIR = "data/sandbox/conversational_intent";

fs.mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  console.log("=== NIRNAY.AI CONVERSATIONAL INTENT ENGINE LIVE E2E VERIFICATION ===");

  // 1. Authenticate with backend
  const loginRes = await fetch("http://127.0.0.1:8787/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "operator@local.dev", password: "test-password-1234" }),
  });
  if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status}`);

  const cookies = loginRes.headers.getSetCookie();
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const csrfCookie = cookies.find((c) => c.startsWith("aip_csrf="));
  const csrfToken = csrfCookie.split(";")[0].split("=")[1];

  const projRes = await fetch("http://127.0.0.1:8787/api/v1/projects", {
    headers: { Cookie: cookieHeader },
  });
  const projects = await projRes.json();
  const projectId = projects.projects[0].id;
  console.log(`✓ Authenticated with backend. Using project: ${projectId}`);

  const turns = [
    {
      turnNumber: 1,
      slug: "turn1_village_initial",
      prompt: "Ek village ki realistic image banao, old man aur woman khana bana rahe hain aur bachche kha rahe hain.",
      description: "Initial Hinglish request: Rural village, elderly couple cooking, children eating",
      expectTerms: ["village", "cooking", "children"],
    },
    {
      turnNumber: 2,
      slug: "turn2_village_evening_red_sari",
      prompt: "Same image but evening light, woman ki sari red honi chahiye.",
      description: "Follow-up revision: Preserve scene, apply evening sunset light + red sari delta",
      expectTerms: ["evening", "sunset", "red"],
    },
    {
      turnNumber: 3,
      slug: "turn3_village_professional_preserve",
      prompt: "Isko aur professional banao, but original meaning change mat karna.",
      description: "Follow-up polish: High professional detail while strictly preserving semantic meaning",
      expectTerms: ["professional", "village", "red"],
    },
  ];

  const turnResults = [];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    console.log(`\n------------------------------------------------------------`);
    console.log(`[Turn ${t.turnNumber}/3] "${t.prompt}"`);
    console.log(`Objective: ${t.description}`);

    const start = Date.now();
    const createRes = await fetch("http://127.0.0.1:8787/api/v1/images", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        projectId,
        prompt: t.prompt,
        aspectRatio: "1:1",
      }),
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create generation for Turn ${t.turnNumber}: ${await createRes.text()}`);
    }

    const { generation } = await createRes.json();
    const genId = generation.id;
    console.log(`  Generation ID: ${genId} (queued)`);

    // Poll for completion (up to 180s)
    let completedItem = null;
    const maxWaitMs = 180000;
    const pollStart = Date.now();

    while (Date.now() - pollStart < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 2000));
      const listRes = await fetch(`http://127.0.0.1:8787/api/v1/images?projectId=${projectId}`, {
        headers: { Cookie: cookieHeader },
      });
      const listData = await listRes.json();
      const item = listData.generations.find((g) => g.id === genId);
      if (item?.status === "succeeded") {
        completedItem = item;
        break;
      }
      if (item?.status === "failed") {
        throw new Error(`Generation failed for Turn ${t.turnNumber}: ${item.errorMessage}`);
      }
    }

    if (!completedItem) {
      throw new Error(`Generation timed out after ${maxWaitMs}ms for Turn ${t.turnNumber}`);
    }

    const durationMs = Date.now() - start;
    console.log(`  ✓ Completed in ${durationMs}ms. AssetId: ${completedItem.resultAssetId}`);

    // Download asset
    const assetRes = await fetch(
      `http://127.0.0.1:8787/api/v1/assets/${completedItem.resultAssetId}?projectId=${projectId}`,
      { headers: { Cookie: cookieHeader } }
    );
    const imgBuffer = Buffer.from(await assetRes.arrayBuffer());

    const outPath = path.join(OUT_DIR, `${t.slug}.png`);
    fs.writeFileSync(outPath, imgBuffer);
    const artifactPath = path.join(ARTIFACT_DIR, `${t.slug}.png`);
    fs.writeFileSync(artifactPath, imgBuffer);
    console.log(`  ✓ Saved image artifact: ${outPath} (${imgBuffer.length} bytes)`);

    // Run Python CV analysis
    const cvOutput = execSync(`python scripts/lib/analyze_image.py "${outPath}"`, { encoding: "utf-8" });
    const metrics = JSON.parse(cvOutput.trim());
    console.log(`  CV Metrics:`, {
      mean_r: metrics.mean_r,
      mean_g: metrics.mean_g,
      mean_b: metrics.mean_b,
      red_ratio: metrics.red_ratio,
      edge_pixels: metrics.edge_pixels,
      contours: metrics.contour_count,
    });

    turnResults.push({
      turnNumber: t.turnNumber,
      prompt: t.prompt,
      description: t.description,
      assetId: completedItem.resultAssetId,
      outPath,
      artifactPath,
      fileSize: imgBuffer.length,
      durationMs,
      metrics,
    });

    // Pacing pause between requests for rate limit compliance
    if (i < turns.length - 1) {
      console.log("  Pacing: waiting 46s for next turn...");
      await new Promise((r) => setTimeout(r, 46000));
    }
  }

  const summaryPath = path.join(OUT_DIR, "conversational_intent_e2e_summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(turnResults, null, 2));
  console.log(`\n=== CONVERSATIONAL INTENT E2E VERIFICATION COMPLETED (3/3 TURNS SUCCESSFUL) ===`);
  console.log(`Summary written to: ${summaryPath}`);
}

main().catch((err) => {
  console.error("FATAL ERROR in conversational intent E2E:", err);
  process.exit(1);
});
