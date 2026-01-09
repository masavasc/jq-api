import { NextRequest, NextResponse } from "next/server";

type FredObs = { date: string; value: string };
type Point = { date: string; value: number };

const FRED_US10Y = "DGS10";
const MOF_JGBCM_CSV = "https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv";

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
  // MOF CSV is often Shift-JIS; try it first, then UTF-8.
  try {
    // @ts-ignore
    return new TextDecoder("shift_jis").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

// MOF CSV is simple; usually no quoted commas.
// We keep it simple but robust for extra spaces.
function splitCsvLine(line: string): string[] {
  return line.split(",").map((s) => s.trim());
}

function normalizeHeader(s: string): string {
  // Remove spaces (incl. full-width), unify
  return s
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function findHeaderRow(lines: string[]): { headerIndex: number; headers: string[] } {
  // Find the first row that contains "日付" (date) and looks like a CSV header row.
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length < 5) continue;

    const norm = cols.map(normalizeHeader);
    const hasDate = norm.some((h) => h === "日付" || h.includes("日付") || h === "date");
    // Also check there are term-like columns e.g. "10年" or "1年"
    const hasTerm = norm.some((h) => h.includes("10年") || h === "10" || h.includes("1年") || h.includes("2年"));
    if (hasDate && hasTerm) {
      return { headerIndex: i, headers: cols };
    }
  }
  throw new Error(`MOF CSV: header row not found (searched first 40 lines).`);
}

function findColumnIndex(headers: string[], candidates: RegExp[]): number {
  const norm = headers.map(normalizeHeader);
  for (const re of candidates) {
    const idx = norm.findIndex((h) => re.test(h));
    if (idx >= 0) return idx;
  }
  return -1;
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

  // shrinking: v0 < v1 < v2 < v3 < v4 < v5 (latest smallest)
  const isShrinking = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] < v);
  // widening: v0 > v1 > v2 > v3 > v4 > v5
  const isWidening = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] > v);

  const consecutive: "shrinking" | "widening" | "mixed" =
    isShrinking ? "shrinking" : isWidening ? "widening" : "mixed";

  return { latest, prev5, delta5, avgDaily, consecutive };
}

// ---------------- FRED US10Y ----------------

async function fredLatestN(seriesId: string, apiKey: string, need: number): Promise<Point[]> {
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

// ---------------- MOF JP10Y ----------------

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

  if (lines.length < 3) {
    throw new Error("MOF CSV: too few lines");
  }

  // Detect header row (skip title/units lines)
  const { headerIndex, headers } = findHeaderRow(lines);

  // Find date column
  const dateIdx = findColumnIndex(headers, [/^(日付|date)$/i, /日付/]);
  if (dateIdx < 0) {
    throw new Error(`MOF CSV: date column not found. headers=${headers.join("|")}`);
  }

  // Find 10Y column (robust patterns)
  // normalized header examples: "10年", "10", "10year"
  const tenIdx = findColumnIndex(headers, [/^10年$/i, /^10$/i, /^10y$/i, /^10year$/i, /10年/]);
  if (tenIdx < 0) {
    throw new Error(`MOF CSV: 10Y column not found. headers=${headers.join("|")}`);
  }

  // Data lines start after header row
  const dataLines = lines.slice(headerIndex + 1);

  // Read from bottom to top (latest first)
  const out: Point[] = [];
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const cols = splitCsvLine(dataLines[i]);
    if (cols.length <= Math.max(dateIdx, tenIdx)) continue;

    const iso = parseDateToISO(cols[dateIdx]);
    if (!iso) continue;

    const v = safeNumber(cols[tenIdx]);
    if (v === null) continue;

    out.push({ date: iso, value: v });
    if (out.length >= need) break;
  }

  if (out.length < need) {
    throw new Error(`MOF CSV: not enough valid JP10Y points (need ${need}, got ${out.length})`);
  }

  return out; // newest -> older
}

// ---------------- Alignment ----------------

function alignByDate(us: Point[], jp: Point[], need: number) {
  const usMap = new Map(us.map((p) => [p.date, p.value]));
  const jpMap = new Map(jp.map((p) => [p.date, p.value]));

  const commonDates = us
    .map((p) => p.date)          // already newest -> older
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
    throw new Error(`Not enough common dates to align (need ${need}, got ${aligned.length}).`);
  }
  return aligned; // newest -> older
}

// ---------------- API ----------------

export async function GET(_req: NextRequest) {
  try {
    const apiKey = process.env.FRED_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json({ error: "FRED_API_KEY missing" }, { status: 500 });
    }

    // Fetch more than we need to survive holidays & mismatched calendars
    const usRaw = await fredLatestN(FRED_US10Y, apiKey, 40);
    const jpRaw = await mofLatestN_JP10Y(40);

    // Need 6 aligned points for 5-business-day trend
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
        jp_source: "MOF jgbcm.csv (daily). Header row auto-detected (skipping title/unit lines).",
        alignment: "US & JP aligned by common dates before computing 5-business-day trend.",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
