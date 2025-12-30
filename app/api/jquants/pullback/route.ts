import { NextRequest, NextResponse } from "next/server";
import { getIdToken } from "../../../../lib/jquantsToken";

const jp4 = (s: string) => (s.match(/\d{4}/)?.[0] ?? "").slice(0, 4);
const jqCode5 = (t4: string) => t4 + "0";
const toYYYYMMDD = (d: Date) =>
  d.getFullYear().toString() +
  String(d.getMonth() + 1).padStart(2, "0") +
  String(d.getDate()).padStart(2, "0");

const RANGE_RE = /(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/;

function sma(arr: number[], n: number) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

function rsi(closes: number[], n = 14) {
  if (closes.length < n + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gains += ch;
    else losses -= ch;
  }
  const avgG = gains / n;
  const avgL = losses / n;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

function atr(high: number[], low: number[], close: number[], n = 14) {
  if (close.length < n + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < close.length; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }
  if (tr.length < n) return null;
  let s = 0;
  for (let i = tr.length - n; i < tr.length; i++) s += tr[i];
  return s / n;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const raw = (searchParams.get("tickers") || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    const t4s = Array.from(new Set(raw.map(jp4).filter(Boolean)));
    if (!t4s.length) {
      return NextResponse.json({ error: "tickers required (comma-separated 4-digit codes)" }, { status: 400 });
    }

    const days = Math.max(260, Math.min(600, Number(searchParams.get("days")) || 450)); // SMA200のため最低260
    const idToken = await getIdToken();

    const today = new Date();
    const from0 = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
    let from = toYYYYMMDD(from0);
    let to = toYYYYMMDD(today);

    async function fetchDaily(code: string) {
      const url = `https://api.jquants.com/v1/prices/daily_quotes?code=${code}&from=${from}&to=${to}`;
      return fetch(url, { headers: { Authorization: `Bearer ${idToken}` }, cache: "no-store" });
    }

    // もし期間外で400なら、提供終了日にクランプしてやり直す
    async function safeFetch(t4: string) {
      let res = await fetchDaily(jqCode5(t4));
      if (res.status === 400) res = await fetchDaily(t4);
      if (res.status === 400) {
        const msg = await res.text().catch(() => "");
        const m = msg.match(RANGE_RE);
        if (m) {
          const end = new Date(m[2]); // 提供終了日
          const toClamped = (today.getTime() < end.getTime()) ? today : end;
          const fromClamped = new Date(toClamped.getTime() - days * 24 * 60 * 60 * 1000);
          from = toYYYYMMDD(fromClamped);
          to = toYYYYMMDD(toClamped);
          res = await fetchDaily(jqCode5(t4));
          if (res.status === 400) res = await fetchDaily(t4);
        }
      }
      return res;
    }

    const results: any[] = [];

    for (const t4 of t4s) {
      const res = await safeFetch(t4);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        results.push({ ticker: t4, error: `${res.status} ${text}` });
        continue;
      }
      const px = await res.json();
      const q = (px.daily_quotes || []).sort((a: any, b: any) => a.Date.localeCompare(b.Date));

      const close = q.map((x: any) => Number(x.Close)).filter((v: number) => Number.isFinite(v));
      const high  = q.map((x: any) => Number(x.High)).filter((v: number) => Number.isFinite(v));
      const low   = q.map((x: any) => Number(x.Low)).filter((v: number) => Number.isFinite(v));
      const vol   = q.map((x: any) => Number(x.Volume)).filter((v: number) => Number.isFinite(v));

      if (close.length < 210 || vol.length < 30) {
        results.push({ ticker: t4, error: "insufficient history" });
        continue;
      }

      const c0 = close[close.length - 1];
      const c1 = close[close.length - 2];
      const h1 = high[high.length - 2];

      const sma50 = sma(close, 50);
      const sma200 = sma(close, 200);
      const sma200_20 = sma(close.slice(0, close.length - 20), 200); // 20日前のMA200
      const rsi14 = rsi(close, 14);
      const atr14 = atr(high, low, close, 14);

      const vol20 = sma(vol, 20);
      const vol0 = vol[vol.length - 1];

      // レジーム
      const regime =
        sma50 !== null && sma200 !== null && sma200_20 !== null &&
        sma50 > sma200 && c0 > sma200 && sma200 > sma200_20;

      // 押し目ゾーン（簡略：2/3条件）
      // 1) MA50±2%
      const near50 = sma50 ? Math.abs(c0 - sma50) / sma50 <= 0.02 : false;
      // 2) 直近20日高値から-6%以下
      const hh20 = Math.max(...high.slice(high.length - 20));
      const dd = (c0 / hh20) - 1;
      const drawdown = dd <= -0.06;
      // 3) ATR条件
      const atrOk = atr14 ? (hh20 - c0) >= 1.2 * atr14 : false;
      const dipHits = [near50, drawdown, atrOk].filter(Boolean).length >= 2;

      // 反発確認
      const confirm =
        c0 > h1 &&
        (vol20 ? vol0 >= 1.2 * vol20 : false) &&
        (rsi14 ? rsi14 >= 45 : false) &&
        (rsi14 ? rsi14 > (rsi(close.slice(0, close.length - 1), 14) ?? 0) : false);

      const signal = (regime && dipHits && confirm) ? "BUY" : "NONE";

      results.push({
        ticker: t4,
        asof: q[q.length - 1]?.Date,
        signal,
        close: c0,
        sma50,
        sma200,
        rsi14,
        atr14,
        vol: vol0,
        vol20,
        drawdown20: dd
      });
    }

    // BUYだけ返すモード（?only=buy）
    const only = (searchParams.get("only") || "").toLowerCase();
    const out = (only === "buy") ? results.filter(x => x.signal === "BUY") : results;

    return NextResponse.json({ count: out.length, results: out });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
