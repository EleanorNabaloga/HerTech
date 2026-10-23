/*
 * Offline outbox, WhatsApp style.
 *
 * Entries recorded without a connection (or whose upload failed) are stored
 * on the phone (IndexedDB) and sent in the order they were recorded once the
 * connection returns. Rules:
 *
 * - Nothing unconfirmed is ever deleted automatically. An entry leaves the
 *   outbox only when the server confirms it, or when the vendor removes it.
 * - Every entry keeps its own id, sent as `clientId`; the server ignores an
 *   id it has already saved, so retries can never create duplicates.
 * - Entries are tagged with the vendor who recorded them and are only sent
 *   while that vendor is logged in (the server double-checks this).
 * - Sales and voice notes are sent together, oldest first. If an entry has
 *   to be retried, later ones wait so the order is kept.
 * - Entries the server can't use (a recording it couldn't understand, data
 *   it rejected) stay on the phone marked for attention, never sent again
 *   automatically, until the vendor deals with them.
 */

/** Entries created by this version; older ones may hold a wrong phone. */
const ENTRY_VERSION = 2;

export type EntryStatus = "waiting" | "unclear" | "rejected";

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
  status?: EntryStatus;
  lastError?: string;
  version?: number;
}

export interface QueuedVoiceNote {
  id: string;
  vendorId?: string;
  audioBlob: Blob;
  mimeType: string;
  language?: string;
  createdAt: string;
  attempts?: number;
  status?: EntryStatus;
  lastError?: string;
  version?: number;
}

export interface SyncResult {
  transactionsSynced: number;
  voiceNotesSynced: number;
  /** Entries newly marked for the vendor's attention in this run. */
  needsAttention: number;
  /** The session expired or belongs to another vendor; entries are kept. */
  needsLogin: boolean;
  /** The network failed part-way; remaining entries retry later. */
  offline: boolean;
  /** The server asked us to wait (or had an error); try again later. */
  retryLater: boolean;
}

const DB_NAME = "duukatalk";
const STORE_NAME = "queued_transactions";
const VOICE_STORE_NAME = "queued_voice_notes";
const DB_VERSION = 2;

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
 * Only the vendor who recorded an entry may send it. Entries from older app
 * versions have no vendor tag; they are never sent under whoever happens to
 * be logged in, since that could file them in another shop's ledger.
 */
function belongsTo(entry: { vendorId?: string }, vendorId: string): boolean {
  return entry.vendorId === vendorId;
}

const byOldest = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt);

// --- Typed sales ---

export async function enqueueOfflineTransaction(
  entry: Omit<QueuedTransaction, "createdAt" | "version" | "status"> & { createdAt?: string },
): Promise<QueuedTransaction> {
  const record: QueuedTransaction = {
    ...entry,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    status: "waiting",
    version: ENTRY_VERSION,
  };
  await withStore(STORE_NAME, "readwrite", (store) => store.put(record));
  return record;
}

export async function listOfflineTransactions(vendorId: string): Promise<QueuedTransaction[]> {
  const rows = (await withStore(STORE_NAME, "readonly", (store) => store.getAll())) as QueuedTransaction[];
  return rows.filter((row) => belongsTo(row, vendorId)).sort(byOldest);
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
    status: "waiting",
    version: ENTRY_VERSION,
  };
  await withStore(VOICE_STORE_NAME, "readwrite", (store) => store.put(record));
  return record;
}

export async function listOfflineVoiceNotes(vendorId: string): Promise<QueuedVoiceNote[]> {
  const rows = (await withStore(VOICE_STORE_NAME, "readonly", (store) => store.getAll())) as QueuedVoiceNote[];
  return rows.filter((row) => belongsTo(row, vendorId)).sort(byOldest);
}

export async function removeOfflineVoiceNote(id: string): Promise<void> {
  await withStore(VOICE_STORE_NAME, "readwrite", (store) => store.delete(id));
}

// --- Sync ---

type Outcome =
  | { kind: "sent" }
  | { kind: "unclear" }
  | { kind: "rejected"; error: string }
  | { kind: "login" }
  | { kind: "offline" }
  | { kind: "retry"; afterMs?: number };

// Don't try again before this time (set from a server's Retry-After).
let notBefore = 0;

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function classify(response: Response): Promise<Outcome> {
  const { status } = response;
  // 401: logged out. 403: logged in as a different vendor. Keep and wait.
  if (status === 401 || status === 403) return { kind: "login" };
  // Timeouts, rate limits and server errors are temporary.
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: "retry", afterMs: retryAfterMs(response) };
  }
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  return { kind: "rejected", error: data?.error || `HTTP ${status}` };
}

async function sendTransaction(entry: QueuedTransaction, vendorId: string): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: entry.id,
        // The server refuses the upload if this isn't the logged-in vendor.
        expectedVendorId: vendorId,
        // When the sale actually happened, not when it reached the server.
        recordedAt: entry.createdAt,
        customer: entry.customer,
        item: entry.item,
        amount: entry.amount,
        paymentType: entry.paymentType,
        dueDate: entry.dueDate ?? null,
        // Entries from older versions saved the vendor's own number here,
        // which sent the customer's debt texts to the shop owner.
        phone: entry.version === ENTRY_VERSION ? (entry.phone ?? null) : null,
        language: entry.language,
        // The sale already happened while offline, so record it even if the
        // customer is over the credit limit; the vendor still sees alerts.
        acknowledgedWarning: true,
      }),
    });
  } catch {
    return { kind: "offline" };
  }
  return response.ok ? { kind: "sent" } : classify(response);
}

