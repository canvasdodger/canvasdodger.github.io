// supabase/functions/initiate-topup/index.ts
// Deno Edge Function — initiates a Ghana Mobile Money top-up via Paystack.
//
// Flow:
//   1. Client posts { amount_ghs, provider ('mtn'|'telecel'), phone }
//   2. This function calls Paystack /transaction/initialize (server-side secret key)
//   3. Inserts a pending coin_topups row (service role bypasses RLS)
//   4. Returns Paystack authorization_url + reference to the client
//   5. Client redirects user to Paystack to complete MoMo on their phone
//   6. Paystack POSTs webhook to /functions/v1/topup-webhook → credits coins
//
// DEPLOY:
//   supabase secrets set PAYSTACK_SECRET_KEY=sk_live_...
//   supabase functions deploy initiate-topup

const PAYSTACK_BASE = "https://api.paystack.co";
const SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 1 GH₵ = 100 ◈ coins (configurable)
const COINS_PER_GHS = 100;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function paystackInitialize(amountGhs: number, provider: string, phone: string, email: string, reference: string) {
  const amountPesewas = amountGhs * 100; // Paystack uses kobo/pesewas (minor unit)
  const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountPesewas,
      currency: "GHS",
      channels: ["mobile_money"],
      email,
      reference,
      callback_url: `${SUPABASE_URL}/functions/v1/topup-webhook`,
      metadata: {
        provider,
        phone,
        purpose: "canvas_dodger_coin_topup",
      },
      mobile_money: {
        phone,
        provider,
      },
    }),
  });
  const body = await res.json();
  return { ok: res.ok, body, status: res.status };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  if (!SECRET_KEY) {
    return json({ error: "PAYSTACK_SECRET_KEY not configured" }, 500);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }

  const { amount_ghs, provider, phone, email, callsign } = payload;

  if (!amount_ghs || amount_ghs < 1 || amount_ghs > 10000) {
    return json({ error: "amount_ghs must be between 1 and 10000" }, 400);
  }
  if (!provider || !["mtn", "telecel"].includes(provider)) {
    return json({ error: "provider must be 'mtn' or 'telecel'" }, 400);
  }
  if (!phone) {
    return json({ error: "phone is required" }, 400);
  }

  // Normalize phone: ensure it starts with country code for Paystack
  let normalizedPhone = String(phone);
  if (!normalizedPhone.startsWith("233")) {
    if (normalizedPhone.startsWith("0")) normalizedPhone = "233" + normalizedPhone.slice(1);
    else normalizedPhone = "233" + normalizedPhone;
  }

  const reference = `CD_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // Call Paystack to initialize the transaction
  const ps = await paystackInitialize(amount_ghs, provider, normalizedPhone, email || `${callsign || "pilot"}@canvasdodger.local`, reference);
  if (!ps.ok) {
    return json({ error: "paystack initialization failed", detail: ps.body }, ps.status || 502);
  }

  const data = ps.body.data || {};
  const accessCode = data.access_code || null;
  const authUrl = data.authorization_url || null;

  // Insert pending coin_topups row (service role bypasses RLS)
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/coin_topups`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      callsign: callsign || "",
      amount_ghs,
      provider,
      status: "pending",
      reference,
      access_code: accessCode || null,
      coins_awarded: amount_ghs * COINS_PER_GHS,
    }),
  });

  if (!insertRes.ok) {
    const errText = await insertRes.text();
    return json({ error: "failed to record top-up", detail: errText }, 500);
  }

  return json({
    ok: true,
    reference,
    authorization_url: authUrl,
    access_code: accessCode,
    amount_ghs,
    provider,
    coins_awarded: amount_ghs * COINS_PER_GHS,
  });
});