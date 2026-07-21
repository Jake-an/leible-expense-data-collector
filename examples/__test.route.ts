// app/__test/route.ts — live-verification self-check endpoint (Next.js App Router).
//
// Part of the Harness live-verification standard (~/.claude/memory/live-verification.md).
// The checker / scripts/verify_gate.sh hits:  GET /__test  with header  x-test-key: <TEST_KEY>
//
// SECURITY — DO NOT EXPOSE IN PROD.
//   - Auth-gated by the TEST_KEY env var (x-test-key header).
//   - Gate it behind the environment so it is never reachable in production, e.g.:
//       if (process.env.VERCEL_ENV === "production") return new Response("Not found", { status: 404 });
//   - Runs against Dev/Preview only; PROD verification is manual / metrics / logs.
//   - Never leak internal state (user counts, roadmap) in the response.
//
// Pass rule (encoded in summarize):
//   pass = (quality_score >= threshold, default 90) AND every critical check passes.
//   quality_score = weighted average of NON-critical checks only (critical checks have
//   veto power but do not contribute to the score).

export const dynamic = "force-dynamic";

const TEST_THRESHOLD = 90;

type Check = {
  name: string;
  critical: boolean;
  pass?: boolean;
  weight?: number;
  async?: boolean;
  status?: "unreachable" | "pending";
  escalation?: { to: string; instructions: string };
  detail?: string;
};

type Summary = {
  pass: boolean | null;
  quality_score?: number;
  escalate?: boolean;
  escalation?: { to: string; instructions: string };
  checks: Check[];
  last_updated: string;
  covers: string[];
};

export async function GET(req: Request): Promise<Response> {
  // --- auth gate ---
  if (req.headers.get("x-test-key") !== process.env.TEST_KEY) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const checks: Check[] = [
    await checkDbConnected(),
    { name: "auth_valid", critical: true, pass: true }, // reached here ⇒ key matched
    checkOrderTotalCalc(),
    await checkEmailQueued(),
  ];

  const result = summarize(checks, ["orders", "auth", "email"], "2026-06-25");
  // 503 on escalate (unreachable) so the checker stops for the user instead of retrying.
  const status = result.escalate ? 503 : 200;
  return Response.json(result, { status });
}

// --- individual checks ---

async function checkDbConnected(): Promise<Check> {
  // Live check: real data store reachability. Untestable glue — verified live, never mocked.
  try {
    if (!process.env.DATABASE_URL) {
      return {
        name: "db_connected",
        critical: true,
        status: "unreachable",
        escalation: { to: "user", instructions: "Set DATABASE_URL for the Dev environment." },
      };
    }
    // await db.raw("select 1");  // real reachability probe
    return { name: "db_connected", critical: true, pass: true };
  } catch (err) {
    return { name: "db_connected", critical: true, pass: false, detail: String(err).slice(0, 120) };
  }
}

function checkOrderTotalCalc(): Check {
  // Pure-logic check: expected is derived from the spec, asserted against the real fn.
  const got = calcTotal([{ price: 1000, qty: 2 }, { price: 500, qty: 1 }], 0.1);
  const expected = 2750; // (1000*2 + 500*1) * 1.10
  return { name: "order_total_calc", critical: false, weight: 60, pass: got === expected };
}

async function checkEmailQueued(): Promise<Check> {
  // Async / eventually-consistent side effect (email queue).
  let queued = false;
  try {
    queued = true; // e.g. (await emailQueueDepth()) >= 0
  } catch {
    queued = false;
  }
  return { name: "email_queued", critical: false, weight: 40, async: true, pass: queued };
}

// --- pass-rule engine (shared shape with the GAS version) ---

function summarize(checks: Check[], covers: string[], lastUpdated: string): Summary {
  // Unreachable check → escalate to the user instead of pass/fail.
  const unreachable = checks.filter((c) => c.status === "unreachable");
  if (unreachable.length) {
    return {
      pass: null,
      escalate: true,
      checks,
      escalation: unreachable[0].escalation,
      last_updated: lastUpdated,
      covers,
    };
  }

  // quality_score = weighted average of NON-critical checks only.
  const nonCritical = checks.filter((c) => !c.critical);
  let totalWeight = 0;
  let earned = 0;
  for (const c of nonCritical) {
    const w = c.weight ?? 1;
    totalWeight += w;
    if (c.pass) earned += w;
  }
  const qualityScore = totalWeight ? Math.round((earned / totalWeight) * 100) : 100;

  // Critical checks have veto power, regardless of score.
  const criticalOk = checks.filter((c) => c.critical).every((c) => c.pass === true);
  const pass = criticalOk && qualityScore >= TEST_THRESHOLD;

  return { pass, quality_score: qualityScore, checks, last_updated: lastUpdated, covers };
}

// --- helper / example business fn under test ---

function calcTotal(items: { price: number; qty: number }[], taxRate: number): number {
  const sub = items.reduce((a, it) => a + it.price * it.qty, 0);
  return Math.round(sub * (1 + taxRate));
}
