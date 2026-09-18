import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TasksPage from "./page";

/**
 * Starting the agent the platform is for — docs/26_DECISIONS.md ADR-136.
 *
 * ADR-064 unified the deterministic task graph with the model-driven reasoning loop, and the
 * second one is the product: the model decides what to do, turn by turn, with real tools. The task
 * type list omitted it. Every option was a hardcoded recipe, so from the interface this WAS the
 * workflow runner an earlier audit had called it — the autonomous engine existed, was tested, and
 * could only be reached by posting JSON by hand.
 *
 * The same screen told users to `POST` to a tool-enable endpoint themselves, which is the other
 * half: MCP tools ship disabled so that a person decides (ADR-083), and no person could.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/tasks",
}));

const createTask = vi.fn(async () => ({ task: { id: "task-1" } }));
const listTasks = vi.fn(async () => ({ tasks: [] }));
const listTools = vi.fn(async () => ({ tools: [] as unknown[] }));
const listWorkspaceFiles = vi.fn(async () => ({ files: [] as unknown[], truncated: false }));
const writeWorkspaceFile = vi.fn(async () => ({ file: { path: "a", sizeBytes: 1, modifiedAt: "" } }));
const setToolEnabled = vi.fn(async () => ({ tool: { id: "t", enabled: true } }));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  createTask: (...a: unknown[]) => createTask(...(a as [])),
  listTasks: () => listTasks(),
  listTools: () => listTools(),
  setToolEnabled: (...a: unknown[]) => setToolEnabled(...(a as [])),
  listWorkspaceFiles: () => listWorkspaceFiles(),
  writeWorkspaceFile: (...a: unknown[]) => writeWorkspaceFile(...(a as [])),
}));

describe("Tasks screen", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("offers the autonomous agent, and starts it with the goal that was typed", async () => {
    const user = userEvent.setup();
    render(<TasksPage />);

    // It is a real option, not documentation telling the reader it exists.
    const select = screen.getByLabelText(/task type/i);
    await user.selectOptions(select, "autonomous");

    // Its one field is the GOAL — not a path, not a recipe step.
    const goal = screen.getByPlaceholderText("goal");
    await user.type(goal, "Tidy the repository");
    await user.click(screen.getByRole("button", { name: /start task/i }));

    await waitFor(() => expect(createTask).toHaveBeenCalled());
    expect(createTask).toHaveBeenCalledWith("autonomous", { goal: "Tidy the repository" });
  });

  it("explains that the model plans rather than following steps", async () => {
    const user = userEvent.setup();
    render(<TasksPage />);
    await user.selectOptions(screen.getByLabelText(/task type/i), "autonomous");
    expect(screen.getByText(/the model plans, calls tools/i)).toBeInTheDocument();
  });

  it("lets a human enable an MCP tool instead of telling them to send a POST", async () => {
    listTools.mockResolvedValue({
      tools: [
        {
          id: "mcp.reference-filesystem.read_text_file",
          name: "read_text_file",
          description: "Reads a file",
          origin: { kind: "mcp", serverId: "reference-filesystem" },
          permissionLevel: "read_only",
          riskLevel: "low",
          requiresApproval: "never",
          enabled: false,
        },
      ],
    });

    const user = userEvent.setup();
    render(<TasksPage />);
    await user.selectOptions(screen.getByLabelText(/task type/i), "mcp_read_and_summarize");

    const enable = await screen.findByRole("button", { name: /^enable$/i });
    await user.click(enable);

    await waitFor(() => expect(setToolEnabled).toHaveBeenCalledWith("mcp.reference-filesystem.read_text_file", true));
    // And the instruction to run a command by hand is gone.
    expect(screen.queryByText(/POST \/api\/v1\/tools/)).not.toBeInTheDocument();
  });

  it("says plainly when there is no MCP server to enable anything from", async () => {
    listTools.mockResolvedValue({ tools: [] });
    const user = userEvent.setup();
    render(<TasksPage />);
    await user.selectOptions(screen.getByLabelText(/task type/i), "mcp_read_and_summarize");
    expect(await screen.findByText(/No MCP server is configured/i)).toBeInTheDocument();
  });

  /**
   * Seeding the workspace — docs/26_DECISIONS.md ADR-142.
   *
   * The coding agent works inside a per-project directory and nothing could put anything into it,
   * so "fix the failing test" had no test to fix. An uploaded document is not the same thing: it
   * goes to the asset store, which the filesystem tools cannot see.
   */
  it("offers a workspace for a coding task, and says plainly when it is empty", async () => {
    const user = userEvent.setup();
    render(<TasksPage />);
    await user.selectOptions(screen.getByLabelText(/task type/i), "fix_failing_test");

    expect(await screen.findByText(/the agent's workspace/i)).toBeInTheDocument();
    expect(await screen.findByText(/it will find nothing to work on/i)).toBeInTheDocument();
  });

  it("adds a file to the workspace with the path and contents that were typed", async () => {
    const user = userEvent.setup();
    render(<TasksPage />);
    await user.selectOptions(screen.getByLabelText(/task type/i), "fix_failing_test");

    await user.type(await screen.findByPlaceholderText("src/sum.test.ts"), "src/sum.test.ts");
    await user.type(screen.getByPlaceholderText(/the file the agent should work on/i), "expect(sum(1,2)).toBe(3);");
    await user.click(screen.getByRole("button", { name: /add file to workspace/i }));

    await waitFor(() =>
      expect(writeWorkspaceFile).toHaveBeenCalledWith("src/sum.test.ts", "expect(sum(1,2)).toBe(3);")
    );
  });

  it("does not offer a workspace for a task type that has no use for one", async () => {
    const user = userEvent.setup();
    render(<TasksPage />);
    await user.selectOptions(screen.getByLabelText(/task type/i), "echo_chat");
    expect(screen.queryByText(/the agent's workspace/i)).not.toBeInTheDocument();
  });
});
