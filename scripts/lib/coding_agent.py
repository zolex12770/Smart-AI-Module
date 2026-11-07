#!/usr/bin/env python3
"""
NirnayAI Autonomous Coding Agent
Implements safe workspace exploration, symbol search, patch creation, diff computation, test execution, and rollback guards.
"""

import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

import os
import shutil
import difflib
import subprocess


class CodingAgent:
    """Autonomous Coding Agent for NirnayAI."""

    def __init__(self, workspace_root: str = "data/sandbox/coding_project"):
        self.workspace_root = Path(workspace_root).resolve()
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        self.snapshots = {}

    def _resolve_safe_path(self, relative_path: str) -> Path:
        """Enforce strict workspace confinement to prevent path traversal."""
        target = (self.workspace_root / relative_path).resolve()
        try:
            target.relative_to(self.workspace_root)
        except ValueError:
            raise PermissionError(f"Security Violation: Path '{relative_path}' is outside the authorized sandbox.")
        return target

    def list_files(self) -> list:
        """List all files in the workspace."""
        files = []
        for p in self.workspace_root.rglob("*"):
            if p.is_file() and not any(part.startswith(".") for part in p.parts):
                files.append(str(p.relative_to(self.workspace_root)).replace("\\", "/"))
        return sorted(files)

    def search_symbols(self, query: str) -> list:
        """Search for a keyword or symbol across workspace files."""
        results = []
        for file_rel in self.list_files():
            path = self._resolve_safe_path(file_rel)
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    for line_no, line in enumerate(f, start=1):
                        if query in line:
                            results.append({
                                "file": file_rel,
                                "line": line_no,
                                "content": line.strip()
                            })
            except Exception:
                pass
        return results

    def read_file(self, relative_path: str) -> str:
        """Read file contents safely."""
        target = self._resolve_safe_path(relative_path)
        if not target.exists():
            raise FileNotFoundError(f"File not found: {relative_path}")
        with open(target, "r", encoding="utf-8") as f:
            return f.read()

    def write_file(self, relative_path: str, content: str) -> dict:
        """Create or overwrite a file, returning the unified diff if it existed."""
        target = self._resolve_safe_path(relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)

        old_content = ""
        is_new = not target.exists()
        if not is_new:
            with open(target, "r", encoding="utf-8") as f:
                old_content = f.read()

        # Save snapshot for rollback
        self.snapshots[relative_path] = old_content

        diff_lines = list(difflib.unified_diff(
            old_content.splitlines(keepends=True),
            content.splitlines(keepends=True),
            fromfile=f"a/{relative_path}",
            tofile=f"b/{relative_path}"
        ))
        diff_text = "".join(diff_lines)

        with open(target, "w", encoding="utf-8") as f:
            f.write(content)

        return {
            "path": relative_path,
            "is_new": is_new,
            "diff": diff_text,
            "status": "WRITTEN"
        }

    def rollback(self, relative_path: str) -> dict:
        """Roll back file to its pre-edit snapshot state."""
        target = self._resolve_safe_path(relative_path)
        if relative_path not in self.snapshots:
            raise ValueError(f"No snapshot recorded for '{relative_path}'")

        content = self.snapshots[relative_path]
        if content == "":
            if target.exists():
                target.unlink()
            return {"path": relative_path, "status": "ROLLED_BACK_DELETED"}
        else:
            with open(target, "w", encoding="utf-8") as f:
                f.write(content)
            return {"path": relative_path, "status": "ROLLED_BACK_RESTORED"}

    def run_tests(self, command: list = None) -> dict:
        """Execute test runner within workspace sandbox."""
        cmd = command or [sys.executable, "-m", "unittest", "discover", "-s", ".", "-p", "*_test.py"]
        proc = subprocess.run(
            cmd,
            cwd=str(self.workspace_root),
            capture_output=True,
            text=True,
            timeout=30
        )
        return {
            "exit_code": proc.returncode,
            "passed": proc.returncode == 0,
            "stdout": proc.stdout,
            "stderr": proc.stderr
        }


def run_verification():
    print("=== NIRNAYAI AUTONOMOUS CODING AGENT VERIFICATION ===")
    agent = CodingAgent(workspace_root="data/sandbox/coding_project")

    # Step 1: Initialize project with a deliberate defect
    print("[1] Initializing test project with faulty code...")
    faulty_code = (
        "def calculate_total(prices, tax_rate=0.05):\n"
        "    subtotal = sum(prices)\n"
        "    return subtotal - (subtotal * tax_rate)  # BUG: subtracting tax instead of adding\n"
    )
    agent.write_file("calculator.py", faulty_code)

    test_code = (
        "import unittest\n"
        "from calculator import calculate_total\n\n"
        "class TestCalculator(unittest.TestCase):\n"
        "    def test_total_with_tax(self):\n"
        "        result = calculate_total([100, 200], tax_rate=0.10)\n"
        "        self.assertEqual(result, 330.0)\n\n"
        "if __name__ == '__main__':\n"
        "    unittest.main()\n"
    )
    agent.write_file("calculator_test.py", test_code)
    print("✓ Project initialized with calculator.py and calculator_test.py")

    # Step 2: Run tests and assert failure
    print("[2] Running automated tests (expecting failure)...")
    initial_test = agent.run_tests()
    assert not initial_test["passed"], "Test should have failed on deliberate bug!"
    print(f"✓ Initial test failed as expected (Exit code {initial_test['exit_code']})")

    # Step 3: Search symbol & diagnose
    print("[3] Searching symbols in codebase for 'calculate_total'...")
    symbols = agent.search_symbols("calculate_total")
    assert len(symbols) >= 2, "Symbol search failed to locate function!"
    print(f"✓ Located symbol in {len(symbols)} references.")

    # Step 4: Autonomous patch application
    print("[4] Applying autonomous patch to fix tax calculation...")
    fixed_code = (
        "def calculate_total(prices, tax_rate=0.05):\n"
        "    subtotal = sum(prices)\n"
        "    return subtotal + (subtotal * tax_rate)  # FIXED: add tax\n"
    )
    patch_result = agent.write_file("calculator.py", fixed_code)
    print("✓ Diff generated:")
    for line in patch_result["diff"].splitlines():
        print(f"   {line}")

    # Step 5: Re-run tests and assert PASS
    print("[5] Re-running automated tests after patch...")
    fixed_test = agent.run_tests()
    assert fixed_test["passed"], f"Test failed after fix: {fixed_test['stderr']}"
    print("✓ All automated tests PASSED after patch!")

    # Step 6: Test Rollback Guard
    print("[6] Testing rollback capability...")
    agent.rollback("calculator.py")
    rolled_back_content = agent.read_file("calculator.py")
    assert "-" in rolled_back_content and "subtotal - (subtotal * tax_rate)" in rolled_back_content, "Rollback failed!"
    print("✓ Rollback successfully restored previous snapshot state.")

    # Re-apply fix so workspace stays working
    agent.write_file("calculator.py", fixed_code)
    print("\n🎉 ALL AUTONOMOUS CODING AGENT TESTS PASSED WITH 100% SUCCESS!")


if __name__ == "__main__":
    run_verification()
