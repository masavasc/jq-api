// lib/jquantsToken.ts
let cached: { token: string; expiresAt: number } | null = null;

async function fetchIdToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const mail = process.env.JQ_MAIL!;
  const pass = process.env.JQ_PASS!;
  if (!mail || !pass) throw new Error("Missing JQ_MAIL/JQ_PASS");

  // ① refreshToken
  const r1 = await fetch("https://api.jquants.com/v1/token/auth_user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mailaddress: mail, password: pass }),
    cache: "no-store",
  });
  if (!r1.ok) throw new Error(`auth_user failed: ${r1.status}`);
  const j1 = await r1.json();

  // ② idToken
  const r2 = await fetch(
    "https://api.jquants.com/v1/token/auth_refresh?refreshtoken=" + j1.refreshToken,
    { method: "POST", cache: "no-store" }
  );
  if (!r2.ok) throw new Error(`auth_refresh failed: ${r2.status}`);
  const j2 = await r2.json();

  // 24h有効だが安全に23hで更新
  cached = { token: j2.idToken as string, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
  return cached.token;
}

export async function getIdToken(): Promise<string> {
  try {
    return await fetchIdToken();
  } catch {
    cached = null;
    return await fetchIdToken();
  }
}
