import { describe, expect, it } from "vitest";
import {
  isValidTaskTransition,
  LEGAL_TASK_TRANSITIONS,
  TERMINAL_TASK_STATES,
  type TaskState,
} from "./task-graph.js";

describe("Task Graph State Machine — Transitions & Invariants", () => {
  it("allows legal forward transitions from IDLE to planning/execution states", () => {
    expect(isValidTaskTransition("IDLE", "UNDERSTANDING")).toBe(true);
    expect(isValidTaskTransition("IDLE", "PLANNING")).toBe(true);
    expect(isValidTaskTransition("IDLE", "EXECUTING")).toBe(true);
    expect(isValidTaskTransition("IDLE", "BLOCKED")).toBe(true);
    expect(isValidTaskTransition("IDLE", "CANCELLED")).toBe(true);
  });

  it("permits transitions to PARTIALLY_COMPLETED and BLOCKED from EXECUTING and RETRYING", () => {
    expect(isValidTaskTransition("EXECUTING", "PARTIALLY_COMPLETED")).toBe(true);
    expect(isValidTaskTransition("EXECUTING", "BLOCKED")).toBe(true);
    expect(isValidTaskTransition("RETRYING", "PARTIALLY_COMPLETED")).toBe(true);
    expect(isValidTaskTransition("RETRYING", "BLOCKED")).toBe(true);
    expect(isValidTaskTransition("VERIFYING", "PARTIALLY_COMPLETED")).toBe(true);
  });

  it("strictly prohibits transitions out of terminal states (COMPLETED, FAILED, CANCELLED, etc.)", () => {
    const nonTerminalTargetStates: TaskState[] = [
      "IDLE",
      "UNDERSTANDING",
      "PLANNING",
      "EXECUTING",
      "WAITING_FOR_APPROVAL",
      "WAITING_FOR_MODEL",
      "WAITING_FOR_TOOL",
      "RETRYING",
      "PAUSED",
    ];

    for (const term of ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"] as const) {
      for (const target of nonTerminalTargetStates) {
        expect(isValidTaskTransition(term, target)).toBe(false);
      }
      expect(LEGAL_TASK_TRANSITIONS[term]).toHaveLength(0);
    }
  });

  it("allows BLOCKED tasks to be resumed into EXECUTING or CANCELLED", () => {
    expect(isValidTaskTransition("BLOCKED", "EXECUTING")).toBe(true);
    expect(isValidTaskTransition("BLOCKED", "CANCELLED")).toBe(true);
    expect(isValidTaskTransition("BLOCKED", "FAILED")).toBe(true);
    expect(isValidTaskTransition("BLOCKED", "PLANNING")).toBe(false);
  });

  it("ensures reflexive state transition (staying in current state) is always valid", () => {
    const states: TaskState[] = [
      "IDLE",
      "EXECUTING",
      "WAITING_FOR_APPROVAL",
      "PAUSED",
      "BLOCKED",
      "PARTIALLY_COMPLETED",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ];

    for (const s of states) {
      expect(isValidTaskTransition(s, s)).toBe(true);
    }
  });

  it("includes all 5 terminal states in TERMINAL_TASK_STATES", () => {
    expect(TERMINAL_TASK_STATES).toContain("COMPLETED");
    expect(TERMINAL_TASK_STATES).toContain("PARTIALLY_COMPLETED");
    expect(TERMINAL_TASK_STATES).toContain("FAILED");
    expect(TERMINAL_TASK_STATES).toContain("BLOCKED");
    expect(TERMINAL_TASK_STATES).toContain("CANCELLED");
    expect(TERMINAL_TASK_STATES).toHaveLength(5);
  });
});
