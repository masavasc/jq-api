import { NextRequest, NextResponse } from "next/server";

function fmt(n: number, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

function labelFor(delta5: number, consecutive: string) {
  const TH = 0.10; // 10bp
  if (consecutive === "shrinking" && delta5 <= -TH) return "円高警戒";
  if (consecutive === "widening" && delta5 >= +TH) return "円安継続";
  if (delta5 <= -TH) return "円高警戒（弱）";
  if (delta5 >= +TH) return "円安継続（弱）";
  return "中立";
}

function iconFor(label: string) {
  if (label.startsWith("円高警戒")) return "🟢";
  if (label.startsWith("円安継続")) return "🔴";
  return "🟡";
}

async function postSlack(webhook: string, text: string) {
  const r = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await r.text().catch(() => "");
  if (!r.ok) {
    throw new Error(`Slack post failed: ${r.status} ${body.slice(0, 200)}`);
  }
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
    // --- rate-diff を取得（失敗したら Slack に警告を送る） ---
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";

    if (!res.ok) {
      const msg =
`⚠️ 日米金利差レポート取得エラー（rate-diff）
status: ${res.status}
content-type: ${ct}
url: ${url}
body(head): ${text.slice(0, 200)}`;
      await postSlack(webhook, msg);
      return NextResponse.json({ ok: false, sent: true, error: "rate-diff fetch failed" }, { status: 200 });
    }

    if (!ct.includes("application/json")) {
      const msg =
`⚠️ 日米金利差レポート取得エラー（JSONではありません）
content-type: ${ct}
url: ${url}
body(head): ${text.slice(0, 200)}`;
      await postSlack(webhook, msg);
      return NextResponse.json({ ok: false, sent: true, error: "non-json response" }, { status: 200 });
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
`${icon}【${label}】日米金利差（10年）

US10Y: ${fmt(us.value)}% (${us.date})
JP10Y: ${fmt(jp.value)}% (${jp.date}) [${jp.source ?? "MOF"}]
Spread: ${fmt(sp.value)}%pt

📉 5営業日トレンド
Δ5: ${fmt(delta5)}%pt / avg: ${fmt(avgDaily)}%pt/day
${consLabel}
内訳：US Δ5 ${fmt(Number(trUs?.delta5))} / JP Δ5 ${fmt(Number(trJp?.delta5))}

参照:
${url}`;

    await postSlack(webhook, msg);
    return NextResponse.json({ ok: true, sent: true, label }, { status: 200 });

  } catch (e: any) {
    // --- ここで落ちても必ず Slack に出す ---
    const msg =
`⚠️ 日米金利差アラート内部エラー（rate-diff-alerts）
message: ${e?.message ?? "unknown"}
url: ${url}`;
    try {
      await postSlack(webhook, msg);
    } catch {
      // Slackすら落ちたら返すしかない
    }
    return NextResponse.json({ ok: false, error: e?.message ?? "error" }, { status: 500 });
  }
}
