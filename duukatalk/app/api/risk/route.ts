import { after, NextRequest, NextResponse } from "next/server";
import { getSessionVendorId } from "@/lib/session";
import { getDb } from "@/lib/firebase";
import { dispatchVendorAlertSms } from "@/lib/dispatch-vendor-alerts";
import { evaluateRiskFlags, parseLanguage, RiskTransaction } from "@/lib/risk-flags";


export async function GET(request: NextRequest) {
  try {
    const language = parseLanguage(request.nextUrl.searchParams.get("language"));
    const vendorId = getSessionVendorId(request);

    if (!vendorId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const snapshot = await getDb()
      .collection("transactions")
      .where("vendor_id", "==", vendorId)
      .get();
    const transactions = snapshot.docs.map((docSnap) => docSnap.data() as RiskTransaction);
    const flags = evaluateRiskFlags(transactions, language);

    after(() => {
      void dispatchVendorAlertSms(language, transactions, vendorId).catch((error) => {
        console.error("Vendor alert SMS dispatch failed:", error);
      });
    });

    return NextResponse.json({ flags });
  } catch (error) {
    console.error("Error checking risk flags:", error);
    return NextResponse.json({ error: "Failed to check risk flags" }, { status: 500 });
  }
}
