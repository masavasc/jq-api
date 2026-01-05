import { NextRequest, NextResponse } from "next/server";

function fmt(n: number, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

// ラベル付け（5日差分Δ5 [%pt] と 5日連続性で判定）
function labelFor(delta5: number, consecutive: string) {
  // 目安（必要なら後で環境変数化できます）
  // 縮小が強い → 円高警戒（円高方向）
  // 拡大が強い → 円安継続（円安方向）
  const TH = 0.10; // 10bp

  // 強いシグナル（連続性 + 閾値）
  if (consecutive === "shrinking" && delta5 <= -TH) return "円高警戒";
  if (consecutive === "widening" && delta5 >= +TH) return "円安継続";

  // 閾値は超えているが連続性が混在
  if (delta5 <= -TH) return "円高警戒（弱）";
  if (delta5 >= +TH) return "円安継続（弱）";

  return "中立";
}

function iconFor(label: string) {
  if (label.startsWith("円高警戒")) return "🟢";
  if (label.startsWith("円安継続")) return "🔴";
  return "🟡";
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
  const sp = json.spread10y;

  const tr = json.trend5d?.spread;
  const trUs = json.trend5d?.us10y;
  const trJp = json.trend5d?.jp10y;

  const delta5 = Number(tr?.delta5);
  const avgDaily = Number(tr?.avgDaily);
  const consecutive = String(tr?.consecutive || "mixed");

  const consLabel =
    consecutive === "shrinking" ? "5日連続：縮小" :
    consecutive === "widening" ? "5日連続：拡大" :
    "5日連続：混在";

  const label = labelFor(delta5, consecutive);
  const icon = iconFor(label);

  const msg =
`${icon} 【${label}】日米金利差（10年）

US10Y: ${fmt(us.value)}% (${us.date})
JP10Y: ${fmt(jp.value)}% (${jp.date})
Spread: ${fmt(sp.value)}%pt

📉 5営業日トレンド
Δ5: ${fmt(delta5)}%pt  / avg: ${fmt(avgDaily)}%pt/day
${consLabel}
内訳：US Δ5 ${fmt(Number(trUs?.delta5))} / JP Δ5 ${fmt(Number(trJp?.delta5))}

参照:
${url}`;

  const r = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: msg }),
  });

  const body = await r.text().catch(() => "");
  if (!r.ok) {
    return NextResponse.json(
      { error: "slack post failed", status: r.status, bodyHead: body.slice(0, 200) },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, sent: true, label });
}
