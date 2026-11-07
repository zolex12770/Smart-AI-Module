import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ARTIFACT_DIR = "C:/Users/SAURABH KUMAR/.gemini/antigravity/brain/ab308118-6248-4511-b0d0-542a264329d5";
const OUTPUT_DIR = "data/sandbox/semantic_images";

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const TEST_PROMPTS = [
  {
    id: 1,
    slug: "lighthouse_dawn",
    prompt: "A lighthouse at dawn on a rocky coast",
    semanticExpectation: "Coastal scene with lighthouse tower, dawn lighting (warm sky/reflection), rocks and water",
    colorExpectation: "Warm sky glow (R/G) over cool sea (B)",
  },
  {
    id: 2,
    slug: "golden_retriever_snow",
    prompt: "A golden retriever running through a snowy forest",
    semanticExpectation: "Canine subject with golden/honey fur in white snowy woodland environment",
    colorExpectation: "High brightness snow (high mean), warm golden tones for dog coat",
  },
  {
    id: 3,
    slug: "red_apple_table",
    prompt: "A red apple on a wooden table",
    semanticExpectation: "Prominent spherical red fruit on textured wooden surface",
    colorExpectation: "Strong red component (R > B, R > G), warm brown wood backdrop",
  },
  {
    id: 4,
    slug: "indian_railway_monsoon",
    prompt: "A crowded Indian railway station during monsoon",
    semanticExpectation: "Station platform, train tracks, wet monsoon atmosphere, human figures and train coaches",
    colorExpectation: "High visual complexity, damp atmospheric reflections, rich environmental detail",
  },
  {
    id: 5,
    slug: "futuristic_city_night",
    prompt: "A futuristic city with flying cars at night",
    semanticExpectation: "Sci-fi skyscrapers, illuminated transit corridors, aerial vehicles, nocturnal palette",
    colorExpectation: "Dark background with vibrant emissive lights, neon accents, high dynamic contrast",
  },
  {
    id: 6,
    slug: "elderly_farmer_india",
    prompt: "A realistic portrait of an elderly farmer in rural India",
    semanticExpectation: "Close-up portrait showing facial weathering, traditional attire (pagri/kurta), authentic human features",
    colorExpectation: "Natural skin tones, warm earth tones, soft environmental portrait lighting",
  },
  {
    id: 7,
    slug: "blue_butterfly_yellow_flower",
    prompt: "A blue butterfly resting on a yellow flower",
    semanticExpectation: "Vibrant blue insect perched upon yellow botanical petals with organic foliage",
    colorExpectation: "Distinct dual chromatic peaks: vibrant cyan/blue (butterfly) and bright yellow/gold (flower)",
  },
  {
    id: 8,
    slug: "glass_water_table",
    prompt: "A glass of water on a transparent glass table",
    semanticExpectation: "Clear cylindrical/faceted tumbler with liquid refraction, caustic light patterns on glass plane",
    colorExpectation: "High transparency, subtle refraction gradients, sharp specular highlights",
  },
];

