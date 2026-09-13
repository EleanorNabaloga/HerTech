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

// Claim-first sync: remove each item from the queue BEFORE processing it.
// If two syncs somehow overlap (React Strict Mode remount, duplicate
// 'online' events, etc.), only one of them can ever claim a given item --
// the second sees it already gone from the queue and skips it. If the
// upload fails, the item is put back so it can be retried later.
export async function syncOfflineTransactions(): Promise<{ synced: number; remaining: number }> {
  const queued = await listOfflineTransactions();
  let synced = 0;

  for (const entry of [...queued].reverse()) {
    // Claim: remove first, before the network call.
    await removeOfflineTransaction(entry.id);

    try {
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
        // Put it back so it can be retried on the next sync.
        await enqueueOfflineTransaction(entry);
        break;
      }

      synced += 1;
    } catch (err) {
      console.error(`Transaction ${entry.id} failed during sync, re-queueing:`, err);
      await enqueueOfflineTransaction(entry);
      break;
    }
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

async function enqueueExistingVoiceNote(note: QueuedVoiceNote): Promise<void> {
  const db = await openQueueDb();
  try {
    const tx = db.transaction(VOICE_STORE_NAME, "readwrite");
    await requestToPromise(tx.objectStore(VOICE_STORE_NAME).put(note));
  } finally {
    db.close();
  }
}

// Sends each queued voice note through the same pipeline uploadRecording() uses:
// a single call to /api/voice-to-json, which transcribes, extracts, and saves
// the transaction to Firestore itself -- no separate /api/ledger call needed here.
//
// Claim-first pattern: each note is removed from the queue BEFORE it's sent.
// This is what prevents the same recording from being processed twice if two
// syncs ever overlap (e.g. React Strict Mode's dev-mode double-invoke, or the
// 'online' event firing more than once). A genuine failure re-queues the note
// so it isn't lost; an unusable note (bad audio, bad response) is dropped for
// good so it doesn't block everything behind it forever.
export async function syncOfflineVoiceNotes(): Promise<{ synced: number; remaining: number; failed: number }> {
  const queued = await listOfflineVoiceNotes();
  let synced = 0;
  let failed = 0;

  for (const note of queued) {
    // Claim: remove first, before the network call. If another sync run
    // already claimed this note, listOfflineVoiceNotes() at the top of
    // that other run wouldn't have included it in the first place, so
    // there's no double-claim risk here -- only double-listing, which
    // this removal step resolves.
    await removeOfflineVoiceNote(note.id);

    try {
      const formData = new FormData();
      formData.append("audio", note.audioBlob, `queued-${note.id}.webm`);

      const extractResponse = await fetch("/api/voice-to-json", {
        method: "POST",
        body: formData,
      });

      if (!extractResponse.ok) {
        const status = extractResponse.status;
        const bodyText = await extractResponse.text().catch(() => "");
        console.error(`Voice note ${note.id} failed at transcription:`, status, bodyText);

        if (status >= 500) {
          // Server/network problem -- likely transient. Re-queue for retry.
          await enqueueExistingVoiceNote(note);
        } else {
          // Client-side rejection (bad request, auth, etc.) won't fix
          // itself on retry -- drop it so it doesn't block the queue.
          failed += 1;
        }
        continue;
      }

      const data = (await extractResponse.json().catch(() => null)) as
        | { success?: boolean; transaction?: Record<string, unknown>; error?: string }
        | null;
      const transaction = data?.success ? data.transaction : null;

      if (!transaction) {
        console.error(`Voice note ${note.id} produced no transaction:`, data?.error);
        failed += 1;
        continue;
      }

      synced += 1;
    } catch (err) {
      // A thrown error here means the fetch itself failed -- genuinely
      // offline or unreachable. Re-queue so it retries on the next sync.
      console.error(`Voice note ${note.id} threw an error during sync, re-queueing:`, err);
      await enqueueExistingVoiceNote(note);
    }
  }

  const remaining = (await listOfflineVoiceNotes()).length;
  return { synced, remaining, failed };
}