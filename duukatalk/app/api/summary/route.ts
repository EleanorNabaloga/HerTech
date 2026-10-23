import { NextRequest, NextResponse } from "next/server";
import { getVendorCurrency } from "@/lib/auth";
import { getSessionVendorId } from "@/lib/session";
import { getDb } from "@/lib/firebase";
import {
  buildLoanGuidance,
  isOutstandingCredit,
  normalizeCustomerName,
  parseGuidanceLanguage,
} from "@/lib/credit";


export async function GET(request: NextRequest) {
  try {
    // Get the logged-in vendor ID from the authentication cookie.
    const vendorId = getSessionVendorId(request);

    if (!vendorId) {
      return NextResponse.json(
        {
          error: "Not authenticated",
        },
        { status: 401 }
      );
    }

    const language = parseGuidanceLanguage(
      request.nextUrl.searchParams.get("language")
    );

    // Fetch only transactions belonging to this vendor.
    const snapshot = await getDb()
      .collection("transactions")
      .where("vendor_id", "==", vendorId)
      .get();
    const transactions = snapshot.docs.map((doc) => doc.data());

    let totalSales = 0;
    let totalCreditOutstanding = 0;

    const perCustomerCredit: Record<string, number> = {};

    // Balances come only from the transactions themselves. The saved
    // customer balance already includes these same sales, so adding both
    // counted every debt twice.
    for (const txn of transactions) {
      const amount = Number(txn.total_amount) || 0;

      // Cash transactions and settled credit transactions
      // count toward total sales.
      if (
        txn.payment_type === "cash" ||
        txn.settled === true
      ) {
        totalSales += amount;
      }

      // Only genuinely outstanding credit transactions
      // should count as money still owed.
      if (isOutstandingCredit(txn)) {
        totalCreditOutstanding += amount;

        const name = String(
          txn.customer_name || "Unknown"
        );

        const key = normalizeCustomerName(name);

        perCustomerCredit[key] =
          (perCustomerCredit[key] || 0) + amount;
      }
    }

    // Build the loan and savings guidance using the vendor's
    // sales and outstanding credit figures.
    const guidance = buildLoanGuidance(
      totalSales,
      totalCreditOutstanding,
      language,
      await getVendorCurrency(vendorId)
    );

    return NextResponse.json({
      totalSales,
      totalCreditOutstanding,
      perCustomerCredit,

      adviceCode: guidance.adviceCode,
      recommendedSavings: guidance.recommendedSavings,
      savingsPercent: guidance.savingsPercent,
      loanReadinessScore: guidance.loanReadinessScore,
      loanAdvice: guidance.loanAdvice,
      creditToSalesRatio: guidance.creditToSalesRatio,
      creditSharePercent: guidance.creditSharePercent,
      shouldStopLending: guidance.shouldStopLending,
    });
  } catch (error) {
    console.error(
      "Failed to fetch transaction summary:",
      error
    );

    return NextResponse.json(
      {
        error: "Failed to fetch transaction summary",
      },
      { status: 500 }
    );
  }
}
