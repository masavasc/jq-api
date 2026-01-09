import { NextRequest, NextResponse } from "next/server";

type FredObs = { date: string; value: string };
type Point = { date: string; value: number };

const VERSION = "mof-header-skip-v4";
const FRED_US10Y = "DGS10";
const MOF_JGBCM_CSV = "https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv";

// ---------- utils ----------
function safeNumber(s: string): number | null {
  const v = Number(String(s).trim());
  return Number.isFinite(v) ? v : null;
}

function parseDateToISO(s: string): string | null {
  const t = String(s).trim();
  if (!t) return null;

  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;

  m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;

  m = t.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;

  return null;
}

function decodeCsv(buf: ArrayBuffer): string {
  try {
    // @ts-ignore
    return new TextDecoder("shift_jis").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

// カンマ/全角カンマ/タブの揺れを吸収
function splitRow(line: string): string[] {
  // BOM除去
  let s = line.replace(/^\uFEFF/, "").trim();
  // 全角カンマを半角へ
  s = s.replace(/，/g, ",");
  // まずカンマで割る
  let cols = s.split(",").map((x) => x.trim());
  // もしほぼ1列ならタブ区切りの可能性
  if (cols.length <= 1) cols = s.split("\t").map((x) => x.trim());
  return cols;
}

function normalizeHeader(s: string): string {
  return s
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isLikelyMetaLine(line: string): boolean {
  return (
    /国債金利情報/.test(line) ||
    /単位/.test(line) ||
    /（単位/.test(line) ||
    /月/.test(line) && /令和/.test(line) ||
    /^#/.test(line)
  );
}

function hasTenYear(cols: string[]): boolean {
  const norm = cols.map(normalizeHeader);
  return norm.some((h) => h === "10年" || h === "10" || h.includes("10年") || h.includes("10y") || h.includes("10year"));
}

function findDateCol(cols: string[]): number {
  const norm = cols.map(normalizeHeader);
  // 日付の呼び方揺れに対応
  const idx = norm.findIndex((h) =>
    h === "日付" ||
    h.includes("日付") ||
    h === "date" ||
    h.includes("年月日") ||
    h.includes("年月")
  );
  return idx;
}

function find10yCol(headers: string[]): number {
  const norm = headers.map(normalizeHeader);
  // 強めの候補
  const idx =
    norm.findIndex((h) => h === "10年") >= 0 ? norm.findIndex((h) => h === "10年") :
    norm.findIndex((h) => h === "10") >= 0 ? norm.findIndex((h) => h === "10") :
    norm.findIndex((h) => h.includes("10年")) >= 0 ? norm.findIndex((h) => h.includes("10年")) :
    norm.findIndex((h) => h.includes("10y")) >= 0 ? norm.findIndex((h) => h.includes("10y")) :
    norm.findIndex((h) => h.includes("10year")) >= 0 ? norm.findIndex((h) => h.includes("10year")) :
    -1;
  return idx;
}

// ヘッダー検出：
// 1) 「日付」+「10年」を含む行を探す（最優先）
// 2) 「10年」を含む行の“次行”が日付データなら、その行をヘッダーとみなす（2段構造対応）
// 3) それもなければ「最初のデータ行（先頭列が日付）」の直前行をヘッダー候補にする
function detectHeader(lines: string[]) {
  const maxScan = Math.min(lines.length, 200);

  // (1) 直球のヘッダー
  for (let i = 0; i < maxScan; i++) {
    const raw = lines[i];
    if (isLikelyMetaLine(raw)) continue;

    const cols = splitRow(raw);
    if (cols.length < 6) continue;

    const dateIdx = findDateCol(cols);
    const tenOk = hasTenYear(cols);

    if (dateIdx >= 0 && tenOk) {
      return { headerIndex: i, headers: cols, dateIdx, tenIdx: find10yCol(cols) };
    }
  }

  // (2) 2段構造（上段に年限、次行からデータ）
  for (let i = 0; i < maxScan - 1; i++) {
    const raw = lines[i];
    if (isLikelyMetaLine(raw)) continue;

    const cols = splitRow(raw);
    if (cols.length < 6) continue;

    if (!hasTenYear(cols)) continue;

    const next = splitRow(lines[i + 1]);
    if (next.length >= 2) {
      const d = parseDateToISO(next[0]) ?? parseDateToISO(next[findDateCol(next)] ?? "");
      if (d) {
        // ヘッダー行に日付名が無くても、日付列は先頭と仮定
        const tenIdx = find10yCol(cols);
        if (tenIdx >= 0) return { headerIndex: i, headers: cols, dateIdx: 0, tenIdx };
      }
    }
  }

  // (3) データ行の直前をヘッダー候補にする
  for (let i = 1; i < maxScan; i++) {
    const cols = splitRow(lines[i]);
    if (cols.length < 6) continue;

    const d0 = parseDateToISO(cols[0]);
    if (!d0) continue;

    // ある程度数値が入っている（データ行らしい）ことを確認
    const numericCount = cols.slice(1, Math.min(cols.length, 10)).map(safeNumber).filter(v => v !== null).length;
    if (numericCount >= 3) {
      // 直前行をヘッダーとみなす
      const hdr = splitRow(lines[i - 1]);
      const tenIdx = find10yCol(hdr);
      if (hdr.length >= 6 && tenIdx >= 0) {
        return { headerIndex: i - 1, headers: hdr, dateIdx: 0, tenIdx };
      }
    }
  }

  // デバッグ情報（先頭数行を返す）
  const head = lines.slice(0, Math.min(20, lines.length)).join("\\n");
  throw new Error(`MOF CSV: header row not found. version=${VERSION}. head20=${head.slice(0, 800)}`);
}

function calcTrend5(valuesNewestFirst: number[]) {
  if (valuesNewestFirst.length < 6) throw new Error(`Need at least 6 points for 5D trend, got ${valuesNewestFirst.length}`);
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

// ---------- FRED ----------
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
  if (out.length < need) throw new Error(`Not enough valid observations for ${seriesId} (need ${need}, got ${out.length})`);
  return out; // newest -> older
}

// ---------- MOF ----------
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

  const { headerIndex, headers, dateIdx, tenIdx } = detectHeader(lines);
  if (tenIdx < 0) throw new Error(`MOF CSV: 10Y column not found. version=${VERSION}. headers=${headers.join("|")}`);

  const dataLines = lines.slice(headerIndex + 1);

  const out: Point[] = [];
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const cols = splitRow(dataLines[i]);
    if (cols.length <= Math.max(dateIdx, tenIdx)) continue;

    const iso = parseDateToISO(cols[dateIdx]);
    if (!iso) continue;

    const v = safeNumber(cols[tenIdx]);
    if (v === null) continue;

    out.push({ date: iso, value: v });
    if (out.length >= need) break;
  }

  if (out.length < need) {
    throw new Error(`MOF CSV: not enough valid JP10Y points (need ${need}, got ${out.length}). version=${VERSION}`);
  }

  return out; // newest -> older
}

// ---------- alignment ----------
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
    throw new Error(`Not enough common dates to align (need ${need}, got ${aligned.length}). version=${VERSION}`);
  }

  return aligned; // newest -> older
}

// ---------- API ----------
export async function GET(_req: NextRequest) {
  try {
    const apiKey = process.env.FRED_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json({ error: "FRED_API_KEY missing", version: VERSION }, { status: 500 });
    }

    const usRaw = await fredLatestN(FRED_US10Y, apiKey, 40);
    const jpRaw = await mofLatestN_JP10Y(40);

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
        jp_source: "MOF jgbcm.csv (daily). Header auto-detected with fallbacks.",
        alignment: "US & JP aligned by common dates.",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error", version: VERSION }, { status: 500 });
  }
}
