import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get("secret") || "";
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tickers = process.env.ALERT_TICKERS || "";
  if (!tickers) {
    return NextResponse.json({ error: "ALERT_TICKERS missing" }, { status: 500 });
  }

  const webhook = process.env.SLACK_WEBHOOK_URL || "";
  if (!webhook) {
    return NextResponse.json({ error: "SLACK_WEBHOOK_URL missing" }, { status: 500 });
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  // 既存API（pullback）を呼ぶ
  const url = `${baseUrl}/api/jquants/pullback?tickers=${encodeURIComponent(tickers)}&only=buy`;
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json();

  const buys = (json.results || []).filter((x: any) => x.signal === "BUY");

  // BUYがなければ何もしない（静かな運用）
  if (buys.length === 0) {
    return NextResponse.json({ ok: true, sent: false, count: 0 });
  }

  const lines = buys.map((x: any) => {
    const ddPct = (x.drawdown20 * 100).toFixed(1);
    const rsi = typeof x.rsi14 === "number" ? x.rsi14.toFixed(1) : x.rsi14;
    return `• ${x.ticker}  score=${x.score}  close=${x.close}  DD20=${ddPct}%  RSI14=${rsi}`;
  });

  const payload = {
    text:
`@here ★★★ MARKET SIGNAL（BUY候補）

${lines.join("\n")}

確認（BUYだけ表示）:
${url}
`,
  };

  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return NextResponse.json({ ok: true, sent: true, count: buys.length });
}
