import { NextRequest, NextResponse } from "next/server";

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
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();

  if (!res.ok) {
    return NextResponse.json(
      { error: "rate-diff fetch failed", status: res.status, bodyHead: text.slice(0, 200) },
      { status: 500 }
    );
  }

  const json = JSON.parse(text);

  const us = json.series.us10y;
  const jp = json.series.jp10y;
  const sp = json.spread10y.value;

  const msg =
`📈 日米金利差（10年）自動配信
US10Y: ${us.value.toFixed(2)}% (${us.date})
JP10Y: ${jp.value.toFixed(2)}% (${jp.date})
Spread: ${(sp).toFixed(2)}%pt

参照:
${url}`;

  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: msg }),
  });

  return NextResponse.json({ ok: true, sent: true });
}
