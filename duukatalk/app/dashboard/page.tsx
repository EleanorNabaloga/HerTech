'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import {
  enqueueOfflineTransaction,
  enqueueOfflineVoiceNote,
  syncOfflineTransactions,
  syncOfflineVoiceNotes,
} from '@/lib/offline-queue';

import {
  AlertCircle,
  BarChart3,
  Bell,
  BookOpen,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  DollarSign,
  Download,
  Edit3,
  Loader2,
  LogOut,
  Mic,
  Moon,
  Package,
  Plus,
  Save,
  Search,
  Settings,
  Store,
  Sun,
  Trash2,
  TrendingUp,
  User,
  X,
} from 'lucide-react';

import {
  LANGUAGE_OPTIONS,
  Language,
  TranslationVars,
  applyDocumentLanguage,
  hasTranslation,
  localeFor,
  translate,
} from '@/lib/i18n';
import { CREDIT_LIMIT } from '@/lib/credit';

type TabType = 'record' | 'ledgers' | 'debts' | 'reports';

const navItems: Array<{
  name: string;
  tab: TabType;
  icon: typeof Mic;
}> = [
  { name: 'Record', tab: 'record', icon: Mic },
  { name: 'Ledgers', tab: 'ledgers', icon: BookOpen },
  { name: 'Debts & Dues', tab: 'debts', icon: CreditCard },
  { name: 'Reports', tab: 'reports', icon: BarChart3 },
];

interface Transaction {
  id: string;
  customer: string;
  initials: string;
  item: string;
  amount: number;
  type: 'cash' | 'credit';
  // Raw stored date (ISO or YYYY-MM-DD); formatted only when displayed.
  dueDate?: string;
  date: string;
  timestamp?: string;
}

interface Debt {
  id: string;
  customer: string;
  initials: string;
  item: string;
  amount: number;
  dueDate?: string;
}

interface ApiTransaction {
  id?: string;
  transaction_id?: string;
  type?: string;
  item?: string;
  quantity?: number;
  unit?: string;
  total_amount?: number;
  customer_name?: string;
  payment_type?: string;
  due_date?: string;
  timestamp?: string;
}

interface ApiSummary {
  totalSales?: number;
  totalCreditOutstanding?: number;
  perCustomerCredit?: Record<string, number>;
  recommendedSavings?: number;
  savingsPercent?: number;
  loanReadinessScore?: number;
  loanAdvice?: string;
  adviceCode?: 'stop_lending' | 'cautious' | 'healthy';
  creditToSalesRatio?: number;
  creditSharePercent?: number;
  shouldStopLending?: boolean;
}

interface StoredUser {
  vendorId?: string;
  businessName?: string;
  ownerName?: string;
  phone?: string;
  country?: string;
  currency?: string;
}

interface ApiDebt {
  customerName?: string;
  amountOwed?: number;
  dueDates?: string[];
}

interface VoiceTransaction {
  item?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  customerName?: string | null;
  paymentType?: string | null;
  dueDate?: string | null;
  timestamp?: string | null;
}

interface VoiceToJsonResponse {
  success: boolean;
  transcript?: string;
  transaction?: VoiceTransaction;
  transactionId?: string;
  error?: string;
}

interface RiskFlagNotification {
  id: string;
  type?: string;
  severity?: 'warning' | 'critical';
  message: string;
  details?: Record<string, unknown>;
}

interface RiskFlagsApiResponse {
  flags?: RiskFlagNotification[];
}

type CreditWarningMode = 'manual' | 'voice';

type CreditWarningPayload = {
  customer: string;
  item: string;
  amount: number;
  paymentType: Transaction['type'];
  dueDate: string | null;
  phone: string | null;
  language: Language;
  acknowledgedWarning: boolean;
};

interface CreditWarningState {
  mode: CreditWarningMode;
  message: string;
  payload?: CreditWarningPayload;
  audioBlob?: Blob;
}

// --- HELPERS ---

function deriveInitials(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return initials || '??';
}

function isValidDate(value?: string | null): value is string {
  return Boolean(value) && !Number.isNaN(new Date(value as string).getTime());
}

/** Earliest valid due date, kept raw so it can be formatted per language. */
function earliestDueDate(dueDates: string[]): string | undefined {
  return dueDates
    .filter(isValidDate)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
}

function formatCurrency(
  amount: number,
  currency?: string
): string {
  const code = currency || 'UGX';

  return `${code} ${amount.toLocaleString()}`;
}

export default function DuukaTalkApp() {
  const router = useRouter();

  const [isDarkMode, setIsDarkMode] = useState<boolean>(false);
  const [language, setLanguage] = useState<Language>('EN');
  const [showNotifications, setShowNotifications] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('record');
  const [user, setUser] = useState<StoredUser>({});
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');
  const [reportNow] = useState(() => Date.now());

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);

  const [formMessage, setFormMessage] = useState('');
  const [summary, setSummary] = useState<ApiSummary | null>(null);
  const [apiError, setApiError] = useState('');
  const [riskFlags, setRiskFlags] = useState<RiskFlagNotification[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [isLoadingDebts, setIsLoadingDebts] = useState(false);
  const [creditWarning, setCreditWarning] = useState<CreditWarningState | null>(null);
  const [audioTransactionLinkView, setAudioTransactionLinkView] = useState<string | null>(null);

  // --- EDIT TRANSACTION STATE ---

  const [editingTransaction, setEditingTransaction] =
    useState<Transaction | null>(null);

  const [editFormData, setEditFormData] = useState({
    customer: '',
    item: '',
    amount: '',
    paymentType: 'cash' as Transaction['type'],
    dueDate: '',
  });

  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editError, setEditError] = useState('');

  // --- DELETE TRANSACTION STATE ---

  const [deletingTransaction, setDeletingTransaction] =
    useState<Transaction | null>(null);

  const [isDeletingTransaction, setIsDeletingTransaction] =
    useState(false);

  const [deleteError, setDeleteError] = useState('');

  // --- RECORDING STATE ---

  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [micError, setMicError] = useState<string>('');
  const [transcript, setTranscript] = useState<string>('');

  const [formData, setFormData] = useState<{
    customer: string;
    item: string;
    amount: string;
    paymentType: Transaction['type'];
  }>({
    customer: '',
    item: '',
    amount: '',
    paymentType: 'cash',
  });

  // --- VOICE RECORDING REFS ---

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const activeStreamRef = useRef<MediaStream | null>(null);

  // --- VOICE QUESTION REFS ---
const questionMediaRecorderRef =
  useRef<MediaRecorder | null>(null);

const questionAudioChunksRef =
  useRef<Blob[]>([]);

const questionStreamRef =
  useRef<MediaStream | null>(null);

const questionAudioRef =
  useRef<HTMLAudioElement | null>(null);

  // --- LEDGER STATE ---

  const [timeframe, setTimeframe] = useState<
    'daily' | 'weekly' | 'monthly'
  >('daily');

  const [searchQuery, setSearchQuery] = useState('');
  // --- VOICE QUESTION STATE ---
const [isQuestionRecording, setIsQuestionRecording] =
  useState<boolean>(false);

const [isQuestionProcessing, setIsQuestionProcessing] =
  useState<boolean>(false);

const [isQuestionSpeaking, setIsQuestionSpeaking] =
  useState<boolean>(false);

const [questionTranscript, setQuestionTranscript] =
  useState<string>('');

const [questionAnswer, setQuestionAnswer] =
  useState<string>('');

