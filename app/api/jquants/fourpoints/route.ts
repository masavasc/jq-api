import { NextRequest, NextResponse } from "next/server";
import { getIdToken } from "@/lib/jquantsToken";

const jp4 = (s: string) => (s.match(/\d{4}/)?.[0] ?? "").slice(0,4);
const jqCode = (t4: string) => t4 + "0";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const raw = (searchParams.get("tickers") || "").split(",").map(s=>s.trim()).filter(Boolean);
    const t4s = Array.from(new Set(raw.map(jp4).filter(Boolean)));
    if (!t4s.length) return NextResponse.json({ error: "tickers required" }, { status: 400 });

    const idToken = await getIdToken();
    const from = new Date(Date.now() - 120*24*60*60*1000).toISOString().slice(0,10);
    const to   = new Date().toISOString().slice(0,10);

    const rows:any[] = [];
    for (const t4 of t4s) {
      const code = jqCode(t4);
      const px = await fetch(`https://api.jquants.com/v1/prices/daily_quotes?code=${code}&from=${from}&to=${to}`, {
        headers: { Authorization: `Bearer ${idToken}` }, cache: "no-store"
      }).then(r=>r.json());

      const q = (px.daily_quotes||[]).sort((a:any,b:any)=>a.Date.localeCompare(b.Date));
      const pick = (o:number)=> q[Math.max(0,q.length-1-o)];
      const p0  = pick(0)?.Close ?? "";
      const p30 = pick(22)?.Close ?? "";
      const p60 = pick(44)?.Close ?? "";
      const p90 = pick(66)?.Close ?? "";

      rows.push({
        ticker: t4, sector: "",
        price_t90: p90, price_t60: p60, price_t30: p30, price_t0: p0,
        per_t90: "", per_t60: "", per_t30: "", per_t0: "",
        pbr_t90: "", pbr_t60: "", pbr_t30: "", pbr_t0: "",
        roe_t90: "", roe_t60: "", roe_t30: "", roe_t0: "",
        roic_t90: "", roic_t60: "", roic_t30: "", roic_t0: "",
        cagr_t90: "", cagr_t60: "", cagr_t30: "", cagr_t0: "",
        fcf_t90: "", fcf_t60: "", fcf_t30: "", fcf_t0: "",
        consensus_eps_revision_1m: ""
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

    return NextResponse.json({ csv, count: rows.length, note: "まずは価格4点だけ返す骨組み。後でPER/PBR/ROE等を実レスポンスに合わせて実装。" });
  } catch (e:any) {
    return NextResponse.json({ error: e.message ?? "error" }, { status: 500 });
  }
}
