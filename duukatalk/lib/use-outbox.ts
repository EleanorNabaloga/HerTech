'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  QueuedTransaction,
  SyncResult,
  enqueueOfflineTransaction,
  enqueueOfflineVoiceNote,
  listOfflineTransactions,
  listOfflineVoiceNotes,
  syncOutbox,
} from './offline-queue';

/** An entry recorded on this phone that the server hasn't confirmed yet. */
export interface PendingEntry {
  id: string;
  kind: 'sale' | 'voice';
  customer?: string;
  item?: string;
  amount?: number;
  paymentType?: 'cash' | 'credit';
  createdAt: string;
}

export type OutboxStatus = 'offline' | 'syncing' | 'waiting' | 'synced';

// While entries are waiting, try again this often (like WhatsApp's retries).
const RETRY_INTERVAL_MS = 20_000;

/**
 * WhatsApp-style outbox for the dashboard: queue entries while offline,
 * show them as waiting, and send them automatically when online.
 */
export function useOutbox(options: {
  vendorId: string | undefined;
  language: string;
  onSynced: (result: SyncResult) => void;
}) {
  const { vendorId, language } = options;
  const [pending, setPending] = useState<PendingEntry[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);

  // Keep the latest callback without re-running effects when it changes.
  const onSyncedRef = useRef(options.onSynced);
  useEffect(() => {
    onSyncedRef.current = options.onSynced;
  });

  const refreshPending = useCallback(async () => {
    if (!vendorId) {
      setPending([]);
      return;
    }
    try {
      const [sales, notes] = await Promise.all([
        listOfflineTransactions(vendorId),
        listOfflineVoiceNotes(vendorId),
      ]);
      setPending(
        [
          ...sales.map(
            (sale): PendingEntry => ({
              id: sale.id,
              kind: 'sale',
              customer: sale.customer,
              item: sale.item,
              amount: sale.amount,
              paymentType: sale.paymentType,
              createdAt: sale.createdAt,
            }),
          ),
          ...notes.map(
            (note): PendingEntry => ({
              id: note.id,
              kind: 'voice',
              createdAt: note.createdAt,
            }),
          ),
        ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    } catch (error) {
      console.error('Could not read the offline outbox:', error);
    }
  }, [vendorId]);

  const syncNow = useCallback(async () => {
    if (!vendorId) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsOnline(false);
      return;
    }

    setIsSyncing(true);
    try {
      const result = await syncOutbox(vendorId);
      if (!result) return; // another sync is already running

      setNeedsLogin(result.needsLogin);
      setIsOnline(!result.offline);

      const sent = result.transactionsSynced + result.voiceNotesSynced;
      if (sent > 0 || result.dropped > 0 || result.unclear > 0) {
        onSyncedRef.current(result);
      }
    } catch (error) {
      console.error('Outbox sync failed:', error);
    } finally {
      setIsSyncing(false);
      await refreshPending();
    }
  }, [vendorId, refreshPending]);

  const queueSale = useCallback(
    async (entry: Omit<QueuedTransaction, 'vendorId' | 'language' | 'createdAt'>) => {
      await enqueueOfflineTransaction({ ...entry, vendorId, language });
      await refreshPending();
      void syncNow();
    },
    [vendorId, language, refreshPending, syncNow],
  );

  const queueVoiceNote = useCallback(
    async (audioBlob: Blob, mimeType: string, id?: string) => {
      await enqueueOfflineVoiceNote(audioBlob, mimeType, { vendorId, language, id });
      await refreshPending();
      void syncNow();
    },
    [vendorId, language, refreshPending, syncNow],
  );

  // Send on load, whenever the connection or the app comes back.
  useEffect(() => {
    if (!vendorId) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOnline(navigator.onLine);
    void refreshPending().then(syncNow);

    const handleOnline = () => {
      setIsOnline(true);
      void syncNow();
    };
    const handleOffline = () => setIsOnline(false);
    const handleVisible = () => {
      if (document.visibilityState === 'visible') void syncNow();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [vendorId, refreshPending, syncNow]);

  // Keep retrying while anything is waiting.
  useEffect(() => {
    if (pending.length === 0 || needsLogin) return;
    const timer = window.setInterval(() => void syncNow(), RETRY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pending.length, needsLogin, syncNow]);

  const status: OutboxStatus = !isOnline
    ? 'offline'
    : isSyncing && pending.length > 0
      ? 'syncing'
      : pending.length > 0
        ? 'waiting'
        : 'synced';

  return {
    pending,
    status,
    isOnline,
    needsLogin,
    queueSale,
    queueVoiceNote,
    syncNow,
    markOffline: () => setIsOnline(false),
  };
}