const [questionError, setQuestionError] =
  useState<string>('');

  const text = (
    english: string,
    vars?: TranslationVars
  ) => translate(language, english, vars);

  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  // Display helpers: data keeps raw dates and English placeholder values
  // (e.g. 'Unknown customer'); these turn them into the chosen language.
  const locale = localeFor(language);

  const formatDay = (value?: string | null) =>
    isValidDate(value)
      ? new Date(value).toLocaleDateString(locale)
      : '';

  const dueLabel = (value?: string | null) =>
    isValidDate(value)
      ? text('Due {date}', { date: formatDay(value) })
      : text('No due date');

  const whenLabel = (value?: string | null) =>
    isValidDate(value)
      ? new Date(value).toLocaleString(locale)
      : text('Just now');

  const shown = (value: string) =>
    hasTranslation(value) ? text(value) : value;

  // Coach advice is built here (not on the server) so it follows the chosen
  // language and the vendor's own currency.
  const coachAdvice = (data: ApiSummary) => {
    const vars = {
      share: data.creditSharePercent ?? 0,
      percent: data.savingsPercent ?? 0,
      amount: formatCurrency(
        data.recommendedSavings ?? 0,
        user.currency
      ),
    };

    if (data.adviceCode === 'stop_lending') {
      return text(
        'Stop giving new credit now. Credit is {share}% of sales, which is too high. First collect debts and save {percent}% of sales, about {amount}. A clear savings record can help banks trust you.',
        vars
      );
    }

    if (data.adviceCode === 'cautious') {
      return text(
        'Cash is okay, but credit is {share}% of sales. Be careful with new credit. Collect repayments, save {percent}% of sales, about {amount}, and keep a simple savings record. This helps banks see you as ready for a loan.',
        vars
      );
    }

    return text(
      'Sales are stronger than credit. Keep giving credit carefully, save {percent}% of sales, about {amount}, and keep saving every week. This helps banks trust your sales record and may help you get a loan.',
      vars
    );
  };

  const loadApiData = async () => {
    setIsLoadingData(true);
    setApiError('');

    // Ask the server for the chosen language itself. Kiswahili, Arabic and
    // French used to request 'MIX', which returned English + Luganda together.
    const routeLanguage = language;

    const responses = await Promise.allSettled([
      fetch('/api/ledger'),
      fetch(`/api/summary?language=${routeLanguage}`),
      fetch('/api/credit'),
      fetch(`/api/risk?language=${routeLanguage}`),
    ]);

    let failedRoutes = 0;

    const readJson = async <T,>(
      result: PromiseSettledResult<Response>
    ): Promise<T | null> => {
      if (
        result.status !== 'fulfilled' ||
        !result.value.ok
      ) {
        failedRoutes += 1;
        return null;
      }

      try {
        return (await result.value.json()) as T;
      } catch {
        failedRoutes += 1;
        return null;
      }
    };

    const [
      ledgerData,
      summaryData,
      creditData,
      riskData,
    ] = await Promise.all([
      readJson<{ transactions?: ApiTransaction[] }>(
        responses[0]
      ),
      readJson<ApiSummary>(responses[1]),
      readJson<ApiDebt[]>(responses[2]),
      readJson<RiskFlagsApiResponse>(responses[3]),
    ]);

    if (ledgerData?.transactions) {
      const databaseTransactions: Transaction[] =
        ledgerData.transactions.map(
          (transaction, index) => {
            const customer =
              transaction.customer_name ||
              'Unknown customer';

            const itemParts = [
              transaction.quantity,
              transaction.unit,
              transaction.item,
            ].filter(
              (value) =>
                value !== undefined &&
                value !== null &&
                value !== ''
            );

            const amount =
              typeof transaction.total_amount === 'number'
                ? transaction.total_amount
                : Number(transaction.total_amount) || 0;

            const paymentType =
              transaction.payment_type ||
              transaction.type ||
              'cash';

            return {
              id:
                transaction.id ||
                transaction.transaction_id ||
                `database-${index}`,

              customer,

              initials: deriveInitials(customer),

              item:
                itemParts.length > 0
                  ? itemParts.join(' ')
                  : 'Recorded transaction',

              amount,

              type:
                paymentType.toLowerCase() === 'credit'
                  ? 'credit'
                  : 'cash',

              dueDate: transaction.due_date || undefined,

              date: transaction.timestamp || '',

              timestamp: transaction.timestamp,
            };
          }
        );

      setTransactions(databaseTransactions);
    } else {
      setTransactions([]);
    }

    if (summaryData) {
      setSummary(summaryData);
    } else {
      setSummary(null);
    }

    if (creditData) {
      const databaseDebts: Debt[] =
        creditData.map((debt, index) => {
          const customer =
            debt.customerName ||
            'Unknown customer';

          const amount =
            typeof debt.amountOwed === 'number'
              ? debt.amountOwed
              : Number(debt.amountOwed) || 0;

          const dueDates = Array.isArray(debt.dueDates)
            ? debt.dueDates
            : [];

          return {
            id: `debt-${customer}-${index}`,
            customer,
            initials: deriveInitials(customer),
            item: 'Credit balance',
            amount,
            dueDate: earliestDueDate(dueDates),
          };
        });

      setDebts(databaseDebts);
    } else {
      setDebts([]);
    }

    if (riskData?.flags && riskData.flags.length > 0) {
      setRiskFlags(riskData.flags);
    } else {
      setRiskFlags([]);
    }

    if (failedRoutes > 0) {
      setApiError(
        'Could not load live data. Please refresh and try again.'
      );
    }

    setIsLoadingData(false);
  };

  // --- INITIAL LOCAL STORAGE LOAD ---

  useEffect(() => {
    const savedLanguage =
      window.localStorage.getItem('duukatalk-language');

    if (
      savedLanguage &&
      LANGUAGE_OPTIONS.some(
        (option) => option.value === savedLanguage
      )
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLanguage(savedLanguage as Language);
    }

    const savedUser =
      window.localStorage.getItem('duukatalk-user');

    if (savedUser) {
      setUser(JSON.parse(savedUser) as StoredUser);
    }

    const savedTheme =
      window.localStorage.getItem('duukatalk-theme');

    setIsDarkMode(savedTheme === 'dark');
  }, []);

  // =========================================================
  // LOAD DEBTS
  // =========================================================

  const loadDebts = async () => {
    setIsLoadingDebts(true);

    try {
      const response = await fetch('/api/credit');

      if (!response.ok) {
        throw new Error('Failed to load debts');
      }

      const data = (await response.json()) as ApiDebt[];

      const databaseDebts: Debt[] = data.map(
        (debt, index) => {
          const customer =
            debt.customerName || 'Unknown customer';

          const amount =
            typeof debt.amountOwed === 'number'
              ? debt.amountOwed
              : Number(debt.amountOwed) || 0;

          const dueDates = Array.isArray(debt.dueDates)
            ? debt.dueDates
            : [];

          return {
            id: `debt-${customer}-${index}`,
            customer,
            initials: deriveInitials(customer),
            item: 'Credit balance',
            amount,
            dueDate: earliestDueDate(dueDates),
          };
        }
      );

      setDebts(databaseDebts);
    } catch (error) {
      console.error('Failed to load debts:', error);
      setDebts([]);
    } finally {
      setIsLoadingDebts(false);
    }
  };

  // =========================================================
  // LOAD REAL DATABASE DATA
  // =========================================================

  const syncInFlightRef = useRef(false);

  useEffect(() => {
    const syncQueuedRecords = async () => {
      if (!navigator.onLine || syncInFlightRef.current) {
        return;
      }

      syncInFlightRef.current = true;

      setFormMessage(
        text(
          'Syncing offline records...')
      );

      try {
        const [transactionSync, voiceSync] = await Promise.all([
          syncOfflineTransactions(),
          syncOfflineVoiceNotes(),
        ]);

        if (
          transactionSync.synced > 0 ||
          voiceSync.synced > 0
        ) {
          setFormMessage(
            text(
              'Synced offline records to the ledger: {transactions} transactions, {notes} voice notes.',
              {
                transactions: transactionSync.synced,
                notes: voiceSync.synced,
              }
            )
          );
        } else {
          setFormMessage(
            text(
              'No offline records to sync.')
          );
        }

        await loadApiData();
      } catch (error) {
        console.error('Failed to sync offline queue:', error);
        setFormMessage(
          text(
            'Offline sync failed. It will retry automatically when the network is back.')
        );
      } finally {
        syncInFlightRef.current = false;
      }
    };

    const handleOnline = () => {
      void syncQueuedRecords();
    };

    window.addEventListener('online', handleOnline);

    void syncQueuedRecords();

    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [language]);

  // =========================================================
  // STOP MICROPHONE WHEN COMPONENT UNMOUNTS
  // =========================================================

  useEffect(() => {
    return () => {
      activeStreamRef.current
        ?.getTracks()
        .forEach((track) => track.stop());
    };
  }, []);

  // =========================================================
  // FILTER TRANSACTIONS
  // =========================================================

  const filteredTransactions = transactions.filter(
    (transaction) => {
      const query = searchQuery.trim().toLowerCase();

      return (
        !query ||
        [
          transaction.customer,
          transaction.item,
          transaction.type,
        ].some((value) =>
          value.toLowerCase().includes(query)
        )
      );
    }
  );
  const notifications = [
  ...riskFlags.map((flag) => ({
    id: flag.id,
    message: flag.message,
  })),

  ...debts
    .filter((debt) => debt.amount > CREDIT_LIMIT)
    .map((debt) => ({
      id: `debt-${debt.id}`,
      message: text('{customer} has an outstanding debt of {amount}.', {
        customer: shown(debt.customer),
        amount: formatCurrency(debt.amount, user.currency),
      }),
    })),

  ...debts
    .filter((debt) => {
      if (!debt.dueDate) return false;

      const dueDate = new Date(debt.dueDate).getTime();

      return !Number.isNaN(dueDate) && dueDate < reportNow;
    })
    .map((debt) => ({
      id: `overdue-${debt.id}`,
      message: text("{customer}'s debt is overdue.", {
        customer: shown(debt.customer),
      }),
    })),
];

  // =========================================================
  // HELPERS
  // =========================================================

  const toggleTheme = () => {
    setIsDarkMode((prev) => {
      const next = !prev;

      window.localStorage.setItem(
        'duukatalk-theme',
        next ? 'dark' : 'light'
      );

      return next;
    });
  };

  const handleManualWarningProceed = async () => {
    if (!creditWarning || creditWarning.mode !== 'manual' || !creditWarning.payload) {
      return;
    }

    const payload = {
      ...creditWarning.payload,
      acknowledgedWarning: true,
    };

    try {
      const response = await fetch('/api/ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await response.json().catch(() => null)) as {
        error?: string;
        id?: string;
      } | null;

      if (!response.ok) {
        throw new Error(data?.error || 'Failed to record transaction.');
      }

      setFormMessage(
        text(
          'Entry saved successfully after warning approval.')
      );

      await loadApiData();
    } catch (error) {
      console.error('Manual warning approval failed:', error);
      setFormMessage(
        text(
          'The warning-approved record could not be saved.')
      );
    } finally {
      setCreditWarning(null);
    }
  };

  const handleVoiceWarningProceed = async () => {
    if (!creditWarning || creditWarning.mode !== 'voice' || !creditWarning.audioBlob) {
      return;
    }

    const formData = new FormData();
    formData.append('audio', creditWarning.audioBlob, 'recording.webm');
    formData.append('acknowledgedWarning', 'true');
    formData.append('language', language);

    setIsProcessing(true);
    try {
      const response = await fetch('/api/voice-to-json', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;

        setMicError(errorData?.error || text(
          'The voice service did not respond. Please try again.'));
        setCreditWarning(null);
        return;
      }

      const data = (await response.json()) as VoiceToJsonResponse;
      if (!data.success || !data.transaction || !data.transactionId) {
        setMicError(text('Could not understand the recording. Please try again.'));
        setCreditWarning(null);
        return;
      }

      setFormMessage(text('Voice record saved after warning approval.'));
      setAudioTransactionLinkView(data.transactionId);
      setCreditWarning(null);
      await loadApiData();
    } catch (error) {
      console.error('Voice warning approval failed:', error);
      setMicError(text('The voice record could not be saved after the warning approval.'));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleLanguageChange = (
    nextLanguage: Language
  ) => {
    setLanguage(nextLanguage);

    window.localStorage.setItem(
      'duukatalk-language',
      nextLanguage
    );
  };

  
  // =========================================================
  // PRIVACY SETTINGS
  // =========================================================

  const handleSavePrivacy = async () => {
    if (newPin && !/^\d{4}$/.test(newPin)) {
      setSettingsMessage(
        text('PIN must be exactly 4 digits.')
      );

      return;
    }

    const response = await fetch(
      '/api/auth/profile',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pin: newPin || undefined,
          phone: newPhone || undefined,
        }),
      }
    );

    const data =
      (await response.json().catch(() => null)) as {
        error?: string;
        phone?: string;
      } | null;

    if (!response.ok) {
      setSettingsMessage(
        data?.error ||
          text('Could not save privacy settings.')
      );

      return;
    }

    const nextUser = {
      ...user,
      phone:
        data?.phone ||
        newPhone ||
        user.phone,
    };

    setUser(nextUser);

    window.localStorage.setItem(
      'duukatalk-user',
      JSON.stringify(nextUser)
    );

    setNewPin('');
    setSettingsMessage(
      text('Privacy settings saved.')
    );
  };

  // =========================================================
  // LOGOUT
  // =========================================================

  const handleLogout = async () => {
    await fetch('/api/auth/logout', {
      method: 'POST',
    });

    window.localStorage.removeItem(
      'duukatalk-user'
    );

    router.push('/login');
  };

  // =========================================================
  // EDIT TRANSACTION
  // =========================================================

  const handleStartEdit = (
    transaction: Transaction
  ) => {
    setEditingTransaction(transaction);
    setEditError('');

    setEditFormData({
      customer: transaction.customer,
      item: transaction.item,
      amount: String(transaction.amount),
      paymentType: transaction.type,
      // The date input needs YYYY-MM-DD.
      dueDate: transaction.dueDate?.slice(0, 10) || '',
    });
  };

  const handleCancelEdit = () => {
    if (isSavingEdit) {
      return;
    }

    setEditingTransaction(null);
    setEditError('');
  };

  const handleSaveEdit = async () => {
    if (!editingTransaction) {
      return;
    }

    const customer =
      editFormData.customer.trim();

    const item =
      editFormData.item.trim();

    const amount =
      Number(editFormData.amount);

    if (
      !customer ||
      !item ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      setEditError(
        text(
          'Please enter a customer, item, and valid amount.')
      );

      return;
    }

    setIsSavingEdit(true);
    setEditError('');

    try {
      const response = await fetch(
        `/api/ledger/${encodeURIComponent(
          editingTransaction.id
        )}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            customer_name: customer,
            item,
            total_amount: amount,
            payment_type:
              editFormData.paymentType,
            due_date:
              editFormData.paymentType ===
                'credit' &&
              editFormData.dueDate.trim()
                ? editFormData.dueDate.trim()
                : null,
          }),
        }
      );

      const data = await response
        .json()
        .catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.error ||
            text(
              'Failed to update transaction.')
        );
      }

      setTransactions(
        (currentTransactions) =>
          currentTransactions.map(
            (transaction) =>
              transaction.id ===
              editingTransaction.id
                ? {
                    ...transaction,
                    customer,
                    initials:
                      deriveInitials(
                        customer
                      ),
                    item,
                    amount,
                    type:
                      editFormData.paymentType,
                    dueDate:
                      editFormData.paymentType ===
                        'credit' &&
                      editFormData.dueDate.trim()
                        ? editFormData.dueDate.trim()
                        : undefined,
                  }
                : transaction
          )
      );

      setEditingTransaction(null);

      setFormMessage(
        text(
          'Transaction updated successfully.')
      );

      try {
        const summaryResponse =
          await fetch('/api/summary');

        if (summaryResponse.ok) {
          const updatedSummary =
            (await summaryResponse.json()) as ApiSummary;

          setSummary(updatedSummary);
        }
      } catch {
        // Transaction update already succeeded.
      }

      await loadDebts();
    } catch (error) {
      setEditError(
        error instanceof Error
          ? error.message
          : text(
              'Failed to update transaction.')
      );
    } finally {
      setIsSavingEdit(false);
    }
  };

  // =========================================================
  // DELETE TRANSACTION
  // =========================================================

  const handleStartDelete = (
    transaction: Transaction
  ) => {
    setDeletingTransaction(transaction);
    setDeleteError('');
  };

  const handleCancelDelete = () => {
    if (isDeletingTransaction) {
      return;
    }

    setDeletingTransaction(null);
    setDeleteError('');
  };

  const handleConfirmDelete = async () => {
    if (!deletingTransaction) {
      return;
    }

    setIsDeletingTransaction(true);
    setDeleteError('');

    try {
      const response = await fetch(
        `/api/ledger/${encodeURIComponent(
          deletingTransaction.id
        )}`,
        {
          method: 'DELETE',
        }
      );

      const data = await response
        .json()
        .catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.error ||
            text(
              'Failed to delete transaction.')
        );
      }

      const deletedId =
        deletingTransaction.id;

      setTransactions(
        (currentTransactions) =>
          currentTransactions.filter(
            (transaction) =>
              transaction.id !== deletedId
          )
      );

      setDebts((currentDebts) =>
        currentDebts.filter(
          (debt) => debt.id !== deletedId
        )
      );

      setDeletingTransaction(null);

      setFormMessage(
        text(
          'Transaction deleted successfully.')
      );

      try {
        const summaryResponse =
          await fetch('/api/summary');

        if (summaryResponse.ok) {
          const updatedSummary =
            (await summaryResponse.json()) as ApiSummary;

          setSummary(updatedSummary);
        }
      } catch {
        // Transaction was already deleted successfully.
      }

      await loadDebts();
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : text(
              'Failed to delete transaction.')
      );
    } finally {
      setIsDeletingTransaction(false);
    }
  };

  // =========================================================
  // MANUAL ENTRY
  // =========================================================

  const handleSaveEntry = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    const amount = Number(formData.amount);

    if (
      !formData.customer.trim() ||
      !formData.item.trim() ||
      !amount
    ) {
      setFormMessage(
        text(
          'Add a customer, item, and amount first.')
      );

      return;
    }

    const customerName = formData.customer.trim();
    const itemName = formData.item.trim();
    const paymentType = formData.paymentType;
    const offlineEntryId = crypto.randomUUID();

    const newTransaction: Transaction = {
      id: offlineEntryId,
      customer: customerName,
      initials: deriveInitials(customerName),
      item: itemName,
      amount,
      type: paymentType,
      dueDate: undefined,
      date: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };

    const queueEntry = {
      id: offlineEntryId,
      customer: customerName,
      item: itemName,
      amount,
      paymentType,
      // The manual form has no due date field; saving "now" made every
      // credit sale instantly overdue (and triggered overdue SMS).
      dueDate: null,
      phone: user.phone || null,
      createdAt: new Date().toISOString(),
    };

    if (
      typeof navigator !== 'undefined' &&
      !navigator.onLine
    ) {
      await enqueueOfflineTransaction(queueEntry);

      setTransactions((currentTransactions) => [
        newTransaction,
        ...currentTransactions,
      ]);

      if (newTransaction.type === 'credit') {
        setDebts((currentDebts) => [
          {
            ...newTransaction,
            dueDate: undefined,
          },
          ...currentDebts,
        ]);
      }

      setFormData({
        customer: '',
        item: '',
        amount: '',
        paymentType: 'cash',
      });

      setFormMessage(
        text(
          'You are offline. The entry was saved to the offline queue.')
      );

      setActiveTab('ledgers');

      return;
    }

    const warningPayload = {
      customer: customerName,
      item: itemName,
      amount,
      paymentType,
      // The manual form has no due date field; saving "now" made every
      // credit sale instantly overdue (and triggered overdue SMS).
      dueDate: null,
      phone: user.phone || null,
      language,
      acknowledgedWarning: false,
    };

    try {
      const response = await fetch('/api/ledger', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(warningPayload),
      });

      const data = (await response.json().catch(() => null)) as {
        error?: string;
        id?: string;
      } | null;

      if (!response.ok) {
        if (response.status === 409 && data?.error) {
          setCreditWarning({
            mode: 'manual',
            message: data.error,
            payload: {
              ...warningPayload,
              paymentType,
              language,
              acknowledgedWarning: false,
            },
          });
          return;
        }
        throw new Error(data?.error || 'Failed to save transaction.');
      }

      setTransactions((currentTransactions) => [
        {
          ...newTransaction,
          id: data?.id || newTransaction.id,
        },
        ...currentTransactions,
      ]);

      if (paymentType === 'credit') {
        setDebts((currentDebts) => [
          {
            ...newTransaction,
            id: data?.id || newTransaction.id,
            dueDate: undefined,
          },
          ...currentDebts,
        ]);
      }

      setFormData({
        customer: '',
        item: '',
        amount: '',
        paymentType: 'cash',
      });

      setFormMessage(
        text(
          'Entry saved successfully.')
      );

      setActiveTab('ledgers');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown save error';

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await enqueueOfflineTransaction(queueEntry);

        setTransactions((currentTransactions) => [
          newTransaction,
          ...currentTransactions,
        ]);

        if (newTransaction.type === 'credit') {
          setDebts((currentDebts) => [
            {
              ...newTransaction,
              dueDate: undefined,
            },
            ...currentDebts,
          ]);
        }

        setFormData({
          customer: '',
          item: '',
          amount: '',
          paymentType: 'cash',
        });

        setFormMessage(
          text(
            'You are offline. The entry was saved to the offline queue.')
        );

        setActiveTab('ledgers');

        return;
      }

      console.error('Manual entry save failed:', error);
      setFormMessage(
        text('Entry could not be saved: {reason}', {
          reason: shown(reason),
        })
      );

      if (reason.includes('Not authenticated')) {
        router.push('/login');
      }
    }
  };

  // =========================================================
  // EXPORT
  // =========================================================

  const handleExport = () => {
    const csvRows = [
      [
        text('Customer'),
        text('Item'),
        text('Amount ({currency})', {
          currency: user.currency || 'UGX',
        }),
        text('Type'),
        text('Date'),
      ],

      ...filteredTransactions.map(
        (transaction) => [
          shown(transaction.customer),
          shown(transaction.item),
          String(transaction.amount),
          transaction.type === 'cash'
            ? text('Cash')
            : text('Credit'),
          whenLabel(
            transaction.timestamp || transaction.date
          ),
        ]
      ),
    ];

    const csv = csvRows
      .map((row) =>
        row
          .map(
            (value) =>
              `"${value.replaceAll(
                '"',
                '""'
              )}"`
          )
          .join(',')
      )
      .join('\n');

    const downloadUrl =
      URL.createObjectURL(
        new Blob([csv], {
          type: 'text/csv;charset=utf-8;',
        })
      );

    const downloadLink =
      document.createElement('a');

    downloadLink.href = downloadUrl;

    downloadLink.download =
      'duukatalk-ledger.csv';

    downloadLink.click();

    URL.revokeObjectURL(downloadUrl);
  };

  // =========================================================
  // VOICE RECORDING
  // =========================================================

  const stopMicrophoneTracks = () => {
    activeStreamRef.current
      ?.getTracks()
      .forEach((track) => track.stop());

    activeStreamRef.current = null;
  };

  const uploadRecording = async (
    audioBlob: Blob
  ) => {
    setIsProcessing(true);
    setMicError('');

    // We no longer gate on navigator.onLine before trying the upload.
    // navigator.onLine is unreliable -- it can report "online" while
    // connected to a network with no real internet behind it. Instead,
    // we try the real upload first and only fall back to the offline
    // queue if the fetch itself fails (a genuine network error).

    try {
      const formData = new FormData();

      formData.append(
        'audio',
        audioBlob,
        'recording.webm'
      );

      formData.append('language', language);
      formData.append('acknowledgedWarning', 'false');

      const response = await fetch(
        '/api/voice-to-json',
        {
          method: 'POST',
          body: formData,
        }
      );

      if (!response.ok) {
        const errorData =
          (await response
            .json()
            .catch(() => null)) as {
            error?: string;
          } | null;

        if (response.status === 409 && errorData?.error) {
          setCreditWarning({
            mode: 'voice',
            message: errorData.error,
            audioBlob,
          });
          return;
        }

        setMicError(
          errorData?.error ||
            text(
              'The voice service did not respond. Please try again.')
        );

        return;
      }

      let data: VoiceToJsonResponse;

      try {
        data =
          (await response.json()) as VoiceToJsonResponse;
      } catch {
        setMicError(
          text(
            'Received an unexpected response. Please try again.')
        );

        return;
      }

      if (
        !data ||
        !data.success ||
        !data.transaction
      ) {
        setMicError(
          data?.error ||
            text(
              'Could not understand the recording. Please try again.')
        );

        return;
      }

      // IMPORTANT:
      // Use the real Firestore document ID.
      if (!data.transactionId) {
        console.error(
          'Voice transaction was saved but no transactionId was returned.'
        );

        setMicError(
          text(
            'The transaction was processed, but its database ID was missing. Please refresh and try again.')
        );

        return;
      }

      const voiceTx =
        data.transaction;

      const customerName =
        voiceTx.customerName?.trim() ||
        'Unknown customer';

      const quantity =
        typeof voiceTx.quantity ===
          'number' &&
        !Number.isNaN(
          voiceTx.quantity
        )
          ? voiceTx.quantity
          : null;

      const unitPrice =
        typeof voiceTx.unitPrice ===
          'number' &&
        !Number.isNaN(
          voiceTx.unitPrice
        )
          ? voiceTx.unitPrice
          : null;

      const amount =
        quantity !== null &&
        unitPrice !== null
          ? quantity * unitPrice
          : 0;

      const itemParts = [
        quantity,
        voiceTx.unit,
        voiceTx.item,
      ].filter(
        (
          part
        ): part is string | number =>
          part !== null &&
          part !== undefined &&
          part !== ''
      );

      const itemLabel =
        itemParts.length > 0
          ? itemParts.join(' ')
          : text(
              'Recorded item');

      const paymentType: Transaction['type'] =
        voiceTx.paymentType ===
        'credit'
          ? 'credit'
          : 'cash';

      const newTransaction: Transaction = {
        id: data.transactionId,

        customer: customerName,

        initials:
          deriveInitials(
            customerName
          ),

        item: itemLabel,

        amount,

        type: paymentType,

        dueDate: voiceTx.dueDate || undefined,

        date:
          voiceTx.timestamp ||
          new Date().toISOString(),
      };

      setTranscript(
        data.transcript || ''
      );

      setTransactions(
        (currentTransactions) => [
          newTransaction,
          ...currentTransactions,
        ]
      );

      if (
        newTransaction.type ===
        'credit'
      ) {
        setDebts(
          (currentDebts) => [
            {
              id: newTransaction.id,
              customer:
                newTransaction.customer,
              initials:
                newTransaction.initials,
              item:
                newTransaction.item,
              amount:
                newTransaction.amount,
              dueDate:
                newTransaction.dueDate,
            },
            ...currentDebts,
          ]
        );
      }

      setFormMessage(
        text(
          'Entry saved from your voice recording.')
      );

      setActiveTab('ledgers');
    } catch (error) {
      // The fetch itself failed -- this means we're genuinely offline
      // (or the server is unreachable), regardless of what
      // navigator.onLine reported. Fall back to queueing the raw
      // recording so it can sync automatically once connectivity
      // actually returns.
      console.error('Voice upload failed, queueing offline:', error);

      const mimeType = audioBlob.type || 'audio/webm';

      try {
        await enqueueOfflineVoiceNote(audioBlob, mimeType);

        setFormMessage(
          text(
            'You are offline. The recording is queued to sync when internet returns.')
        );
      } catch (queueError) {
        console.error(
          'Failed to queue offline voice note:',
          queueError
        );

        setMicError(
          text(
            'Something went wrong uploading your recording. Please check your connection and try again.')
        );
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const startRecording = async () => {
    setMicError('');
    setTranscript('');

    if (
      typeof window === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setMicError(
        text(
          'Microphone access is not supported in this browser.')
      );

      return;
    }

    if (
      typeof MediaRecorder ===
      'undefined'
    ) {
      setMicError(
        text(
          'Voice recording is not supported in this browser.')
      );

      return;
    }

    try {
      const stream =
        await navigator.mediaDevices.getUserMedia(
          {
            audio: true,
          }
        );

      activeStreamRef.current =
        stream;

      const preferredMimeType =
        'audio/webm';

      const recorder =
        MediaRecorder.isTypeSupported(
          preferredMimeType
        )
          ? new MediaRecorder(
              stream,
              {
                mimeType:
                  preferredMimeType,
              }
            )
          : new MediaRecorder(
              stream
            );

      audioChunksRef.current = [];

      recorder.ondataavailable = (
        event: BlobEvent
      ) => {
        if (
          event.data &&
          event.data.size > 0
        ) {
          audioChunksRef.current.push(
            event.data
          );
        }
      };

      recorder.onstop = () => {
        stopMicrophoneTracks();

        const mimeType =
          recorder.mimeType ||
          preferredMimeType;

        const audioBlob =
          new Blob(
            audioChunksRef.current,
            {
              type: mimeType,
            }
          );

        audioChunksRef.current =
          [];

        void uploadRecording(
          audioBlob
        );
      };

      recorder.onerror = () => {
        stopMicrophoneTracks();

        setIsRecording(false);

        setMicError(
          text(
            'Recording failed. Please try again.')
        );
      };

      mediaRecorderRef.current =
        recorder;

      recorder.start();

      setIsRecording(true);
    } catch {
      stopMicrophoneTracks();

      setMicError(
        text(
          'Microphone access was denied or unavailable.')
      );
    }
  };

  const stopRecording = () => {
    const recorder =
      mediaRecorderRef.current;

    if (
      recorder &&
      recorder.state !==
        'inactive'
    ) {
      recorder.stop();
    } else {
      stopMicrophoneTracks();
    }

    setIsRecording(false);
  };

  const handleMicClick = () => {
    if (isProcessing) {
      return;
    }

    if (isRecording) {
      stopRecording();
    } else {
      void startRecording();
    }
  };

  const micStatusText =
    isProcessing
      ? text(
          'Processing...')
      : isRecording
        ? text(
            'Listening...')
        : text(
            'Tap to Speak');

  const micAriaLabel =
    isProcessing
      ? text(
          'Processing recording')
      : isRecording
        ? text(
            'Stop recording')
        : text(
            'Start recording');

  const micStatusMessage =
    isProcessing
      ? text(
          'Processing your recording\u2026')
      : micError
        ? shown(micError)
        : transcript
          ? `${text(
              'Heard')}: "${transcript}"`
          : '';



  const stopQuestionMicrophoneTracks = () => {
  questionStreamRef.current
    ?.getTracks()
    .forEach((track) => track.stop());

  questionStreamRef.current = null;
};
const startQuestionRecording = async () => {
  if (
    isQuestionRecording ||
    isQuestionProcessing
  ) {
    return;
  }

  try {
    setQuestionError('');
    setQuestionTranscript('');
    setQuestionAnswer('');

    if (
      typeof window === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setQuestionError(text('Microphone access is not supported in this browser.'));

      return;
    }

    if (
      typeof MediaRecorder ===
      'undefined'
    ) {
      setQuestionError(text('Voice recording is not supported in this browser.'));

      return;
    }

    const stream =
      await navigator.mediaDevices.getUserMedia(
        {
          audio: true,
        }
      );

    questionStreamRef.current =
      stream;

    // Use the exact same recording format
    // as the working transaction recorder.
    const preferredMimeType =
      'audio/webm';

    const recorder =
      MediaRecorder.isTypeSupported(
        preferredMimeType
      )
        ? new MediaRecorder(
            stream,
            {
              mimeType:
                preferredMimeType,
            }
          )
        : new MediaRecorder(
            stream
          );

    questionMediaRecorderRef.current =
      recorder;

    questionAudioChunksRef.current =
      [];

    recorder.ondataavailable = (
      event: BlobEvent
    ) => {
      if (
        event.data &&
        event.data.size > 0
      ) {
        questionAudioChunksRef.current.push(
          event.data
        );
      }
    };

    recorder.onstop = () => {
      stopQuestionMicrophoneTracks();

      setIsQuestionRecording(false);

      const mimeType =
        recorder.mimeType ||
        preferredMimeType;

      const audioBlob =
        new Blob(
          questionAudioChunksRef.current,
          {
            type: mimeType,
          }
        );
console.log('Question audio:', {
  size: audioBlob.size,
  type: audioBlob.type,
  chunks: questionAudioChunksRef.current.length,
});
      questionAudioChunksRef.current =
        [];

      void askVoiceQuestion(
        audioBlob
      );
    };

    recorder.onerror = () => {
      stopQuestionMicrophoneTracks();

      setIsQuestionRecording(false);

      setQuestionError(text('Recording failed. Please try again.'));
    };

    recorder.start();

    setIsQuestionRecording(true);
  } catch (error) {
    console.error(
      'Failed to start question recording:',
      error
    );

    questionStreamRef.current
      ?.getTracks()
      .forEach((track) => track.stop());

    questionStreamRef.current =
      null;

    setIsQuestionRecording(false);

    setQuestionError(text('Could not access the microphone.'));
  }
};
  const stopQuestionRecording = () => {
  const recorder =
    questionMediaRecorderRef.current;

  if (
    recorder &&
    recorder.state !== 'inactive'
  ) {
    recorder.stop();
  } else {
    stopQuestionMicrophoneTracks();

    setIsQuestionRecording(false);
  }
};

    const askVoiceQuestion = async (
    audioBlob: Blob
  ) => {
    setIsQuestionProcessing(true);
    setQuestionError('');
    setQuestionAnswer('');
    setQuestionTranscript('');

    try {
      const formData = new FormData();

      formData.append(
        'audio',
        audioBlob,
        'question.webm'
      );

      const response = await fetch(
        '/api/query',
        {
          method: 'POST',
          body: formData,
        }
      );

      const data = (await response.json()) as {
        question?: string;
        answer_text?: string;
        audio_url?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(
          data.error ||
            'Could not process your question.'
        );
      }

      if (!data.question) {
        throw new Error(
          'No question transcript was returned.'
        );
      }

      if (!data.answer_text) {
        throw new Error(
          'No answer was returned.'
        );
      }

      setQuestionTranscript(
        data.question
      );

      setQuestionAnswer(
        data.answer_text
      );

      if (data.audio_url) {
        setIsQuestionSpeaking(true);

        const audio = new Audio(
          data.audio_url
        );

        questionAudioRef.current =
          audio;

        audio.onended = () => {
          setIsQuestionSpeaking(false);
          questionAudioRef.current = null;
        };

        audio.onerror = () => {
          setIsQuestionSpeaking(false);
          questionAudioRef.current = null;

          setQuestionError(text('I could not play the spoken response.'));
        };

        try {
          await audio.play();
        } catch (error) {
          console.error(
            'Failed to play voice response:',
            error
          );

          setIsQuestionSpeaking(false);

          setQuestionError(text('The answer is ready, but I could not play the audio.'));
        }
      }
    } catch (error) {
      console.error(
        'Voice question failed:',
        error
      );

      setQuestionError(
        error instanceof Error
          ? shown(error.message)
          : text('Could not process your question.')
      );
    } finally {
      setIsQuestionProcessing(false);
    }
  };
    const handleQuestionMicClick = () => {
    if (
      isQuestionProcessing ||
      isQuestionSpeaking
    ) {
      return;
    }

    if (isQuestionRecording) {
      stopQuestionRecording();
    } else {
      void startQuestionRecording();
    }
  };
  // =========================================================
  // RECORD SCREEN
  // =========================================================

  const renderRecordScreen = () => (
    <div className="space-y-4">
      {/* Profile Header */}
      <div
        className={`p-3.5 rounded-xl border flex items-center justify-between ${
          isDarkMode
            ? 'bg-slate-800/50 border-slate-700'
            : 'bg-slate-50 border-slate-200'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="bg-amber-100 dark:bg-amber-900/40 p-2.5 rounded-full text-amber-600">
            <Store size={20} />
          </div>

          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-sm">
                {text('Your Business')}
              </span>

              <span className="text-sm">
                \ud83d\udc4b
              </span>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">
              {text('DuukaTalk Vendor')}
            </p>
          </div>
        </div>

        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300">
          {text('Connected')}
        </span>
      </div>

      {/* Voice Record Hero */}
      <div className="bg-blue-900 rounded-2xl p-6 text-center text-white flex flex-col items-center justify-center shadow-inner">
        <button
          type="button"
          onClick={handleMicClick}
          disabled={isProcessing}
          aria-pressed={isRecording}
          aria-label={micAriaLabel}
          className={`w-20 h-20 rounded-full flex items-center justify-center transition-all transform active:scale-95 shadow-lg ${
            isProcessing
              ? 'bg-blue-200/60 text-blue-900 cursor-not-allowed'
              : isRecording
                ? 'bg-red-500 ring-8 ring-red-400/30 animate-pulse'
                : 'bg-white text-blue-900 hover:bg-blue-50'
          }`}
        >
          {isProcessing ? (
            <Loader2
              size={36}
              className="text-blue-900 animate-spin"
            />
          ) : (
            <Mic
              size={36}
              className={
                isRecording
                  ? 'text-white'
                  : 'text-blue-900'
              }
            />
          )}
        </button>

        <h2 className="mt-4 font-bold text-lg">
          {micStatusText}
        </h2>

        <p className="text-xs text-blue-200 mt-1 max-w-xs leading-relaxed">
          {text(
            'Record a sale or debt in English or Luganda')}
        </p>

        <p
          className="mt-2 min-h-[1rem] text-xs font-medium text-amber-200"
          role="status"
        >
          {micStatusMessage}
        </p>
      </div>

      {/* API Error */}
      {apiError && (
        <p
          className="rounded-lg bg-amber-50 px-3 py-2 text-center text-xs text-amber-800"
          role="status"
        >
          {text(
            'Could not load your live database data. Please refresh and try again.')}
        </p>
      )}

      <div className="relative flex items-center justify-center py-1">
        <div className="border-t border-slate-200 dark:border-slate-800 w-full" />

        <span className="bg-white dark:bg-slate-900 px-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider absolute">
          {text(
            'OR WRITE')}
        </span>
      </div>

      {/* Manual Input Form */}
      <form
        onSubmit={handleSaveEntry}
        className="space-y-3"
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
          <Edit3 size={14} />

          <span>
            {text(
              'Type manually')}
          </span>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            {text(
              'Customer (Name or Phone)')}
          </label>

          <div className="relative">
            <User
              size={16}
              className="absolute left-3 top-2.5 text-slate-400"
            />

            <input
              type="text"
              placeholder={text('e.g. Nakato Grace or 0772\u2026')}
              value={formData.customer}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  customer:
                    e.target.value,
                })
              }
              className={`w-full pl-9 pr-3 py-2 text-sm rounded-lg border outline-none ${
                isDarkMode
                  ? 'bg-slate-800 border-slate-700 text-white'
                  : 'bg-white border-slate-300'
              }`}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            {text(
              'Item & Quantity')}
          </label>

          <div className="relative">
            <Package
              size={16}
              className="absolute left-3 top-2.5 text-slate-400"
            />

            <input
              type="text"
              placeholder={text('e.g. Kasooli 2kg, Amafuta 1L')}
              value={formData.item}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  item: e.target.value,
                })
              }
              className={`w-full pl-9 pr-3 py-2 text-sm rounded-lg border outline-none ${
                isDarkMode
                  ? 'bg-slate-800 border-slate-700 text-white'
                  : 'bg-white border-slate-300'
              }`}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            {text('Total Amount ({currency})', {
              currency: user.currency || 'UGX',
            })}
          </label>

          <div className="relative">
            <span className="absolute left-3 top-2 text-xs font-bold text-slate-400">
            {user.currency || 'UGX'}
            </span>

            <input
              type="number"
              placeholder="0"
              value={formData.amount}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  amount: e.target.value,
                })
              }
              className={`w-full pl-12 pr-3 py-2 text-sm font-semibold rounded-lg border outline-none ${
                isDarkMode
                  ? 'bg-slate-800 border-slate-700 text-white'
                  : 'bg-white border-slate-300'
              }`}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 pt-1">
          <button
            type="button"
            onClick={() =>
              setFormData({
                ...formData,
                paymentType: 'cash',
              })
            }
            className={`py-2 px-3 rounded-lg border flex items-center justify-center gap-2 text-xs font-medium transition ${
              formData.paymentType === 'cash'
                ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
            }`}
          >
            <DollarSign size={16} />

            \ud83d\udcb5{' '}
            {text(
              'Cash')}
          </button>

          <button
            type="button"
            onClick={() =>
              setFormData({
                ...formData,
                paymentType: 'credit',
              })
            }
            className={`py-2 px-3 rounded-lg border flex items-center justify-center gap-2 text-xs font-medium transition ${
              formData.paymentType === 'credit'
                ? 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
            }`}
          >
            <CreditCard size={16} />

            \ud83d\udcd2{' '}
            {text(
              'Credit')}
          </button>
        </div>

        <button
          type="submit"
          className="w-full py-2.5 mt-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl text-sm flex items-center justify-center gap-2 shadow-sm transition"
        >
          <CheckCircle size={16} />

          {text(
            'Save Entry')}{' '}
          \u2713
        </button>

        {formMessage && (
          <p
            className="text-center text-xs font-medium text-emerald-600 dark:text-emerald-400"
            role="status"
          >
            {shown(formMessage)}
          </p>
        )}
      </form>
    </div>
  );

  // =========================================================
  // LEDGER SCREEN
  // =========================================================

  const renderLedgersScreen = () => {
    const totalSales =
      summary?.totalSales ?? 0;

    const totalCreditOutstanding =
      summary?.totalCreditOutstanding ?? 0;

    return (
      <div className="space-y-4 relative min-h-[36.25rem]">
        {/* Date Navigation */}
        <div className="flex items-center justify-between gap-2">
          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium ${
              isDarkMode
                ? 'bg-slate-800 border-slate-700'
                : 'bg-white border-slate-200'
            }`}
          >
            <ChevronLeft
              size={16}
              className="cursor-pointer text-slate-400 hover:text-slate-600"
            />

            <span>
              {new Date().toLocaleDateString(
                undefined,
                {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'short',
                }
              )}
            </span>

            <ChevronRight
              size={16}
              className="cursor-pointer text-slate-400 hover:text-slate-600"
            />
          </div>

          <button
            onClick={handleExport}
            type="button"
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 rounded-lg border border-blue-200 dark:border-blue-800"
          >
            <Download size={14} />
            CSV
          </button>
        </div>

        {/* Time Filter */}
        <div className="grid grid-cols-3 gap-1.5 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl text-xs font-medium">
          <button
            type="button"
            onClick={() =>
              setTimeframe('daily')
            }
            className={`py-1.5 rounded-lg transition ${
              timeframe === 'daily'
                ? 'bg-white dark:bg-slate-700 shadow-sm text-blue-900 dark:text-white font-bold'
                : 'text-slate-500'
            }`}
          >
            {text(
              'Daily')}
          </button>

          <button
            type="button"
            onClick={() =>
              setTimeframe('weekly')
            }
            className={`py-1.5 rounded-lg transition ${
              timeframe === 'weekly'
                ? 'bg-white dark:bg-slate-700 shadow-sm text-blue-900 dark:text-white font-bold'
                : 'text-slate-500'
            }`}
          >
            {text(
              'Weekly')}
          </button>

          <button
            type="button"
            onClick={() =>
              setTimeframe('monthly')
            }
            className={`py-1.5 rounded-lg transition ${
              timeframe === 'monthly'
                ? 'bg-white dark:bg-slate-700 shadow-sm text-blue-900 dark:text-white font-bold'
                : 'text-slate-500'
            }`}
          >
            {text(
              'Monthly')}
          </button>
        </div>

        {/* Database Summary */}
        <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl p-4 text-white shadow-md">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[11px] text-blue-200 uppercase font-semibold tracking-wider">
                {text(
                  'Total inflows')}
              </span>

             <div className="text-2xl font-extrabold mt-0.5">
              {isLoadingData
              ? text('Loading...')
              : formatCurrency(totalSales, user.currency)}
             </div>

            <span className="inline-flex items-center text-xs font-semibold bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full border border-emerald-500/30">
              <TrendingUp
                size={12}
                className="mr-1"
              />

              {text('Live')}
            </span>
          </div>
</div>
          <div className="grid grid-cols-2 gap-2 mt-4 pt-3 border-t border-blue-800/60 text-xs">
            <div>
              <span className="text-blue-300 text-[11px]">
                {text(
                  'Cash in Hand')}
              </span>

              <p className="font-bold text-sm">
  {isLoadingData
    ? text('Loading...')
    : formatCurrency(totalSales, user.currency)}
</p>
            </div>

            <div>
              <span className="text-blue-300 text-[11px]">
                {text(
                  'Credit Given')}
              </span>

              <p className="font-bold text-sm text-amber-300">
                {isLoadingData
                  ? text('Loading...')
                  : formatCurrency(totalCreditOutstanding, user.currency)}
              </p>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-3 text-slate-400"
          />

          <input
            type="text"
            placeholder={text(
              'Search customer or item\u2026')}
            value={searchQuery}
            onChange={(e) =>
              setSearchQuery(
                e.target.value
              )
            }
            className={`w-full pl-9 pr-9 py-2.5 text-xs rounded-xl border outline-none ${
              isDarkMode
                ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-500'
                : 'bg-slate-50 border-slate-200 placeholder-slate-400'
            }`}
          />

          <button
            type="button"
            onClick={handleQuestionMicClick}
            className="absolute right-3 top-2.5 text-amber-500"
            aria-label={text('Ask DuukaTalk a question')}
          >
             <Mic size={16} />
          </button>

        </div>
                

        {(isQuestionRecording ||
          isQuestionProcessing ||
          isQuestionSpeaking ||
          questionTranscript ||
          questionAnswer ||
          questionError) && (
          <div
            className={`rounded-xl border p-3 ${
              isDarkMode
                ? 'bg-slate-800/60 border-slate-700'
                : 'bg-amber-50 border-amber-200'
            }`}
          >
            <div className="flex items-center gap-2">
              <Mic
                size={15}
                className="text-amber-500"
              />

              <span className="text-xs font-bold">
                {isQuestionRecording
                  ? text(
                      'Listening\u2026')
                  : isQuestionProcessing
                    ? text(
                        'Thinking\u2026')
                    : isQuestionSpeaking
                      ? text(
                          'Speaking\u2026')
                      : text(
                          'Voice Assistant')}
              </span>
            </div>

            {questionTranscript && (
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                <span className="font-semibold">
                  {text(
                    'You:')}
                </span>{' '}
                {questionTranscript}
              </p>
            )}

            {questionAnswer && (
              <p className="mt-1.5 text-xs leading-relaxed">
                <span className="font-semibold">
                  {text(
                    'DuukaTalk:')}
                </span>{' '}
                {questionAnswer}
              </p>
            )}

            {questionError && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                {shown(questionError)}
              </p>
            )}
          </div>
        )}


        {/* Transactions */}
        <div>
          <div className="flex justify-between items-center mb-2 px-1">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
              {text(
                'Transactions')}
            </span>

            <span className="text-[11px] text-slate-400">
              {text(
                'From your database')}
            </span>
          </div>

          <div className="space-y-2">
            {isLoadingData && (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-500">
                <Loader2
                  size={16}
                  className="animate-spin"
                />

                {text(
                  'Loading your transactions...')}
              </div>
            )}

          {!isLoadingData &&
  filteredTransactions.map((tx) => (
    <div
      key={tx.id}
      className={`p-3 rounded-xl border ${
        isDarkMode
          ? 'bg-slate-800/60 border-slate-700/60'
          : 'bg-white border-slate-100 shadow-sm'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 shrink-0 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 flex items-center justify-center font-bold text-xs">
            {tx.initials}
          </div>

          <div className="min-w-0">
            <h4 className="text-xs font-bold truncate">
              {shown(tx.customer)}
            </h4>

            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
              {shown(tx.item)}
            </p>

            <p className="text-[10px] text-slate-400 mt-0.5">
              {whenLabel(tx.timestamp || tx.date)}
            </p>
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="text-xs font-bold">
            {formatCurrency(tx.amount, user.currency)}
          </div>

          <div className="flex items-center justify-end gap-1.5 mt-1">
            <span
              className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                tx.type === 'cash'
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
              }`}
            >
              {tx.type === 'cash'
                ? text('Cash')
                : tx.dueDate
                  ? dueLabel(tx.dueDate)
                  : text('Credit')}
            </span>

            <button
              type="button"
              onClick={() => handleStartEdit(tx)}
              className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300 dark:hover:bg-blue-900 transition"
              aria-label={text('Edit transaction for {customer}', {
                customer: shown(tx.customer),
              })}
              title={text(
                'Edit transaction')}
            >
              <Edit3 size={13} />
            </button>

            <button
              type="button"
              onClick={() => handleStartDelete(tx)}
              className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-900 transition"
              aria-label={text('Delete transaction for {customer}', {
                customer: shown(tx.customer),
              })}
              title={text(
                'Delete transaction')}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  ))}
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // EDIT MODAL
  // =========================================================

  const renderEditModal = () => {
    if (!editingTransaction) {
      return null;
    }

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4">
        <div
          className={`w-full max-w-md rounded-2xl shadow-2xl overflow-hidden ${
            isDarkMode
              ? 'bg-slate-900 text-white'
              : 'bg-white text-slate-800'
          }`}
        >
          {/* Modal Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
            <div>
              <h2 className="font-bold text-base">
                {text(
                  'Edit Transaction')}
              </h2>

              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {text(
                  'Update the transaction details below.')}
              </p>
            </div>

            <button
              type="button"
              onClick={handleCancelEdit}
              disabled={isSavingEdit}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition disabled:opacity-50"
              aria-label={text('Close edit form')}
            >
              <X size={18} />
            </button>
          </div>

          {/* Modal Body */}
          <div className="p-5 space-y-4">
            {/* Customer */}
            <div>
              <label className="block text-xs font-semibold mb-1.5 text-slate-600 dark:text-slate-300">
                {text(
                  'Customer')}
              </label>

              <div className="relative">
                <User
                  size={16}
                  className="absolute left-3 top-2.5 text-slate-400"
                />

                <input
                  type="text"
                  value={
                    editFormData.customer
                  }
                  onChange={(event) =>
                    setEditFormData({
                      ...editFormData,
                      customer:
                        event.target.value,
                    })
                  }
                  className={`w-full pl-9 pr-3 py-2.5 text-sm rounded-lg border outline-none ${
                    isDarkMode
                      ? 'bg-slate-800 border-slate-700 text-white'
                      : 'bg-white border-slate-300'
                  }`}
                />
              </div>
            </div>

            {/* Item */}
            <div>
              <label className="block text-xs font-semibold mb-1.5 text-slate-600 dark:text-slate-300">
                {text(
                  'Item')}
              </label>

              <div className="relative">
                <Package
                  size={16}
                  className="absolute left-3 top-2.5 text-slate-400"
                />

                <input
                  type="text"
                  value={
                    editFormData.item
                  }
                  onChange={(event) =>
                    setEditFormData({
                      ...editFormData,
                      item: event.target.value,
                    })
                  }
                  className={`w-full pl-9 pr-3 py-2.5 text-sm rounded-lg border outline-none ${
                    isDarkMode
                      ? 'bg-slate-800 border-slate-700 text-white'
                      : 'bg-white border-slate-300'
                  }`}
                />
              </div>
            </div>

            {/* Amount */}
            <div>
              <label className="block text-xs font-semibold mb-1.5 text-slate-600 dark:text-slate-300">
                {text('Total Amount ({currency})', {
                  currency: user.currency || 'UGX',
                })}
              </label>

              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs font-bold text-slate-400">
                  {user.currency || 'UGX'}
                </span>

                <input
                  type="number"
                  min="1"
                  value={
                    editFormData.amount
                  }
                  onChange={(event) =>
                    setEditFormData({
                      ...editFormData,
                      amount:
                        event.target.value,
                    })
                  }
                  className={`w-full pl-12 pr-3 py-2.5 text-sm font-semibold rounded-lg border outline-none ${
                    isDarkMode
                      ? 'bg-slate-800 border-slate-700 text-white'
                      : 'bg-white border-slate-300'
                  }`}
                />
              </div>
            </div>

            {/* Payment Type */}
            <div>
              <label className="block text-xs font-semibold mb-1.5 text-slate-600 dark:text-slate-300">
                {text(
                  'Payment Type')}
              </label>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setEditFormData({
                      ...editFormData,
                      paymentType:
                        'cash',
                    })
                  }
                  className={`py-2.5 rounded-lg border text-xs font-semibold transition ${
                    editFormData.paymentType ===
                    'cash'
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                      : 'border-slate-200 dark:border-slate-700 text-slate-500'
                  }`}
                >
                  \ud83d\udcb5{' '}
                  {text(
                    'Cash')}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setEditFormData({
                      ...editFormData,
                      paymentType:
                        'credit',
                    })
                  }
                  className={`py-2.5 rounded-lg border text-xs font-semibold transition ${
                    editFormData.paymentType ===
                    'credit'
                      ? 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
                      : 'border-slate-200 dark:border-slate-700 text-slate-500'
                  }`}
                >
                  \ud83d\udcd2{' '}
                  {text(
                    'Credit')}
                </button>
              </div>
            </div>

            {/* Due Date */}
            {editFormData.paymentType ===
              'credit' && (
              <div>
                <label className="block text-xs font-semibold mb-1.5 text-slate-600 dark:text-slate-300">
                  {text(
                    'Due Date')}
                </label>

                <input
                  type="date"
                  value={
                    editFormData.dueDate
                  }
                  onChange={(event) =>
                    setEditFormData({
                      ...editFormData,
                      dueDate:
                        event.target.value,
                    })
                  }
                  className={`w-full px-3 py-2.5 text-sm rounded-lg border outline-none ${
                    isDarkMode
                      ? 'bg-slate-800 border-slate-700 text-white'
                      : 'bg-white border-slate-300'
                  }`}
                />
              </div>
            )}

            {/* Error */}
            {editError && (
              <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2.5 text-xs text-red-700 dark:text-red-300">
                {shown(editError)}
              </div>
            )}

            {/* Buttons */}
            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                type="button"
                onClick={handleCancelEdit}
                disabled={isSavingEdit}
                className="py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition disabled:opacity-50"
              >
                {text(
                  'Cancel')}
              </button>

              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={isSavingEdit}
                className="py-2.5 rounded-xl bg-blue-900 hover:bg-blue-800 text-white text-xs font-semibold flex items-center justify-center gap-2 transition disabled:opacity-60"
              >
                {isSavingEdit ? (
                  <>
                    <Loader2
                      size={15}
                      className="animate-spin"
                    />

                    {text(
                      'Saving...')}
                  </>
                ) : (
                  <>
                    <Save size={15} />

                    {text(
                      'Save Changes')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // DELETE CONFIRMATION MODAL
  // =========================================================

  const renderDeleteModal = () => {
    if (!deletingTransaction) {
      return null;
    }

    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4">
        <div
          className={`w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden ${
            isDarkMode
              ? 'bg-slate-900 text-white'
              : 'bg-white text-slate-800'
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-950/60 text-red-600 dark:text-red-400 flex items-center justify-center">
                <Trash2 size={19} />
              </div>

              <div>
                <h2 className="font-bold text-base">
                  {text(
                    'Delete Transaction?')}
                </h2>

                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {text(
                    'This action cannot be undone.')}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleCancelDelete}
              disabled={
                isDeletingTransaction
              }
              className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition disabled:opacity-50"
              aria-label={text('Close delete confirmation')}
            >
              <X size={18} />
            </button>
          </div>

          {/* Transaction Preview */}
          <div className="p-5">
            <div
              className={`rounded-xl border p-3 mb-4 ${
                isDarkMode
                  ? 'bg-slate-800/60 border-slate-700'
                  : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold truncate">
                    {
                      deletingTransaction.customer
                    }
                  </p>

                  <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                    {
                      deletingTransaction.item
                    }
                  </p>
                </div>

                <div className="text-right shrink-0">
                  <p className="text-xs font-bold">
                    {formatCurrency(
                      deletingTransaction.amount,
                      user.currency
                    )}
                  </p>

                  <span
                    className={`inline-block mt-1 px-2 py-0.5 rounded text-[10px] font-semibold ${
                      deletingTransaction.type ===
                      'cash'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                    }`}
                  >
                    {deletingTransaction.type ===
                    'cash'
                      ? text('Cash')
                      : text('Credit')}
                  </span>
                </div>
              </div>
            </div>

            {/* Error */}
            {deleteError && (
              <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2.5 text-xs text-red-700 dark:text-red-300 mb-4">
                {shown(deleteError)}
              </div>
            )}

            {/* Buttons */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handleCancelDelete}
                disabled={
                  isDeletingTransaction
                }
                className="py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition disabled:opacity-50"
              >
                {text(
                  'Cancel')}
              </button>

              <button
                type="button"
                onClick={
                  handleConfirmDelete
                }
                disabled={
                  isDeletingTransaction
                }
                className="py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold flex items-center justify-center gap-2 transition disabled:opacity-60"
              >
                {isDeletingTransaction ? (
                  <>
                    <Loader2
                      size={15}
                      className="animate-spin"
                    />

                    {text(
                      'Deleting...')}
                  </>
                ) : (
                  <>
                    <Trash2 size={15} />

                    {text(
                      'Delete')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // DEBTS SCREEN
  // =========================================================

  const totalDebts = debts.reduce(
    (total, debt) =>
      total + debt.amount,
    0
  );

  const renderDebtsScreen = () => (
    <div className="space-y-4">
      {/* Outstanding Debt Summary */}
      <div className="bg-amber-500 rounded-2xl p-4 text-slate-950 shadow-md">
        <div className="flex justify-between items-start">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-800">
              {text(
                'Outstanding debts')}
            </span>

            <div className="text-2xl font-extrabold mt-0.5">
              {isLoadingDebts
                ? text('Loading...')
                : formatCurrency(totalDebts, user.currency)}
            </div>
          </div>

          <AlertCircle
            size={22}
            className="text-slate-900"
          />
        </div>

        <p className="text-xs mt-2 font-medium text-slate-800">
          {debts.length === 1
            ? text('1 customer has outstanding credit.')
            : text('{count} customers have outstanding credit.', {
                count: debts.length,
              })}
        </p>
      </div>

      <div className="flex justify-between items-center pt-2">
        <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
          {text(
            'Active Debts')}
        </h3>

        <button
          type="button"
          onClick={() => {
            setFormData(
              (currentForm) => ({
                ...currentForm,
                paymentType:
                  'credit',
              })
            );

            setActiveTab('record');
          }}
          className="text-xs text-blue-600 dark:text-blue-400 font-semibold flex items-center gap-1"
        >
          <Plus size={14} />

          {text(
            'Add Debt')}
        </button>
      </div>

      {debts
        .filter(
          (debt) => debt.amount > CREDIT_LIMIT
        )
        .map((debt) => (
          <div
            key={`limit-${debt.id}`}
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            <strong>
              {text(
                'Exceeded loan limit')}
            </strong>

            {': '}
            {text('{customer} has exceeded {limit} by {excess}.', {
              customer: shown(debt.customer),
              limit: formatCurrency(CREDIT_LIMIT, user.currency),
              excess: formatCurrency(
                debt.amount - CREDIT_LIMIT,
                user.currency
              ),
            })}
          </div>
        ))}

      {/* Debt List */}
      <div className="space-y-2.5">
        {isLoadingDebts && (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-500">
            <Loader2
              size={16}
              className="animate-spin"
            />

            {text(
              'Loading debts...')}
          </div>
        )}

        {!isLoadingDebts &&
          debts.map((debt) => (
            <div
              key={debt.id}
              className={`p-3 rounded-xl border ${
                isDarkMode
                  ? 'bg-slate-800/60 border-slate-700/60'
                  : 'bg-white border-slate-100 shadow-sm'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 shrink-0 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 flex items-center justify-center font-bold text-xs">
                    {debt.initials}
                  </div>

                  <div className="min-w-0">
                    <h4 className="text-xs font-bold truncate">
                      {shown(debt.customer)}
                    </h4>

                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {shown(debt.item)}
                    </p>

                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {dueLabel(debt.dueDate)}
                    </p>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <div className="text-xs font-extrabold text-amber-600 dark:text-amber-400">
                    {formatCurrency(
                      debt.amount,
                      user.currency
                    )}
                  </div>

                  <span className="inline-block mt-1 px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 text-[10px] font-semibold">
                    {text(
                      'Credit')}
                  </span>
                </div>
              </div>
            </div>
          ))}

        {!isLoadingDebts &&
          debts.length === 0 && (
            <div className="py-8 text-center">
              <CreditCard
                size={28}
                className="mx-auto text-slate-300 dark:text-slate-700 mb-2"
              />

              <p className="text-xs text-slate-500">
                {text(
                  'No outstanding debts found.')}
              </p>
            </div>
          )}
      </div>
    </div>
  );

  // =========================================================
  // REPORTS SCREEN
  // =========================================================

  const renderReportsScreen = () => {
    const now = reportNow;

    const rangeMs =
      timeframe === 'daily'
        ? 24 * 60 * 60 * 1000
        : timeframe === 'weekly'
          ? 7 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000;

    const periodTransactions =
      transactions.filter(
        (transaction) => {
          const timestamp =
            transaction.timestamp
              ? new Date(
                  transaction.timestamp
                ).getTime()
              : new Date(
                  transaction.date
                ).getTime();

          return (
            Number.isNaN(timestamp) ||
            now - timestamp <=
              rangeMs
          );
        }
      );

    const cashSales =
      periodTransactions
        .filter(
          (transaction) =>
            transaction.type ===
            'cash'
        )
        .reduce(
          (total, transaction) =>
            total + transaction.amount,
          0
        );

    const debtSales =
      periodTransactions
        .filter(
          (transaction) =>
            transaction.type ===
            'credit'
        )
        .reduce(
          (total, transaction) =>
            total + transaction.amount,
          0
        );

    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
            {text(
              'Business Insights')}
          </h3>

          <span className="text-xs text-blue-600 dark:text-blue-400 font-semibold">
            {text(
              'Live Data')}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-100 p-1 text-xs font-medium dark:bg-slate-800">
          {(
            [
              'daily',
              'weekly',
              'monthly',
            ] as const
          ).map((period) => (
            <button
              type="button"
              key={period}
              onClick={() =>
                setTimeframe(period)
              }
              className={`rounded-lg py-1.5 ${
                timeframe === period
                  ? 'bg-white font-bold text-blue-900 shadow-sm dark:bg-slate-700 dark:text-white'
                  : 'text-slate-500'
              }`}
            >
              {text(
                period === 'daily'
                  ? 'Daily'
                  : period === 'weekly'
                    ? 'Weekly'
                    : 'Monthly'
              )}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div
            className={`p-3.5 rounded-xl border ${
              isDarkMode
                ? 'bg-slate-800/60 border-slate-700'
                : 'bg-white border-slate-200'
            }`}
          >
            <span className="text-[11px] text-slate-500">
              {text(
                'Cash sales')}
            </span>

            <div className="text-base font-extrabold text-emerald-600 dark:text-emerald-400 mt-1">
              {formatCurrency(cashSales, user.currency)}
            </div>

            <span className="text-[10px] text-emerald-600 font-semibold">
              {text(
                'From your database')}
            </span>
          </div>

          <div
            className={`p-3.5 rounded-xl border ${
              isDarkMode
                ? 'bg-slate-800/60 border-slate-700'
                : 'bg-white border-slate-200'
            }`}
          >
            <span className="text-[11px] text-slate-500">
              {text(
                'Debt sales')}
            </span>

            <div className="text-base font-extrabold text-blue-600 dark:text-blue-400 mt-1">
              {formatCurrency(debtSales, user.currency)}
            </div>

            <span className="text-[10px] text-blue-600 font-semibold">
              {text(
                'From your database')}
            </span>
          </div>
        </div>

        {/* Database transaction information */}
        <div
          className={`p-4 rounded-xl border ${
            isDarkMode
              ? 'bg-slate-800/60 border-slate-700'
              : 'bg-white border-slate-200'
          }`}
        >
          <h4 className="mb-3 text-xs font-bold">
            {text(
              'Savings & Loan Readiness Coach')}
          </h4>

          <div className="space-y-3">
            <div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-950/30">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                  {text(
                    'Loan readiness score')}
                </span>
                <span className="rounded-full bg-emerald-700 px-2 py-0.5 text-[10px] font-bold text-white">
                  {summary?.loanReadinessScore ?? 0}
                </span>
              </div>
              <div className="mt-2 text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                {text(
                  'Recommended savings target')}
                {': '}
                {formatCurrency(
                  summary?.recommendedSavings ?? 0,
                  user.currency
                )}
              </div>
              <div className="mt-2 text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                {text(
                  'Cash vs credit in shop')}
                : {summary?.creditSharePercent ?? 0}%
              </div>
            </div>

            <div className="rounded-xl bg-blue-50 p-3 dark:bg-blue-950/30">
              <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                {text(
                  'Coach advice')}
              </div>
              <p className="mt-2 text-[11px] leading-5 text-slate-600 dark:text-slate-300">
                {summary?.adviceCode
                  ? coachAdvice(summary)
                  : text(
                    'Keep cash at hand above credit and save a percentage of sales each week. If your shop accounts are operating well, banks can give you a loan.')}
              </p>
            </div>
          </div>
        </div>

        <div
          className={`p-4 rounded-xl border ${
            isDarkMode
              ? 'bg-slate-800/60 border-slate-700'
              : 'bg-white border-slate-200'
          }`}
        >
          <h4 className="mb-3 text-xs font-bold">
            {text(
              'Database Activity')}
          </h4>

          <div className="space-y-3">
            <div className="flex justify-between text-xs">
              <span className="text-slate-500">
                {text(
                  'Transactions recorded')}
              </span>

              <span className="font-bold">
                {transactions.length}
              </span>
            </div>

            <div className="flex justify-between text-xs">
              <span className="text-slate-500">
                {text(
                  'Cash transactions')}
              </span>

              <span className="font-bold">
                {
                  transactions.filter(
                    (transaction) =>
                      transaction.type ===
                      'cash'
                  ).length
                }
              </span>
            </div>

            <div className="flex justify-between text-xs">
              <span className="text-slate-500">
                {text(
                  'Credit transactions')}
              </span>

              <span className="font-bold">
                {
                  transactions.filter(
                    (transaction) =>
                      transaction.type ===
                      'credit'
                  ).length
                }
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // MAIN UI
  // =========================================================

  return (
    <div
      className={`min-h-screen flex justify-center items-center ${
        isDarkMode
          ? 'bg-gray-950 text-white'
          : 'bg-slate-100 text-slate-800'
      }`}
    >
      <div
        className={`w-full max-w-md min-h-screen sm:min-h-0 sm:h-[52.5rem] sm:rounded-3xl shadow-2xl flex flex-col justify-between overflow-hidden relative ${
          isDarkMode
            ? 'bg-slate-900'
            : 'bg-white'
        }`}
      >
        {/* App Header */}
    <header className="bg-blue-900 text-white px-5 py-4 flex items-center justify-between shadow-md">
  <div className="flex items-center gap-2">
    <div className="bg-amber-500 p-2 rounded-lg text-slate-900 font-bold">
      <Mic size={18} />
    </div>

    <h1 className="font-bold text-base leading-tight">
      {user.businessName || 'DuukaTalk'}
    </h1>
  </div>

  <div className="flex items-center gap-2">
    <label
      className="sr-only"
      htmlFor="language-mode"
    >
      {text('Language')}
    </label>

    <select
      id="language-mode"
      value={language}
      onChange={(event) =>
        handleLanguageChange(
          event.target.value as Language
        )
      }
      className="max-w-28 rounded-md border border-blue-600 bg-blue-800/80 px-2 py-1 text-xs font-semibold text-white outline-none"
    >
      {LANGUAGE_OPTIONS.map((option) => (
        <option
          key={option.value}
          value={option.value}
        >
          {option.label}
        </option>
      ))}
    </select>

    {/* Notifications */}
    <div className="relative">
      <button
        type="button"
        onClick={() =>
          setShowNotifications(
            (open) => !open
          )
        }
        className="relative rounded-md p-1.5 text-blue-200 transition hover:bg-blue-800/80 hover:text-white"
        aria-label={text(
          'Notifications')}
      >
        <Bell size={18} />

        {notifications.length > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
            {notifications.length > 9
              ? '9+'
              : notifications.length}
          </span>
        )}
      </button>

      {showNotifications && (
        <div className="absolute right-0 top-10 z-50 w-72 rounded-xl border border-slate-200 bg-white p-3 text-slate-800 shadow-xl dark:border-slate-700 dark:bg-slate-800 dark:text-white">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">
              {text(
                'Notifications')}
            </h2>

            <button
              type="button"
              onClick={() =>
                setShowNotifications(false)
              }
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-white"
              aria-label={text(
                'Close notifications')}
            >
              <X size={16} />
            </button>
          </div>

          {notifications.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-500 dark:text-slate-400">
              {text(
                'No new notifications')}
            </p>
          ) : (
            <div className="space-y-2">
              {notifications.map(
                (notification) => (
                  <div
                    key={notification.id}
                    className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                  >
                    <div className="flex gap-2">
                      <AlertCircle
                        size={15}
                        className="mt-0.5 shrink-0"
                      />

                      <span>
                        {notification.message}
                      </span>
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>

    {/* Settings */}
    <button
      type="button"
      onClick={() =>
        setIsSettingsOpen(
          (open) => !open
        )
      }
      className="rounded-md p-1.5 text-blue-200 transition hover:bg-blue-800/80 hover:text-white"
      aria-label={text(
        'Settings')}
    >
      <Settings size={18} />
    </button>
  </div>
</header>
        {/* SETTINGS */}
        {isSettingsOpen && (
          <div className="absolute right-3 top-16 z-20 w-64 rounded-xl border border-slate-200 bg-white p-3 text-slate-800 shadow-xl dark:border-slate-700 dark:bg-slate-800 dark:text-white">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold">
                {text(
                  'Settings')}
              </h2>

              <button
                type="button"
                onClick={toggleTheme}
                aria-label={text('Toggle theme')}
                className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                {isDarkMode ? (
                  <Sun size={16} />
                ) : (
                  <Moon size={16} />
                )}
              </button>
            </div>

            <button
              type="button"
              onClick={() =>
                setIsPrivacyOpen(
                  (open) => !open
                )
              }
              className="mb-2 w-full rounded-lg bg-slate-100 px-3 py-2 text-left text-xs font-semibold dark:bg-slate-700"
            >
              {text(
                'Privacy')}
            </button>

            {isPrivacyOpen && (
              <div className="space-y-2">
                <p className="text-[11px] text-slate-500">
                  {text(
                    'Change PIN or phone number')}
                </p>

                <input
                  value={newPin}
                  onChange={(event) =>
                    setNewPin(
                      event.target.value
                        .replace(/\D/g, '')
                        .slice(0, 4)
                    )
                  }
                  placeholder={text('New 4-digit PIN')}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs dark:border-slate-600 dark:bg-slate-900"
                  inputMode="numeric"
                />

                <input
                  value={newPhone}
                  onChange={(event) =>
                    setNewPhone(
                      event.target.value
                    )
                  }
                  placeholder={text('Phone number')}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs dark:border-slate-600 dark:bg-slate-900"
                />

                <button
                  type="button"
                  onClick={() =>
                    void handleSavePrivacy()
                  }
                  className="w-full rounded-lg bg-blue-900 px-3 py-2 text-xs font-semibold text-white"
                >
                  {text(
                    'Save changes')}
                </button>

                {settingsMessage && (
                  <p className="text-[11px] text-emerald-600">
                    {shown(settingsMessage)}
                  </p>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={handleLogout}
              className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              <LogOut size={15} />

              {text(
                'Log out')}
            </button>
          </div>
        )}

        {/* Dynamic View Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {activeTab === 'record' &&
            renderRecordScreen()}

          {activeTab === 'ledgers' &&
            renderLedgersScreen()}

          {activeTab === 'debts' &&
            renderDebtsScreen()}

          {activeTab === 'reports' &&
            renderReportsScreen()}
        </div>

        {/* Bottom Navigation */}
        <nav
          className={`border-t flex justify-around py-2 px-1 ${
            isDarkMode
              ? 'bg-slate-900 border-slate-800'
              : 'bg-white border-slate-200'
          }`}
        >
          {navItems.map(
            ({
              name,
              tab,
              icon: Icon,
            }) => {
              const isActive =
                activeTab === tab;

              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() =>
                    setActiveTab(tab)
                  }
                  aria-current={
                    isActive
                      ? 'page'
                      : undefined
                  }
                  className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-2 py-2 text-xs font-medium transition ${
                    isActive
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                      : 'text-slate-400 hover:bg-slate-50 hover:text-slate-600 dark:hover:bg-slate-800'
                  }`}
                >
                  <Icon
                    size={18}
                    strokeWidth={
                      isActive
                        ? 2.5
                        : 2
                    }
                  />

                  <span className="truncate">
                    {text(name)}
                  </span>
                </button>
              );
            }
          )}
        </nav>
      </div>

      {/* EDIT MODAL */}
      {renderEditModal()}

      {/* DELETE CONFIRMATION MODAL */}
      {renderDeleteModal()}
    </div>
  );
}
