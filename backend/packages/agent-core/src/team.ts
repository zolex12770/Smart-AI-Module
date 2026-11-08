import {
  type ChatMessage,
  type ToolSpec,
} from "@ai-platform/shared";
import { runReasoningLoop, type ReasoningLoopDeps } from "./reasoning-loop.js";

/**
 * Multi-Agent Specialist Roles.
 */
export type SpecialistRole =
  | "architect"
  | "coder"
  | "reviewer"
  | "security_auditor"
  | "qa_engineer"
  | "researcher";

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

export type FindingSeverity = "critical" | "high" | "medium" | "low";

export interface StructuredSecurityFinding {
  ruleId: string;
  severity: FindingSeverity;
  description: string;
  line?: number;
  matchedText?: string;
  remediation: string;
}

export interface SecurityAuditResult {
  safe: boolean;
  findings: string[];
  structuredFindings?: StructuredSecurityFinding[];
}

export interface QaTestResult {
  passed: boolean;
  testsRun: number;
  failures: string[];
  output: string;
}

export interface VerificationEvidence {
  round: number;
  reviewerVerdict: string;
  reviewerApproved: boolean;
  securityAudit: SecurityAuditResult;
  qaTestResult?: QaTestResult;
  consensusOverridden: boolean;
  overrideReason?: string;
}

export interface TeamProgressEvent {
  type:
    | "team_started"
    | "agent_turn_started"
    | "agent_turn_completed"
    | "critique_round"
    | "security_audit_completed"
    | "qa_evaluation_completed"
    | "review_rejected_by_evidence"
    | "consensus_reached"
    | "team_completed";
  role?: SpecialistRole;
  round?: number;
  message?: TeamMessage;
  reason?: string;
  finalAnswer?: string;
}

export interface TeamRunOptions {
  goal: string;
  context?: string;
  maxRounds?: number;
  onProgress?: (event: TeamProgressEvent) => void;
  /** Injectable QA test runner for objective verification */
  runQaTests?: (proposal: string, round: number) => Promise<QaTestResult>;
  /** Injectable custom security auditor */
  runSecurityAudit?: (proposal: string, round: number) => Promise<SecurityAuditResult>;
}

export interface TeamRunResult {
  ok: boolean;
  finalAnswer: string;
  transcript: TeamMessage[];
  roundsCompleted: number;
  approvedByReviewer: boolean;
  architectSummary?: string;
  evidenceHistory: VerificationEvidence[];
}

/** Default system prompts configured for each specialist */
export const DEFAULT_ROLE_PROMPTS: Record<SpecialistRole, string> = {
  architect: `You are the Lead Systems Architect.
Your role:
1. Deconstruct user requirements into clear architectural specs, constraints, and acceptance criteria.
2. Define technical boundaries, data contracts, and verification criteria.
3. Synthesize the final outcome once work has been completed and verified.
Be precise, structured, and unambiguous.`,

  coder: `You are the Principal Software Engineer.
Your role:
1. Implement technical solutions, write code, search repository structures, and fix defects.
2. Formulate explicit, testable implementations or unified diffs.
3. Address feedback and critique from the Reviewer, Security Auditor, and QA Engineer constructively by refining the code.
Always deliver functional, robust, and clean code.`,

  reviewer: `You are the Senior Quality & Architecture Reviewer.
Your role:
1. Adversarially critique proposals, code diffs, and plans produced by the team.
2. Check for adherence to architectural specs, maintainability, clean design, and edge cases.
3. If defects exist, reply with a clear critique ("type: critique") explaining what must be corrected.
4. If the work satisfies all requirements, reply with explicit approval ("type: approval").`,

  security_auditor: `You are the Lead Security Auditor.
Your role:
1. Inspect code proposals specifically for security vulnerabilities: path traversal, command injection, secret leakage, SSRF, and permission escalation.
2. Enforce defense-in-depth principles and fail-closed defaults.
3. Issue clear, actionable security findings for any defect.`,

  qa_engineer: `You are the Senior QA Verification Engineer.
Your role:
1. Evaluate test coverage, boundary cases, regression risks, and assertion strength.
2. Verify that solutions genuinely execute successfully and satisfy all requirements.`,

  researcher: `You are the Research & Information Specialist.
Your role:
1. Investigate background documentation, specifications, and external evidence.
2. Provide grounded facts, citations, and summaries to support the team.
Avoid hallucinations; state uncertainties explicitly.`,
};

