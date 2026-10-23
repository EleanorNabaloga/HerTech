/*
 * Offline outbox, WhatsApp style.
 *
 * Entries recorded without a connection are stored on the phone (IndexedDB)
 * and sent oldest-first once the connection returns. Every entry keeps its
 * own id, sent to the server as `clientId`; the server ignores an id it has
 * already saved, so retries can never create duplicates. An entry is only
 * removed from the outbox after the server confirms it.
 */

export interface QueuedTransaction {
  id: string;
  vendorId?: string;
  customer: string;
  item: string;
  amount: number;
  paymentType: "cash" | "credit";
  dueDate?: string | null;
  phone?: string | null;
  language?: string;
  createdAt: string;
  attempts?: number;
}

export interface QueuedVoiceNote {
  id: string;
  vendorId?: string;
  audioBlob: Blob;
  mimeType: string;
  language?: string;
  createdAt: string;
  attempts?: number;
}

export interface SyncResult {
  transactionsSynced: number;
  voiceNotesSynced: number;
  /** Rejected by the server for good (e.g. invalid data). */
  dropped: number;
  /** Recordings the server could not turn into a sale. */
  unclear: number;
  /** The session expired; entries are kept until the vendor logs in. */
  needsLogin: boolean;
  /** The network failed part-way; remaining entries retry later. */
  offline: boolean;
}

const DB_NAME = "duukatalk";
const STORE_NAME = "queued_transactions";
const VOICE_STORE_NAME = "queued_voice_notes";
const DB_VERSION = 2;
// Server errors (5xx) are retried; after this many the entry is dropped so a
// broken one can't block the outbox forever. Network failures don't count.
const MAX_SERVER_ATTEMPTS = 5;

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

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openQueueDb();
  try {
    const tx = db.transaction(storeName, mode);
    return await requestToPromise(run(tx.objectStore(storeName)));
  } finally {
    db.close();
  }
}

/**
 * Entries saved before outbox entries were tagged with a vendor have no
 * vendorId; they are sent by whoever is logged in (the old behaviour).
 */
function belongsTo(entry: { vendorId?: string }, vendorId: string): boolean {
  return !entry.vendorId || entry.vendorId === vendorId;
}

const byOldest = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt);

// --- Typed sales ---

export async function enqueueOfflineTransaction(
  entry: Omit<QueuedTransaction, "createdAt"> & { createdAt?: string },
): Promise<QueuedTransaction> {
  const record: QueuedTransaction = {
    ...entry,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
  await withStore(STORE_NAME, "readwrite", (store) => store.put(record));
  return record;
}

export async function listOfflineTransactions(vendorId?: string): Promise<QueuedTransaction[]> {
  const rows = (await withStore(STORE_NAME, "readonly", (store) => store.getAll())) as QueuedTransaction[];
  return rows
    .filter((row) => !vendorId || belongsTo(row, vendorId))
    .sort(byOldest);
}

export async function removeOfflineTransaction(id: string): Promise<void> {
  await withStore(STORE_NAME, "readwrite", (store) => store.delete(id));
}

// --- Voice notes ---

export async function enqueueOfflineVoiceNote(
  audioBlob: Blob,
  mimeType: string,
  options: { vendorId?: string; language?: string; id?: string } = {},
): Promise<QueuedVoiceNote> {
  const record: QueuedVoiceNote = {
    // Reuse the id of a failed live upload so a retry can't duplicate it.
    id: options.id ?? crypto.randomUUID(),
    vendorId: options.vendorId,
    language: options.language,
    audioBlob,
    mimeType,
    createdAt: new Date().toISOString(),
  };
  await withStore(VOICE_STORE_NAME, "readwrite", (store) => store.put(record));
  return record;
}

export async function listOfflineVoiceNotes(vendorId?: string): Promise<QueuedVoiceNote[]> {
  const rows = (await withStore(VOICE_STORE_NAME, "readonly", (store) => store.getAll())) as QueuedVoiceNote[];
  return rows
    .filter((row) => !vendorId || belongsTo(row, vendorId))
    .sort(byOldest);
}

export async function removeOfflineVoiceNote(id: string): Promise<void> {
  await withStore(VOICE_STORE_NAME, "readwrite", (store) => store.delete(id));
}

// --- Sync ---

type Outcome = "sent" | "drop" | "unclear" | "login" | "offline" | "retry";

function classify(status: number): Outcome {
  if (status === 401) return "login";
  if (status >= 500) return "retry";
  return "drop";
}

async function sendTransaction(entry: QueuedTransaction): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: entry.id,
        customer: entry.customer,
        item: entry.item,
        amount: entry.amount,
        paymentType: entry.paymentType,
        dueDate: entry.dueDate ?? null,
        phone: entry.phone ?? null,
        language: entry.language,
        // The sale already happened while offline, so record it even if the
        // customer is over the credit limit; the vendor still sees alerts.
        acknowledgedWarning: true,
      }),
    });
  } catch {
    return "offline";
  }
  return response.ok ? "sent" : classify(response.status);
}

