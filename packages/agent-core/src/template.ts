/**
 * Minimal `{{nodeId.output.field}}` reference resolution — docs/11_AGENT_LOOP.md §3.1
 * ("resolved input... may reference prior nodes' outputs by id... resolved at dispatch
 * time"). Deliberately small: string values only, one reference per string, no
 * arithmetic/expression language. A real expression evaluator (for `condition` fields on
 * conditional/loop nodes) is deferred along with those node types — see PROJECT_STATUS.md.
 */
const REF_PATTERN = /\{\{([\w-]+)\.output\.([\w.]+)\}\}/g;

export function resolveNodeInput(
  input: Record<string, unknown>,
  getNodeOutput: (nodeId: string) => Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    resolved[key] = resolveValue(value, getNodeOutput);
  }
  return resolved;
}

function resolveValue(
  value: unknown,
  getNodeOutput: (nodeId: string) => Record<string, unknown> | null | undefined
): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    return value.replace(REF_PATTERN, (whole, nodeId: string, fieldPath: string) => {
      const output = getNodeOutput(nodeId);
      if (!output) {
        throw new Error(`Template reference "${whole}" points to a node with no output yet.`);
      }
      const resolvedField = fieldPath.split(".").reduce<unknown>((acc, key) => {
        if (acc === null || typeof acc !== "object") return undefined;
        return (acc as Record<string, unknown>)[key];
      }, output);
      if (resolvedField === undefined) {
        throw new Error(`Template reference "${whole}" resolved to undefined.`);
      }
      return typeof resolvedField === "string" ? resolvedField : JSON.stringify(resolvedField);
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, getNodeOutput));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, getNodeOutput);
    }
    return out;
  }
  return value;
}
