import { NextRequest, NextResponse } from "next/server";

type FredObs = { date: string; value: string };
type Point = { date: string; value: number };

const VERSION = "us-led-usdjpy-jgbl-v2";

const FRED_US10Y = "DGS10";
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const Y_USDJPY = "JPY=X";
const Y_JGBL = "%5EJGBL";

const TH_US10Y_STRONG = -0.15;
const TH_US10Y_WEAK   = -0.10;
const TH_USDJPY_STRONG = -0.005;
const TH_USDJPY_WEAK   =  0.000;
const TH_JGBL_STRONG   =  0.20;
const TH_JGBL_WEAK     =  0.00;

function safeNumber(x: any): number | null {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}
function unixToISO(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function calcTrend5(valuesNewestFirst: number[]) {
  if (valuesNewestFirst.length < 6) {
    throw new Error(`Need at least 6 points for 5D trend, got ${valuesNewestFirst.length}`);
  }
  const latest = valuesNewestFirst[0];
  const prev5 = valuesNewestFirst[5];
  const delta5 = latest - prev5;
  const avgDaily = delta5 / 5;

  const isShrinking = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] < v);
  const isWidening  = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] > v);

  const consecutive: "shrinking" | "widening" | "mixed" =
    isShrinking ? "shrinking" : isWidening ? "widening" : "mixed";

  return { latest, prev5, delta5, avgDaily, consecutive };
}

function calcRet5(valuesNewestFirst: number[]) {
  const latest = valuesNewestFirst[0];
  const prev5 = valuesNewestFirst[5];
  const ret5 = (latest / prev5) - 1;
  return { latest, prev5, ret5 };
}

async function fredLatestN(seriesId: string, apiKey: string, need: number): Promise<Point[]> {
  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${encodeURIComponent(apiKey)}` +
    `&file_type=json` +
    `&sort_order=desc` +
    `&limit=140`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`FRED fetch failed ${seriesId}: ${res.status} ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const obs: FredObs[] = json.observations || [];

  const out: Point[] = [];
  for (const o of obs) {
    const v = safeNumber(o.value);
    if (v !== null) {
      out.push({ date: o.date, value: v });
      if (out.length >= need) break;
    }
  }
  if (out.length < need) throw new Error(`Not enough valid observations for ${seriesId}`);
  return out; // newest -> older
}

// Yahoo helper: return [] if unavailable (instead of throwing), unless hardFail=true
async function yahooLatestN(symbolEncoded: string, need: number, hardFail: boolean): Promise<Point[]> {
  const url = `${YAHOO_BASE}${symbolEncoded}?interval=1d&range=6mo`;
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();

  if (!res.ok) {
    if (hardFail) throw new Error(`Yahoo fetch failed ${symbolEncoded}: ${res.status} ${text.slice(0, 200)}`);
    return [];
  }

  let json: any;
  try { json = JSON.parse(text); } catch {
    if (hardFail) throw new Error(`Yahoo JSON parse failed ${symbolEncoded}`);
    return [];
  }

  const chart = json.chart;
  if (!chart || chart.error) {
    if (hardFail) throw new Error(`Yahoo chart error ${symbolEncoded}: ${JSON.stringify(chart?.error)}`);
    return [];
  }

  const r0 = chart.result?.[0];
  if (!r0) {
    if (hardFail) throw new Error(`Yahoo: no result for ${symbolEncoded}`);
    return [];
  }

  const ts: number[] = r0.timestamp || [];
  const close: any[] = r0.indicators?.quote?.[0]?.close || [];

  if (!Array.isArray(ts) || ts.length === 0 || !Array.isArray(close) || close.length === 0) {
    // Some symbols return meta but no timeseries.
    if (hardFail) throw new Error(`Yahoo: empty timeseries for ${symbolEncoded}`);
    return [];
  }

  const out: Point[] = [];
  for (let i = ts.length - 1; i >= 0; i--) {
    const v = safeNumber(close[i]);
    if (v === null) continue;
    out.push({ date: unixToISO(ts[i]), value: v });
    if (out.length >= need) break;
  }

  if (out.length < need) {
    if (hardFail) throw new Error(`Yahoo: not enough points for ${symbolEncoded} (need ${need}, got ${out.length})`);
    return [];
  }

  return out; // newest -> older
}

