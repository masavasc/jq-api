// app/api/jquants/fourpoints/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getIdToken } from "../../../../lib/jquantsToken";

// 4桁コード抽出（安全のため余分文字を除去）
const jp4 = (s: string) => (s.match(/\d{4}/)?.[0] ?? "").slice(0, 4);
// J-Quantsの銘柄コードは基本5桁（末尾0）を使用
const jqCode5 = (t4: string) => t4 + "0";

// J-Quantsの /prices/daily_quotes は YYYYMMDD を要求
const toYYYYMMDD = (d: Date) =>
  d.getFullYear().toString() +
  String(d.getMonth() + 1).padStart(2, "0") +
  String(d.getDate()).padStart(2, "0");

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const raw = (searchParams.get("tickers") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const t4s = Array.from(new Set(raw.map(jp4).filter(Boolean)));
    if (!t4s.length) {
      return NextResponse.json(
        { error: "tickers required (comma-separated 4-digit codes)" },
        { status: 400 }
      );
    }

    // 認証トークンはサーバ側で自動発行＆キャッシュ
    const idToken = await getIdToken();

    const from = toYYYYMMDD(new Date(Date.now() - 120 * 24 * 60 * 60 * 1000)); // 120日前
    const to = toYYYYMMDD(new Date());

    const rows: any[] = [];

    // 価格4点だけまず配管を通す（ファンダ列は後で実データに合わせて実装）
    for (const t4 of t4s) {
      const code5 = jqCode5(t4);

      // まず5桁で試行 → 400なら4桁でフォールバック
      async function fetchDailyQuotes(code: string) {
        const url = `https://api.jquants.com/v1/prices/daily_quotes?code=${code}&from=${from}&to=${to}`;
        return fetch(url, {
          headers: { Authorization: `Bearer ${idToken}` },
          cache: "no-store",
        });
      }

      let pxRes = await fetchDailyQuotes(code5);
      if (pxRes.status === 400) {
        // 仕様差・環境差に備えて4桁でもう一度
        pxRes = await fetchDailyQuotes(t4);
      }
      if (!pxRes.ok) {
        const msg = await pxRes.text().catch(() => "");
        throw new Error(`prices failed: ${t4} (${pxRes.status}) ${msg}`);
      }

      const px = await pxRes.json();
      const quotes = (px.daily_quotes || []).sort((a: any, b: any) =>
        a.Date.localeCompare(b.Date)
      );
      const pick = (off: number) => quotes[Math.max(0, quotes.length - 1 - off)];
      const p0 = pick(0)?.Close ?? "";
      const p30 = pick(22)?.Close ?? ""; // おおよそ1か月(営業日22日)前
      const p60 = pick(44)?.Close ?? "";
      const p90 = pick(66)?.Close ?? "";

      rows.push({
        ticker: t4,
        sector: "",
        price_t90: p90,
        price_t60: p60,
        price_t30: p30,
        price_t0: p0,

        // ▼ ファンダは“器”のみ（後でsummary/balance/cfの実レスポンスに合わせて埋める）
        per_t90: "",
        per_t60: "",
        per_t30: "",
        per_t0: "",
        pbr_t90: "",
        pbr_t60: "",
        pbr_t30: "",
        pbr_t0: "",
        roe_t90: "",
        roe_t60: "",
        roe_t30: "",
        roe_t0: "",
        roic_t90: "",
        roic_t60: "",
        roic_t30: "",
        roic_t0: "",
        cagr_t90: "",
        cagr_t60: "",
        cagr_t30: "",
        cagr_t0: "",
        fcf_t90: "",
        fcf_t60: "",
        fcf_t30: "",
        fcf_t0: "",

        // EPSリビジョン（+1/0/-1）は後で別エンドポイントから算出
        consensus_eps_revision_1m: "",
      });
    }

    // CSVに整形（キャンバスのヘッダに合わせる）
    const header = [
      "ticker",
      "sector",
      "price_t90",
      "price_t60",
      "price_t30",
      "price_t0",
      "per_t90",
      "per_t60",
      "per_t30",
      "per_t0",
      "pbr_t90",
      "pbr_t60",
      "pbr_t30",
      "pbr_t0",
      "roe_t90",
      "roe_t60",
      "roe_t30",
      "roe_t0",
      "roic_t90",
      "roic_t60",
      "roic_t30",
      "roic_t0",
      "cagr_t90",
      "cagr_t60",
      "cagr_t30",
      "cagr_t0",
      "fcf_t90",
      "fcf_t60",
      "fcf_t30",
      "fcf_t0",
      "consensus_eps_revision_1m",
    ];

    const csv =
      [header.join(",")]
        .concat(rows.map((r) => header.map((h) => r[h] ?? "").join(",")))
        .join("\n");

    return NextResponse.json({
      csv,
      count: rows.length,
      note:
        "prices: from/to=YYYYMMDD. 5桁コード(末尾0)→400なら4桁で再試行。ファンダ列はplaceholder。",
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "error" },
      { status: 500 }
    );
  }
}
