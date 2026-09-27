import { readdirSync } from "node:fs";
import { dirname, relative } from "node:path";

/**
 * What a model needs when it names a file that is not there: the names that ARE there.
 *
 * A real fix_failing_test run (qwen2.5:7b) decided the source was `sum.cjs` when it was `sum.js`,
 * and spent its turns reading and editing a file that never existed. All it got back was a bare
 * ENOENT — carrying the server's absolute path — and code.replace_text's message suggested
 * CREATING the file. Listing the directory is what a person would do next, so the tool does it.
 *
 * Names only, relative to the workspace: the absolute layout of the deployment is not the
 * model's business.
 */
export function describeMissingFile(workspace: string, absolute: string, requested: string): string {
  const dir = dirname(absolute);
  const where = relative(workspace, dir) || ".";
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return `"${requested}" does not exist, and neither does the directory "${where}".`;
  }
  if (files.length === 0) return `"${requested}" does not exist; the directory "${where}" has no files.`;
  const shown = files.slice(0, 25);
  const more = files.length > shown.length ? `, and ${files.length - shown.length} more` : "";
  return `"${requested}" does not exist. Files in "${where}": ${shown.join(", ")}${more}.`;
}
