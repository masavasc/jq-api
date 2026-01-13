import { NextRequest, NextResponse } from "next/server";

type FredObs = { date: string; value: string };
type Point = { date: string; value: number };

const VERSION = "us-led-usdjpy-jgbl-v1";

// --- Primary (US yield) ---
const FRED_US10Y = "DGS10";

// --- Helpers (Yahoo chart) ---
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const Y_USDJPY = "JPY=X";
const Y_JGBL = "%5EJGBL"; // ^JGBL URL-encoded

// ---- thresholds (tune here) ----
const TH_US10Y_STRONG = -0.15; // -15bp in 5 days
const TH_US10Y_WEAK   = -0.10; // -10bp in 5 days
const TH_USDJPY_STRONG = -0.005; // -0.5% in 5 days
const TH_USDJPY_WEAK   =  0.000; // <=0% in 5 days
const TH_JGBL_STRONG   =  0.20;  // +0.20 (price points) in 5 days (rough)
const TH_JGBL_WEAK     =  0.00;  // >=0 in 5 days

// ---------- utils ----------
function safeNumber(x: any): number | null {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function unixToISO(sec: number): string {
  const d = new Date(sec * 1000);
  return d.toISOString().slice(0, 10);
}

// valuesNewestFirst length >= 6
function calcTrend5(valuesNewestFirst: number[]) {
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

// 5-day return for FX: (latest/prev5 - 1)
function calcRet5(valuesNewestFirst: number[]) {
  const latest = valuesNewestFirst[0];
  const prev5 = valuesNewestFirst[5];
  const ret5 = (latest / prev5) - 1;
  return { latest, prev5, ret5 };
}

// ---------- FRED ----------
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

// ---------- Yahoo chart ----------
async function yahooLatestN(symbolEncoded: string, need: number): Promise<Point[]> {
  // interval=1d range=3mo enough to cover holidays
  const url = `${YAHOO_BASE}${symbolEncoded}?interval=1d&range=3mo`;
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`Yahoo fetch failed ${symbolEncoded}: ${res.status} ${text.slice(0, 200)}`);

  const json = JSON.parse(text);
  const chart = json.chart;
  if (!chart || chart.error) throw new Error(`Yahoo chart error ${symbolEncoded}: ${JSON.stringify(chart?.error)}`);

  const r0 = chart.result?.[0];
  if (!r0) throw new Error(`Yahoo: no result for ${symbolEncoded}`);

  const ts: number[] = r0.timestamp || [];
  const close: any[] = r0.indicators?.quote?.[0]?.close || [];

  const out: Point[] = [];
  // iterate from end (newest) backwards
  for (let i = ts.length - 1; i >= 0; i--) {
    const v = safeNumber(close[i]);
    if (v === null) continue;
    out.push({ date: unixToISO(ts[i]), value: v });
    if (out.length >= need) break;
  }

  if (out.length < need) throw new Error(`Yahoo: not enough points for ${symbolEncoded} (need ${need}, got ${out.length})`);
  return out; // newest -> older
}

// ---------- Labeling ----------
function label(usDelta5: number, usCons: string, fxRet5: number, jgblDelta5: number) {
  // Strong yen-warning: US yield down strongly + FX down + JGBL up
  const usStrong = (usDelta5 <= TH_US10Y_STRONG) && (usCons === "shrinking");
  const fxStrong = (fxRet5 <= TH_USDJPY_STRONG);
  const jbStrong = (jgblDelta5 >= TH_JGBL_STRONG);

  if (usStrong && fxStrong && jbStrong) return "円高警戒（強）";

  // Weak yen-warning: US yield down moderately + (FX non-positive OR JGBL non-negative)
  const usWeak = (usDelta5 <= TH_US10Y_WEAK);
  const fxWeak = (fxRet5 <= TH_USDJPY_WEAK);
  const jbWeak = (jgblDelta5 >= TH_JGBL_WEAK);

  if (usWeak && (fxWeak || jbWeak)) return "円高警戒（弱）";

  // Yen-weak continuation: US yield up + FX up and JGBL down
  if (usDelta5 >= +0.10 && fxRet5 >= +0.005 && jgblDelta5 <= -0.20) return "円安継続";

  return "中立";
}

function icon(label: string) {
  if (label.startsWith("円高警戒")) return "🟢";
  if (label.startsWith("円安継続")) return "🔴";
  return "🟡";
}

export async function GET(_req: NextRequest) {
  try {
    const fredKey = process.env.FRED_API_KEY || "";
    if (!fredKey) {
      return NextResponse.json({ error: "FRED_API_KEY missing", version: VERSION }, { status: 500 });
    }

    // Need 6 points for 5D calculations
    const us10y = await fredLatestN(FRED_US10Y, fredKey, 6);
    const usdjpy = await yahooLatestN(Y_USDJPY, 6);
    const jgbl = await yahooLatestN(Y_JGBL, 6);

    const usTrend = calcTrend5(us10y.map(p => p.value));
    const fx5 = calcRet5(usdjpy.map(p => p.value));
    const jgblTrend = calcTrend5(jgbl.map(p => p.value));

    const lbl = label(usTrend.delta5, usTrend.consecutive, fx5.ret5, jgblTrend.delta5);
    const ic = icon(lbl);

    // Output latest date = newest common among sources (for display)
    // Here we just display each source's latest date separately.
    return NextResponse.json({
      ok: true,
      version: VERSION,
      label: lbl,
      icon: ic,
      primary: {
        us10y: {
          date: us10y[0].date,
          value: usTrend.latest,
          last6: us10y.map(p => p),
          trend5d: usTrend
        }
      },
      helpers: {
        usdjpy: {
          date: usdjpy[0].date,
          value: fx5.latest,
          last6: usdjpy.map(p => p),
          ret5: fx5.ret5
        },
        jgbl: {
          date: jgbl[0].date,
          value: jgblTrend.latest,
          last6: jgbl.map(p => p),
          trend5d: jgblTrend
        }
      }
    });

  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error", version: VERSION }, { status: 500 });
  }
}
