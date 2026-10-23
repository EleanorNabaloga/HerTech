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
  /** Id the phone gave an offline entry; used to ignore repeat uploads. */
  client_id?: string | null;
}

/**
 * When an offline entry was actually recorded, so it lands on the right day.
 * Accepts a past time up to a year back; anything else (missing, invalid,
 * in the future) returns null and the server's own time is used.
 */
export function parseRecordedAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  const now = Date.now();
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  if (time > now + 5 * 60 * 1000 || time < now - yearMs) return null;
  return new Date(time).toISOString();
}

/**
 * Offline entries name the vendor who recorded them. If the browser is now
 * logged in as someone else, refuse, so the entry is never filed in another
 * shop's ledger; the phone keeps it until the right vendor logs in.
 */
export function vendorMismatch(
  expectedVendorId: unknown,
  sessionVendorId: string,
): boolean {
  return (
    typeof expectedVendorId === "string" &&
    expectedVendorId !== "" &&
    expectedVendorId !== sessionVendorId
  );
}

export const VENDOR_MISMATCH_ERROR =
  "This entry belongs to another shop. Log in as that shop to send it.";

/** Accepts the outbox entry id sent by the app (a UUID), else null. */
export function parseClientId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,100}$/.test(value)
    ? value
    : null;
}

/**
 * The transaction this vendor already saved for an outbox entry, if any.
 * Offline entries can be sent more than once (a retry after a dropped
 * connection); this makes the second upload a no-op instead of a duplicate.
 */
export async function findByClientId(
  vendorId: string,
  clientId: string,
): Promise<FirestoreTransaction | null> {
  const snapshot = await getDb()
    .collection("transactions")
    .where("vendor_id", "==", vendorId)
    .where("client_id", "==", clientId)
    .limit(1)
    .get();
  return snapshot.empty
    ? null
    : (snapshot.docs[0].data() as FirestoreTransaction);
}

/** Converts a stored transaction back to the app's Transaction shape. */
export function fromFirestoreTransaction(row: FirestoreTransaction): Transaction {
  return {
    item: row.item,
    quantity: row.quantity,
    unit: row.unit,
    unitPrice: row.unit_price,
    customerName: row.customer_name,
    paymentType: row.payment_type,
    dueDate: row.due_date,
    timestamp: row.timestamp,
    totalAmount: row.total_amount,
  };
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