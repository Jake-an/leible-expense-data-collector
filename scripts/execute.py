#!/usr/bin/env python3
"""
Harness Step Executor — sequentially executes steps within a phase and self-corrects.

Usage:
    python scripts/execute.py <phase-dir> [--push] [--model <alias>] [--no-review]
"""

import argparse
import contextlib
import json
import os
import subprocess
import sys
import threading
import time
import types
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent

# Windows consoles often default to cp1252, which can't print the status glyphs
# (✓ ⏸ ◐) and crashes with UnicodeEncodeError. Force UTF-8, degrade gracefully.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


@contextlib.contextmanager
def progress_indicator(label: str):
    """Terminal progress indicator. Use as a context manager; read elapsed time via .elapsed."""
    frames = "◐◓◑◒"
    stop = threading.Event()
    t0 = time.monotonic()

    def _animate():
        idx = 0
        while not stop.wait(0.12):
            sec = int(time.monotonic() - t0)
            sys.stderr.write(f"\r{frames[idx % len(frames)]} {label} [{sec}s]")
            sys.stderr.flush()
            idx += 1
        sys.stderr.write("\r" + " " * (len(label) + 20) + "\r")
        sys.stderr.flush()

    th = threading.Thread(target=_animate, daemon=True)
    th.start()
    info = types.SimpleNamespace(elapsed=0.0)
    try:
        yield info
    finally:
        stop.set()
        th.join()
        info.elapsed = time.monotonic() - t0


