"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Task } from "@ai-platform/shared";
import { createTask, listTasks, listWorkspaceFiles, writeWorkspaceFile, type WorkspaceFile } from "../lib/api";
import { StatusBadge } from "../lib/status-badge";
import { RequireSession, useSession } from "../lib/session-context";

export default function CodingAgentPage() {
  const { projectId } = useSession();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Form inputs
  const [codingMode, setCodingMode] = useState<"fix_test" | "autonomous_code">("fix_test");
  const [testDir, setTestDir] = useState("coding-demo");
  const [testFile, setTestFile] = useState("math.test.js");
  const [goal, setGoal] = useState("");

  const refreshFiles = useCallback(() => {
    listWorkspaceFiles()
      .then((r) => setWorkspaceFiles(r.files))
      .catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    listTasks()
      .then((r) => {
        const codingTasks = r.tasks.filter(
          (t) => t.taskType === "fix_failing_test" || t.taskType === "autonomous"
        );
        setTasks(codingTasks);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    refreshFiles();
  }, [refresh, refreshFiles, projectId]);

  async function handleSeedDemo() {
    setSeeding(true);
    setError(null);
    try {
      await writeWorkspaceFile("coding-demo/math.js", "const ANSWER = 41;\nmodule.exports = { ANSWER };\n");
      await writeWorkspaceFile(
        "coding-demo/math.test.js",
        'const assert = require("assert");\nconst { ANSWER } = require("./math");\nassert.strictEqual(ANSWER, 42, "Expected ANSWER to be 42");\nconsole.log("PASS");\n'
      );
      refreshFiles();
    } catch (err) {
      setError(String(err));
    } finally {
      setSeeding(false);
    }
  }

  async function handleLaunchCodingAgent(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      let taskType = "fix_failing_test";
      let input: Record<string, unknown> = {};

      if (codingMode === "fix_test") {
        taskType = "fix_failing_test";
        input = { testDir, testFile };
        // If targeting coding-demo and files not yet present, ensure seeded
        if (testDir === "coding-demo" && !workspaceFiles.some((f) => f.path.includes("math.test.js"))) {
          await handleSeedDemo();
        }
      } else {
        taskType = "autonomous";
        input = { goal: goal || "Inspect codebase, diagnose issues, and apply safe unit-tested fixes." };
      }

      const { task } = await createTask(taskType as any, input);
      refresh();
      window.location.href = `/coding/${task.id}`;
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <RequireSession requireProject={true}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px" }}>
        <header style={{ marginBottom: 24, borderBottom: "1px solid var(--border)", paddingBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 700 }}>NirnayAI — Autonomous Coding Workspace</h1>
              <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: "14px" }}>
                Grounded software engineering agent: symbol search, test-driven defect repair, unified patch diffs, and rollback safety.
              </p>
            </div>
            <span
              style={{
                background: "#2563eb",
                color: "#ffffff",
                padding: "4px 10px",
                borderRadius: "4px",
                fontSize: "12px",
                fontWeight: 700,
                letterSpacing: "0.05em",
              }}
            >
              SANDBOX JAIL ACTIVE
            </span>
          </div>
        </header>

        {error && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "6px",
              background: "color-mix(in srgb, #dc2626 10%, transparent)",
              border: "1px solid #dc2626",
              color: "#dc2626",
              fontSize: "13px",
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        {/* Workspace Fixture Status Bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--card-bg, #ffffff)",
            marginBottom: 24,
          }}
        >
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600 }}>Project Workspace Sandbox</div>
            <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: 2 }}>
              {workspaceFiles.length === 0
                ? "No files seeded yet in this project workspace."
                : `${workspaceFiles.length} file(s) present: ${workspaceFiles.map((f) => f.path).join(", ")}`}
            </div>
          </div>
          <button
            type="button"
            onClick={handleSeedDemo}
            disabled={seeding}
            style={{
              background: "#059669",
              color: "#ffffff",
              border: "none",
              padding: "6px 12px",
              borderRadius: 4,
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {seeding ? "Seeding Fixture..." : "Seed Demo Fixture (math.test.js)"}
          </button>
        </div>

        {/* Dispatch Form */}
        <section
          style={{
            background: "var(--card-bg, #ffffff)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 20,
            marginBottom: 32,
          }}
        >
          <h2 style={{ fontSize: "17px", marginTop: 0, marginBottom: 16, fontWeight: 600 }}>
            Dispatch Autonomous Coding Agent
          </h2>

          <form onSubmit={handleLaunchCodingAgent}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: 6 }}>
                Execution Mode
              </label>
              <div style={{ display: "flex", gap: 16 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "14px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="mode"
                    value="fix_test"
                    checked={codingMode === "fix_test"}
                    onChange={() => setCodingMode("fix_test")}
                  />
                  Fix Failing Test (TDD Loop: Run &rarr; Parse Failure &rarr; Patch &rarr; Re-verify)
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "14px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="mode"
                    value="autonomous_code"
                    checked={codingMode === "autonomous_code"}
                    onChange={() => setCodingMode("autonomous_code")}
                  />
                  Autonomous Goal Driven
                </label>
              </div>
            </div>

            {codingMode === "fix_test" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                <div>
                  <label
                    htmlFor="testDir"
                    style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: 6 }}
                  >
                    Test Directory (Workspace Relative)
                  </label>
                  <input
                    id="testDir"
                    type="text"
                    value={testDir}
                    onChange={(e) => setTestDir(e.target.value)}
                    placeholder="e.g. coding-demo or src"
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--input-bg, transparent)",
                      color: "inherit",
                      fontSize: "13px",
                    }}
                    required
                  />
                </div>
                <div>
                  <label
                    htmlFor="testFile"
                    style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: 6 }}
                  >
                    Target Test File
                  </label>
                  <input
                    id="testFile"
                    type="text"
                    value={testFile}
                    onChange={(e) => setTestFile(e.target.value)}
                    placeholder="e.g. math.test.js"
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--input-bg, transparent)",
                      color: "inherit",
                      fontSize: "13px",
                    }}
                    required
                  />
                </div>
              </div>
            ) : (
              <div style={{ marginBottom: 16 }}>
                <label htmlFor="goal" style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: 6 }}>
                  Autonomous Coding Goal
                </label>
                <textarea
                  id="goal"
                  rows={3}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="e.g. Find where the tax calculation is defined, fix the negative rate bug, and verify unit tests pass."
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--input-bg, transparent)",
                    color: "inherit",
                    fontSize: "13px",
                    fontFamily: "inherit",
                  }}
                  required
                />
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                Policy: Read &amp; patch permitted in sandbox. Consequential shell actions held for approval.
              </span>
              <button
                type="submit"
                disabled={submitting}
                style={{
                  background: "#2563eb",
                  color: "#fff",
                  border: "none",
                  padding: "8px 18px",
                  borderRadius: 6,
                  fontWeight: 600,
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                {submitting ? "Launching Agent..." : "Start Coding Agent"}
              </button>
            </div>
          </form>
        </section>

        {/* Coding Tasks History */}
        <section>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ fontSize: "17px", margin: 0, fontWeight: 600 }}>Active &amp; Recent Coding Tasks</h2>
            <button
              onClick={refresh}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                padding: "4px 10px",
                borderRadius: 4,
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              Refresh
            </button>
          </div>

          {loading ? (
            <p style={{ color: "var(--muted)", fontSize: "14px" }}>Loading coding tasks...</p>
          ) : tasks.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: "center",
                borderRadius: 8,
                border: "1px dashed var(--border)",
                color: "var(--muted)",
                fontSize: "14px",
              }}
            >
              No coding tasks initiated in this project yet. Use the form above to run your first task.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {tasks.map((task) => (
                <div
                  key={task.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 16px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--card-bg, #ffffff)",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Link
                        href={`/coding/${task.id}`}
                        style={{
                          fontSize: "14px",
                          fontWeight: 600,
                          color: "inherit",
                          textDecoration: "none",
                        }}
                      >
                        {task.taskType === "fix_failing_test" ? "Fix Failing Test" : "Autonomous Coding Task"}
                      </Link>
                      <StatusBadge status={task.state} />
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: 4 }}>
                      Task ID: <code>{task.id.slice(0, 8)}</code> &bull; Created:{" "}
                      {new Date(task.createdAt).toLocaleTimeString()}
                      {Boolean((task.input as Record<string, unknown>)?.testFile) && (
                        <span> &bull; File: <code>{String((task.input as Record<string, unknown>).testFile)}</code></span>
                      )}
                    </div>
                  </div>

                  <Link
                    href={`/coding/${task.id}`}
                    style={{
                      fontSize: "13px",
                      color: "#2563eb",
                      textDecoration: "none",
                      fontWeight: 600,
                    }}
                  >
                    View Workspace &rarr;
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </RequireSession>
  );
}