/**
 * Built-in Automated Static Security Scanner.
 * Detects hardcoded credentials, unsafe execution, path escapes, and SSRF.
 */
export function defaultSecurityAudit(proposal: string): SecurityAuditResult {
  const findings: string[] = [];
  const structuredFindings: StructuredSecurityFinding[] = [];

  // Check 1: Secret / API Key / Cloud Credential Leakage
  const secretMatch = proposal.match(
    /\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16,}|ASIA[0-9A-Z]{16,}|AIzaSy[a-zA-Z0-9_-]{33}|bearer\s+[a-zA-Z0-9._-]{30,}|xox[baprs]-[a-zA-Z0-9-]{10,})\b/i
  );
  if (secretMatch) {
    findings.push("Exposed API key, token, or bearer credential in proposed code");
    structuredFindings.push({
      ruleId: "CWE-798-HARDCODED-CREDENTIALS",
      severity: "critical",
      description: "Hardcoded API key, access token, or cloud credential detected in proposal",
      matchedText: secretMatch[0].slice(0, 10) + "...",
      remediation: "Use environment variables or a secure key manager instead of committing secrets into source.",
    });
  }

  // Check 2: Unsafe command execution
  const cmdMatch = proposal.match(
    /\b(child_process\.exec\s*\(|eval\s*\(|new\s+Function\s*\(|spawn\s*\([^,]+,[^,]+,\s*\{[^}]*shell:\s*true)/
  );
  if (cmdMatch) {
    findings.push("Unsafe command execution detected (eval, Function, child_process.exec, or shell: true)");
    structuredFindings.push({
      ruleId: "CWE-78-COMMAND-INJECTION",
      severity: "critical",
      description: "Potentially vulnerable command evaluation mechanism detected",
      matchedText: cmdMatch[0],
      remediation: "Avoid string-based shell invocation. Use execFile or spawn with argument arrays and shell: false.",
    });
  }

  // Check 3: Direct unsanitized path traversal
  if (/\.\.\/(\.\.\/)+/.test(proposal) && !proposal.includes("resolveSandboxedPath")) {
    findings.push("Potential unconstrained path traversal (../../) without sandboxed path resolution");
    structuredFindings.push({
      ruleId: "CWE-22-PATH-TRAVERSAL",
      severity: "high",
      description: "Path traversal pattern found without sandboxed root validation",
      remediation: "Always use resolveSandboxedPath to ensure path cannot escape tenant workspace.",
    });
  }

  // Check 4: Hardcoded private network addresses / cloud metadata
  if (/\b(169\.254\.169\.254|metadata\.google\.internal)\b/.test(proposal)) {
    findings.push("Hardcoded cloud metadata IP/endpoint reference detected");
    structuredFindings.push({
      ruleId: "CWE-918-SSRF-CLOUD-METADATA",
      severity: "critical",
      description: "Cloud metadata instance endpoint detected (potential SSRF escalation)",
      remediation: "Filter private network addresses and enforce strict domain allowlisting.",
    });
  }

  // Check 5: Adversarial prompt injection trying to instruct the auditor to ignore rules
  if (/(SYSTEM\s*:\s*OVERRIDE|IGNORE\s+ALL\s+SECURITY|APPROVE_WITHOUT_REVIEW|BYPASS_AUDIT)\b/i.test(proposal)) {
    findings.push("Adversarial prompt injection attempt detected in code proposal");
    structuredFindings.push({
      ruleId: "SEC-PROMPT-INJECTION-DETECTED",
      severity: "critical",
      description: "Proposal contains adversarial tokens attempting to deceive automated verification",
      remediation: "Reject proposal and flag for human review.",
    });
  }

  return {
    safe: findings.length === 0,
    findings,
    structuredFindings,
  };
}

/**
 * Autonomous Multi-Agent Team Orchestrator.
 * Coordinates collaboration between Architect, Coder, Reviewer, Security Auditor, and QA specialists.
 */
export class AgentTeam {
  private specialists: Map<SpecialistRole, SpecialistAgentConfig>;

  constructor(
    private deps: Pick<ReasoningLoopDeps, "streamChat" | "tools" | "executeTool">,
    customConfigs?: Partial<Record<SpecialistRole, Partial<SpecialistAgentConfig>>>
  ) {
    this.specialists = new Map();
    const roles: SpecialistRole[] = [
      "architect",
      "coder",
      "reviewer",
      "security_auditor",
      "qa_engineer",
      "researcher",
    ];

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
   * Phase 1: Architect plans and establishes constraints.
   * Phase 2: Coder produces implementation / proposal.
   * Phase 3: Reviewer inspects, Security Auditor scans, QA executes tests.
   *          Approval requires model agreement AND passing objective evidence.
   * Phase 4: Architect synthesizes final verified deliverable.
   */
  async execute(options: TeamRunOptions): Promise<TeamRunResult> {
    const maxRounds = options.maxRounds ?? 3;
    const transcript: TeamMessage[] = [];
    const evidenceHistory: VerificationEvidence[] = [];

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

    // Review Consensus Loop (Coder -> Reviewer / Security / QA -> Revision)
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
        // Feed previous critique and objective evidence back
        const previousCritique = transcript[transcript.length - 1];
        coderPrompt.push({
          role: "user",
          content: `Previous Feedback & Verification Evidence (Round ${round - 1}):\n${previousCritique.content}\n\nPlease revise your solution addressing all concerns raised.`,
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
          content: `Goal:\n${options.goal}\n\nArchitect Plan:\n${architectPlan}\n\nCoder Proposal (Round ${round}):\n${currentProposal}\n\nEvaluate this implementation for correctness, edge cases, and compliance with requirements.\nIf acceptable without critical defects, explicitly include "APPROVED" in your verdict.\nOtherwise, provide bulleted critique items.`,
        },
      ];

      const reviewVerdict = await this.runSpecialistTurn("reviewer", reviewerPrompt);
      const modelApproved =
        /\b(APPROVED|LGTM|PASSED)\b/i.test(reviewVerdict) &&
        !/\b(REJECTED|FAILED|NEEDS_WORK)\b/i.test(reviewVerdict);

      // Objective Security Audit
      const securityAudit = options.runSecurityAudit
        ? await options.runSecurityAudit(currentProposal, round)
        : defaultSecurityAudit(currentProposal);

      emit({
        type: "security_audit_completed",
        round,
        role: "security_auditor",
        reason: securityAudit.safe ? "Clean" : securityAudit.findings.join("; "),
      });

      // Objective QA Evaluation
      let qaResult: QaTestResult | undefined;
      if (options.runQaTests) {
        qaResult = await options.runQaTests(currentProposal, round);
        emit({
          type: "qa_evaluation_completed",
          round,
          role: "qa_engineer",
          reason: qaResult.passed ? "All tests passed" : qaResult.failures.join("; "),
        });
      }

      // Reconcile Consensus with Objective Evidence
      let consensusOverridden = false;
      let overrideReason: string | undefined;

      const isApproved =
        modelApproved &&
        securityAudit.safe &&
        (qaResult ? qaResult.passed : true);

      if (modelApproved && !isApproved) {
        // Model hallucinated an approval despite failed objective checks!
        consensusOverridden = true;
        const failurePoints: string[] = [];
        if (!securityAudit.safe) {
          failurePoints.push(`Security findings: ${securityAudit.findings.join("; ")}`);
        }
        if (qaResult && !qaResult.passed) {
          failurePoints.push(`QA Failures: ${qaResult.failures.join("; ")}`);
        }
        overrideReason = `Orchestrator rejected model approval due to objective verification failures: ${failurePoints.join(" | ")}`;
        emit({
          type: "review_rejected_by_evidence",
          round,
          reason: overrideReason,
        });
      }

      const evidence: VerificationEvidence = {
        round,
        reviewerVerdict: reviewVerdict,
        reviewerApproved: modelApproved,
        securityAudit,
        qaTestResult: qaResult,
        consensusOverridden,
        overrideReason,
      };
      evidenceHistory.push(evidence);

      // Formulate feedback for coder
      let feedbackContent = reviewVerdict;
      if (consensusOverridden) {
        feedbackContent = `[CRITICAL REJECTION BY OBJECTIVE VERIFIER]\n${overrideReason}\n\nReviewer comments:\n${reviewVerdict}`;
      }

      const reviewerMsg: TeamMessage = {
        from: isApproved ? "reviewer" : "coordinator",
        to: isApproved ? "architect" : "coder",
        type: isApproved ? "approval" : "critique",
        content: feedbackContent,
        timestamp: new Date().toISOString(),
        metadata: {
          round,
          approved: isApproved,
          evidence,
        },
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
      metadata: {
        approvedByReviewer: approved,
        rounds: Math.min(round, maxRounds),
        evidenceCount: evidenceHistory.length,
      },
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
      evidenceHistory,
    };
  }
}