class StepExecutor:
    """Harness that sequentially executes steps inside a phase directory."""

    MAX_RETRIES = 3
    FEAT_MSG = "feat({phase}): step {num} — {name}"
    CHORE_MSG = "chore({phase}): step {num} output"
    TZ = timezone(timedelta(hours=9))
    DEFAULT_MODEL = "sonnet"        # execution steps: plan is locked, favor speed
    REVIEW_MODEL = "opus"           # review gate: judgment-heavy, favor quality
    REVIEW_RESULT_FILE = "review-result.json"

    def __init__(self, phase_dir_name: str, *, auto_push: bool = False,
                 model: Optional[str] = None, skip_review: bool = False):
        self._root = str(ROOT)
        self._phases_dir = ROOT / "phases"
        self._phase_dir = self._phases_dir / phase_dir_name
        self._phase_dir_name = phase_dir_name
        self._top_index_file = self._phases_dir / "index.json"
        self._auto_push = auto_push
        self._cli_model = model
        self._skip_review = skip_review

        if not self._phase_dir.is_dir():
            print(f"ERROR: {self._phase_dir} not found")
            sys.exit(1)

        self._index_file = self._phase_dir / "index.json"
        if not self._index_file.exists():
            print(f"ERROR: {self._index_file} not found")
            sys.exit(1)

        idx = self._read_json(self._index_file)
        self._project = idx.get("project", "project")
        self._phase_name = idx.get("phase", phase_dir_name)
        self._task_model = idx.get("model")
        self._review_cfg = idx.get("review", {})
        self._total = len(idx["steps"])

    def run(self):
        self._print_header()
        self._check_blockers()
        self._checkout_branch()
        guardrails = self._load_guardrails()
        self._ensure_created_at()
        self._execute_all_steps(guardrails)
        self._review_gate()
        self._live_verification_gate()
        self._finalize()

    # --- timestamps ---

    def _stamp(self) -> str:
        return datetime.now(self.TZ).strftime("%Y-%m-%dT%H:%M:%S%z")

    # --- JSON I/O ---

    @staticmethod
    def _read_json(p: Path) -> dict:
        return json.loads(p.read_text(encoding="utf-8"))

    @staticmethod
    def _write_json(p: Path, data: dict):
        p.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    # --- git ---

    def _run_git(self, *args) -> subprocess.CompletedProcess:
        cmd = ["git"] + list(args)
        return subprocess.run(cmd, cwd=self._root, capture_output=True, text=True)

    def _checkout_branch(self):
        branch = f"feat-{self._phase_name}"

        r = self._run_git("rev-parse", "--abbrev-ref", "HEAD")
        if r.returncode != 0:
            print(f"  ERROR: git is unavailable or this is not a git repository.")
            print(f"  {r.stderr.strip()}")
            sys.exit(1)

        if r.stdout.strip() == branch:
            return

        r = self._run_git("rev-parse", "--verify", branch)
        r = self._run_git("checkout", branch) if r.returncode == 0 else self._run_git("checkout", "-b", branch)

        if r.returncode != 0:
            print(f"  ERROR: Failed to checkout branch '{branch}'.")
            print(f"  {r.stderr.strip()}")
            print(f"  Hint: Stash or commit your changes and try again.")
            sys.exit(1)

        print(f"  Branch: {branch}")

    def _commit_step(self, step_num: int, step_name: str):
        output_rel = f"phases/{self._phase_dir_name}/step{step_num}-output.json"
        index_rel = f"phases/{self._phase_dir_name}/index.json"

        self._run_git("add", "-A")
        self._run_git("reset", "HEAD", "--", output_rel)
        self._run_git("reset", "HEAD", "--", index_rel)

        if self._run_git("diff", "--cached", "--quiet").returncode != 0:
            msg = self.FEAT_MSG.format(phase=self._phase_name, num=step_num, name=step_name)
            r = self._run_git("commit", "-m", msg)
            if r.returncode == 0:
                print(f"  Commit: {msg}")
            else:
                print(f"  WARN: Code commit failed: {r.stderr.strip()}")

        self._run_git("add", "-A")
        if self._run_git("diff", "--cached", "--quiet").returncode != 0:
            msg = self.CHORE_MSG.format(phase=self._phase_name, num=step_num)
            r = self._run_git("commit", "-m", msg)
            if r.returncode != 0:
                print(f"  WARN: Housekeeping commit failed: {r.stderr.strip()}")

    # --- top-level index ---

    def _update_top_index(self, status: str):
        if not self._top_index_file.exists():
            return
        top = self._read_json(self._top_index_file)
        ts = self._stamp()
        for phase in top.get("phases", []):
            if phase.get("dir") == self._phase_dir_name:
                phase["status"] = status
                ts_key = {"completed": "completed_at", "error": "failed_at", "blocked": "blocked_at"}.get(status)
                if ts_key:
                    phase[ts_key] = ts
                break
        self._write_json(self._top_index_file, top)

    # --- guardrails & context ---

    def _load_guardrails(self) -> str:
        sections = []
        claude_md = ROOT / "CLAUDE.md"
        if claude_md.exists():
            sections.append(f"## Project Rules (CLAUDE.md)\n\n{claude_md.read_text(encoding='utf-8')}")
        docs_dir = ROOT / "docs"
        if docs_dir.is_dir():
            for doc in sorted(docs_dir.glob("*.md")):
                sections.append(f"## {doc.stem}\n\n{doc.read_text(encoding='utf-8')}")
        return "\n\n---\n\n".join(sections) if sections else ""

    @staticmethod
    def _build_step_context(index: dict) -> str:
        lines = [
            f"- Step {s['step']} ({s['name']}): {s['summary']}"
            for s in index["steps"]
            if s["status"] == "completed" and s.get("summary")
        ]
        if not lines:
            return ""
        return "## Previous Step Outputs\n\n" + "\n".join(lines) + "\n\n"

    def _build_preamble(self, guardrails: str, step_context: str,
                        prev_error: Optional[str] = None) -> str:
        commit_example = self.FEAT_MSG.format(
            phase=self._phase_name, num="N", name="<step-name>"
        )
        retry_section = ""
        if prev_error:
            retry_section = (
                f"\n## ⚠ Previous Attempt Failed — You MUST address the error below\n\n"
                f"{prev_error}\n\n---\n\n"
            )
        return (
            f"You are a developer on the {self._project} project. Complete the step below.\n\n"
            f"{guardrails}\n\n---\n\n"
            f"{step_context}{retry_section}"
            f"## Work Rules\n\n"
            f"1. Review code written in previous steps and maintain consistency.\n"
            f"2. Only perform the work specified in this step. Do not create additional features or files.\n"
            f"3. Do not break existing tests.\n"
            f"4. Run the AC (Acceptance Criteria) verification yourself.\n"
            f"5. Update the step status in /phases/{self._phase_dir_name}/index.json:\n"
            f"   - AC passes → \"completed\" + summarize this step's output in the \"summary\" field\n"
            f"   - Still failing after {self.MAX_RETRIES} fix attempts → \"error\" + record in \"error_message\"\n"
            f"   - User intervention required (API keys, auth, manual setup, etc.) → \"blocked\" + record in \"blocked_reason\" then stop immediately\n"
            f"6. Commit all changes:\n"
            f"   {commit_example}\n\n---\n\n"
        )

    # --- Claude invocation ---

    def _resolve_model(self, step: dict) -> str:
        """Model precedence: CLI --model > step 'model' > task 'model' > default (sonnet)."""
        return self._cli_model or step.get("model") or self._task_model or self.DEFAULT_MODEL

    def _run_claude(self, prompt: str, model: str, timeout: int = 1800) -> subprocess.CompletedProcess:
        # Prompt goes via stdin: guardrail-laden prompts exceed Windows' ~32k argv limit.
        return subprocess.run(
            ["claude", "-p", "--dangerously-skip-permissions", "--output-format", "json",
             "--model", model],
            input=prompt, cwd=self._root, capture_output=True, text=True,
            encoding="utf-8", timeout=timeout,
        )

    def _invoke_claude(self, step: dict, preamble: str) -> dict:
        step_num, step_name = step["step"], step["name"]
        step_file = self._phase_dir / f"step{step_num}.md"

        if not step_file.exists():
            print(f"  ERROR: {step_file} not found")
            sys.exit(1)

        prompt = preamble + step_file.read_text(encoding="utf-8")
        result = self._run_claude(prompt, self._resolve_model(step))

        if result.returncode != 0:
            print(f"\n  WARN: Claude exited abnormally (code {result.returncode})")
            if result.stderr:
                print(f"  stderr: {result.stderr[:500]}")

        output = {
            "step": step_num, "name": step_name,
            "exitCode": result.returncode,
            "stdout": result.stdout, "stderr": result.stderr,
        }
        out_path = self._phase_dir / f"step{step_num}-output.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        return output

    # --- header & validation ---

    def _print_header(self):
        print(f"\n{'='*60}")
        print(f"  Harness Step Executor")
        print(f"  Phase: {self._phase_name} | Steps: {self._total}")
        if self._auto_push:
            print(f"  Auto-push: enabled")
        print(f"{'='*60}")

    def _check_blockers(self):
        index = self._read_json(self._index_file)
        for s in reversed(index["steps"]):
            if s["status"] == "error":
                print(f"\n  ✗ Step {s['step']} ({s['name']}) failed.")
                print(f"  Error: {s.get('error_message', 'unknown')}")
                print(f"  Fix and reset status to 'pending' to retry.")
                sys.exit(1)
            if s["status"] == "blocked":
                print(f"\n  ⏸ Step {s['step']} ({s['name']}) blocked.")
                print(f"  Reason: {s.get('blocked_reason', 'unknown')}")
                print(f"  Resolve and reset status to 'pending' to retry.")
                sys.exit(2)
            if s["status"] != "pending":
                break

    def _ensure_created_at(self):
        index = self._read_json(self._index_file)
        if "created_at" not in index:
            index["created_at"] = self._stamp()
            self._write_json(self._index_file, index)

    # --- execution loop ---

    def _execute_single_step(self, step: dict, guardrails: str) -> bool:
        """Execute a single step (with retries). Returns True on completion, False on failure/block."""
        step_num, step_name = step["step"], step["name"]
        done = sum(1 for s in self._read_json(self._index_file)["steps"] if s["status"] == "completed")
        prev_error = None

        for attempt in range(1, self.MAX_RETRIES + 1):
            index = self._read_json(self._index_file)
            step_context = self._build_step_context(index)
            preamble = self._build_preamble(guardrails, step_context, prev_error)

            tag = f"Step {step_num}/{self._total - 1} ({done} done): {step_name}"
            if attempt > 1:
                tag += f" [retry {attempt}/{self.MAX_RETRIES}]"

            with progress_indicator(tag) as pi:
                self._invoke_claude(step, preamble)
                elapsed = int(pi.elapsed)

            index = self._read_json(self._index_file)
            status = next((s.get("status", "pending") for s in index["steps"] if s["step"] == step_num), "pending")
            ts = self._stamp()

            if status == "completed":
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["completed_at"] = ts
                self._write_json(self._index_file, index)
                self._commit_step(step_num, step_name)
                print(f"  ✓ Step {step_num}: {step_name} [{elapsed}s]")
                return True

            if status == "blocked":
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["blocked_at"] = ts
                self._write_json(self._index_file, index)
                reason = next((s.get("blocked_reason", "") for s in index["steps"] if s["step"] == step_num), "")
                print(f"  ⏸ Step {step_num}: {step_name} blocked [{elapsed}s]")
                print(f"    Reason: {reason}")
                self._update_top_index("blocked")
                sys.exit(2)

            err_msg = next(
                (s.get("error_message", "Step did not update status") for s in index["steps"] if s["step"] == step_num),
                "Step did not update status",
            )

            if attempt < self.MAX_RETRIES:
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["status"] = "pending"
                        s.pop("error_message", None)
                self._write_json(self._index_file, index)
                prev_error = err_msg
                print(f"  ↻ Step {step_num}: retry {attempt}/{self.MAX_RETRIES} — {err_msg}")
            else:
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["status"] = "error"
                        s["error_message"] = f"[Failed after {self.MAX_RETRIES} attempts] {err_msg}"
                        s["failed_at"] = ts
                self._write_json(self._index_file, index)
                self._commit_step(step_num, step_name)
                print(f"  ✗ Step {step_num}: {step_name} failed after {self.MAX_RETRIES} attempts [{elapsed}s]")
                print(f"    Error: {err_msg}")
                self._update_top_index("error")
                sys.exit(1)

        return False  # unreachable

    def _execute_all_steps(self, guardrails: str):
        while True:
            index = self._read_json(self._index_file)
            pending = next((s for s in index["steps"] if s["status"] == "pending"), None)
            if pending is None:
                print("\n  All steps completed!")
                return

            step_num = pending["step"]
            for s in index["steps"]:
                if s["step"] == step_num and "started_at" not in s:
                    s["started_at"] = self._stamp()
                    self._write_json(self._index_file, index)
                    break

            self._execute_single_step(pending, guardrails)

    # --- review gate (phase gate, runs after all steps, before live verification) ---

    def _resolve_review_base(self, base: str) -> Optional[str]:
        for candidate in (base, "master"):
            if self._run_git("rev-parse", "--verify", candidate).returncode == 0:
                return candidate
        return None

    def _build_review_prompt(self, base: str, model: str) -> str:
        result_rel = f"phases/{self._phase_dir_name}/{self.REVIEW_RESULT_FILE}"
        return (
            f"You are an independent code reviewer for the {self._project} project. "
            f"Phase '{self._phase_name}' just completed on this branch. You did not write this code.\n\n"
            f"1. Run `git diff {base}...HEAD` and read the changed files as needed for context.\n"
            f"2. Review for:\n"
            f"   - Correctness bugs (logic errors, edge cases, race conditions)\n"
            f"   - Security issues (injection, secrets in code, missing auth)\n"
            f"   - Silent failures (swallowed errors, bad fallbacks, missing error propagation)\n"
            f"   - Architecture drift vs docs/ARCHITECTURE.md, docs/ADR.md, and CLAUDE.md CRITICAL rules\n"
            f"   - UNTESTED LOGIC: business rules, data transforms, or handlers added without tests "
            f"(audit the tdd:false escape hatch — flag logic that snuck into 'scaffolding' steps)\n"
            f"3. Do NOT modify any code. Review only.\n"
            f"4. Write your verdict to {result_rel} as JSON:\n"
            f'   {{"verdict": "approve" | "revise", "issues": '
            f'[{{"severity": "critical|major|minor", "file": "...", "summary": "..."}}]}}\n'
            f"   Use \"revise\" only when there is at least one critical or major issue. "
            f"List minor issues but still approve.\n"
        )

    def _read_review_result(self) -> Optional[dict]:
        p = self._phase_dir / self.REVIEW_RESULT_FILE
        if not p.exists():
            return None
        try:
            data = self._read_json(p)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        return data if data.get("verdict") in ("approve", "revise") else None

    def _review_gate(self):
        if self._skip_review or self._review_cfg is False:
            print("  · Review gate: disabled — skipping.")
            return
        cfg = self._review_cfg if isinstance(self._review_cfg, dict) else {}

        base = self._resolve_review_base(cfg.get("base", "main"))
        if base is None:
            print("  · Review gate: no base branch (main/master) — skipping.")
            return
        diff = self._run_git("diff", f"{base}...HEAD")
        if diff.returncode != 0 or not diff.stdout.strip():
            print("  · Review gate: no diff vs base — skipping.")
            return

        print("\n  ── Review gate ──")
        model = cfg.get("model", self.REVIEW_MODEL)
        (self._phase_dir / self.REVIEW_RESULT_FILE).unlink(missing_ok=True)
        prompt = self._build_review_prompt(base, model)

        result = None
        for attempt in (1, 2):
            with progress_indicator(f"Review ({model}, attempt {attempt}/2)") as pi:
                self._run_claude(prompt, model)
            result = self._read_review_result()
            if result:
                break

        index = self._read_json(self._index_file)
        ts = self._stamp()

        if result is None:
            index["review_result"] = {"verdict": "unavailable", "checked_at": ts}
            self._write_json(self._index_file, index)
            print("  ⏸ Review gate: reviewer produced no valid verdict — needs you.")
            self._update_top_index("blocked")
            sys.exit(2)

        result["checked_at"] = ts
        index["review_result"] = result
        self._write_json(self._index_file, index)
        issues = result.get("issues", [])

        if result["verdict"] == "approve":
            note = f" ({len(issues)} minor issue(s) noted)" if issues else ""
            print(f"  ✓ Review gate passed{note}")
            return

        print(f"  ✗ Review gate: REVISE — {len(issues)} issue(s):")
        for i in issues:
            print(f"    [{i.get('severity', '?')}] {i.get('file', '?')}: {i.get('summary', '')}")
        print("    Fix the issues, reset, and re-run. Finalize/push blocked.")
        self._update_top_index("error")
        sys.exit(1)

    # --- live verification gate (phase gate, runs after all steps, before finalize) ---

    @staticmethod
    def _http_get_json(url: str, headers: dict, timeout: float) -> dict:
        req = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    @staticmethod
    def _eval_verdict(data: dict, threshold: int) -> tuple:
        """Map a /__test response to (verdict, reason).

        verdict ∈ {"pass", "fail", "retry", "escalate"}.
        Pass rule: quality_score >= threshold AND every critical check passes.
        A failure is "retry" only when the failing checks are async/pending
        (eventual consistency); otherwise it is decisive ("fail") and stops early.
        Unreachable checks → "escalate" (needs the user, not a failure).
        """
        checks = data.get("checks", [])
        unreachable = [c for c in checks if c.get("status") == "unreachable"]
        if data.get("escalate") or unreachable:
            names = ", ".join(c.get("name", "?") for c in unreachable) or "see response"
            return ("escalate", f"unreachable check(s): {names}")

        failed_critical = [c for c in checks if c.get("critical") and not c.get("pass", False)]
        if failed_critical:
            retryable = all(c.get("async") for c in failed_critical)
            names = ", ".join(c.get("name", "?") for c in failed_critical)
            return (("retry" if retryable else "fail"), f"critical check(s) failed: {names}")

        score = data.get("quality_score", data.get("score", 0))
        if score < threshold:
            pending = any(c.get("async") or c.get("status") == "pending"
                          for c in checks if not c.get("pass", False))
            return (("retry" if pending else "fail"), f"quality_score {score} < {threshold}")

        return ("pass", "")

    def _build_test_url(self, cfg: dict) -> tuple:
        """Apply the auth key (from env) as a query param or header. Never log the key."""
        url, headers = cfg["test_url"], {}
        auth = cfg.get("auth") or {}
        key = os.environ.get(auth["env"]) if auth.get("env") else None
        if key:
            if auth.get("header"):
                headers[auth["header"]] = key
            else:
                sep = "&" if "?" in url else "?"
                url = f"{url}{sep}{auth.get('query_param', 'key')}={key}"
        return url, headers

    def _run_probe(self, probe: dict, headers: dict, timeout: float) -> tuple:
        """Independent anti-false-pass probe: real feature endpoint vs committed expectation."""
        try:
            actual = self._http_get_json(probe["url"], headers, timeout)
        except Exception as e:
            return (False, f"probe request failed: {e}")
        expect_path = ROOT / probe["expect_file"]
        if not expect_path.exists():
            return (False, f"expected file missing: {probe['expect_file']}")
        expected = json.loads(expect_path.read_text(encoding="utf-8"))
        if actual != expected:
            return (False, "probe response did not match committed expectation")
        return (True, "")

    def _record_verify(self, index: dict, result: dict):
        index["verify_result"] = result
        self._write_json(self._index_file, index)

    def _live_verification_gate(self):
        index = self._read_json(self._index_file)
        cfg = index.get("verify")
        if not cfg or not cfg.get("test_url"):
            print("  · Live-verification: no 'verify' config — skipping gate.")
            return

        threshold = cfg.get("pass_threshold", 90)
        max_attempts = cfg.get("max_attempts", 5)
        wall_clock_ms = cfg.get("wall_clock_ms", 300000)
        http_timeout = cfg.get("http_timeout_s", 30)

        print("\n  ── Live-verification gate ──")

        # 1. Deploy to Dev (optional — assumes already deployed if omitted)
        deploy = cfg.get("deploy")
        if deploy:
            with progress_indicator(f"Deploy: {deploy}"):
                r = subprocess.run(deploy, cwd=self._root, shell=True,
                                   capture_output=True, text=True, timeout=600)
            if r.returncode != 0:
                self._record_verify(index, {"pass": False, "reason": "deploy failed",
                                            "checked_at": self._stamp()})
                print(f"  ✗ Deploy failed: {r.stderr.strip()[:300]}")
                self._update_top_index("error")
                sys.exit(1)
            print("  ✓ Deployed to Dev")

        # 2. Hit /__test, score the rubric (bounded by attempts + wall-clock)
        url, headers = self._build_test_url(cfg)
        deadline = time.monotonic() + wall_clock_ms / 1000.0
        verdict, reason, attempts_used, data = "fail", "no attempts made", 0, {}

        for attempt in range(1, max_attempts + 1):
            if time.monotonic() > deadline:
                verdict, reason = "fail", f"wall-clock cap ({wall_clock_ms}ms) exceeded"
                break
            attempts_used = attempt
            try:
                data = self._http_get_json(url, headers, http_timeout)
            except Exception as e:
                verdict, reason = "retry", f"/__test request failed: {e}"
                time.sleep(min(2 ** attempt, 15))
                continue

            verdict, reason = self._eval_verdict(data, threshold)
            if verdict == "escalate":
                self._record_verify(index, {"pass": None, "escalate": True, "reason": reason,
                                            "attempts": attempt, "checked_at": self._stamp()})
                print(f"  ⏸ Live-verification needs you: {reason}")
                self._update_top_index("blocked")
                sys.exit(2)
            if verdict in ("pass", "fail"):  # decisive — stop early
                break
            time.sleep(min(2 ** attempt, 15))  # retry (async/pending)

        passed = verdict == "pass"

        # 3. Independent probe (anti-false-pass) — only if the suite passed
        if passed and cfg.get("probe"):
            ok, preason = self._run_probe(cfg["probe"], headers, http_timeout)
            if not ok:
                passed, reason = False, f"independent probe failed: {preason}"

        score = data.get("quality_score", data.get("score"))
        self._record_verify(index, {
            "pass": passed, "quality_score": score, "attempts": attempts_used,
            "reason": "" if passed else reason, "checked_at": self._stamp(),
        })

        if passed:
            print(f"  ✓ Live-verification passed (score {score}, {attempts_used} attempt(s))")
            return

        print(f"  ✗ Live-verification failed: {reason}")
        print("    Fix, then reset and re-run. Finalize/push blocked.")
        self._update_top_index("error")
        sys.exit(1)

    def _finalize(self):
        index = self._read_json(self._index_file)
        index["completed_at"] = self._stamp()
        self._write_json(self._index_file, index)
        self._update_top_index("completed")

        self._run_git("add", "-A")
        if self._run_git("diff", "--cached", "--quiet").returncode != 0:
            msg = f"chore({self._phase_name}): mark phase completed"
            r = self._run_git("commit", "-m", msg)
            if r.returncode == 0:
                print(f"  ✓ {msg}")

        if self._auto_push:
            branch = f"feat-{self._phase_name}"
            r = self._run_git("push", "-u", "origin", branch)
            if r.returncode != 0:
                print(f"\n  ERROR: git push failed: {r.stderr.strip()}")
                sys.exit(1)
            print(f"  ✓ Pushed to origin/{branch}")

        print(f"\n{'='*60}")
        print(f"  Phase '{self._phase_name}' completed!")
        print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(description="Harness Step Executor")
    parser.add_argument("phase_dir", help="Phase directory name (e.g. 0-mvp)")
    parser.add_argument("--push", action="store_true", help="Push branch after completion")
    parser.add_argument("--model", help="Override model for all steps (default: per-step/task config, else sonnet)")
    parser.add_argument("--no-review", action="store_true", help="Skip the phase-end review gate")
    args = parser.parse_args()

    StepExecutor(args.phase_dir, auto_push=args.push, model=args.model,
                 skip_review=args.no_review).run()


if __name__ == "__main__":
    main()
