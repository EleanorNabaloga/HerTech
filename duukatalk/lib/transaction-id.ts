import { getDb } from "./firebase";

export async function getNextTransactionId(): Promise<string> {
  const db = getDb();
  const counterRef = db.collection("metadata").doc("transaction_counter");

  const nextNumber = await db.runTransaction(async (transaction) => {
    const counterSnapshot = await transaction.get(counterRef);
    const storedNumber = Number(counterSnapshot.data()?.lastNumber) || 0;
    const next = storedNumber + 1;

    transaction.set(counterRef, { lastNumber: next }, { merge: true });
    return next;
  });

  return `txn_${String(nextNumber).padStart(3, "0")}`;
}
