export interface QueuedTransaction {
  id: string;
  customer: string;
  item: string;
  amount: number;
  paymentType: "cash" | "credit";
  dueDate?: string | null;
  phone?: string | null;
  createdAt: string;
}

export interface QueuedVoiceNote {
  id: string;
  audioBlob: Blob;
  mimeType: string;
  createdAt: string;
}

const DB_NAME = "duukatalk";
const STORE_NAME = "queued_transactions";
const VOICE_STORE_NAME = "queued_voice_notes";
const DB_VERSION = 2; // bumped from 1 to add the voice-note store

function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(VOICE_STORE_NAME)) {
        db.createObjectStore(VOICE_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

// --- Manual/typed transaction queue (existing) ---

export async function enqueueOfflineTransaction(
  entry: Omit<QueuedTransaction, "createdAt"> & { createdAt?: string },
): Promise<QueuedTransaction> {
  const record: QueuedTransaction = {
    ...entry,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
  const db = await openQueueDb();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    await requestToPromise(tx.objectStore(STORE_NAME).put(record));
    return record;
  } finally {
    db.close();
  }
}

export async function listOfflineTransactions(): Promise<QueuedTransaction[]> {
  const db = await openQueueDb();
  try {
    const tx = db.transaction(STORE_NAME, "readonly");
    const rows = await requestToPromise(tx.objectStore(STORE_NAME).getAll());
    return (rows as QueuedTransaction[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally {
    db.close();
  }
}

export async function removeOfflineTransaction(id: string): Promise<void> {
  const db = await openQueueDb();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    await requestToPromise(tx.objectStore(STORE_NAME).delete(id));
  } finally {
    db.close();
  }
}

export async function syncOfflineTransactions(): Promise<{ synced: number; remaining: number }> {
  const queued = await listOfflineTransactions();
  let synced = 0;

  for (const entry of [...queued].reverse()) {
    const response = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer: entry.customer,
        item: entry.item,
        amount: entry.amount,
        paymentType: entry.paymentType,
        dueDate: entry.dueDate,
        phone: entry.phone,
      }),
    });
    if (!response.ok) {
      break;
    }
    await removeOfflineTransaction(entry.id);
    synced += 1;
  }

  const remaining = (await listOfflineTransactions()).length;
  return { synced, remaining };
}

// --- Voice-note queue (new) ---
// Stores raw recorded audio when offline, since transcription/extraction
// requires a live call to /api/voice-to-json and can't happen on-device.

export async function enqueueOfflineVoiceNote(
  audioBlob: Blob,
  mimeType: string,
): Promise<QueuedVoiceNote> {
  const record: QueuedVoiceNote = {
    id: crypto.randomUUID(),
    audioBlob,
    mimeType,
    createdAt: new Date().toISOString(),
  };
  const db = await openQueueDb();
  try {
    const tx = db.transaction(VOICE_STORE_NAME, "readwrite");
    await requestToPromise(tx.objectStore(VOICE_STORE_NAME).put(record));
    return record;
  } finally {
    db.close();
  }
}

export async function listOfflineVoiceNotes(): Promise<QueuedVoiceNote[]> {
  const db = await openQueueDb();
  try {
    const tx = db.transaction(VOICE_STORE_NAME, "readonly");
    const rows = await requestToPromise(tx.objectStore(VOICE_STORE_NAME).getAll());
    return (rows as QueuedVoiceNote[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } finally {
    db.close();
  }
}

export async function removeOfflineVoiceNote(id: string): Promise<void> {
  const db = await openQueueDb();
  try {
    const tx = db.transaction(VOICE_STORE_NAME, "readwrite");
    await requestToPromise(tx.objectStore(VOICE_STORE_NAME).delete(id));
  } finally {
    db.close();
  }
}

// Sends each queued voice note through the same pipeline uploadRecording() uses:
// transcribe+extract via /api/voice-to-json, then save to /api/ledger. Stops on
// first failure so nothing gets skipped out of order, same as syncOfflineTransactions().
export async function syncOfflineVoiceNotes(): Promise<{ synced: number; remaining: number }> {
  const queued = await listOfflineVoiceNotes();
  let synced = 0;

  for (const note of queued) {
    const formData = new FormData();
    formData.append("audio", note.audioBlob, `queued-${note.id}.webm`);

    const extractResponse = await fetch("/api/voice-to-json", {
      method: "POST",
      body: formData,
    });
    if (!extractResponse.ok) break;

    const data = (await extractResponse.json().catch(() => null)) as
      | { success?: boolean; transaction?: Record<string, unknown> }
      | null;
    const transaction = data?.success ? data.transaction : null;
    if (!transaction) break;

    const customer = (transaction.customerName as string | null) || "Unknown customer";
    const quantity = typeof transaction.quantity === "number" ? transaction.quantity : 1;
    const unitPrice = typeof transaction.unitPrice === "number" ? transaction.unitPrice : 0;

    const ledgerResponse = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer,
        item: (transaction.item as string) || "Recorded item",
        amount: quantity * unitPrice,
        paymentType: transaction.paymentType === "credit" ? "credit" : "cash",
        dueDate: transaction.dueDate ?? null,
      }),
    });
    if (!ledgerResponse.ok) break;

    await removeOfflineVoiceNote(note.id);
    synced += 1;
  }

  const remaining = (await listOfflineVoiceNotes()).length;
  return { synced, remaining };
}

