import { Transaction } from "./schema";
import { getDb } from "./firebase";
import { formatMoney } from "./money";

export interface FirestoreTransaction {
  id: string;
  transaction_id: string;
  vendor_id: string;
  type: "cash" | "credit";
  item: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  total_amount: number;
  customer_name: string | null;
  payment_type: "cash" | "credit";
  due_date: string | null;
  settled?: boolean;
  settled_at?: string | null;
  timestamp: string;
  raw_transcript: string;
  confidence_flag: boolean;
}

export function toFirestoreTransaction(
  transaction: Transaction,
  transcript: string,
  id: string,
  vendorId: string
): FirestoreTransaction {
  return {
    id,
    transaction_id: id,
    vendor_id: vendorId,
    type: transaction.paymentType,
    item: transaction.item,
    quantity: transaction.quantity,
    unit: transaction.unit,
    unit_price: transaction.unitPrice,
    total_amount: transaction.quantity * transaction.unitPrice,
    customer_name: transaction.customerName,
    payment_type: transaction.paymentType,
    due_date: transaction.dueDate,
    settled: false,
    settled_at: null,
    timestamp: transaction.timestamp,
    raw_transcript: transcript,
    confidence_flag:
      transaction.customerName === null ||
      transaction.item.trim() === "",
  };
}

/**
 * Builds a spoken-friendly summary of today's transactions.
 */
export async function buildDailySummary(
  vendorId: string,
  currency?: string,
): Promise<string> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const snapshot = await getDb()
    .collection("transactions")
    .where("vendor_id", "==", vendorId)
    .where("timestamp", ">=", startOfToday.toISOString())
    .get();

  const transactions = snapshot.docs.map((doc) => doc.data() as FirestoreTransaction);
  const sales = transactions.filter((t) => t.payment_type === "cash");
  const credits = transactions.filter((t) => t.payment_type === "credit");

  const totalSales = sales.reduce((sum, t) => sum + t.total_amount, 0);
  const totalOwed = credits.reduce((sum, t) => sum + t.total_amount, 0);

  const creditList = credits
    .map((t) => `${t.customer_name ?? "someone"} owes ${formatMoney(t.total_amount, currency)}`)
    .join(", ");

  return `Today you made ${formatMoney(totalSales, currency)} in sales. You are owed ${formatMoney(totalOwed, currency)} in credit. ${
    creditList ? creditList + "." : "No outstanding credit today."
  }`;
}