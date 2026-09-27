/**
 * Whether a run has changed any file yet — read from its own activity log.
 *
 * Found by a real fix_failing_test run on qwen2.5:7b. Its only edit attempts were a diff with no
 * file headers (refused) and an edit to the read-only test (refused); it then answered with a
 * description of the fix for someone else to apply. The in-loop test run told it "the test still
 * fails" three times, and three times it answered in prose. What it was never told is the one
 * fact that explains the failure: nothing it did had changed a file. That fact is in the log, so
 * the harness states it rather than leaving the model to infer it.
 */

/** Tools whose success means a file in the workspace changed. */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "code.replace_text",
  "code.apply_patch",
  "fs.write_file",
  "fs.delete_file",
]);

/** How many file-editing calls in `activity` succeeded, and how many were attempted. */
export function countFileEdits(activity: ReadonlyArray<Record<string, unknown>>): { attempted: number; succeeded: number } {
  const editCalls = new Set<string>();
  for (const entry of activity) {
    if (entry.kind === "tool_call" && typeof entry.name === "string" && FILE_EDIT_TOOLS.has(entry.name)) {
      editCalls.add(String(entry.callId));
    }
  }
  let succeeded = 0;
  for (const entry of activity) {
    if (entry.kind === "tool_result" && editCalls.has(String(entry.callId)) && entry.ok === true) succeeded++;
  }
  return { attempted: editCalls.size, succeeded };
}

/**
 * The sentence added to a failed test verdict when no edit has succeeded — empty otherwise, so a
 * run that did change something is not told it did not.
 */
export function noEditYetNotice(activity: ReadonlyArray<Record<string, unknown>>): string {
  const { attempted, succeeded } = countFileEdits(activity);
  if (succeeded > 0) return "";
  // Only what the log proves: an edit TOOL has not succeeded. A terminal command could still have
  // written a file, so this never claims the source is untouched.
  const history =
    attempted === 0
      ? "No file-editing tool has been used in this run"
      : `None of this run's ${attempted} file-editing tool call(s) succeeded`;
  return (
    `${history}. Make the change yourself with a tool — code.replace_text takes the file's exact ` +
    "current text and its replacement. An answer that describes a fix does not apply it. "
  );
}
