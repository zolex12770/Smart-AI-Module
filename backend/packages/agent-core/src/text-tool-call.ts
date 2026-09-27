import type { ToolCall, ToolSpec } from "@ai-platform/shared";

/**
 * A tool call the model wrote as TEXT instead of emitting as a call — found by the
 * autonomous-completion pass.
 *
 * Local models are served through a chat template that turns a `<tool_call>{json}</tool_call>`
 * block into a structured call. When the block is malformed the runtime passes it through as
 * ordinary content. A real fix_failing_test run on qwen2.5:7b ended three turns with exactly that:
 *
 *     ... Let's re-run the test ...\n\n Ronaldo\n{"name": "terminal.run_command", "arguments":
 *     {"command": "node", "args": ["sum.test.cjs"], "cwd": "."}}\n</tool_call>
 *
 * a stray token where the opening tag belonged. The loop read each as a final answer, the test
 * verdict sent it back three times, and the run ended FAILED having never re-run the test it was
 * asking to run. The intent is unambiguous and the call is well-formed, so it is recovered.
 *
 * Deliberately narrow: only a JSON object that parses, whose `name` is a tool OFFERED in this very
 * turn, and whose `arguments` is an object. The recovered call then goes through exactly the path
 * a structured one does — argument validation against the tool's schema, the approval gate, the
 * audit log — so recovery grants nothing a structured call would not have.
 */
export function recoverTextToolCalls(content: string, tools: ReadonlyArray<Pick<ToolSpec, "name">>, idPrefix: string): ToolCall[] {
  if (!content.includes("{") || tools.length === 0) return [];
  const offered = new Set(tools.map((tool) => tool.name));
  const calls: ToolCall[] = [];
  for (const candidate of balancedObjects(content)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const args = record.arguments ?? record.parameters;
    if (typeof record.name !== "string" || !offered.has(record.name)) continue;
    if (typeof args !== "object" || args === null || Array.isArray(args)) continue;
    calls.push({ id: `${idPrefix}-${calls.length + 1}`, name: record.name, arguments: args as Record<string, unknown> });
    // A model that writes several calls as text means several; a bound keeps a runaway reply
    // from becoming a burst of actions.
    if (calls.length === 4) break;
  }
  return calls;
}

/** Every top-level balanced `{...}` in `text`, honouring JSON string quoting. */
function* balancedObjects(text: string): Generator<string> {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (depth > 0 && inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) yield text.slice(start, i + 1);
    }
  }
}
