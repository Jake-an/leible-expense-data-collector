# Step 3: wholesale-row-mapping

## Requirements Covered

- `PRD-14` — map producer orders onto `Revenue`-tab rows. This function is the **only
  validator on this path**, so it carries every rejection the ingest layer would have.

If the Task below contradicts the requirement, `docs/ADR.md`, or a CRITICAL rule in
CLAUDE.md, set `"status": "needs_context"` with the contradiction spelled out and stop.

## Files to Read

- `connectors/gas/Code.gs` — `normalizeRevenueRow` (`:479-490`), `REVENUE_HEADERS` (`:31`),
  `REVENUE_KEY_COLS = [6,5]` (`:62`), and `validateIngest_`'s `kind==='revenue'` branch
  (`:432-438`) **plus** the `channel:'online'` rejection (`:358-369`).
- `connectors/gas/orderapp.gs` — your step-1 constants.
- `phases/roastery-wholesale/prod-probe.md` — the real order field list and a sample order.
- `docs/schema.md` — the `Revenue` tab section.

## Task

**Read this first, it is the reason the step exists.** `ingestRevenueRows` (`Code.gs:633`)
is reached today only from `doPost`, which runs `validateIngest_` first. A GAS-native
caller bypasses `validateIngest_` **entirely**, and `normalizeRevenueRow` validates
nothing — it is `String()`/`Number()` coercion and nothing else. So every rejection
`docs/ingest-contract.md` attributes to "ingest" does not exist on this path unless you
write it here.

Add the pure function `wholesaleRevenueRows_(orders)` to `connectors/gas/orderapp.gs`:

```
wholesaleRevenueRows_(orders) -> {
  rows:  [ {date, department, channel, customer, amount, order_ref} , … ],
  drops: { unknownShopType:N, badAmount:N, badDate:N, badOrderRef:N, byReason:[…] },
  grossCentsByChannel: { wholesale:N, internal:N, ambiguous:N, unknown:N }   // integer cents
}
```

Mapping — `shopType` → producer bucket → `channel`, via an explicit table, never a default:

| `order.shopType` | producer `summary` bucket | emitted `channel` |
|---|---|---|
| `WHOLESALE` | `external` | `wholesale` |
| `INTERNAL` | `internal` | `internal` |
| `AMBIGUOUS` | `ambiguous` | `ambiguous` |
| `UNKNOWN` | `unknown` | `unknown` |

Export that table as `WHOLESALE_SHOPTYPE_MAP_` so step 4's cross-foot can index the
producer bucket from the emitted channel without re-deriving it.

Per order, in order, dropping and counting rather than throwing:
- `shopType` not a key of the table → drop, `unknownShopType++`. **Never** fall back to
  `wholesale`.
- `order_ref = String(order.orderId).trim()`; empty → drop, `badOrderRef++`.
- `amount = Number(order.amount)`; not finite → drop, `badAmount++`.
- `date = String(order.date).trim()`; must match `/^\d{4}-\d{2}-\d{2}$/` → else drop,
  `badDate++`.
- `customer = String(order.shopId).trim()`; if empty, use the literal
  `'(blank shop id)'` — never `''`, which would produce an invisible `Summary` row.
- `department` is always `'Roastery'`.
- Accumulate `grossCentsByChannel[channel] += Math.round(amount * 100)`.

`drops.byReason` is a short array of `{orderId, reason}` for logging — capped at 20
entries so a mass failure cannot produce an unreadable log blob.

### Test First (TDD step)

Test cases (defined at design time — these are "done"):
- each of the four `shopType` values maps to its channel, `department` is `Roastery`,
  `order_ref` is `orderId`, `customer` is `shopId` (4 cases)
- an unrecognised `shopType` (`'RETAIL'`, `''`, `undefined`, lowercase `'wholesale'`)
  is dropped and counted, and **no row is emitted for it** (4 cases)
- `amount` of `null`, `'342.10'`, `NaN`, `undefined` → dropped, `badAmount` counted
  (4 cases). A numeric string is a DROP here, deliberately — the producer emits numbers.
- `amount` of `0` → **kept**, not dropped. Zero is a finite amount.
- a negative `amount` → kept and counted into `grossCentsByChannel` (credits are real)
- `date` of `'2026-8-3'`, `'03/08/2026'`, `''`, a `Date` object → dropped, `badDate`
  counted (4 cases)
- blank / whitespace-only `shopId` → emitted with customer `'(blank shop id)'`
- blank `orderId` → dropped, `badOrderRef` counted
- **no input can ever produce `channel:'online'`** — feed a `shopType` of `'ONLINE'` and
  an order whose `shopId` is `'online'`, and assert every emitted channel is in the
  whitelist
- `grossCentsByChannel` is integer cents: 12 orders of `342.10` sum to exactly `410520`,
  not a float — assert `Number.isInteger`
- a 250-order mixed fixture with assorted cents values: `grossCentsByChannel.wholesale`
  equals the independently computed integer-cent sum exactly
- `drops.byReason` caps at 20 entries when 50 orders are dropped, while the numeric
  counters still report all 50
- empty input `[]` → `{rows:[], drops all zero, grossCentsByChannel all 0}`

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

## Verification Procedure

1. Run the AC command. Record pass/fail counts.
2. Confirm the function is pure — no `SpreadsheetApp`, `PropertiesService`, `UrlFetchApp`,
   `Logger` inside it.
3. Run the Prohibitions as greps against the diff, not just the tests:
   `grep -n "'online'" ` in the new code must find only the whitelist assertion.
4. Mutation check: make an unrecognised `shopType` default to `wholesale` and confirm
   the 4 unknown-shopType cases red. Revert.
5. Update this step in `phases/roastery-wholesale/index.json`.

## Prohibitions

- Do not emit a `channel` outside `{wholesale, internal, ambiguous, unknown}`, and in
  particular never `online`. Reason: `aggregateSupplierRows_` (`Code.gs:1914-1918`)
  silently **excludes** `channel='online'` revenue rows from the weekly rollup. It would
  not error — the money would simply vanish from `Summary` with one log line.
- Do not default an unrecognised `shopType` to any channel. Reason: defaulting to
  `wholesale` publishes an unclassified (possibly own-cafe) order as external company
  revenue; defaulting to `internal` hides real income. Dropping and alerting is the only
  safe branch.
- Do not throw on a bad order. Reason: one malformed row must not abort a week; the
  counters are what step 4 subtracts in its cross-foot.
- Do not accumulate gross as floats. Reason: step 4 compares to the cent against the
  producer's integer-cent-derived total; float accumulation over hundreds of two-decimal
  values drifts and would fail-closed on every real week.
- Do not call `validateIngest_` from here. Reason: it is `doPost`'s gate and takes a whole
  payload; this path is GAS-native by design (CLAUDE.md — connectors never POST to
  themselves). Re-implement the rules, do not reroute through the HTTP boundary.
- Do not break existing tests.
