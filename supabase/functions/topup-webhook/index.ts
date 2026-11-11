// supabase/functions/topup-webhook/index.ts
// Deno Edge Function — Paystack webhook for GH₵ coin top-ups.
//
// Paystack POSTs here when a customer completes (or fails) a Mobile Money
// transaction. We verify the signature, find the matching coin_topups row by
// reference, mark it success/failed, and award ◈ coins to the pilot's passport.
//
// DEPLOY:
//   supabase secrets set PAYSTACK_SECRET_KEY=sk_live_...
//   supabase functions deploy topup-webhook
//   Then add this URL as your Paystack webhook:
//     https://<project-ref>.supabase.co/functions/v1/topup-webhook

import { createHmac } from "https://deno.land/std@0.224.0/crypto/mod.ts";

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Verify Paystack webhook signature (HMAC-SHA512 of raw body using secret key)
function verifySignature(secret: string, signature: string, body: string): boolean {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["verify"]
    );
    const sigBuf = new Uint8Array(signature.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
    const bodyBuf = new TextEncoder().encode(body);
    return crypto.subtle.verify("HMAC", key, sigBuf, bodyBuf);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const signature = req.headers.get("x-paystack-signature") || "";
  const rawBody = await req.text();

  if (!PAYSTACK_SECRET_KEY) {
    return json({ error: "PAYSTACK_SECRET_KEY not configured" }, 500);
  }

  if (!signature || !verifySignature(PAYSTACK_SECRET_KEY, signature, rawBody)) {
    return json({ error: "invalid signature" }, 401);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const eventType = event.event;
  const data = event.data || {};

  // We only care about successful charges
  if (eventType !== "charge.success") {
    return json({ ok: true, skipped: eventType });
  }

  const reference = data.reference;
  const status = data.status;
  const amount = data.amount; // in pesewas (minor unit)
  const metadata = data.metadata || {};

  if (!reference) {
    return json({ error: "no reference" }, 400);
  }

  // Find the pending top-up row by reference
  const lookupRes = await fetch(
    `${SUPABASE_URL}/rest/v1/coin_topups?reference=eq.${encodeURIComponent(reference)}&select=id,user_id,callsign,amount_ghs,status,coins_awarded`,
    {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!lookupRes.ok) {
    return json({ error: "failed to look up top-up" }, 500);
  }
  const rows: any[] = await lookupRes.json();
  if (rows.length === 0) {
    return json({ error: "top-up not found" }, 404);
  }

  const row = rows[0];
  if (row.status === "success") {
    return json({ ok: true, already: "success" }); // idempotent
  }

  // Mark the top-up as success
  const updateRes = await fetch(
    `${SUPABASE_URL}/rest/v1/coin_topups?id=eq.${row.id}`,
    {
      method: "PATCH",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        status: "success",
        updated_at: (extractEpochNow()),
      }),
    }
  );
  if (!updateRes.ok) {
    const errText = await updateRes.text();
    return json({ error: "failed to mark top-up success", detail: errText }, 500);
  }

  // Award coins to the pilot's passport via RPC (service role)
  const coinsToAward = row.coins_awarded || 0;
  if (coinsToAward > 0 && row.user_id) {
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/award_coins_for_topup`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_id: row.user_id, p_coins: coinsToAward }),
    });
    if (!rpcRes.ok) {
      const errText = await rpcRes.text();
      // Top-up marked success but coin award failed — log but don't fail webhook
      return json({ ok: true, warning: `coins not awarded: ${errText}` });
    }
  }

  return json({ ok: true, reference, status, coins_awarded: coinsToAward });
});

function extractEpochNow(): number {
  return Math.floor(Date.now());
}