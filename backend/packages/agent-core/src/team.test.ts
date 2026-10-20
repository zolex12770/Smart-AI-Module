import { describe, expect, it } from "vitest";
import { type ChatMessage, type ChatStreamEvent } from "@ai-platform/shared";
import { AgentTeam, type TeamProgressEvent } from "./team.js";

function mockStreamChat(responses: string[]) {
  let callIndex = 0;
  return async function* (_request: { messages: ChatMessage[] }): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const text = responses[callIndex++] ?? "Default specialist response";
    yield { type: "token", delta: text };
    yield {
      type: "done",
      message: { role: "assistant", content: text },
      usage: { inputTokens: 50, outputTokens: 20 },
      provider: "mock",
      model: "mock-model",
      finishReason: "stop",
    };
  };
}

describe("AgentTeam — Multi-Agent Autonomous Teamwork", () => {
  it("coordinates Architect, Coder, and Reviewer to reach consensus on Round 1", async () => {
    // Round 1:
    // 1. Architect: Blueprint
    // 2. Coder: Implementation
    // 3. Reviewer: APPROVED
    // 4. Architect: Final Synthesis
    const responses = [
      "ARCHITECT BLUEPRINT: Create secure auth module with argon2/scrypt.",
      "CODER IMPLEMENTATION: function hashPassword() { return scrypt(pass); }",
      "REVIEWER VERDICT: Code is robust and handles salt correctly. APPROVED.",
      "FINAL SYNTHESIS: Authentication module successfully designed and verified.",
    ];

    const events: TeamProgressEvent[] = [];
    const team = new AgentTeam({
      streamChat: mockStreamChat(responses),
      tools: [],
      executeTool: async () => ({ content: "ok", ok: true }),
    });

    const result = await team.execute({
      goal: "Implement secure password hashing",
      onProgress: (ev) => events.push(ev),
    });

    expect(result.ok).toBe(true);
    expect(result.approvedByReviewer).toBe(true);
    expect(result.roundsCompleted).toBe(1);
    expect(result.transcript.length).toBe(4);
    expect(result.finalAnswer).toContain("Authentication module successfully designed");

    // Verify event progression
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("team_started");
    expect(eventTypes).toContain("consensus_reached");
    expect(eventTypes).toContain("team_completed");
  });

  it("handles Reviewer critique, feeding feedback to Coder for Round 2 correction", async () => {
    // Round 1:
    // 1. Architect
    // 2. Coder (flawed)
    // 3. Reviewer (critique: missing rate limit)
    // Round 2:
    // 4. Coder (revised with rate limit)
    // 5. Reviewer (APPROVED)
    // 6. Architect (Final Synthesis)
    const responses = [
      "ARCHITECT BLUEPRINT: API endpoint for file uploads.",
      "CODER V1: app.post('/upload', handleUpload);",
      "REVIEWER CRITIQUE: Missing max file size cap and authentication. NEEDS_WORK.",
      "CODER V2: app.post('/upload', { preHandler: [auth, sizeCap(10MB)] }, handleUpload);",
      "REVIEWER VERDICT: Security controls verified. APPROVED.",
      "FINAL SYNTHESIS: File upload API ready with auth and size caps.",
    ];

    const team = new AgentTeam({
      streamChat: mockStreamChat(responses),
      tools: [],
      executeTool: async () => ({ content: "ok", ok: true }),
    });

    const result = await team.execute({
      goal: "Build secure file upload endpoint",
      maxRounds: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.approvedByReviewer).toBe(true);
    expect(result.roundsCompleted).toBe(2);
    expect(result.transcript.length).toBe(6);

    // Verify feedback loop in transcript
    const critiqueMsg = result.transcript.find((m) => m.type === "critique");
    expect(critiqueMsg?.content).toContain("Missing max file size");

    const approvalMsg = result.transcript.find((m) => m.type === "approval");
    expect(approvalMsg?.content).toContain("APPROVED");
  });

  it("terminates cleanly at maxRounds ceiling when Reviewer continually rejects", async () => {
    // Continual rejection: never approves
    const responses = [
      "ARCHITECT BLUEPRINT: Payment processor.",
      "CODER V1: pay();",
      "REVIEWER: REJECTED (Missing HMAC signature).",
      "CODER V2: payWithHmac();",
      "REVIEWER: REJECTED (Replay attack vulnerability).",
      "FINAL SYNTHESIS: Delivered with outstanding reviewer concerns.",
    ];

    const team = new AgentTeam({
      streamChat: mockStreamChat(responses),
      tools: [],
      executeTool: async () => ({ content: "ok", ok: true }),
    });

    const result = await team.execute({
      goal: "Implement payment processing",
      maxRounds: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.approvedByReviewer).toBe(false);
    expect(result.roundsCompleted).toBe(2);
    expect(result.finalAnswer).toContain("Delivered with outstanding reviewer concerns");
  });

  it("filters tools appropriately per specialist role configuration", async () => {
    const executedTools: string[] = [];
    const team = new AgentTeam(
      {
        streamChat: mockStreamChat(["Plan", "Code", "APPROVED", "Summary"]),
        tools: [
          { name: "read_file", description: "read", inputSchema: { type: "object" } },
          { name: "apply_patch", description: "write", inputSchema: { type: "object" } },
        ],
        executeTool: async (req) => {
          executedTools.push(req.call.name);
          return { content: "ok", ok: true };
        },
      },
      {
        reviewer: {
          allowedToolNames: ["read_file"], // Reviewer cannot execute mutating apply_patch
        },
      }
    );

    const result = await team.execute({ goal: "Refactor core module" });
    expect(result.ok).toBe(true);
  });
});
