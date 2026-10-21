# Step 1 review response (round 1)

1. [important] shopcoffee.gs:31 — ACCEPTED, fixed. Verified: producer `parseSkuSize_` (Engine_Utils.js:650-660) matches only -8K/-1K/-200. `shopCoffeeSizeKg_` now uses an exact-suffix table {-8K,-1K,-200,-PT}. Added SO-DUM-5K/-500/-1000 to the classify cases and the drift-pin table (additive; existing RED cases untouched). `node connectors/gas/test_code.js` → 3340 passed, 0 failed.
2. [minor] no qty > 0 guard — NOT CHANGED. Producer drops qty <= 0 (Engine_ShopCoffeeApi.js:148-149), and the step brief's enumerated cases don't specify it; adding it would be out of scope. The producer is the guard.
3. [minor] committed run logs — NOT CHANGED. Out of the finding scope (hygiene/.gitignore is a separate step); logs are harness output committed by the runner's step commits, not by this fix.
