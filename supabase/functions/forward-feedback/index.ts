// supabase/functions/forward-feedback/index.ts
// Deno Edge Function — emails new Canvas Dodger feedback to the owner.
//
// WHY THIS EXISTS: a static site (GitHub Pages) can't send mail from the
// browser (no SMTP, and you must never put an email API key in the client).
// So feedback lands in the public.feedback table, and this function — which
// runs server-side with the RESEND_API_KEY secret — forwards each new row to
// the owner's inbox, then marks it forwarded=true so it isn't mailed twice.
//
// ── DEPLOY (one-time) ────────────────────────────────────────────────────
//   supabase secrets set RESEND_API_KEY=re_xxxxxxxx            (from resend.com)
//   supabase functions deploy forward-feedback
//
// Then EITHER schedule it, OR wire a DB webhook on public.feedback INSERT:
//   Dashboard → Database → Webhooks → Create
//     table: public.feedback   events: Insert
//     type:  Supabase Edge Function   function: forward-feedback
//
// The owner address is baked in below (change if needed). Resend's test
// sender is onboarding@resend.dev until you verify your own domain.
// ────────────────────────────────────────────────────────────────────────

const OWNER_EMAIL = "kwoffiekiphnic7@gmail.com";
const FROM_EMAIL = "Canvas Dodger <onboarding@resend.dev>"; // swap once domain verified
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY");

function esc(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

async function mail(row: any): Promise<boolean> {
  if (!RESEND_KEY) return false;
  const kind = String(row.kind || "other").toUpperCase();
  const who = String(row.callsign || "ANON").toUpperCase();
  const msg = String(row.msg || "");
  const when = new Date(Number(row.at) || Date.now()).toISOString();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [OWNER_EMAIL],
      reply_to: undefined, // callsign has no real mailbox; replies won't route
      subject: `[${kind}] Canvas Dodger feedback from ${who}`,
      html:
        `<div style="font-family:monospace;background:#0a0e14;color:#e6f1ff;padding:16px;border-radius:10px">` +
        `<h2 style="color:#00f0ff;margin:0 0 8px">${esc(kind)} · ${esc(who)}</h2>` +
        `<p style="color:#8aa0b4;margin:0 0 12px;font-size:12px">${esc(when)} · feedback #${esc(String(row.id))}</p>` +
        `<p style="white-space:pre-wrap;line-height:1.5">${esc(msg)}</p>` +
        `</div>`,
    }),
  });
  return res.ok;
}

async function markForwarded(id: number): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/feedback?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({ forwarded: true }),
  });
}

Deno.serve(async (req) => {
  // A DB webhook posts the new row under "record"; a cron/GET sends all unsent.
  let rows: any[] = [];
  try {
    const body = await req.json();
    if (body && body.record) rows = [body.record];
    else if (body && Array.isArray(body.rows)) rows = body.rows;
  } catch { /* empty body (GET) -> poll unsent below */ }

  if (!rows.length) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/feedback?forwarded=eq.false&select=id,callsign,kind,msg,at&order=at.asc&limit=25`,
      { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
    );
    rows = r.ok ? await r.json() : [];
  }

  if (!RESEND_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "RESEND_API_KEY not set" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  let sent = 0;
  for (const row of rows) {
    try {
      if (await mail(row)) { await markForwarded(Number(row.id)); sent++; }
    } catch { /* keep going; row stays unsent for the next run */ }
  }
  return new Response(JSON.stringify({ ok: true, sent }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
