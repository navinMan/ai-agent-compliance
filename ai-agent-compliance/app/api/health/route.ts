import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "healthy",
    service: "AI Compliance Engine",
    timestamp: new Date().toISOString(),
  });
}
