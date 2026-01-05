import { NextRequest, NextResponse } from "next/server";

type FredObs = { date: string; value: string };

// FREDから直近n件（有効値のみ）を新しい順で取る
async function fredLatestN(seriesId: string, apiKey: string, need: number) {
  // 欠損値が混ざるので多めに取る（直近180日）
  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${encodeURIComponent(apiKey)}` +
    `&file_type=json` +
    `&sort_order=desc` +
    `&limit=180`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`FRED fetch failed ${seriesId}: ${res.status} ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const obs: FredObs[] = json.observations || [];

  const out: { date: string; value: number }[] = [];
  for (const o of obs) {
    const v = Number(o.value);
    if (Number.isFinite(v)) {
      out.push({ date: o.date, value: v });
      if (out.length >= need) break;
    }
  }
  if (out.length < need) {
    throw new Error(`Not enough valid observations for ${seriesId} (need ${need}, got ${out.length})`);
  }
  return out; // newest -> older
}

// 直近6点（= 5日差分・5日連続判定に必要）からトレンドを計算
function trend5(valuesNewestFirst: number[]) {
  // valuesNewestFirst.length >= 6 を想定（最新, 1日前, ... 5日前）
  const latest = valuesNewestFirst[0];
  const prev5 = valuesNewestFirst[5];
  const delta5 = latest - prev5; // 5営業日差分（スプレッドの変化量）

  // 5日連続の方向性（単調性）
  // 連続縮小：v0 < v1 < v2 < v3 < v4 < v5（新→旧で小さいほど縮小）
  // 連続拡大：v0 > v1 > v2 > v3 > v4 > v5
  let consecutive = "mixed" as "shrinking" | "widening" | "mixed";
  const shrinking = valuesNewestFirst.every((v, i, arr) => i === 0 || v < arr[i - 1]); // v0 < v(-1) は常にfalse、なので逆
  // ↑これだと判定が逆になるので、正しくは「最新が一番小さい」方向で比較する必要がある
  // valuesNewestFirst: [v0(最新), v1, v2, v3, v4, v5(5日前)]
  // 連続縮小（毎日縮んでいる）＝ v0 < v1 < v2 < v3 < v4 < v5
  const isShrinking = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] < v);
  // 連続拡大（毎日広がっている）＝ v0 > v1 > v2 > v3 > v4 > v5
  const isWidening = valuesNewestFirst.every((v, i, arr) => i === 0 || arr[i - 1] > v);

  if (isShrinking) consecutive = "shrinking";
  else if (isWidening) consecutive = "widening";

  // 5日平均変化（目安）
  const avgDaily = delta5 / 5;

  return { latest, prev5, delta5, avgDaily, consecutive };
}

export async function GET(_req: NextRequest) {
  try {
    const apiKey = process.env.FRED_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json({ error: "FRED_API_KEY missing" }, { status: 500 });
    }

    // series（安定運用：10年）
    const US_ID = "DGS10";
    const JP_ID = "IRLTLT01JPM156N";

    // 直近6点（= 5日トレンド計算に必要）
    const us6 = await fredLatestN(US_ID, apiKey, 6);
    const jp6 = await fredLatestN(JP_ID, apiKey, 6);

    // スプレッド（同じ“日付”で揃わない可能性があるので、日付はそれぞれ保持しつつ値で計算）
    // ※FREDは営業日欠けや更新タイミング差があるため、厳密な日付アラインは別実装が必要。
    // まずは「直近同士の6点」でトレンドを見る（実務ではこれで十分なことが多い）。
    const spread6 = us6.map((u, i) => u.value - jp6[i].value); // newest -> older

    const tSpread = trend5(spread6);
    const tUs = trend5(us6.map(x => x.value));
    const tJp = trend5(jp6.map(x => x.value));

    return NextResponse.json({
      ok: true,
      series: {
        us10y: { id: US_ID, date: us6[0].date, value: us6[0].value, last6: us6 },
        jp10y: { id: JP_ID, date: jp6[0].date, value: jp6[0].value, last6: jp6 },
      },
      spread10y: {
        // 最新値
        date: us6[0].date, // 便宜上US側の日付（両者がズレる場合がある点は注意）
        value: tSpread.latest,
        unit: "pct_points",
        last6: spread6.map((v, i) => ({
          // 参考：各点の“組み合わせ日付”としてUS側日付を置く（より厳密にするなら日付アライン実装）
          date: us6[i].date,
          value: v,
        })),
      },
      trend5d: {
        // スプレッド（=日米金利差）の5日トレンド
        spread: {
          delta5: tSpread.delta5,          // 最新 - 5日前（%pt）
          avgDaily: tSpread.avgDaily,      // 1日あたり平均
          consecutive: tSpread.consecutive // shrinking / widening / mixed
        },
        // 参考：内訳（US / JP の5日変化）
        us10y: {
          delta5: tUs.delta5,
          avgDaily: tUs.avgDaily,
          consecutive: tUs.consecutive
        },
        jp10y: {
          delta5: tJp.delta5,
          avgDaily: tJp.avgDaily,
          consecutive: tJp.consecutive
        }
      }
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