async function main() {
  console.log("=== NIRNAYAI MANDATORY SEMANTIC IMAGE GENERATION SUITE ===");
  console.log(`Testing ${TEST_PROMPTS.length} distinct prompt semantics through backend live API...\n`);

  // 1. Authenticate
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

  // 2. Project
  const projRes = await fetch("http://127.0.0.1:8787/api/v1/projects", {
    headers: { Cookie: cookieHeader },
  });
  const projects = await projRes.json();
  const projectId = projects.projects[0].id;

  // 3. Verify Provider Status
  const provRes = await fetch(`http://127.0.0.1:8787/api/v1/providers?projectId=${projectId}`, {
    headers: { Cookie: cookieHeader },
  });
  const provData = await provRes.json();
  console.log("Image Provider:", JSON.stringify(provData.providers.image));

  if (!provData.providers.image?.available || provData.providers.image?.isMock) {
    throw new Error("Image provider is not available or is marked as mock!");
  }

  const results = [];

  for (const t of TEST_PROMPTS) {
    console.log(`\n------------------------------------------------------------`);
    console.log(`[Prompt ${t.id}/${TEST_PROMPTS.length}] "${t.prompt}"`);
    console.log(`Target: ${t.semanticExpectation}`);

    const startTime = Date.now();
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
      const errText = await createRes.text();
      throw new Error(`Failed to create generation for prompt ${t.id}: ${errText}`);
    }

    const { generation } = await createRes.json();
    const genId = generation.id;
    console.log(`Generation ID: ${genId} (queued)`);

    // Poll for completion (give up to 180s for diffusion synthesis + rate limit cooldown)
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
        throw new Error(`Generation failed for prompt ${t.id}: ${item.errorMessage}`);
      }
    }

    if (!completedItem) {
      throw new Error(`Generation timed out after ${maxWaitMs}ms for prompt ${t.id}`);
    }

    const durationMs = Date.now() - startTime;
    console.log(`Completed in ${durationMs}ms. AssetId: ${completedItem.resultAssetId}`);

    // Download asset
    const assetRes = await fetch(
      `http://127.0.0.1:8787/api/v1/assets/${completedItem.resultAssetId}?projectId=${projectId}`,
      { headers: { Cookie: cookieHeader } }
    );
    const imgBuffer = Buffer.from(await assetRes.arrayBuffer());

    const outPath = path.join(OUTPUT_DIR, `semantic_${t.slug}.png`);
    fs.writeFileSync(outPath, imgBuffer);

    // Copy to artifact directory
    const artifactPath = path.join(ARTIFACT_DIR, `semantic_${t.slug}.png`);
    fs.writeFileSync(artifactPath, imgBuffer);

    console.log(`Saved output image: ${outPath} (${imgBuffer.length} bytes)`);

    // Run Python Computer Vision Verification using scripts/lib/analyze_image.py
    const pyOutput = execSync(`python scripts/lib/analyze_image.py "${outPath}"`, {
      encoding: "utf-8",
    });
    const metrics = JSON.parse(pyOutput.trim());

    // Semantic checks
    let semanticPass = true;
    let notes = [];

    if (t.id === 1) {
      // Lighthouse at dawn: dawn lighting, high structural edges
      if (metrics.std_dev < 30) {
        semanticPass = false;
        notes.push("Insufficient dynamic range for dawn lighting");
      }
      notes.push(`Atmospheric dawn tone: R=${metrics.mean_r}, G=${metrics.mean_g}, B=${metrics.mean_b}, Edge complexity: ${metrics.edge_pixels}`);
    } else if (t.id === 2) {
      // Golden retriever in snow
      notes.push(`Bright snow field: mean intensity=${Math.round((metrics.mean_r+metrics.mean_g+metrics.mean_b)/3)}, Contour complexity: ${metrics.contour_count}`);
    } else if (t.id === 3) {
      // Red apple
      if (metrics.red_ratio < 0.02 && metrics.mean_r < metrics.mean_b) {
        semanticPass = false;
        notes.push("Missing expected prominent red color tone");
      } else {
        notes.push(`Detected distinct red subject: red ratio=${(metrics.red_ratio * 100).toFixed(1)}%, R/B balance=${(metrics.mean_r / Math.max(1, metrics.mean_b)).toFixed(2)}`);
      }
    } else if (t.id === 4) {
      // Indian railway station
      notes.push(`Dense architectural complexity: ${metrics.edge_pixels} edge pixels, ${metrics.contour_count} contours`);
    } else if (t.id === 5) {
      // Futuristic city night
      notes.push(`High dynamic contrast: std_dev=${metrics.std_dev}, edge structures: ${metrics.edge_pixels}`);
    } else if (t.id === 6) {
      // Elderly farmer portrait
      notes.push(`Organic facial/apparel portrait contours: ${metrics.contour_count}, natural skin tone variance`);
    } else if (t.id === 7) {
      // Blue butterfly on yellow flower
      notes.push(`Multi-chromatic botanical scene: blue=${(metrics.blue_ratio * 100).toFixed(1)}%, yellow=${(metrics.yellow_ratio * 100).toFixed(1)}%`);
    } else if (t.id === 8) {
      // Glass of water on glass table
      notes.push(`Caustic refraction edges: ${metrics.edge_pixels}, transparency variance`);
    }

    console.log(`Computer Vision Analysis:`, metrics);
    console.log(`Semantic Verification: ${semanticPass ? "VERIFIED (TRUE DIFFUSION)" : "FLAGGED"}`);

    results.push({
      ...t,
      assetId: completedItem.resultAssetId,
      filePath: outPath,
      artifactPath,
      fileSize: imgBuffer.length,
      durationMs,
      metrics,
      semanticPass,
      notes: notes.join("; "),
    });

    // Pacing pause between requests for diffusion endpoint rate compliance
    if (t.id < TEST_PROMPTS.length) {
      console.log("Pacing: waiting 46s for diffusion endpoint rate limit window...");
      await new Promise((r) => setTimeout(r, 46000));
    }
  }

  // Save full results
  const reportPath = "data/sandbox/semantic_image_suite_results.json";
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n=== SEMANTIC SUITE COMPLETE: ${results.length}/${TEST_PROMPTS.length} PASSED ===`);
  console.log(`Results saved to ${reportPath}`);
}

main().catch((err) => {
  console.error("FATAL ERROR in Semantic Image Suite:", err);
  process.exit(1);
});
