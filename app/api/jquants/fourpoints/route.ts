import { NextRequest, NextResponse } from "next/server";
import { getIdToken } from "../../../../lib/jquantsToken";

const jp4 = (s: string) => (s.match(/\d{4}/)?.[0] ?? "").slice(0, 4);
const jqCode5 = (t4: string) => t4 + "0";
const toYYYYMMDD = (d: Date) =>
  d.getFullYear().toString() +
  String(d.getMonth() + 1).padStart(2, "0") +
  String(d.getDate()).padStart(2, "0");

// "2023-08-14 ~ 2025-08-14" を抽出するための簡易正規表現
const RANGE_RE = /(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rawTickers = (searchParams.get("tickers") || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    const t4s = Array.from(new Set(rawTickers.map(jp4).filter(Boolean)));
    if (!t4s.length) return NextResponse.json({ error: "tickers required (comma-separated 4-digit codes)" }, { status: 400 });

    // 取得期間（日数）。指定がなければ 120 日
    const days = Math.max(5, Math.min(365, Number(searchParams.get("days")) || 120));

    const idToken = await getIdToken();

    // まずは通常どおり「今日」を上限として期間を作成
    const tryFetch = async (t4: string, toDate: Date) => {
      const fromDate = new Date(toDate.getTime() - days * 24 * 60 * 60 * 1000);
      const from = toYYYYMMDD(fromDate);
      const to = toYYYYMMDD(toDate);

      const fetchDaily = async (code: string) => {
        const url = `https://api.jquants.com/v1/prices/daily_quotes?code=${code}&from=${from}&to=${to}`;
        return fetch(url, { headers: { Authorization: `Bearer ${idToken}` }, cache: "no-store" });
      };

      // 5桁 → 400なら4桁
      let res = await fetchDaily(jqCode5(t4));
      if (res.status === 400) res = await fetchDaily(t4);
      return res;
    };

    const rows: any[] = [];
    const today = new Date();

    for (const t4 of t4s) {
      // 1) まず「今日」を上限に試行
      let res = await tryFetch(t4, today);

      // 2) もし 400 なら、エラーテキストから提供期間を読み取り、終了日にクランプして再試行
      if (res.status === 400) {
        const msg = await res.text().catch(() => "");
        const m = msg.match(RANGE_RE);
        if (m) {
          const end = new Date(m[2]); // 提供終了日
          // to = min(今日, 終了日)
          const toClamped = (today.getTime() < end.getTime()) ? today : end;
          // from は days だけ巻き戻す（提供開始より前に行ってしまう場合は更に短くなるがOK）
          res = await tryFetch(t4, toClamped);
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`prices failed: ${t4} (${res.status}) ${text}`);
      }

      const px = await res.json();
      const quotes = (px.daily_quotes || []).sort((a: any, b: any) => a.Date.localeCompare(b.Date));
      const pick = (off: number) => quotes[Math.max(0, quotes.length - 1 - off)];
      const p0  = pick(0)?.Close ?? "";
      const p30 = pick(22)?.Close ?? "";
      const p60 = pick(44)?.Close ?? "";
      const p90 = pick(66)?.Close ?? "";

      rows.push({
        ticker: t4, sector: "",
        price_t90: p90, price_t60: p60, price_t30: p30, price_t0: p0,
        // ファンダ列はあとで実装（placeholder）
        per_t90: "", per_t60: "", per_t30: "", per_t0: "",
        pbr_t90: "", pbr_t60: "", pbr_t30: "", pbr_t0: "",
        roe_t90: "", roe_t60: "", roe_t30: "", roe_t0: "",
        roic_t90: "", roic_t60: "", roic_t30: "", roic_t0: "",
        cagr_t90: "", cagr_t60: "", cagr_t30: "", cagr_t0: "",
        fcf_t90: "", fcf_t60: "", fcf_t30: "", fcf_t0: "",
        consensus_eps_revision_1m: "",
      });
    }

    const header = [
      "ticker","sector",
      "price_t90","price_t60","price_t30","price_t0",
      "per_t90","per_t60","per_t30","per_t0",
      "pbr_t90","pbr_t60","pbr_t30","pbr_t0",
      "roe_t90","roe_t60","roe_t30","roe_t0",
      "roic_t90","roic_t60","roic_t30","roic_t0",
      "cagr_t90","cagr_t60","cagr_t30","cagr_t0",
      "fcf_t90","fcf_t60","fcf_t30","fcf_t0",
      "consensus_eps_revision_1m"
    ];
    const csv = [header.join(",")]
      .concat(rows.map(r => header.map(h => r[h] ?? "").join(",")))
      .join("\n");

    return NextResponse.json({
      csv, count: rows.length,
      note: "date-window is auto-clamped to your subscription range when 400 occurs; optional ?days=N (default 120)"
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
