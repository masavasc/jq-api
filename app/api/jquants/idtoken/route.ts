// app/api/jquants/idtoken/route.ts
import { NextResponse } from "next/server";
import { getIdToken } from "../../../../lib/jquantsToken";

export async function GET() {
  const token = await getIdToken();
  return NextResponse.json({ idToken: token });
}
