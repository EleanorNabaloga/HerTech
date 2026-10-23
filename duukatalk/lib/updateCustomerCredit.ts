import { getDb } from "./firebase";
import { isOutstandingCredit, normalizeCustomerName } from "./credit";

const TRANSACTIONS_COLLECTION = "transactions";
const CUSTOMERS_COLLECTION = "customers";

async function getCustomerTransactions(
  vendorId: string,
  customerName: string,
) {
  const snapshot = await getDb()
    .collection(TRANSACTIONS_COLLECTION)
    .where("vendor_id", "==", vendorId)
    .get();
  const requestedKey = normalizeCustomerName(customerName);

  return snapshot.docs.filter((docSnap) => {
    const storedName = normalizeCustomerName(docSnap.data().customer_name ?? "");
    return storedName === requestedKey;
  });
}

/** Sum of this customer's unpaid credit sales, straight from the ledger. */
async function outstandingFromTransactions(
  vendorId: string,
  customerName: string,
): Promise<number> {
  const docs = await getCustomerTransactions(vendorId, customerName);
  return docs.reduce((sum, docSnap) => {
    const data = docSnap.data();
    return isOutstandingCredit(data) ? sum + (Number(data.total_amount) || 0) : sum;
  }, 0);
}

/**
 * Fast customer credit update path. When an amount is provided, the customer
 * profile is incremented in-place instead of scanning every transaction for
 * the vendor. That keeps record saves predictable and prevents the route from
 * waiting on a full ledger fan-out recalculation.
 *
 * Without an amount, the balance is recalculated from the ledger. Use that
 * after a payment, edit or delete so the saved balance can't go stale.
 */
export async function updateCustomerCredit(
  vendorId: string,
  customerName: string,
  amountDelta?: number,
): Promise<number | void> {
  if (!customerName?.trim()) return;

  try {
    const customerKey = `${vendorId}_${normalizeCustomerName(customerName)}`;
    const customerRef = getDb().collection(CUSTOMERS_COLLECTION).doc(customerKey);
    const customerSnap = await customerRef.get();
    const currentOutstanding = customerSnap.exists
      ? Number(customerSnap.data()?.outstanding_credit || 0)
      : 0;

    const nextOutstanding = Number.isFinite(amountDelta)
      ? currentOutstanding + Number(amountDelta)
      : await outstandingFromTransactions(vendorId, customerName);

    await customerRef.set(
      {
        vendor_id: vendorId,
        customer_name: customerName.trim(),
        outstanding_credit: nextOutstanding,
        updated_at: new Date().toISOString(),
      },
      { merge: true },
    );

    return nextOutstanding;
  } catch (error) {
    console.error("Failed to update customer credit:", error);
    throw error;
  }
}

/**
 * Marks every open credit transaction for the customer as paid, then
 * refreshes their outstanding balance.
 */
export async function settleCustomerCredit(
  vendorId: string,
  customerName: string,
): Promise<{
  paidAmount: number;
  outstandingCredit: number;
}> {
  const snapshot = await getCustomerTransactions(vendorId, customerName);
  const settledAt = new Date().toISOString();
  const batch = getDb().batch();
  let paidAmount = 0;
  let updates = 0;

  for (const docSnap of snapshot) {
    const data = docSnap.data();
    if (!isOutstandingCredit(data)) continue;
    paidAmount += Number(data.total_amount) || 0;
    batch.update(docSnap.ref, {
      settled: true,
      settled_at: settledAt,
    });
    updates += 1;
  }

  if (updates > 0) {
    await batch.commit();
  }

  const outstandingCredit =
    (await updateCustomerCredit(vendorId, customerName)) ?? 0;
  return { paidAmount, outstandingCredit };
}