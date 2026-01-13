import { NextRequest, NextResponse } from "next/server";

function fmt(n: number, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

async function postSlack(webhook: string, text: string) {
  const r = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`Slack post failed: ${r.status} ${body.slice(0, 200)}`);
}

export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get("secret") || "";
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const webhook = process.env.SLACK_WEBHOOK_URL || "";
  if (!webhook) {
    return NextResponse.json({ error: "SLACK_WEBHOOK_URL missing" }, { status: 500 });
  }

  const baseUrl =
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "https://jq-api.vercel.app";

  const url = `${baseUrl}/api/macro/rate-diff`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json();

    if (!json.ok) {
      await postSlack(webhook, `⚠️ macro/rate-diff error: ${json.error}\n${url}`);
      return NextResponse.json({ ok: false, sent: true }, { status: 200 });
    }

    const label = json.label;
    const icon = json.icon;

    const us = json.primary.us10y;
    const fx = json.helpers.usdjpy;
    const jb = json.helpers.jgbl;

    const usT = us.trend5d;
    const jbT = jb.trend5d;

    const fxRet5Pct = fx.ret5 * 100;

    const msg =
`${icon}【${label}】米金利主導＋補助条件（為替・国債先物）

US10Y: ${fmt(us.value)}% (${us.date})
US10Y Δ5: ${fmt(usT.delta5)}%pt / avg: ${fmt(usT.avgDaily)}%pt/day
US10Y 5日連続: ${usT.consecutive}

USD/JPY: ${fmt(fx.value)} (${fx.date})
USD/JPY 5日変化: ${fmt(fxRet5Pct, 2)}%

^JGBL: ${fmt(jb.value)} (${jb.date})
^JGBL Δ5: ${fmt(jbT.delta5)} / avg: ${fmt(jbT.avgDaily)}
^JGBL 5日連続: ${jbT.consecutive}

参照:
${url}`;

    await postSlack(webhook, msg);
    return NextResponse.json({ ok: true, sent: true }, { status: 200 });

  } catch (e: any) {
    const msg = `⚠️ rate-diff-alerts internal error: ${e?.message ?? "error"}\n${url}`;
    try { await postSlack(webhook, msg); } catch {}
    return NextResponse.json({ ok: false, error: e?.message ?? "error" }, { status: 500 });
  }
}
