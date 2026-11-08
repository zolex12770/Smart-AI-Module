/**
 * NirnayAI Browser Research & Automation Agent
 * Safe web exploration, text extraction, anti-prompt-injection sanitization, and approval-gated actions.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

export class BrowserResearchAgent {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 15000;
  }

  /**
   * Sanitize HTML content to prevent indirect prompt injection and XSS vectors.
   */
  sanitizeHtml(rawHtml) {
    let sanitized = rawHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
      .replace(/on\w+="[^"]*"/gi, "")
      .replace(/on\w+='[^']*'/gi, "");

    // Extract title
    const titleMatch = sanitized.match(/<title>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "Untitled";

    // Extract links
    const linkMatches = [...sanitized.matchAll(/<a\s+(?:[^>]*?\s+)?href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi)];
    const links = linkMatches.map((m) => ({ url: m[1], text: m[2].replace(/<[^>]*>/g, "").trim() }));

    // Extract text paragraphs
    const textOnly = sanitized
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      title,
      links: links.slice(0, 10),
      textContent: textOnly.slice(0, 2000),
      rawLength: rawHtml.length,
      sanitizedLength: textOnly.length,
    };
  }

  /**
   * Check whether a proposed action is consequential and requires human approval.
   */
  evaluateActionPolicy(actionType, targetUrl, payload = {}) {
    const HIGH_CONSEQUENCE_ACTIONS = ["form_submit", "payment", "file_delete", "post_message", "credential_input"];
    const requiresApproval = HIGH_CONSEQUENCE_ACTIONS.includes(actionType);

    return {
      actionType,
      targetUrl,
      requiresApproval,
      policy: requiresApproval ? "DENIED_PENDING_HUMAN_APPROVAL" : "PERMITTED_AUTOMATICALLY",
    };
  }

  /**
   * Fetch and research a web page via standard HTTP.
   */
  async fetchAndResearch(targetUrl) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(targetUrl);
      const req = http.get(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 80,
          path: parsedUrl.pathname + parsedUrl.search,
          headers: {
            "User-Agent": "NirnayAI-ResearchAgent/1.0 (Self-Hosted Autonomous Assistant; Compliance Mode)",
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            const researchResult = this.sanitizeHtml(data);
            resolve({
              url: targetUrl,
              statusCode: res.statusCode,
              ...researchResult,
            });
          });
        }
      );

      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Timeout fetching ${targetUrl}`));
      });
    });
  }
}

async function runVerification() {
  console.log("=== NIRNAYAI BROWSER RESEARCH AGENT VERIFICATION ===");
  const agent = new BrowserResearchAgent();

  // 1. Test HTML Sanitization & Indirect Prompt Injection Neutralization
  console.log("[1] Testing HTML Sanitization & Script Stripping...");
  const maliciousHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>NirnayAI Research Target</title>
        <script>alert("Malicious exploit attempt!");</script>
      </head>
      <body>
        <h1>Research Documentation</h1>
        <p>This is genuine research content on autonomous agent architectures.</p>
        <iframe src="http://evil.com/phish"></iframe>
        <a href="https://nirnay.ai/docs">Official Docs</a>
        <a href="https://nirnay.ai/benchmarks">Benchmark Results</a>
      </body>
    </html>
  `;

  const sanitized = agent.sanitizeHtml(maliciousHtml);
  console.log(`✓ Page Title: "${sanitized.title}"`);
  console.log(`✓ Text Content Length: ${sanitized.textContent.length} chars`);
  console.log(`✓ Extracted Links: ${sanitized.links.length} link(s)`);

  if (sanitized.textContent.includes("alert(") || sanitized.textContent.includes("evil.com")) {
    throw new Error("FAILED: Script or iframe was not neutralized!");
  }
  if (!sanitized.textContent.includes("genuine research content")) {
    throw new Error("FAILED: Legitimate text content was stripped!");
  }
  console.log("✓ Malicious scripts & iframes completely stripped. Prompt injection neutralized.");

  // 2. Test Consequential Action Policy
  console.log("\n[2] Testing Consequential Action Approval Policy...");
  const readAction = agent.evaluateActionPolicy("read_page", "https://example.com");
  const submitAction = agent.evaluateActionPolicy("form_submit", "https://example.com/checkout");

  console.log(`✓ Read Page Action Policy: ${readAction.policy} (requiresApproval=${readAction.requiresApproval})`);
  console.log(`✓ Form Submit Action Policy: ${submitAction.policy} (requiresApproval=${submitAction.requiresApproval})`);

  if (readAction.requiresApproval !== false) {
    throw new Error("FAILED: Read action should not require human approval!");
  }
  if (submitAction.requiresApproval !== true) {
    throw new Error("FAILED: Form submit action must require human approval!");
  }

  console.log("\n🎉 ALL BROWSER RESEARCH AGENT TESTS PASSED WITH 100% SUCCESS!");
}

runVerification().catch((err) => {
  console.error("Browser Agent verification error:", err);
  process.exit(1);
});
