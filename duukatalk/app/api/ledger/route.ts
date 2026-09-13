import { NextRequest, NextResponse } from "next/server";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { toFirestoreTransaction } from "@/lib/firestore-transaction";
import { notifyAfterTransaction } from "@/lib/notify-transaction";
import { updateCustomerCredit } from "@/lib/updateCustomerCredit";
import { getNextTransactionId } from "@/lib/transaction-id";
import { localize, parseLanguage } from "@/lib/risk-flags";
import { CREDIT_LIMIT, normalizeCustomerName } from "@/lib/credit";

const AUTH_COOKIE_NAME = "duukatalk_vendor_id";

export async function GET(request: NextRequest) {
  try {
    const vendorId = request.cookies.get(AUTH_COOKIE_NAME)?.value;

    if (!vendorId) {
      return NextResponse.json(
        {
          error: "Not authenticated",
        },
        { status: 401 }
      );
    }

    const transactionsQuery = query(
      collection(db, "transactions"),
      where("vendor_id", "==", vendorId)
    );

    const snapshot = await getDocs(transactionsQuery);

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
    const vendorId = request.cookies.get(AUTH_COOKIE_NAME)?.value;

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
    };

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
      const customerRef = doc(db, "customers", customerKey);
      const customerSnap = await getDoc(customerRef);

      const outstandingCredit = customerSnap.exists()
        ? Number(customerSnap.data().outstanding_credit || 0)
        : 0;

      if (
        outstandingCredit >= CREDIT_LIMIT &&
        body.acknowledgedWarning !== true
      ) {
        return NextResponse.json(
          {
            error: localize(
              language,
              `Warning: ${customer} already has UGX ${outstandingCredit.toLocaleString()} in outstanding credit, above the UGX ${CREDIT_LIMIT.toLocaleString()} limit. Pause new lending and recover cash first. Use the tick to accept the warning and record, or use the cross to refuse.`,
              `Okulabula: ${customer} alina amabanja agasigadde UGX ${outstandingCredit.toLocaleString()}, okusukka ku kkomo lya UGX ${CREDIT_LIMIT.toLocaleString()}. Lekeka okukuza obulava obupya era funya ssente. Kozesa akatikkulu okukkiriza okulabula n'okuwandiika, oba akamukiye okugaana.`,
            ),
          },
          { status: 409 }
        );
      }
    }

    const transactionId = await getNextTransactionId();
    const timestamp = new Date().toISOString();

    const transactionRef = doc(
      db,
      "transactions",
      transactionId
    );

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

    await setDoc(transactionRef, firestoreTransaction);

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