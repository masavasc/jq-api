import { NextRequest, NextResponse } from "next/server";

type FredObs = { date: string; value: string };
type Point = { date: string; value: number };

const VERSION = "boj-primary-mof-fallback-v1";

const FRED_US10Y = "DGS10"; // US 10Y (daily, FRED)

// BOJ direct link (set in env). If missing/unusable -> fallback to MOF historical daily.
const MOF_ALL_DAILY = "https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv";

// ---------- utils ----------
function safeNumber(s: string): number | null {
  const v = Number(String(s).trim());
  return Number.isFinite(v) ? v : null;
}

function pad2(n: string) { return n.padStart(2, "0"); }

function parseDateToISO(s: string): string | null {
  const t = String(s).trim();
  if (!t) return null;

  // YYYY-MM-DD
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  // YYYY/MM/DD
  m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  // YYYY.MM.DD
  m = t.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  return null;
}

// MOF historical "基準日" often like S49.9.24 / H1.5.7 / R8.1.6 etc.
function parseJapaneseEraDateToISO(s: string): string | null {
  const t = String(s).trim();
  if (!t) return null;

  // Era + yy.mm.dd  (S,H,R)
  const m = t.match(/^([SHR])\s*([0-9]{1,2})\.\s*([0-9]{1,2})\.\s*([0-9]{1,2})$/i);
  if (!m) return null;

  const era = m[1].toUpperCase();
  const yy = Number(m[2]);
  const mm = Number(m[3]);
  const dd = Number(m[4]);

  if (!(yy >= 1 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;

  let year = 0;
  if (era === "S") year = 1925 + yy; // Showa 1=1926
  if (era === "H") year = 1988 + yy; // Heisei 1=1989
  if (era === "R") year = 2018 + yy; // Reiwa 1=2019

  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// delimiter wobble
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

  const isShrinking = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] < v);
  const isWidening = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] > v);

  const consecutive: "shrinking" | "widening" | "mixed" =
    isShrinking ? "shrinking" : isWidening ? "widening" : "mixed";

  return { latest, prev5, delta5, avgDaily, consecutive };
}

function alignByDate(us: Point[], jp: Point[], need: number) {
  const usMap = new Map(us.map((p) => [p.date, p.value]));
  const jpMap = new Map(jp.map((p) => [p.date, p.value]));
  const commonDates = us.map((p) => p.date).filter((d) => jpMap.has(d));

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

// ---------- FRED US10Y ----------
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

// ---------- BOJ JP10Y (direct link) ----------
// Expect text/CSV/TSV with date in first column and value in second column.
// We accept many formats; pick newest 60 valid points.
async function bojLatestN_JP10Y(bojUrl: string, need: number): Promise<Point[]> {
  const res = await fetch(bojUrl, { cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`BOJ JP10Y fetch failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const text = await res.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Parse from bottom to top (newest first) using date pattern
  const out: Point[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const cols = splitRow(lines[i]);
    if (cols.length < 2) continue;

    const iso = parseDateToISO(cols[0]) ?? parseJapaneseEraDateToISO(cols[0]);
    if (!iso) continue;

    const v = safeNumber(cols[1]);
    if (v === null) continue;

    out.push({ date: iso, value: v });
    if (out.length >= need) break;
  }

  if (out.length < need) {
    throw new Error(`BOJ JP10Y: not enough valid rows (need ${need}, got ${out.length})`);
  }
  return out; // newest -> older
}

// ---------- MOF fallback (historical daily) ----------
// Use jgbcm_all.csv which contains daily rows with date in first column (era-style) and 10Y around col 10/11.
// The header line includes "基準日,1年,2年,...,10年,..."
async function mofFallbackLatestN_JP10Y(need: number): Promise<Point[]> {
  const res = await fetch(MOF_ALL_DAILY, { cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`MOF all.csv fetch failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const text = await res.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Find header row containing "基準日" and "10年"
  let headerIdx = -1;
  let tenIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const cols = splitRow(lines[i]);
    if (cols.length < 10) continue;
    const joined = cols.join(",");
    if (joined.includes("基準日") && joined.includes("10年")) {
      headerIdx = i;
      tenIdx = cols.findIndex(c => c.includes("10年"));
      break;
    }
  }
  if (headerIdx < 0 || tenIdx < 0) {
    throw new Error("MOF all.csv: header not found (基準日/10年)");
  }

  const data = lines.slice(headerIdx + 1);

  const out: Point[] = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const cols = splitRow(data[i]);
    if (cols.length <= tenIdx) continue;

    const iso =
      parseDateToISO(cols[0]) ??
      parseJapaneseEraDateToISO(cols[0]);

    if (!iso) continue;

    const v = safeNumber(cols[tenIdx]);
    if (v === null) continue;

    out.push({ date: iso, value: v });
    if (out.length >= need) break;
  }

  if (out.length < need) {
    throw new Error(`MOF all.csv: not enough JP10Y rows (need ${need}, got ${out.length})`);
  }
  return out; // newest -> older
}

// ---------- API ----------
export async function GET(_req: NextRequest) {
  try {
    const apiKey = process.env.FRED_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json({ error: "FRED_API_KEY missing", version: VERSION }, { status: 500 });
    }

    // US from FRED
    const usRaw = await fredLatestN(FRED_US10Y, apiKey, 80);

    // JP: BOJ if URL provided, else MOF fallback
    const bojUrl = (process.env.BOJ_JP10Y_URL || "").trim();
    let jpRaw: Point[] = [];
    let jpSource = "";

    if (bojUrl) {
      jpRaw = await bojLatestN_JP10Y(bojUrl, 80);
      jpSource = "BOJ";
    } else {
      jpRaw = await mofFallbackLatestN_JP10Y(80);
      jpSource = "MOF_fallback_all";
    }

    // align by common dates and compute 5D trend
    const aligned6 = alignByDate(usRaw, jpRaw, 6);

    const spread6 = aligned6.map(x => x.spread);
    const us6 = aligned6.map(x => x.us);
    const jp6 = aligned6.map(x => x.jp);

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
          last6: aligned6.map(x => ({ date: x.date, value: x.us })),
        },
        jp10y: {
          id: jpSource === "BOJ" ? "BOJ_JP10Y" : "MOF_JP10Y",
          source: jpSource,
          date: latest.date,
          value: latest.jp,
          last6: aligned6.map(x => ({ date: x.date, value: x.jp })),
        },
      },
      spread10y: {
        date: latest.date,
        value: tSpread.latest,
        unit: "pct_points",
        last6: aligned6.map(x => ({ date: x.date, value: x.spread })),
      },
      trend5d: {
        spread: tSpread,
        us10y: tUs,
        jp10y: tJp,
      },
      notes: {
        jp_source_behavior: "If BOJ_JP10Y_URL is set, use BOJ. Otherwise use MOF historical daily (jgbcm_all.csv) as official fallback.",
      },
    });

  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error", version: VERSION }, { status: 500 });
  }
}
