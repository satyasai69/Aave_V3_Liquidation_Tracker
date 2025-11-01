import { NextRequest, NextResponse } from "next/server";
import { getSnapshot } from "@/lib/liquidations";

const clampLimit = (value: number) =>
  Math.min(Math.max(Math.round(value), 1), 200);

export async function GET(request: NextRequest) {
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? clampLimit(Number(limitParam)) : 50;

  const snapshot = await getSnapshot(limit);
  return NextResponse.json(snapshot);
}
