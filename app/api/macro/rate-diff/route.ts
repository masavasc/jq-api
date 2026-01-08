import { NextRequest, NextResponse } from "next/server";

type FredObs = { date: string; value: string };

type Point = { date: string; value: number };

const FRED_US10Y = "DGS10"; // US 10Y Treasury (daily)
const MOF_JP10Y_URL = "https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv";

// ----------- Utilities -----------

function parseDateToISO(s: string): string | null {
  const t = s.trim();
  if (!t) return null;

  // YYYY-MM-DD
  const m1 = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m1) {
    const y = m1[1], mo = m1[2].padStart(2, "0"), d = m1[3].padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }

  // YYYY/MM/DD
  const m2 = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m2) {
    const y = m2[1], mo = m2[2].padStart(2, "0"), d = m2[3].padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }

  // YYYY.MM.DD
  const m3 = t.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (m3) {
    const y = m3[1], mo = m3[2].padStart(2, "0"), d = m3[3].padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }

  return null;
}

function safeNumber(s: string): number | null {
  const v = Number(String(s).trim());
  return Number.isFinite(v) ? v : null;
}

// valuesNewestFirst: [v0(latest), v1, ... v5(5-days-ago)]
function calcTrend5(valuesNewestFirst: number[]) {
  if (valuesNewestFirst.length < 6) {
    throw new Error(`Need at least 6 points to compute 5D trend, got ${valuesNewestFirst.length}`);
  }

  const latest = valuesNewestFirst[0];
  const prev5 = valuesNewestFirst[5];
  const delta5 = latest - prev5;
  const avgDaily = delta5 / 5;

  // consecutive shrinking: v0 < v1 < v2 < v3 < v4 < v5
  const isShrinking = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] < v);
  // consecutive widening: v0 > v1 > v2 > v3 > v4 > v5
  const isWidening = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] > v);

  const consecutive: "shrinking" | "widening" | "mixed" =
    isShrinking ? "shrinking" : isWidening ? "widening" : "mixed";

  return { latest, prev5, delta5, avgDaily, consecutive };
}

// ----------- FRED (US) -----------

async function fredLatestN(seriesId: string, apiKey: string, need: number): Promise<Point[]> {
  // Get plenty to survive missing days/holidays
  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${encodeURIComponent(apiKey)}` +
    `&file_type=json` +
    `&sort_order=desc` +
    `&limit=120`;

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

// ----------- MOF (JP) -----------

function decodeCsv(buf: ArrayBuffer): string {
  // Try Shift-JIS first (MOF CSV is often SJIS), fallback to UTF-8
  try {
    // @ts-ignore
    return new TextDecoder("shift_jis").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

function splitCsvLine(line: string): string[] {
  // Simple CSV splitter (MOF is plain CSV; no quoted commas in headers/values typically)
  // If you ever see quoted commas, we can upgrade to a full CSV parser.
  return line.split(",").map((s) => s.trim());
}

function findColIndex(headers: string[], patterns: RegExp[]): number {
  for (const re of patterns) {
    const idx = headers.findIndex((h) => re.test(h));
    if (idx >= 0) return idx;
  }
  return -1;
}

async function mofLatestN_JP10Y(need: number): Promise<Point[]> {
  const res = await fetch(MOF_JP10Y_URL, { cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`MOF CSV fetch failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const buf = await res.arrayBuffer();
  const text = decodeCsv(buf);

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) throw new Error("MOF CSV has too few lines");

  const headers = splitCsvLine(lines[0]);

  // Date column candidates
  const dateIdx = findColIndex(headers, [/^date$/i, /日付/, /年月日/, /年\/月\/日/, /date/i]);
  if (dateIdx < 0) throw new Error(`MOF CSV: date column not found. headers=${headers.join("|")}`);

  // 10Y column candidates (try common representations)
  const tenIdx = findColIndex(headers, [
    /^10$/i,
    /10\s*年/,
    /10\s*year/i,
    /10y/i,
    /10\-year/i,
    /10year/i,
  ]);
  if (tenIdx < 0) {
    // Sometimes MOF uses "10" but with spaces or fullwidth; try a last-resort scan for "10"
    const fallback = headers.findIndex((h) => /10/.test(h));
    if (fallback < 0) throw new Error(`MOF CSV: 10Y column not found. headers=${headers.join("|")}`);
    // else accept fallback
  }

  const jp10Idx = tenIdx >= 0 ? tenIdx : headers.findIndex((h) => /10/.test(h));

  const points: Point[] = [];

  // MOF CSV is usually oldest -> newest. We'll read from bottom to top to get latest quickly.
  for (let i = lines.length - 1; i >= 1; i--) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length <= Math.max(dateIdx, jp10Idx)) continue;

    const iso = parseDateToISO(cols[dateIdx]);
    if (!iso) continue;

    const v = safeNumber(cols[jp10Idx]);
    if (v === null) continue;

    points.push({ date: iso, value: v });
    if (points.length >= need) break;
  }

  if (points.length < need) {
    throw new Error(`MOF CSV: not enough valid JP10Y points (need ${need}, got ${points.length})`);
  }

  // points currently newest -> older
  return points;
}

// ----------- Alignment (by common dates) -----------

function alignByDate(us: Point[], jp: Point[], need: number) {
  const usMap = new Map(us.map((p) => [p.date, p.value]));
  const jpMap = new Map(jp.map((p) => [p.date, p.value]));

  // common dates (newest first)
  const common = us
    .map((p) => p.date)
    .filter((d) => jpMap.has(d))
    .slice(0, 60); // just in case

  const aligned: { date: string; us: number; jp: number; spread: number }[] = [];
  for (const d of common) {
    const u = usMap.get(d);
    const j = jpMap.get(d);
    if (u === undefined || j === undefined) continue;
    aligned.push({ date: d, us: u, jp: j, spread: u - j });
    if (aligned.length >= need) break;
  }

  if (aligned.length < need) {
    throw new Error(`Not enough common dates to align (need ${need}, got ${aligned.length}).`);
  }

  return aligned; // newest -> older
}

// ----------- API -----------

export async function GET(_req: NextRequest) {
  try {
    const apiKey = process.env.FRED_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json({ error: "FRED_API_KEY missing" }, { status: 500 });
    }

    // We need 6 points (latest + 5 business days ago) AFTER alignment.
    // Fetch a bit more to ensure overlap.
    const usRaw = await fredLatestN(FRED_US10Y, apiKey, 30);     // newest -> older
    const jpRaw = await mofLatestN_JP10Y(30);                   // newest -> older

    const aligned6 = alignByDate(usRaw, jpRaw, 6);              // newest -> older

    const spread6 = aligned6.map((x) => x.spread);              // newest -> older
    const us6 = aligned6.map((x) => x.us);
    const jp6 = aligned6.map((x) => x.jp);

    const tSpread = calcTrend5(spread6);
    const tUs = calcTrend5(us6);
    const tJp = calcTrend5(jp6);

    const latest = aligned6[0];

    return NextResponse.json({
      ok: true,
      series: {
        us10y: {
          id: FRED_US10Y,
          source: "FRED",
          date: latest.date,
          value: latest.us,
          last6: aligned6.map((x) => ({ date: x.date, value: x.us })),
        },
        jp10y: {
          id: "MOF_JP10Y",
          source: "MOF",
          date: latest.date,
          value: latest.jp,
          last6: aligned6.map((x) => ({ date: x.date, value: x.jp })),
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
        jp_source: "MOF jgbcm.csv (daily, business days)",
        alignment: "US & JP aligned by common dates before computing 5-day trend",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
