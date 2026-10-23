'use client';

import {
  FormEvent,
  Suspense,
  useEffect,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  Loader2,
  Mic,
  Store,
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
import { COUNTRIES } from '@/lib/money';



type AuthMode = 'signup' | 'login';

interface AuthApiResponse {
  success: boolean;
  error?: string;
  attemptsRemaining?: number;
  lockedUntil?: string;
  vendorId?: string;
  businessName?: string;
  ownerName?: string;
  phone?: string;
  country?: string;
  currency?: string;
}

// Shared with the server so currencies always match the country.
const COUNTRY_OPTIONS = COUNTRIES;

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const modeParam = searchParams.get('mode');

  const [mode, setMode] = useState<AuthMode>(
    modeParam === 'login' ? 'login' : 'signup',
  );

  const [language, setLanguage] = useState<Language>('EN');
  const [businessName, setBusinessName] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);

  const [country, setCountry] = useState('Uganda');
  const [phone, setPhone] = useState('');

  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isSignup = mode === 'signup';

  /*
   * Keep the local mode in sync with the URL.
   *
   * This is important because after signup we navigate to:
   * /login?mode=login
   */
  useEffect(() => {
    const nextMode: AuthMode =
      searchParams.get('mode') === 'login'
        ? 'login'
        : 'signup';

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(nextMode);
  }, [searchParams]);

  useEffect(() => {
    const savedLanguage = window.localStorage.getItem(
      'duukatalk-language',
    );

    if (
      savedLanguage &&
      LANGUAGE_OPTIONS.some(
        (option) => option.value === savedLanguage,
      )
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLanguage(savedLanguage as Language);
    }
  }, []);

  const text = (
    english: string,
    vars?: TranslationVars,
  ) => translate(language, english, vars);

  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  /** Server messages are English; show them translated, or a safe fallback. */
  const serverError = (
    message: string | undefined,
    fallback: string,
  ) => {
    if (message && hasTranslation(message)) {
      return text(message);
    }
    if (message) console.error('Auth error:', message);
    return text(fallback);
  };

  const selectedCountry =
    COUNTRY_OPTIONS.find(
      (option) => option.name === country,
    ) || COUNTRY_OPTIONS[0];

  const formatLockoutMessage = (
    lockedUntil: string,
  ): string => {
    const unlockDate = new Date(lockedUntil);

    const timeLabel = unlockDate.toLocaleTimeString(
      localeFor(language),
      {
        hour: '2-digit',
        minute: '2-digit',
      },
    );

    return text(
      'Too many incorrect attempts. Please try again after {time}.',
      { time: timeLabel },
    );
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();

    setError('');
    setMessage('');

    if (!businessName.trim()) {
      setError(
        text(
          'Enter your business name to continue.'),
      );
      return;
    }

    if (!/^\d{4}$/.test(pin)) {
      setError(
        text(
          'Your PIN must be exactly 4 digits.'),
      );
      return;
    }

    if (isSignup) {
      if (!country) {
        setError(
          text(
            'Select your country to continue.'),
        );
        return;
      }

      const cleanedPhone = phone.replace(/\D/g, '');

      if (!cleanedPhone) {
        setError(
          text(
            'Enter your phone number to continue.'),
        );
        return;
      }

      if (cleanedPhone.length < 7) {
        setError(
          text(
            'Enter a valid phone number.'),
        );
        return;
      }
    }

    setIsSubmitting(true);

    try {
      if (isSignup) {
        const cleanedPhone = phone.replace(/\D/g, '');

        const fullPhoneNumber = `${selectedCountry.code}${cleanedPhone}`;

        const response = await fetch(
          '/api/auth/signup',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              businessName: businessName.trim(),
              pin,
              phone: fullPhoneNumber,
              country: selectedCountry.name,
              currency: selectedCountry.currency,
            }),
          },
        );

        const data = (await response.json().catch(
          () => null,
        )) as AuthApiResponse | null;

        if (!response.ok || !data?.success) {
          setError(
            serverError(
              data?.error,
              'Could not create your account. Please try again.',
            ),
          );
          return;
        }

        setMessage(
          text(
            'Your {shop} account is ready to go. You can now log in.',
            { shop: businessName.trim() },
          ),
        );

        router.replace('/login?mode=login');
        return;
      }

      // Login
      // The API requires BOTH the business name and PIN.
      const response = await fetch(
        '/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            businessName: businessName.trim(),
            pin,
          }),
        },
      );

      const data = (await response.json().catch(
        () => null,
      )) as AuthApiResponse | null;

      if (!response.ok || !data?.success) {
        if (data?.lockedUntil) {
          setError(
            formatLockoutMessage(
              data.lockedUntil,
            ),
          );
        } else if (
          typeof data?.attemptsRemaining ===
          'number'
        ) {
          setError(
            data.attemptsRemaining === 1
              ? text('Incorrect PIN. 1 attempt remaining.')
              : text(
                  'Incorrect PIN. {count} attempts remaining.',
                  { count: data.attemptsRemaining },
                ),
          );
        } else {
          setError(
            serverError(
              data?.error,
              'Could not log in. Please try again.',
            ),
          );
        }

        return;
      }

      // Login was successful.
      window.localStorage.setItem(
        'duukatalk-user',
        JSON.stringify({
          vendorId: data.vendorId,
          businessName:
            data.businessName ||
            businessName.trim(),
          ownerName: data.ownerName || '',
          phone: data.phone || '',
          country: data.country || '',
          currency: data.currency || '',
        }),
      );

      window.localStorage.setItem(
        'duukatalk-language',
        language,
      );

      console.log('Vendor logged in:', {
        vendorId: data.vendorId,
        businessName: data.businessName,
        ownerName: data.ownerName,
      });

      router.push('/dashboard');
    } catch {
      setError(
        text(
          'Something went wrong. Please check your connection and try again.'),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError('');
    setMessage('');

    const url =
      nextMode === 'login'
        ? '/login?mode=login'
        : '/login?mode=signup';

    router.replace(url);
  };

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 lg:grid lg:grid-cols-[minmax(22rem,0.9fr)_minmax(30rem,1.1fr)]">
      <section className="relative hidden min-h-screen overflow-hidden bg-blue-950 px-10 py-10 text-white lg:flex lg:flex-col lg:justify-between xl:px-16">
        <div className="absolute -right-28 top-24 h-72 w-72 rounded-full border-[3rem] border-amber-500/20" />
        <div className="absolute -bottom-40 -left-32 h-96 w-96 rounded-full bg-blue-900/70" />
        <div className="absolute bottom-32 right-20 h-4 w-4 rounded-full bg-amber-400 shadow-[0_0_0_10px_rgba(245,158,11,0.12)]" />

        <div className="relative z-10 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500 text-blue-950 shadow-lg shadow-amber-950/20">
            <Mic size={22} strokeWidth={2.5} />
          </div>

          <div>
            <p className="text-lg font-bold leading-none">
              DuukaTalk
            </p>
            <p className="mt-1 text-xs font-medium text-blue-200">
              {text(
                'Your shop, your story.')}
            </p>
          </div>
        </div>

        <div className="relative z-10 max-w-md">
          <p className="mb-5 text-sm font-semibold uppercase tracking-[0.22em] text-amber-400">
            {text(
              'Simple books. Strong business.')}
          </p>

          <h1 className="text-4xl font-bold leading-tight xl:text-5xl">
            {text(
              'Keep your business moving forward.')}
          </h1>

          <p className="mt-6 max-w-sm text-base leading-7 text-blue-100">
            {text(
              "Record sales, track debts, and understand your shop's story in one friendly place.")}
          </p>

          <div className="mt-10 flex items-center gap-3 text-sm font-medium text-blue-100">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300">
              <Store size={17} />
            </span>

            {text(
              'Built for everyday shop owners')}
          </div>
        </div>

        <p className="relative z-10 text-xs text-blue-300">
          {text(
            '© 2025 DuukaTalk · Made for local businesses')}
        </p>
      </section>

      <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-6 flex justify-end">
            <label
              className="sr-only"
              htmlFor="login-language-mode"
            >
              {text('Language')}
            </label>

            <select
              id="login-language-mode"
              value={language}
              onChange={(event) => {
                const nextLanguage =
                  event.target.value as Language;

                setLanguage(nextLanguage);

                window.localStorage.setItem(
                  'duukatalk-language',
                  nextLanguage,
                );
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm outline-none focus:border-blue-600"
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
          </div>

          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500 text-blue-950">
              <Mic size={20} strokeWidth={2.5} />
            </div>

            <div>
              <p className="font-bold text-blue-950">
                DuukaTalk
              </p>
              <p className="text-xs text-slate-500">
                {text(
                  'Your shop, your story.')}
              </p>
            </div>
          </div>

          <div className="mb-8">
            <p className="mb-3 text-sm font-semibold text-amber-600">
              {isSignup
                ? text(
                    'Welcome to DuukaTalk')
                : text(
                    'Welcome back')}
            </p>

            <h2 className="text-3xl font-bold tracking-tight text-blue-950 sm:text-4xl">
              {isSignup
                ? text(
                    'Set up your shop.')
                : text(
                    'Log in to your shop.')}
            </h2>

            <p className="mt-3 text-sm leading-6 text-slate-500">
              {isSignup
                ? text(
                    'Create a quick, secure account for your business.')
                : text(
                    'Enter your details to pick up where you left off.')}
            </p>
          </div>

          <div className="mb-8 grid grid-cols-2 rounded-xl bg-slate-200/80 p-1">
            <button
              type="button"
              onClick={() =>
                switchMode('signup')
              }
              className={`rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
                isSignup
                  ? 'bg-white text-blue-950 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {text('Sign up')}
            </button>

            <button
              type="button"
              onClick={() =>
                switchMode('login')
              }
              className={`rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
                !isSignup
                  ? 'bg-white text-blue-950 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {text('Log in')}
            </button>
          </div>

          <form
            onSubmit={handleSubmit}
            className="space-y-5"
            noValidate
          >
            <div>
              <label
                htmlFor="business-name"
                className="mb-2 block text-sm font-semibold text-slate-700"
              >
                {text(
                  'Business name')}
              </label>

              <div className="relative">
                <Store
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
                  size={19}
                />

                <input
                  id="business-name"
                  type="text"
                  autoComplete="organization"
                  value={businessName}
                  onChange={(event) =>
                    setBusinessName(
                      event.target.value,
                    )
                  }
                  placeholder={text(
                    "e.g. Mama Kintu's Shop")}
                  className="h-13 w-full rounded-xl border border-slate-200 bg-white pl-12 pr-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-600 focus:ring-4 focus:ring-blue-600/10"
                />
              </div>
            </div>

            {isSignup && (
              <>
                <div>
                  <label
                    htmlFor="country"
                    className="mb-2 block text-sm font-semibold text-slate-700"
                  >
                    {text(
                      'Country')}
                  </label>

                  <select
                    id="country"
                    value={country}
                    onChange={(event) =>
                      setCountry(event.target.value)
                    }
                    className="h-13 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-4 focus:ring-blue-600/10"
                  >
                    {COUNTRY_OPTIONS.map(
                      (option) => (
                        <option
                          key={option.name}
                          value={option.name}
                        >
                          {text(option.name)} (
                          {option.currency})
                        </option>
                      ),
                    )}
                  </select>

                  <p className="mt-2 text-xs text-slate-400">
                    {text('Currency: {currency}', {
                      currency: selectedCountry.currency,
                    })}
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="phone-number"
                    className="mb-2 block text-sm font-semibold text-slate-700"
                  >
                    {text(
                      'Phone number')}
                  </label>

                  <div className="flex gap-2">
                    <div className="flex h-13 w-24 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700">
                      {selectedCountry.code}
                    </div>

                    <input
                      id="phone-number"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={phone}
                      onChange={(event) =>
                        setPhone(
                          event.target.value
                            .replace(/\D/g, ''),
                        )
                      }
                      placeholder="700 000 000"
                      className="h-13 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-600 focus:ring-4 focus:ring-blue-600/10"
                    />
                  </div>

                  <p className="mt-2 text-xs text-slate-400">
                    {text('Your number will be saved as {phone}.', {
                      phone: `${selectedCountry.code}${phone || '...'}`,
                    })}
                  </p>
                </div>
              </>
            )}

            <div>
              <div className="mb-2 flex items-center justify-between">
                <label
                  htmlFor="business-pin"
                  className="block text-sm font-semibold text-slate-700"
                >
                  {text(
                    '4-digit PIN')}
                </label>

                <span className="text-xs text-slate-400">
                  {text(
                    'Keep it private')}
                </span>
              </div>

              <div className="relative">
                <LockKeyhole
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
                  size={18}
                />

                <input
                  id="business-pin"
                  type={
                    showPin
                      ? 'text'
                      : 'password'
                  }
                  inputMode="numeric"
                  autoComplete={
                    isSignup
                      ? 'new-password'
                      : 'current-password'
                  }
                  pattern="[0-9]{4}"
                  maxLength={4}
                  value={pin}
                  onChange={(event) =>
                    setPin(
                      event.target.value
                        .replace(/\D/g, '')
                        .slice(0, 4),
                    )
                  }
                  placeholder="••••"
                  className="h-13 w-full rounded-xl border border-slate-200 bg-white pl-12 pr-12 text-lg tracking-[0.45em] text-slate-900 outline-none transition placeholder:tracking-[0.35em] placeholder:text-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-600/10"
                />

                <button
                  type="button"
                  onClick={() =>
                    setShowPin(
                      (visible) => !visible,
                    )
                  }
                  aria-label={
                    showPin
                      ? text(
                          'Hide PIN')
                      : text(
                          'Show PIN')
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                >
                  {showPin ? (
                    <EyeOff size={18} />
                  ) : (
                    <Eye size={18} />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p
                className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700"
                role="alert"
              >
                {error}
              </p>
            )}

            {message && (
              <p
                className="rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700"
                role="status"
              >
                {message}
              </p>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="flex h-13 w-full items-center justify-center gap-2 rounded-xl bg-blue-900 px-4 text-sm font-bold text-white shadow-lg shadow-blue-950/15 transition hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-900/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? (
                <Loader2
                  size={18}
                  className="animate-spin"
                />
              ) : (
                <>
                  {isSignup
                    ? text(
                        'Create my account')
                    : text(
                        'Log in')}

                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>

          <p className="mt-8 text-center text-xs leading-5 text-slate-400">
            {text(
              'By continuing, you agree to keep your account details safe and private.')}
          </p>
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-slate-100">
          <Loader2
            size={24}
            className="animate-spin text-blue-900"
          />
        </main>
      }
    >
      <LoginContent />
    </Suspense>
  );
}