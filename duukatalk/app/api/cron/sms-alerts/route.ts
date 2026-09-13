import { NextRequest, NextResponse } from "next/server";
import { dispatchVendorAlertSms } from "@/lib/dispatch-vendor-alerts";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await dispatchVendorAlertSms("en", undefined, undefined);
    console.log("Scheduled overdue-debt SMS sweep:", result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Scheduled SMS sweep failed:", error);
    return NextResponse.json({ error: "Failed to run scheduled SMS sweep" }, { status: 500 });
  }
}