#!/usr/bin/env python3
"""
Teammate-safe git sync gate. Run before any push.

Mirrors the LEIBLE Order App's pre-deploy-sync.js (added after 2026-06-11 incident).
Fetches origin, rebases if behind, blocks on conflict. Never pushes blind.

Usage:
    python scripts/pre_push_sync.py [branch]   # default: current branch
"""

import subprocess
import sys


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def bold(s):
    return f"\033[1m{s}\033[0m"


def main():
    branch = sys.argv[1] if len(sys.argv) > 1 else None

    if not branch:
        rc, branch, _ = run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
        if rc != 0:
            print(f"{bold('[sync]')} Not in a git repo.")
            sys.exit(1)

    rc, _, err = run(["git", "fetch", "origin", branch, "--quiet"])
    if rc != 0:
        print(f"{bold('[sync]')} Could not reach GitHub: {err.split(chr(10))[0]}")
        print("Push blocked — without syncing you might overwrite a teammate's work.")
        sys.exit(1)

    rc, count_str, _ = run(["git", "rev-list", "--count", f"HEAD..origin/{branch}"])
    if rc != 0:
        print(f"{bold('[sync]')} No remote tracking for origin/{branch} yet — first push, OK to proceed.")
        sys.exit(0)

    behind = int(count_str)
    if behind == 0:
        print(f"{bold('[sync]')} Up to date with origin/{branch}.")
        sys.exit(0)

    s = "s" if behind > 1 else ""
    print(f"{bold('[sync]')} origin/{branch} has {behind} new commit{s} — rebasing...")

    rc, out, err = run(["git", "pull", "--rebase", "--autostash", "origin", branch])
    if rc != 0:
        run(["git", "rebase", "--abort"])
        print(f"{bold('[sync]')} Rebase hit a conflict — push blocked.")
        print("Your changes and a teammate's touch the same lines.")
        print(f"Resolve manually: git pull --rebase origin {branch} → fix conflicts → retry.")
        sys.exit(1)

    if out:
        print(out)
    print(f"{bold('[sync]')} Synced. Safe to push.")


if __name__ == "__main__":
    main()
