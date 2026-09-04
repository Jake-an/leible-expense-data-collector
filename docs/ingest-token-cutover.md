# Per-connector ingest tokens — cutover runbook

**Load when:** performing the one-time cutover to per-source `doPost` tokens, or
rotating/revoking one connector's ingest token afterwards.

Contains **no secrets**. The generated values live in
`credentials/ingest-tokens-2026-09-04.txt` (gitignored).

---

## What changed, and why one sitting

Before, `doPost` required **one shared token**. That is authentication only — it
proves the caller holds a secret, not that it may claim the `source` it wrote in
the body. `upsertRows_` keys on `source` + `invoice_ref`, so any token holder
could POST `source: "square"` and **overwrite Square's real rows in place**, or
swing the headline `LEIBLE_GM_COST_MONITOR` reads every Monday 08:00.

```
  BEFORE                                AFTER
  ------                                -----
  connector ──token──┐                  food_dairy_co ──INGEST_TOKEN_FOOD_DAIRY_CO──┐
  attacker  ──token──┤                  ordermentum   ──INGEST_TOKEN_ORDERMENTUM────┤
                     │                  shopspend     ──INGEST_TOKEN_SHOPSPEND──────┤
                     ▼                  attacker      ──(no token for any source)───┤
            ┌────────────────┐                                                      ▼
            │ checkReadToken_│                                    ┌─────────────────────────────┐
            │  token == ?    │                                    │      checkIngestToken_      │
            └───────┬────────┘                                    │ 1. source in INGEST_SOURCES_│
                    │ ok                                          │ 2. its property is set      │
                    ▼                                             │ 3. token matches THAT one   │
        writes as ANY source it likes                             └──────────────┬──────────────┘
        (square, mayers, greenbean, …)                                           │ ok
                                                                                 ▼
                                                              writes ONLY as the source it owns
```

The GAS side and the connector side **must land together**. A deploy without the
`.env` values stops every connector; `.env` values without the deploy are simply
ignored. There is deliberately **no legacy branch** — a valid `API_READ_TOKEN`
buys nothing on `doPost` — so there is no window where the old and new worlds
overlap. Hence: one sitting, Jake at the keyboard.

Three connectors run **unattended** on Task Scheduler (`LEIBLE Expense - Food and
Dairy Co`, `- Fresh and Chill`, `- Ordermentum`) and the staleness alert is
currently **blind** (Calendar OAuth scope missing, see `TODO.md`). A broken
ingest would therefore go unnoticed. Step 5 below is not optional.

---

## Cutover, in order

**1. Confirm the code is committed and the suites are green.**

```bash
git log --oneline -1
bash scripts/lint.sh && python -m pytest -q && node connectors/gas/test_code.js
```

**2. Set five Script Properties.** Apps Script editor → ⚙ Project Settings →
Script Properties → Add. Names and values are in
`credentials/ingest-tokens-2026-09-04.txt`.

| Property | Covers |
|---|---|
| `INGEST_TOKEN_FOOD_DAIRY_CO` | `food_dairy_co` |
| `INGEST_TOKEN_FRESH_AND_CHILL` | `fresh_and_chill` |
| `INGEST_TOKEN_KENT_PAPER` | `kent_paper` |
| `INGEST_TOKEN_ORDERMENTUM` | `ordermentum` |
| `INGEST_TOKEN_SHOPSPEND` | `shopspend` **and** `shopspend-backfill` |

Leave `API_READ_TOKEN` **exactly as it is** — it is still the `doGet` read
secret and is used by `connectors/shopspend/client.py`. Do not create
`INGEST_TOKEN_COFFEE_ORDER_APP`: no producer POSTs as that source, so an unset
property is the correct (fail-closed) state.

> The properties UI clips long values on paste. These are 32 hex characters —
> short enough that it should not bite — but **retype rather than debug** if a
> value looks wrong afterwards.

**3. Add the same five lines to repo-root `.env`.** Same names, same values.
Also add them to `.env.example` with empty values, so a fresh clone knows they
exist.

**4. Deploy.**

```bash
bash scripts/deploy.sh
```

**5. Prove every token authenticates — BEFORE walking away.**

```bash
python scripts/verify_ingest_tokens.py
```

> ⚠ **`--dry-run` does NOT verify auth.** `base_connector.py:351` returns the
> dry-run report *before* `post()`, so the ingest token is never resolved and
> never sent. A green `--dry-run` says nothing about whether the cutover worked.
> That is what `verify_ingest_tokens.py` exists for.

It POSTs a correctly-authenticated but deliberately invalid payload (no
`extracted_at`) to each source. Because doPost checks auth *before*
`validateIngest_`, the two outcomes are unambiguous — `UNAUTHORIZED` means the
token is wrong, `missing extracted_at` means auth passed. Nothing is written, no
heartbeat is stamped, no browser or portal session is needed. It then confirms
the fix is live by spoofing `square`/`mayers`/`greenbean`/`shopify_orderapp`
with a real connector token; each must be refused.

Diagnosing a failure: `… is not set in .env` means step 3 was missed for that
connector. `UNAUTHORIZED` means step 2's value and step 3's value differ, or the
deploy in step 4 did not take. `spoof … NOT REFUSED` means the hub is still
running the old shared-token build — step 4 did not take.

Optionally follow with one real connector run. A re-post of invoices already in
the Sheet dedups to `rowsAdded: 0`, so it costs nothing and exercises the whole
path:

```bash
python connectors/playwright/food_dairy_co.py
```

**6. Only then leave it to the scheduler.** If step 5 cannot be made to pass,
roll back the deploy — the spoofing hole reopens, but nothing is silently
broken, which is the worse failure.

---

## Diagnosing an `UNAUTHORIZED` afterwards

The response is **uniform on purpose** — `{"result":"error","code":"UNAUTHORIZED",
"message":"unauthorized"}` — so an anonymous caller holding the committed `/exec`
URL gets no source-enumeration oracle. Which of the four checks failed is written
to the **GAS execution log**:

```
doPost UNAUTHORIZED: <reason> (source="<claimed source>")
```

Apps Script editor → Executions. The four reasons are: source not in
`INGEST_SOURCES_`; the property is not set; no token on the payload; token does
not match the property.

## Rotating or revoking one connector

Because it is one property per source, each is independent:

- **Rotate:** generate a new value, paste it into the Script Property and `.env`
  together, then re-run `python scripts/verify_ingest_tokens.py` (NOT `--dry-run`,
  which never resolves the token). No other connector is touched.
- **Revoke:** delete the Script Property. That source fails closed immediately;
  everything else keeps ingesting. Revoking `INGEST_TOKEN_SHOPSPEND` revokes
  `shopspend-backfill` too — they share one credential by design.

## Adding a connector later

Adding a property alone does nothing: `INGEST_SOURCES_` in
`connectors/gas/Code.gs` is the allowlist and is checked first, so a new source
needs a **code change plus a deploy**. That is deliberate — it keeps the security
boundary in reviewed code rather than in the properties UI.
