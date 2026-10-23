import { NextRequest, NextResponse } from "next/server";
import { getVendorCurrency } from "@/lib/auth";
import { getSessionVendorId } from "@/lib/session";
import { getDb } from "@/lib/firebase";
import {
  findByClientId,
  parseClientId,
  toFirestoreTransaction,
} from "@/lib/firestore-transaction";
import { notifyAfterTransaction } from "@/lib/notify-transaction";
import { updateCustomerCredit } from "@/lib/updateCustomerCredit";
import { getNextTransactionId } from "@/lib/transaction-id";
import { creditLimitWarning, parseLanguage } from "@/lib/risk-flags";
import { CREDIT_LIMIT, normalizeCustomerName } from "@/lib/credit";


export async function GET(request: NextRequest) {
  try {
    const vendorId = getSessionVendorId(request);

    if (!vendorId) {
      return NextResponse.json(
        {
          error: "Not authenticated",
        },
        { status: 401 }
      );
    }

    const snapshot = await getDb()
      .collection("transactions")
      .where("vendor_id", "==", vendorId)
      .get();

    const transactions = snapshot.docs.map((docSnap) => ({
      ...docSnap.data(),
      id: docSnap.id,
    }));

    return NextResponse.json({ transactions });
  } catch (error) {
    console.error("Error fetching ledger:", error);

    return NextResponse.json(
      {
        error: "Failed to fetch transactions",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const vendorId = getSessionVendorId(request);

    if (!vendorId) {
      return NextResponse.json(
        {
          error: "Not authenticated",
        },
        { status: 401 }
      );
    }

    const body = (await request.json()) as {
      customer?: string;
      customer_name?: string;
      item?: string;
      amount?: number;
      total_amount?: number;
      paymentType?: "cash" | "credit";
      payment_type?: "cash" | "credit";
      dueDate?: string | null;
      phone?: string | null;
      language?: string;
      acknowledgedWarning?: boolean;
      clientId?: string;
    };

    // Offline entries carry the phone's id for them. If this one was
    // already saved (a retry after a dropped connection), return it.
    const clientId = parseClientId(body.clientId);
    if (clientId) {
      const existing = await findByClientId(vendorId, clientId);
      if (existing) {
        return NextResponse.json(
          { id: existing.id, transaction: existing, duplicate: true },
          { status: 200 }
        );
      }
    }

    const customer = (body.customer ?? body.customer_name)?.trim();
    const customerKey = `${vendorId}_${normalizeCustomerName(customer)}`;
    const item = body.item?.trim();
    const amount = Number(body.amount ?? body.total_amount);

    const paymentType =
      (body.paymentType ?? body.payment_type) === "credit"
        ? "credit"
        : "cash";

    if (!customer || !item || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        {
          error: "customer, item, and a positive amount are required",
        },
        { status: 400 }
      );
    }

    const language = parseLanguage(body.language);

    if (paymentType === "credit") {
      const customerSnap = await getDb()
        .collection("customers")
        .doc(customerKey)
        .get();

      const outstandingCredit = customerSnap.exists
        ? Number(customerSnap.data()?.outstanding_credit || 0)
        : 0;

      if (
        outstandingCredit >= CREDIT_LIMIT &&
        body.acknowledgedWarning !== true
      ) {
        return NextResponse.json(
          {
            error: creditLimitWarning(
              language,
              customer,
              outstandingCredit,
              await getVendorCurrency(vendorId),
            ),
          },
          { status: 409 }
        );
      }
    }

    const transactionId = await getNextTransactionId();
    const timestamp = new Date().toISOString();

    const transactionRef = getDb()
      .collection("transactions")
      .doc(transactionId);

    const firestoreTransaction = toFirestoreTransaction(
      {
        item,
        quantity: 1,
        unit: null,
        unitPrice: amount,
        customerName: customer,
        paymentType,
        dueDate:
          paymentType === "credit"
            ? (body.dueDate ?? null)
            : null,
        timestamp,
        totalAmount: 1 * amount,
      },
      "manual entry",
      transactionId,
      vendorId
    );

    await transactionRef.set({ ...firestoreTransaction, client_id: clientId });

    let outstandingCredit: number | undefined;

    if (paymentType === "credit") {
      outstandingCredit =
        (await updateCustomerCredit(vendorId, customer, amount)) ?? undefined;
    }

    void notifyAfterTransaction({
      customerName: customer,
      paymentType,
      item,
      amount,
      quantity: 1,
      dueDate: firestoreTransaction.due_date,
      outstandingCredit,
      customerPhone: body.phone,
      language,
      vendorId,
    }).catch((error) => {
      console.error("Background notification fan-out failed:", error);
    });

    return NextResponse.json(
      {
        id: transactionId,
        transaction: firestoreTransaction,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error recording ledger entry:", error);

    return NextResponse.json(
      {
        error: "Failed to record transaction",
      },
      { status: 500 }
    );
  }
}