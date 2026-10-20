import {
  type ChatMessage,
  type ToolSpec,
} from "@ai-platform/shared";
import { runReasoningLoop, type ReasoningLoopDeps } from "./reasoning-loop.js";

/**
 * Multi-Agent Specialist Roles.
 */
export type SpecialistRole = "architect" | "coder" | "reviewer" | "researcher";

export interface SpecialistAgentConfig {
  role: SpecialistRole;
  name: string;
  systemPrompt: string;
  allowedToolNames?: string[];
  maxTurns?: number;
}

export interface TeamMessage {
  from: SpecialistRole | "user" | "coordinator";
  to: SpecialistRole | "all" | "user";
  type: "task_assignment" | "proposal" | "critique" | "approval" | "final_delivery";
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface TeamProgressEvent {
  type: "team_started" | "agent_turn_started" | "agent_turn_completed" | "critique_round" | "consensus_reached" | "team_completed";
  role?: SpecialistRole;
  round?: number;
  message?: TeamMessage;
  finalAnswer?: string;
}

export interface TeamRunOptions {
  goal: string;
  context?: string;
  maxRounds?: number;
  onProgress?: (event: TeamProgressEvent) => void;
}

export interface TeamRunResult {
  ok: boolean;
  finalAnswer: string;
  transcript: TeamMessage[];
  roundsCompleted: number;
  approvedByReviewer: boolean;
  architectSummary?: string;
}

/** Default system prompts configured for each specialist */
export const DEFAULT_ROLE_PROMPTS: Record<SpecialistRole, string> = {
  architect: `You are the Lead Systems Architect.
Your role:
1. Deconstruct user requirements into clear architectural specs, constraints, and acceptance criteria.
2. Define technical boundaries, data contracts, and verification criteria.
3. Synthesize the final outcome once work has been completed and reviewed.
Be precise, structured, and unambiguous.`,

  coder: `You are the Principal Software Engineer.
Your role:
1. Implement technical solutions, write code, search repository structures, and fix defects.
2. Formulate explicit, testable implementations or unified diffs.
3. Address feedback and critique from the Reviewer constructively by refining the code.
Always deliver functional, robust, and clean code.`,

  reviewer: `You are the Senior Security & Quality Reviewer.
Your role:
1. Adversarially critique proposals, code diffs, and plans produced by the team.
2. Check for security vulnerabilities, path traversal, injection, edge cases, and missing tests.
3. If defects exist, reply with a clear critique ("type: critique") explaining what must be corrected.
4. If the work satisfies all requirements and passes security criteria, reply with explicit approval ("type: approval").`,

  researcher: `You are the Research & Information Specialist.
Your role:
1. Investigate background documentation, specifications, and external evidence.
2. Provide grounded facts, citations, and summaries to support the Architect and Coder.
Avoid hallucinations; state uncertainties explicitly.`,
};

/**
 * Autonomous Multi-Agent Team Orchestrator.
 * Coordinates collaboration between Architect, Coder, and Reviewer specialists.
 */
export class AgentTeam {
  private specialists: Map<SpecialistRole, SpecialistAgentConfig>;

  constructor(
    private deps: Pick<ReasoningLoopDeps, "streamChat" | "tools" | "executeTool">,
    customConfigs?: Partial<Record<SpecialistRole, Partial<SpecialistAgentConfig>>>
  ) {
    this.specialists = new Map();
    const roles: SpecialistRole[] = ["architect", "coder", "reviewer", "researcher"];

    for (const role of roles) {
      const custom = customConfigs?.[role];
      this.specialists.set(role, {
        role,
        name: custom?.name ?? role.toUpperCase(),
        systemPrompt: custom?.systemPrompt ?? DEFAULT_ROLE_PROMPTS[role],
        allowedToolNames: custom?.allowedToolNames,
        maxTurns: custom?.maxTurns ?? 5,
      });
    }
  }

  /**
   * Filter available tools for a given specialist role.
   */
  private getToolsForRole(role: SpecialistRole): ToolSpec[] {
    const config = this.specialists.get(role);
    if (!config?.allowedToolNames) {
      return this.deps.tools;
    }
    const allowed = new Set(config.allowedToolNames);
    return this.deps.tools.filter((t) => allowed.has(t.name));
  }

  /**
   * Run a single specialist agent turn using the underlying reasoning loop.
   */
  private async runSpecialistTurn(
    role: SpecialistRole,
    messages: ChatMessage[]
  ): Promise<string> {
    const config = this.specialists.get(role)!;
    const tools = this.getToolsForRole(role);

    const fullMessages: ChatMessage[] = [
      { role: "system", content: config.systemPrompt },
      ...messages,
    ];

    const result = await runReasoningLoop(
      {
        streamChat: this.deps.streamChat,
        tools,
        executeTool: this.deps.executeTool,
      },
      fullMessages,
      {
        maxIterations: config.maxTurns ?? 5,
      }
    );

    return result.answer;
  }