async function sendVoiceNote(note: QueuedVoiceNote): Promise<Outcome> {
  const form = new FormData();
  form.append("audio", note.audioBlob, `queued-${note.id}.webm`);
  form.append("clientId", note.id);
  form.append("acknowledgedWarning", "true");
  if (note.language) form.append("language", note.language);

  let response: Response;
  try {
    response = await fetch("/api/voice-to-json", { method: "POST", body: form });
  } catch {
    return "offline";
  }

  if (!response.ok) return classify(response.status);

  const data = (await response.json().catch(() => null)) as
    | { success?: boolean; transaction?: unknown; needsClarification?: boolean }
    | null;
  return data?.success && data.transaction ? "sent" : "unclear";
}

async function bumpAttempts<T extends { attempts?: number }>(
  entry: T,
  storeName: string,
): Promise<boolean> {
  const attempts = (entry.attempts ?? 0) + 1;
  if (attempts >= MAX_SERVER_ATTEMPTS) return false;
  await withStore(storeName, "readwrite", (store) => store.put({ ...entry, attempts }));
  return true;
}

let syncRunning = false;

async function runSync(vendorId: string): Promise<SyncResult> {
  const result: SyncResult = {
    transactionsSynced: 0,
    voiceNotesSynced: 0,
    dropped: 0,
    unclear: 0,
    needsLogin: false,
    offline: false,
  };

  for (const entry of await listOfflineTransactions(vendorId)) {
    const outcome = await sendTransaction(entry);
    if (outcome === "sent") {
      await removeOfflineTransaction(entry.id);
      result.transactionsSynced += 1;
    } else if (outcome === "drop") {
      console.error(`Queued sale ${entry.id} was rejected; removing it.`);
      await removeOfflineTransaction(entry.id);
      result.dropped += 1;
    } else if (outcome === "retry") {
      if (!(await bumpAttempts(entry, STORE_NAME))) {
        await removeOfflineTransaction(entry.id);
        result.dropped += 1;
      }
    } else if (outcome === "login") {
      result.needsLogin = true;
      return result;
    } else {
      result.offline = true;
      return result;
    }
  }

  for (const note of await listOfflineVoiceNotes(vendorId)) {
    const outcome = await sendVoiceNote(note);
    if (outcome === "sent") {
      await removeOfflineVoiceNote(note.id);
      result.voiceNotesSynced += 1;
    } else if (outcome === "unclear") {
      await removeOfflineVoiceNote(note.id);
      result.unclear += 1;
    } else if (outcome === "drop") {
      console.error(`Queued voice note ${note.id} was rejected; removing it.`);
      await removeOfflineVoiceNote(note.id);
      result.dropped += 1;
    } else if (outcome === "retry") {
      if (!(await bumpAttempts(note, VOICE_STORE_NAME))) {
        await removeOfflineVoiceNote(note.id);
        result.dropped += 1;
      }
    } else if (outcome === "login") {
      result.needsLogin = true;
      return result;
    } else {
      result.offline = true;
      return result;
    }
  }

  return result;
}

/**
 * Sends everything waiting for this vendor. Only one sync runs at a time,
 * across browser tabs too when the browser supports Web Locks; a call made
 * while another sync is running returns null.
 */
export async function syncOutbox(vendorId: string): Promise<SyncResult | null> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      "duukatalk-outbox-sync",
      { ifAvailable: true },
      async (lock) => (lock ? runSync(vendorId) : null),
    );
  }

  if (syncRunning) return null;
  syncRunning = true;
  try {
    return await runSync(vendorId);
  } finally {
    syncRunning = false;
  }
}
