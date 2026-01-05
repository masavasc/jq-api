import { NextRequest, NextResponse } from "next/server";

type FredObs = { date: string; value: string };

async function fredLatest(seriesId: string, apiKey: string) {
  // 最新の有効値を取るために直近60日を取得して末尾から探す
  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${encodeURIComponent(apiKey)}` +
    `&file_type=json` +
    `&sort_order=desc` +
    `&limit=60`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`FRED fetch failed ${seriesId}: ${res.status} ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const obs: FredObs[] = json.observations || [];
  for (const o of obs) {
    const v = Number(o.value);
    if (Number.isFinite(v)) return { date: o.date, value: v };
  }
  throw new Error(`No valid observations for ${seriesId}`);
}

export async function GET(req: NextRequest) {
  try {
    const apiKey = process.env.FRED_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json({ error: "FRED_API_KEY missing" }, { status: 500 });
    }

    // 10年差（まずはこれが最も安定）
    const us = await fredLatest("DGS10", apiKey);              // US 10Y Treasury
    const jp = await fredLatest("IRLTLT01JPM156N", apiKey);    // Japan long-term gov bond yield proxy
    const spread = us.value - jp.value;

    return NextResponse.json({
      ok: true,
      series: {
        us10y: { id: "DGS10", date: us.date, value: us.value },
        jp10y: { id: "IRLTLT01JPM156N", date: jp.date, value: jp.value },
      },
      spread10y: { value: spread, unit: "pct_points" },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
