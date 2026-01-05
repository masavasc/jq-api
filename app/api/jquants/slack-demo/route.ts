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

  const now = new Date().toISOString();
  const payload = {
    text:
`@here ✅ Slack送信デモ（market-signal）
時刻: ${now}
from: jq-api (vercel)
これは疎通確認のテスト投稿です。`,
  };

  const r = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await r.text().catch(() => "");
  return NextResponse.json({
    ok: r.ok,
    status: r.status,
    response: body.slice(0, 200),
    sent: true,
  });
}
