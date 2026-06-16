# Architecture & Core Idea

> Captured 2026-06-17. The mental model behind this project, worked out with Jake.

## The core realization

OpenClaw (the "lobster" 🦞) and Claude Code are **two different AI runtimes**:

- **OpenClaw** — separate product (v2026.6.6), npm-installed, runs as an always-on
  gateway daemon (Windows Scheduled Task, `localhost:18789`), wired to WhatsApp,
  thinks with **Gemini Flash**. Cheap, persistent, channel-facing, has a persona/SOUL.
- **Claude Code** — Opus/Haiku/Sonnet. Powerful, runs in bursts when triggered.
  Has native tools (browser, files, skills, memory).

They are **neighbors, not nested.** Claude can *operate* OpenClaw via its CLI, but
OpenClaw is not "inside" Claude and vice-versa.

## What OpenClaw uniquely had — and how we replaced each piece

| OpenClaw feature | Claude equivalent | Status |
|---|---|---|
| Cheap to run 24/7 (Gemini Flash) | **Haiku 4.5** — same cost ballpark | ✅ solves cost |
| Browser automation to scrape sites | Claude's **native browser tools** — no setup needed | ✅ already built in |
| Always-listening inbound channel | **Telegram bridge** at `~/.claude/channels/telegram` (bot + allowlist) | ✅ Jake already set this up |
| Persona / SOUL | (not needed for this use case) | n/a |

**Conclusion:** a DIY "OpenClaw on Claude" is not only possible, it's *simpler and
smarter-per-dollar*, because Haiku-in-Claude-Code already has the browser tools that
OpenClaw would need a whole setup project to gain.

## The target architecture

```
Telegram (Jake, from phone)
      ↓   [bot + allowlist — already built at ~/.claude/channels/telegram]
Claude Code on Haiku   ← cheap, always-available worker, full native tools
      ↓
Does the job → replies on Telegram
      +
Cron-scheduled Haiku runs recurring jobs (e.g. BrightHR download) unattended
      +
Claude Opus = plan, harden recipes/skills, fix when something breaks
```

## Division of labor (the operating principle)

- **Opus (me)** — planning, hardening click-paths into reliable recipes, fixing breakage.
- **Haiku** — executing the proven recipe on a schedule or on-demand. Cheap. Follows the
  recipe; escalates when something looks wrong rather than improvising.
- **The lobster (OpenClaw)** — only still needed if a Gemini-based / WhatsApp-native
  front desk is specifically wanted. Otherwise Telegram + Haiku covers it.

## Key nuance: it's "writing a recipe," not "training"

Handing a task to Haiku/the lobster does **not** change the model (no training, no weights).
It's writing a precise **skill** (markdown step-by-step) that the cheap model *follows*.
Brittle if the target site changes — which is why Opus hardens it first and stays on call.

## First concrete use case

Automate BrightHR payroll roster download — see `../CLAUDE.md` and `../TODO.md`.
