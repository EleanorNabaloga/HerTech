import { NextRequest, NextResponse } from "next/server";
import { getSessionVendorId } from "@/lib/session";
import { dispatchVendorAlertSms, getAlertSummary } from "@/lib/dispatch-vendor-alerts";
import { isSmsConfigured } from "@/lib/sms";
import { parseLanguage } from "@/lib/risk-flags";

async function dispatchAlertSms(request: NextRequest, bodyOverride?: { language?: string }) {
  if (!isSmsConfigured()) {
    return NextResponse.json(
      { error: "Africa's Talking is not configured. Set AT_USERNAME and AT_API_KEY in .env.local." },
      { status: 503 },
    );
  }

  const queryLanguage = request.nextUrl.searchParams.get("language");
  const bodyLanguage = bodyOverride?.language;
  const language = parseLanguage(bodyLanguage || queryLanguage);
  const vendorId = getSessionVendorId(request);
  if (!vendorId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const sms = await dispatchVendorAlertSms(language, undefined, vendorId);
  return NextResponse.json({ ok: true, ...sms });
}

export async function GET(request: NextRequest) {
  try {
    const vendorId = getSessionVendorId(request);
    if (!vendorId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const summary = await getAlertSummary(vendorId);
    return NextResponse.json(summary);
  } catch (error) {
    console.error("Vendor alert summary lookup failed:", error);
    return NextResponse.json({ error: "Failed to read vendor alert summary" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    let body: { language?: string } = {};
    try {
      body = (await request.json()) as { language?: string };
    } catch {
      body = {};
    }

    return await dispatchAlertSms(request, body);
  } catch (error) {
    console.error("Vendor alert SMS sweep failed:", error);
    return NextResponse.json({ error: "Failed to send vendor alert SMS" }, { status: 500 });
  }
}
