'use client';

import { useState } from 'react';
import { ArrowRight, Mic, BookOpen, BarChart3 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { LANGUAGE_OPTIONS, Language, translate } from '@/lib/i18n';

export default function GetStartedPage() {
  const router = useRouter();
  const [language, setLanguage] = useState<Language>(() => {
    if (typeof window === 'undefined') return 'EN';
    const saved = window.localStorage.getItem('duukatalk-language');
    return saved && LANGUAGE_OPTIONS.some((option) => option.value === saved)
      ? (saved as Language)
      : 'EN';
  });

  const text = (value: string) => translate(language, value);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col lg:flex-row">
        {/* Left side */}
        <section className="relative flex min-h-[45vh] flex-1 flex-col justify-between overflow-hidden bg-blue-950 px-6 py-8 text-white sm:px-10 lg:min-h-screen lg:px-14 lg:py-10">
          {/* Decorative shapes */}
          <div className="absolute -right-24 top-20 h-64 w-64 rounded-full border-[3rem] border-amber-500/20" />
          <div className="absolute -bottom-32 -left-24 h-80 w-80 rounded-full bg-blue-900/70" />
          <div className="absolute right-20 top-40 h-4 w-4 rounded-full bg-amber-400 shadow-[0_0_0_10px_rgba(245,158,11,0.12)]" />

          {/* Logo */}
          <div className="relative z-10 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500 text-blue-950 shadow-lg">
              <Mic size={22} strokeWidth={2.5} />
            </div>

            <div>
              <p className="text-lg font-bold leading-none">DuukaTalk</p>
              <p className="mt-1 text-xs font-medium text-blue-200">
                {text('Your shop, your story.')}
              </p>
            </div>
          </div>

          {/* Main message */}
          <div className="relative z-10 my-12 max-w-lg lg:my-0">
            <p className="mb-5 text-sm font-semibold uppercase tracking-[0.22em] text-amber-400">
              {text('Simple books. Strong business.')}
            </p>

            <h1 className="text-4xl font-bold leading-tight sm:text-5xl xl:text-6xl">
              {text('Keep your business moving forward.')}
            </h1>

            <p className="mt-6 max-w-md text-base leading-7 text-blue-100 sm:text-lg">
              {text("Record sales, track debts, and understand your shop's story in one friendly place.")}
            </p>
          </div>

          {/* Footer */}
          <p className="relative z-10 text-xs text-blue-300">
            © 2025 DuukaTalk · Made for local businesses
          </p>
        </section>

        {/* Right side */}
        <section className="flex flex-1 items-center justify-center bg-white px-6 py-12 sm:px-10 lg:min-h-screen lg:px-16">
          <div className="w-full max-w-lg">
            <div className="mb-6 flex justify-end">
              <label className="sr-only" htmlFor="landing-language">
                Language
              </label>
              <select
                id="landing-language"
                value={language}
                onChange={(event) => {
                  const nextLanguage = event.target.value as Language;
                  setLanguage(nextLanguage);
                  window.localStorage.setItem('duukatalk-language', nextLanguage);
                }}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm"
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {/* Mobile logo */}
            <div className="mb-10 flex items-center gap-3 lg:hidden">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500 text-blue-950">
                <Mic size={20} strokeWidth={2.5} />
              </div>

              <div>
                <p className="font-bold text-blue-950">DuukaTalk</p>
                <p className="text-xs text-slate-500">
                  Your shop, your story.
                </p>
              </div>
            </div>

            <div className="mb-10">
              <p className="mb-3 text-sm font-semibold text-amber-600">
                {text('Welcome to DuukaTalk')}
              </p>

              <h2 className="text-3xl font-bold tracking-tight text-blue-950 sm:text-4xl">
                {text('Your business, made simpler.')}
              </h2>

              <p className="mt-4 text-sm leading-7 text-slate-500 sm:text-base">
                {text('Keep track of your sales and customer debts without the stress of complicated bookkeeping.')}
              </p>
            </div>

            {/* Features */}
            <div className="space-y-4">
              <div className="flex items-start gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-900">
                  <Mic size={20} />
                </div>

                <div>
                  <h3 className="font-semibold text-slate-900">
                    {text('Record with your voice')}
                  </h3>
                  <p className="mt-1 text-sm leading-5 text-slate-500">
                    Speak naturally and let DuukaTalk help record your
                    transactions.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                  <BookOpen size={20} />
                </div>

                <div>
                  <h3 className="font-semibold text-slate-900">
                    {text('Keep your ledger organized')}
                  </h3>
                  <p className="mt-1 text-sm leading-5 text-slate-500">
                    See your sales and customer debts in one simple ledger.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                  <BarChart3 size={20} />
                </div>

                <div>
                  <h3 className="font-semibold text-slate-900">
                    {text('Understand your business')}
                  </h3>
                  <p className="mt-1 text-sm leading-5 text-slate-500">
                    Get a clear view of sales and outstanding credit.
                  </p>
                </div>
              </div>
            </div>

            {/* Get Started button */}
            <button
              type="button"
              onClick={() => router.push('/login')}
              className="mt-8 flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-blue-900 px-6 text-sm font-bold text-white shadow-lg shadow-blue-950/15 transition hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-900/20"
            >
              {text('Get Started')}
              <ArrowRight size={19} />
            </button>

            <p className="mt-5 text-center text-xs text-slate-400">
              {text('Create an account or log in to continue.')}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}