import { NextRequest, NextResponse } from "next/server";

type FredObs = { date: string; value: string };
type Point = { date: string; value: number };

const VERSION = "mof-pattern-fixedcol-v1";

// US: FRED daily
const FRED_US10Y = "DGS10";

// JP: MOF CSV (human-oriented; title/notes/header may vary)
const MOF_JGBCM_CSV = "https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv";

// MOF “fixed column” rule:
// Col0 = date-like (e.g., 2026/01/06), Col1=1Y, Col2=2Y, ... Col10=10Y
const MOF_TENOR_10Y_INDEX = 10;

// ---------------- Utilities ----------------

function safeNumber(s: string): number | null {
  const v = Number(String(s).trim());
  return Number.isFinite(v) ? v : null;
}

function parseDateToISO(s: string): string | null {
  const t = String(s).trim();
  if (!t) return null;

  // YYYY-MM-DD
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;

  // YYYY/MM/DD
  m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;

  // YYYY.MM.DD
  m = t.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;

  return null;
}

function decodeCsv(buf: ArrayBuffer): string {
  // MOF is often Shift-JIS; fall back to UTF-8
  try {
    // @ts-ignore
    return new TextDecoder("shift_jis").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

// delimiter wobble: comma / fullwidth comma / tab
function splitRow(line: string): string[] {
  let s = line.replace(/^\uFEFF/, "").trim();
  s = s.replace(/，/g, ",");
  let cols = s.split(",").map((x) => x.trim());
  if (cols.length <= 1) cols = s.split("\t").map((x) => x.trim());
  return cols;
}

// 5D trend from valuesNewestFirst: [v0(latest), v1, ... v5(5days-ago)]
function calcTrend5(valuesNewestFirst: number[]) {
  if (valuesNewestFirst.length < 6) {
    throw new Error(`Need at least 6 points for 5D trend, got ${valuesNewestFirst.length}`);
  }
  const latest = valuesNewestFirst[0];
  const prev5 = valuesNewestFirst[5];
  const delta5 = latest - prev5;
  const avgDaily = delta5 / 5;

  // shrinking: v0 < v1 < v2 < v3 < v4 < v5
  const isShrinking = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] < v);
  // widening: v0 > v1 > v2 > v3 > v4 > v5
  const isWidening = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] > v);

  const consecutive: "shrinking" | "widening" | "mixed" =
    isShrinking ? "shrinking" : isWidening ? "widening" : "mixed";

  return { latest, prev5, delta5, avgDaily, consecutive };
}

// ---------------- FRED (US10Y) ----------------

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
  if (out.length < need) {
    throw new Error(`Not enough valid observations for ${seriesId} (need ${need}, got ${out.length})`);
  }
  return out; // newest -> older
}

// ---------------- MOF (JP10Y by pattern + fixed column) ----------------

async function mofLatestN_JP10Y(need: number): Promise<Point[]> {
  const res = await fetch(MOF_JGBCM_CSV, { cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`MOF CSV fetch failed: ${res.status} ${t.slice(0, 200)}`);
  }

  const buf = await res.arrayBuffer();
  const csvText = decodeCsv(buf);

  const rawLines = csvText.split(/\r?\n/);
  const lines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 5) throw new Error("MOF CSV: too few lines");

  // Scan from bottom to top, pick lines whose col0 is date-like.
  const out: Point[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const cols = splitRow(lines[i]);
    if (cols.length <= MOF_TENOR_10Y_INDEX) continue;

    const iso = parseDateToISO(cols[0]);
    if (!iso) continue; // not a data row

    const v = safeNumber(cols[MOF_TENOR_10Y_INDEX]);
    if (v === null) continue;

    out.push({ date: iso, value: v });
    if (out.length >= need) break;
  }

  if (out.length < need) {
    // Include some head lines for debugging
    const head20 = lines.slice(0, 20).join("\\n").slice(0, 800);
    throw new Error(
      `MOF CSV: not enough JP10Y data rows (need ${need}, got ${out.length}). ` +
      `Check fixed index=${MOF_TENOR_10Y_INDEX}. head20=${head20}`
    );
  }

  return out; // newest -> older
}

// ---------------- Alignment (by common dates) ----------------

function alignByDate(us: Point[], jp: Point[], need: number) {
  const usMap = new Map(us.map((p) => [p.date, p.value]));
  const jpMap = new Map(jp.map((p) => [p.date, p.value]));

  const commonDates = us
    .map((p) => p.date) // newest -> older
    .filter((d) => jpMap.has(d));

  const aligned: { date: string; us: number; jp: number; spread: number }[] = [];
  for (const d of commonDates) {
    const u = usMap.get(d);
    const j = jpMap.get(d);
    if (u === undefined || j === undefined) continue;
    aligned.push({ date: d, us: u, jp: j, spread: u - j });
    if (aligned.length >= need) break;
  }

  if (aligned.length < need) {
    throw new Error(
      `Not enough common dates to align (need ${need}, got ${aligned.length}). ` +
      `Tip: holidays/calendar mismatch can reduce overlap; we already fetch extra points.`
    );
  }

  return aligned; // newest -> older
}

// ---------------- API ----------------

export async function GET(_req: NextRequest) {
  try {
    const apiKey = process.env.FRED_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json({ error: "FRED_API_KEY missing", version: VERSION }, { status: 500 });
    }

    // fetch extra points to survive holidays/calendar mismatches
    const usRaw = await fredLatestN(FRED_US10Y, apiKey, 60);
    const jpRaw = await mofLatestN_JP10Y(60);

    // need 6 aligned points for 5 business-day trend
    const aligned6 = alignByDate(usRaw, jpRaw, 6);

    const spread6 = aligned6.map((x) => x.spread);
    const us6 = aligned6.map((x) => x.us);
    const jp6 = aligned6.map((x) => x.jp);

    const tSpread = calcTrend5(spread6);
    const tUs = calcTrend5(us6);
    const tJp = calcTrend5(jp6);

    const latest = aligned6[0];

    return NextResponse.json({
      ok: true,
      version: VERSION,
      series: {
        us10y: {
          id: FRED_US10Y,
          source: "FRED",
          date: latest.date,
          value: latest.us,
          last6: aligned6.map((x) => ({ date: x.date, value: x.us })),
        },
        jp10y: {
          id: "MOF_JP10Y_FIXEDCOL",
          source: "MOF",
          date: latest.date,
          value: latest.jp,
          last6: aligned6.map((x) => ({ date: x.date, value: x.jp })),
          notes: { fixedColIndex10Y: MOF_TENOR_10Y_INDEX },
        },
      },
      spread10y: {
        date: latest.date,
        value: tSpread.latest,
        unit: "pct_points",
        last6: aligned6.map((x) => ({ date: x.date, value: x.spread })),
      },
      trend5d: {
        spread: {
          delta5: tSpread.delta5,
          avgDaily: tSpread.avgDaily,
          consecutive: tSpread.consecutive,
        },
        us10y: {
          delta5: tUs.delta5,
          avgDaily: tUs.avgDaily,
          consecutive: tUs.consecutive,
        },
        jp10y: {
          delta5: tJp.delta5,
          avgDaily: tJp.avgDaily,
          consecutive: tJp.consecutive,
        },
      },
      notes: {
        jp_source: "MOF jgbcm.csv (daily). Data rows detected by date pattern; 10Y read from fixed column index.",
        alignment: "US & JP aligned by common dates before computing 5-business-day trend.",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error", version: VERSION }, { status: 500 });
  }
}
