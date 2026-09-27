import { describe, expect, it } from "vitest";
import { countFileEdits, noEditYetNotice } from "./edit-progress.js";

const call = (callId: string, name: string) => ({ kind: "tool_call", callId, name, arguments: {} });
const result = (callId: string, ok: boolean) => ({ kind: "tool_result", callId, ok, content: "" });

describe("whether a run has changed a file yet", () => {
  // The recorded failing run: a headerless diff, reads, a refused edit to the read-only test.
  const recorded = [
    call("1", "terminal.run_command"), result("1", true),
    call("2", "code.read_lines"), result("2", true),
    call("3", "code.apply_patch"), result("3", false),
    call("4", "code.replace_text"), result("4", false),
    call("5", "terminal.run_command"), result("5", true),
  ];

  it("counts the recorded run's two refused edits and no successful one", () => {
    expect(countFileEdits(recorded)).toEqual({ attempted: 2, succeeded: 0 });
  });

  it("tells that run the fact it was missing", () => {
    const notice = noEditYetNotice(recorded);
    expect(notice).toMatch(/None of this run's 2 file-editing tool call\(s\) succeeded/);
    expect(notice).toMatch(/code\.replace_text/);
    expect(notice).toMatch(/describes a fix does not apply it/);
  });

  it("names a run that never tried to edit", () => {
    expect(noEditYetNotice([call("1", "terminal.run_command"), result("1", true)])).toMatch(/No file-editing tool has been used/);
  });

  it("says nothing once any edit has succeeded, however many failed first", () => {
    const fixed = [...recorded, call("6", "code.replace_text"), result("6", true)];
    expect(countFileEdits(fixed)).toEqual({ attempted: 3, succeeded: 1 });
    expect(noEditYetNotice(fixed)).toBe("");
  });

  it("does not count a successful read or command as an edit", () => {
    const readsOnly = [call("1", "fs.read_file"), result("1", true), call("2", "terminal.run_command"), result("2", true)];
    expect(countFileEdits(readsOnly)).toEqual({ attempted: 0, succeeded: 0 });
  });
});
