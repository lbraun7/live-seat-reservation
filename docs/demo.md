# Demo guide

## Concurrent contention

With the complete stack ready, run:

```bash
./scripts/demo-concurrency.sh
```

The script checks service readiness, runs 100 virtual users against the same seat, and performs an independent PostgreSQL invariant audit. Business conflicts are expected; the persisted result must end with:

```text
PASS: reservation invariants hold; oversold_seats=0 active_hold_collisions=0
```

Results are written to `load-tests/results/`. To record a video or terminal cast, start the capture tool before the script and stop it after the audit; the output contains no credentials.

## Complete purchase flow

Start the stack and define the deterministic IDs created by the seed job:

```bash
docker compose up --build -d

API_URL=http://localhost:3000
EVENT_ID=10000000-0000-4000-8000-000000000001
SECTION_ID=20000000-0000-4000-8000-000000000001
USER_ID=40000000-0000-4000-8000-000000000001
```

### 1. Find an available seat

```bash
curl "$API_URL/events/$EVENT_ID"
curl "$API_URL/events/$EVENT_ID/seats?sectionId=$SECTION_ID&limit=3"
```

Copy the `id` of an `AVAILABLE` seat into `SEAT_ID`.

### 2. Join the waiting room

```bash
curl -X POST "$API_URL/events/$EVENT_ID/waiting-room" \
  -H "x-user-id: $USER_ID"
```

Copy `sessionId` into `SESSION_ID`, then send heartbeats until the response contains a token:

```bash
curl -X POST \
  "$API_URL/events/$EVENT_ID/waiting-room/$SESSION_ID/heartbeat" \
  -H "x-user-id: $USER_ID"
```

Copy the returned token into `ADMISSION_TOKEN`.

### 3. Create an idempotent hold

```bash
curl -i -X POST "$API_URL/events/$EVENT_ID/holds" \
  -H 'content-type: application/json' \
  -H "x-user-id: $USER_ID" \
  -H "x-admission-token: $ADMISSION_TOKEN" \
  -H 'idempotency-key: portfolio-hold-1' \
  -d "{\"seatId\":\"$SEAT_ID\"}"
```

Copy `id` into `HOLD_ID`. Repeating the exact request returns the persisted response with `idempotency-replayed: true`. Reusing the key with another seat returns `IDEMPOTENCY_KEY_REUSED`.

### 4. Start checkout

```bash
curl -X POST "$API_URL/holds/$HOLD_ID/checkout" \
  -H "x-user-id: $USER_ID" \
  -H 'idempotency-key: portfolio-checkout-1'
```

Copy `id` into `PAYMENT_ID` and `providerPaymentId` into `PROVIDER_PAYMENT_ID`. Query the pending payment with:

```bash
curl "$API_URL/payments/$PAYMENT_ID" -H "x-user-id: $USER_ID"
```

### 5. Simulate a successful provider webhook

Generate a provider event and its HMAC signature with the local Compose secret:

```bash
WEBHOOK_EVENT_ID=$(node -e "console.log(crypto.randomUUID())")
OCCURRED_AT=$(node -e "console.log(new Date().toISOString())")
SIGNATURE=$(node -e "const c=require('crypto'); const [,e,p,t,o]=process.argv; console.log(c.createHmac('sha256','local-development-payment-webhook-secret').update([e,p,t,o].join('.')).digest('hex'))" "$WEBHOOK_EVENT_ID" "$PROVIDER_PAYMENT_ID" payment.succeeded "$OCCURRED_AT")

curl -X POST "$API_URL/webhooks/fake-payment" \
  -H 'content-type: application/json' \
  -H "x-payment-signature: $SIGNATURE" \
  -d "{\"eventId\":\"$WEBHOOK_EVENT_ID\",\"providerPaymentId\":\"$PROVIDER_PAYMENT_ID\",\"type\":\"payment.succeeded\",\"occurredAt\":\"$OCCURRED_AT\"}"
```

### 6. Verify the final state

```bash
curl "$API_URL/holds/$HOLD_ID" -H "x-user-id: $USER_ID"
curl "$API_URL/payments/$PAYMENT_ID" -H "x-user-id: $USER_ID"
curl "$API_URL/events/$EVENT_ID/seats?sectionId=$SECTION_ID&limit=500"
```

The expected state is a `CONFIRMED` hold, a `SUCCEEDED` payment, an `orderId`, and a `SOLD` seat.

To exercise the cancellation path, cancel the pending payment before sending the webhook:

```bash
curl -X POST "$API_URL/payments/$PAYMENT_ID/cancel" \
  -H "x-user-id: $USER_ID" \
  -H 'idempotency-key: portfolio-payment-cancel-1'
```