async function sendVoiceNote(note: QueuedVoiceNote, vendorId: string): Promise<Outcome> {
  const form = new FormData();
  form.append("audio", note.audioBlob, `queued-${note.id}.webm`);
  form.append("clientId", note.id);
  form.append("expectedVendorId", vendorId);
  form.append("recordedAt", note.createdAt);
  form.append("acknowledgedWarning", "true");
  if (note.language) form.append("language", note.language);

  let response: Response;
  try {
    response = await fetch("/api/voice-to-json", { method: "POST", body: form });
  } catch {
    return { kind: "offline" };
  }

  if (!response.ok) return classify(response);

  const data = (await response.json().catch(() => null)) as
    | { success?: boolean; transaction?: unknown; needsClarification?: boolean }
    | null;
  return data?.success && data.transaction ? { kind: "sent" } : { kind: "unclear" };
}

type OutboxItem =
  | { kind: "sale"; entry: QueuedTransaction }
  | { kind: "voice"; entry: QueuedVoiceNote };

async function saveItem(item: OutboxItem): Promise<void> {
  const store = item.kind === "sale" ? STORE_NAME : VOICE_STORE_NAME;
  await withStore(store, "readwrite", (s) => s.put(item.entry));
}

async function removeItem(item: OutboxItem): Promise<void> {
  if (item.kind === "sale") await removeOfflineTransaction(item.entry.id);
  else await removeOfflineVoiceNote(item.entry.id);
}

async function runSync(vendorId: string): Promise<SyncResult> {
  const result: SyncResult = {
    transactionsSynced: 0,
    voiceNotesSynced: 0,
    needsAttention: 0,
    needsLogin: false,
    offline: false,
    retryLater: false,
  };

  const [sales, notes] = await Promise.all([
    listOfflineTransactions(vendorId),
    listOfflineVoiceNotes(vendorId),
  ]);

  // Everything waiting, in the order it was recorded.
  const items: OutboxItem[] = [
    ...sales.map((entry): OutboxItem => ({ kind: "sale", entry })),
    ...notes.map((entry): OutboxItem => ({ kind: "voice", entry })),
  ]
    .filter((item) => (item.entry.status ?? "waiting") === "waiting")
    .sort((a, b) => byOldest(a.entry, b.entry));

  for (const item of items) {
    const outcome =
      item.kind === "sale"
        ? await sendTransaction(item.entry, vendorId)
        : await sendVoiceNote(item.entry, vendorId);

    switch (outcome.kind) {
      case "sent":
        await removeItem(item);
        if (item.kind === "sale") result.transactionsSynced += 1;
        else result.voiceNotesSynced += 1;
        break;

      case "unclear":
      case "rejected":
        // Keep it, set aside for the vendor; don't block the entries after it.
        item.entry.status = outcome.kind;
        item.entry.lastError = outcome.kind === "rejected" ? outcome.error : undefined;
        await saveItem(item);
        result.needsAttention += 1;
        break;

      case "retry":
        // Keep it, and stop here so later entries don't overtake it.
        item.entry.attempts = (item.entry.attempts ?? 0) + 1;
        await saveItem(item);
        if (outcome.afterMs) notBefore = Date.now() + outcome.afterMs;
        result.retryLater = true;
        return result;

      case "login":
        result.needsLogin = true;
        return result;

      case "offline":
        result.offline = true;
        return result;
    }
  }

  return result;
}

let syncRunning = false;

/**
 * Sends everything waiting for this vendor. Only one sync runs at a time,
 * across browser tabs too when the browser supports Web Locks. Returns null
 * when it didn't run (another sync is running, or the server asked us to
 * wait a while).
 */
export async function syncOutbox(vendorId: string): Promise<SyncResult | null> {
  if (Date.now() < notBefore) return null;

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

/** Puts an entry the vendor set aside back in line to be sent. */
export async function retryOutboxEntry(kind: "sale" | "voice", id: string): Promise<void> {
  const store = kind === "sale" ? STORE_NAME : VOICE_STORE_NAME;
  const entry = (await withStore(store, "readonly", (s) => s.get(id))) as
    | QueuedTransaction
    | QueuedVoiceNote
    | undefined;
  if (!entry) return;
  await withStore(store, "readwrite", (s) =>
    s.put({ ...entry, status: "waiting", lastError: undefined }),
  );
}

/** The recorded audio of a queued voice note, e.g. to play it back. */
export async function getQueuedVoiceAudio(id: string): Promise<Blob | null> {
  const note = (await withStore(VOICE_STORE_NAME, "readonly", (s) => s.get(id))) as
    | QueuedVoiceNote
    | undefined;
  return note?.audioBlob ?? null;
}