function label(usDelta5: number, usCons: string, fxRet5: number, jgblDelta5: number | null) {
  const usStrong = (usDelta5 <= TH_US10Y_STRONG) && (usCons === "shrinking");
  const fxStrong = (fxRet5 <= TH_USDJPY_STRONG);
  const jbStrong = (jgblDelta5 !== null) && (jgblDelta5 >= TH_JGBL_STRONG);

  if (usStrong && fxStrong && (jbStrong || jgblDelta5 === null)) {
    // If JGBL missing, still allow "strong" only when US+FX are strong
    return jgblDelta5 === null ? "円高警戒（強）※先物不明" : "円高警戒（強）";
  }

  const usWeak = (usDelta5 <= TH_US10Y_WEAK);
  const fxWeak = (fxRet5 <= TH_USDJPY_WEAK);
  const jbWeak = (jgblDelta5 !== null) && (jgblDelta5 >= TH_JGBL_WEAK);

  if (usWeak && (fxWeak || jbWeak || jgblDelta5 === null)) {
    return jgblDelta5 === null ? "円高警戒（弱）※先物不明" : "円高警戒（弱）";
  }

  if (usDelta5 >= +0.10 && fxRet5 >= +0.005 && (jgblDelta5 === null || jgblDelta5 <= -0.20)) {
    return jgblDelta5 === null ? "円安継続※先物不明" : "円安継続";
  }

  return jgblDelta5 === null ? "中立※先物不明" : "中立";
}

function icon(lbl: string) {
  if (lbl.startsWith("円高警戒")) return "🟢";
  if (lbl.startsWith("円安継続")) return "🔴";
  return "🟡";
}

export async function GET(_req: NextRequest) {
  try {
    const fredKey = process.env.FRED_API_KEY || "";
    if (!fredKey) return NextResponse.json({ error: "FRED_API_KEY missing", version: VERSION }, { status: 500 });

    const us10y = await fredLatestN(FRED_US10Y, fredKey, 6);

    // USDJPY is required (hardFail=true)
    const usdjpy = await yahooLatestN(Y_USDJPY, 6, true);

    // JGBL is optional (hardFail=false)
    const jgbl = await yahooLatestN(Y_JGBL, 6, false);

    const usTrend = calcTrend5(us10y.map(p => p.value));
    const fx5 = calcRet5(usdjpy.map(p => p.value));

    let jgblTrend: any = null;
    let jgblUnavailable = false;
    if (jgbl.length >= 6) {
      jgblTrend = calcTrend5(jgbl.map(p => p.value));
    } else {
      jgblUnavailable = true;
    }

    const jgblDelta5 = jgblTrend ? Number(jgblTrend.delta5) : null;

    const lbl = label(usTrend.delta5, usTrend.consecutive, fx5.ret5, jgblDelta5);
    const ic = icon(lbl);

    return NextResponse.json({
      ok: true,
      version: VERSION,
      label: lbl,
      icon: ic,
      primary: {
        us10y: { date: us10y[0].date, value: usTrend.latest, last6: us10y, trend5d: usTrend }
      },
      helpers: {
        usdjpy: { date: usdjpy[0].date, value: fx5.latest, last6: usdjpy, ret5: fx5.ret5 },
        jgbl: jgblUnavailable
          ? { available: false, symbol: "^JGBL", note: "Yahoo returned empty timeseries today" }
          : { available: true, date: jgbl[0].date, value: jgblTrend.latest, last6: jgbl, trend5d: jgblTrend }
      }
    });

  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error", version: VERSION }, { status: 500 });
  }
}