  /**
   * Execute the collaborative team workflow.
   * Phase 1: Architect plans and decomposes.
   * Phase 2: Coder produces implementation / proposal.
   * Phase 3: Reviewer inspects. If critique, Coder revises (bounded review loop).
   * Phase 4: Architect synthesizes final deliverable.
   */
  async execute(options: TeamRunOptions): Promise<TeamRunResult> {
    const maxRounds = options.maxRounds ?? 3;
    const transcript: TeamMessage[] = [];

    const emit = (event: TeamProgressEvent) => {
      options.onProgress?.(event);
    };

    emit({ type: "team_started" });

    // Step 1: Architect planning
    emit({ type: "agent_turn_started", role: "architect" });
    const architectPlan = await this.runSpecialistTurn(
      "architect",
      [
        {
          role: "user",
          content: `User Goal:\n${options.goal}\n\nContext:\n${options.context ?? "None provided"}\n\nProduce an actionable architecture plan and implementation requirements for the team.`,
        },
      ]
    );

    const architectMsg: TeamMessage = {
      from: "architect",
      to: "all",
      type: "task_assignment",
      content: architectPlan,
      timestamp: new Date().toISOString(),
    };
    transcript.push(architectMsg);
    emit({ type: "agent_turn_completed", role: "architect", message: architectMsg });

    let currentProposal = "";
    let approved = false;
    let round = 1;

    // Review Consensus Loop (Coder -> Reviewer -> Revision)
    while (round <= maxRounds && !approved) {
      emit({ type: "critique_round", round });

      // Coder Turn: implement or revise based on feedback
      emit({ type: "agent_turn_started", role: "coder", round });
      const coderPrompt: ChatMessage[] = [
        {
          role: "user",
          content: `Architect Plan:\n${architectPlan}\n\nUser Goal:\n${options.goal}`,
        },
      ];

      if (transcript.length > 1) {
        // Feed previous critique back
        const previousCritique = transcript[transcript.length - 1];
        coderPrompt.push({
          role: "user",
          content: `Previous Reviewer Feedback (Round ${round - 1}):\n${previousCritique.content}\n\nPlease revise your solution addressing all concerns raised.`,
        });
      }

      currentProposal = await this.runSpecialistTurn("coder", coderPrompt);

      const coderMsg: TeamMessage = {
        from: "coder",
        to: "reviewer",
        type: "proposal",
        content: currentProposal,
        timestamp: new Date().toISOString(),
        metadata: { round },
      };
      transcript.push(coderMsg);
      emit({ type: "agent_turn_completed", role: "coder", round, message: coderMsg });

      // Reviewer Turn: audit proposal
      emit({ type: "agent_turn_started", role: "reviewer", round });
      const reviewerPrompt: ChatMessage[] = [
        {
          role: "user",
          content: `Goal:\n${options.goal}\n\nArchitect Plan:\n${architectPlan}\n\nCoder Proposal (Round ${round}):\n${currentProposal}\n\nEvaluate this implementation for correctness, security, edge cases, and compliance with requirements.\nIf acceptable without critical defects, explicitly include "APPROVED" in your verdict.\nOtherwise, provide bulleted critique items.`,
        },
      ];

      const reviewVerdict = await this.runSpecialistTurn("reviewer", reviewerPrompt);
      const isApproved = /\b(APPROVED|LGTM|PASSED)\b/i.test(reviewVerdict) && !/\b(REJECTED|FAILED|NEEDS_WORK)\b/i.test(reviewVerdict);

      const reviewerMsg: TeamMessage = {
        from: "reviewer",
        to: isApproved ? "architect" : "coder",
        type: isApproved ? "approval" : "critique",
        content: reviewVerdict,
        timestamp: new Date().toISOString(),
        metadata: { round, approved: isApproved },
      };
      transcript.push(reviewerMsg);
      emit({ type: "agent_turn_completed", role: "reviewer", round, message: reviewerMsg });

      if (isApproved) {
        approved = true;
        emit({ type: "consensus_reached", round });
        break;
      }

      round++;
    }

    // Step 4: Final Synthesis by Architect
    emit({ type: "agent_turn_started", role: "architect" });
    const finalSynthesis = await this.runSpecialistTurn(
      "architect",
      [
        {
          role: "user",
          content: `Goal: ${options.goal}\n\nFinal Code/Solution from Coder:\n${currentProposal}\n\nReviewer Assessment (Approved: ${approved}):\n${transcript[transcript.length - 1]?.content ?? "N/A"}\n\nSummarize the final deliverable, remaining caveats, and verification outcome for the user.`,
        },
      ]
    );

    const finalDeliveryMsg: TeamMessage = {
      from: "architect",
      to: "user",
      type: "final_delivery",
      content: finalSynthesis,
      timestamp: new Date().toISOString(),
      metadata: { approvedByReviewer: approved, rounds: round - 1 },
    };
    transcript.push(finalDeliveryMsg);
    emit({ type: "team_completed", finalAnswer: finalSynthesis });

    return {
      ok: true,
      finalAnswer: finalSynthesis,
      transcript,
      roundsCompleted: Math.min(round, maxRounds),
      approvedByReviewer: approved,
      architectSummary: architectPlan,
    };
  }
}
