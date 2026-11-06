"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Task } from "@ai-platform/shared";
import { createTask, listTasks } from "../lib/api";
import { StatusBadge } from "../lib/status-badge";
import { RequireSession, useSession } from "../lib/session-context";

export default function CodingAgentPage() {
  const { projectId } = useSession();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Form inputs
  const [codingMode, setCodingMode] = useState<"fix_test" | "autonomous_code">("fix_test");
  const [testDir, setTestDir] = useState("coding-demo");
  const [testFile, setTestFile] = useState("math.test.js");
  const [goal, setGoal] = useState("");

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

  useEffect(refresh, [refresh, projectId]);

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
            role="alert"
          >
            {error}
          </div>
        )}

        {/* Coding Task Launcher */}
        <section
          style={{
            padding: 20,
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--card-bg, #ffffff)",
            marginBottom: 24,
          }}
        >
          <h2 style={{ fontSize: "17px", margin: "0 0 12px", fontWeight: 600 }}>Launch Coding Agent Job</h2>
          <form onSubmit={handleLaunchCodingAgent}>
            <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "14px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="codingMode"
                  value="fix_test"
                  checked={codingMode === "fix_test"}
                  onChange={() => setCodingMode("fix_test")}
                />
                <strong>Automated Test Fixer</strong> (Runs tests, locates failure, applies patch)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "14px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="codingMode"
                  value="autonomous_code"
                  checked={codingMode === "autonomous_code"}
                  onChange={() => setCodingMode("autonomous_code")}
                />
                <strong>Autonomous Engineering Agent</strong> (Multi-step goal execution)
              </label>
            </div>

            {codingMode === "fix_test" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: 4 }}>
                    Workspace Directory
                  </label>
                  <input
                    type="text"
                    value={testDir}
                    onChange={(e) => setTestDir(e.target.value)}
                    placeholder="e.g. coding-demo or src"
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      fontSize: "13px",
                    }}
                    required
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: 4 }}>
                    Test File Name
                  </label>
                  <input
                    type="text"
                    value={testFile}
                    onChange={(e) => setTestFile(e.target.value)}
                    placeholder="e.g. math.test.js"
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      fontSize: "13px",
                    }}
                    required
                  />
                </div>
              </div>
            ) : (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: 4 }}>
                  Engineering Goal / Task Description
                </label>
                <textarea
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="Describe the software engineering task in detail..."
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    fontSize: "13px",
                    fontFamily: "inherit",
                  }}
                  required
                />
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                Policy: Read & patch permitted in sandbox. Consequential shell actions held for approval.
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
            <h2 style={{ fontSize: "17px", margin: 0, fontWeight: 600 }}>Active & Recent Coding Tasks</h2>
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
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Link
                        href={`/coding/${task.id}`}
                        style={{ fontWeight: 600, fontSize: "15px", color: "var(--fg)", textDecoration: "none" }}
                      >
                        Task #{task.id.slice(0, 8)}
                      </Link>
                      <span
                        style={{
                          fontSize: "11px",
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: "var(--border)",
                          fontWeight: 600,
                        }}
                      >
                        {task.taskType}
                      </span>
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: 4 }}>
                      Created at {new Date(task.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <StatusBadge status={task.state} />
                    <Link
                      href={`/coding/${task.id}`}
                      style={{
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "#2563eb",
                        textDecoration: "none",
                      }}
                    >
                      View Diffs & Actions &rarr;
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </RequireSession>
  );
}
