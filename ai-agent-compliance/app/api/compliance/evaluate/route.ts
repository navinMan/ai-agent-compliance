import { NextRequest, NextResponse } from "next/server";
import { evaluateCompliance, AgentLogPayloadSchema } from "@/lib/compliance/evaluator";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = AgentLogPayloadSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid agent payload", details: parsed.error.format() },
        { status: 400 }
      );
    }

    const report = evaluateCompliance(parsed.data);

    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    console.error("Compliance evaluation error:", error);
    return NextResponse.json(
      { error: "Internal compliance evaluation failed" },
      { status: 500 }
    );
  }
}
