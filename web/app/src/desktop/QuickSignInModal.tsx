import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Clock,
  Copy,
  KeyRound,
  LogIn,
  QrCode,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PairingCodeBoxes } from '@/components/PairingCodeBoxes';
import { QrCodeSvg } from '@/components/QrCodeSvg';
import {
  desktopApi,
  isTauriDesktop,
  type DesktopSessionMeta,
  type QuickLoginStatus,
} from '@/desktop/tauriBridge';
import { useYtAuth, ytAuthQueryKey } from '@/extension/useYtAuth';
import { queryClient } from '@/lib/queryClient';
import { useUi } from '@/state/ui';

type SignInTab = 'qr' | 'key';

const PREVIEW_HASH = '#preview-quick-signin';

function makePreviewQuickLogin(keepSignedIn: boolean): QuickLoginStatus {
  return {
    active: true,
    code: '394-821',
    pairId: 'preview-pair',
    qrUrl: 'http://192.168.1.42:47923/quick-login?code=394-821',
    lanIp: '192.168.1.42',
    port: 47923,
    expiresAtMs: Date.now() + 5 * 60_000,
    keepSignedIn,
  };
}

function formatRemainingMs(expiresAtMs: number | null, nowMs: number): string {
  if (!expiresAtMs) return '5:00';
  const remainingSec = Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export interface QuickSignInModalProps {
  /** Overrides desktop detection for unit tests and browser previews. */
  forceDesktop?: boolean;
  /** Optional initial session metadata for isolated component tests. */
  initialSessionMeta?: DesktopSessionMeta | null;
  /** Optional initial QR pairing status for isolated component tests or previews. */
  initialQuickLogin?: QuickLoginStatus | null;
}

export function QuickSignInModal({
  forceDesktop = false,
  initialSessionMeta = null,
  initialQuickLogin = null,
}: QuickSignInModalProps = {}) {
  const open = useUi((s) => s.quickSignInOpen);
  const setOpen = useUi((s) => s.setQuickSignInOpen);
  const remindedThisRun = useUi((s) => s.quickSignInRemindedThisRun);
  const mandatoryUpdateLocked = useUi((s) => s.mandatoryUpdateLocked);

  const yt = useYtAuth();
  const [previewMode, setPreviewMode] = useState(
    () => typeof window !== 'undefined' && window.location.hash === PREVIEW_HASH,
  );
  const autoPromptCheckedRef = useRef(false);

  const realDesktop = isTauriDesktop();
  const desktop = forceDesktop || realDesktop || previewMode;

  useEffect(() => {
    const syncPreviewHash = () => {
      const active = window.location.hash === PREVIEW_HASH;
      setPreviewMode(active);
      if (active) setOpen(true);
    };
    syncPreviewHash();
    window.addEventListener('hashchange', syncPreviewHash);
    return () => window.removeEventListener('hashchange', syncPreviewHash);
  }, [setOpen]);

  useEffect(() => {
    if (!realDesktop || previewMode) return;
    let active = true;
    const unlistenFns: Array<() => void> = [];

    void desktopApi
      .onQuickLoginCompleted(() => {
        if (!active) return;
        void queryClient.invalidateQueries({ queryKey: ytAuthQueryKey });
        void queryClient.invalidateQueries({ queryKey: ['desktop', 'session-meta'] });
        setOpen(false);
      })
      .then((fn) => {
        if (active) unlistenFns.push(fn);
        else fn();
      });

    void desktopApi
      .onSessionMetaChanged(() => {
        if (!active) return;
        void queryClient.invalidateQueries({ queryKey: ['desktop', 'session-meta'] });
        void queryClient.invalidateQueries({ queryKey: ytAuthQueryKey });
      })
      .then((fn) => {
        if (active) unlistenFns.push(fn);
        else fn();
      });

    return () => {
      active = false;
      for (const fn of unlistenFns) fn();
    };
  }, [realDesktop, previewMode, setOpen]);

  const sessionMetaQuery = useQuery({
    queryKey: ['desktop', 'session-meta'],
    queryFn: () => desktopApi.authGetSessionMeta(),
    enabled: realDesktop && !previewMode,
    initialData: initialSessionMeta ?? undefined,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!desktop || previewMode) return;
    if (autoPromptCheckedRef.current) return;
    if (remindedThisRun || mandatoryUpdateLocked) return;

    const meta = initialSessionMeta ?? sessionMetaQuery.data;
    if (!meta) return;

    const isSignedOut =
      (yt.state === 'ready' && !yt.auth.signedIn) ||
      (!realDesktop && yt.state === 'unavailable' && meta.persistence === 'signed_out');

    if (yt.state === 'checking') return;

    autoPromptCheckedRef.current = true;
    if (isSignedOut && !meta.skipSignInPrompt) {
      setOpen(true);
    }
  }, [
    desktop,
    previewMode,
    realDesktop,
    remindedThisRun,
    mandatoryUpdateLocked,
    initialSessionMeta,
    sessionMetaQuery.data,
    yt,
    setOpen,
  ]);

  if (!desktop || mandatoryUpdateLocked) return null;
  if (!open && !previewMode) return null;

  return (
    <QuickSignInModalContent
      previewMode={previewMode}
      realDesktop={realDesktop}
      initialQuickLogin={initialQuickLogin}
      onExitPreview={() => setPreviewMode(false)}
    />
  );
}

interface QuickSignInModalContentProps {
  previewMode: boolean;
  realDesktop: boolean;
  initialQuickLogin: QuickLoginStatus | null;
  onExitPreview: () => void;
}

function QuickSignInModalContent({
  previewMode,
  realDesktop,
  initialQuickLogin,
  onExitPreview,
}: QuickSignInModalContentProps) {
  const qc = useQueryClient();
  const setOpen = useUi((s) => s.setQuickSignInOpen);
  const remindLater = useUi((s) => s.remindQuickSignInLater);

  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [tab, setTab] = useState<SignInTab>('qr');

  const [quickLogin, setQuickLogin] = useState<QuickLoginStatus | null>(() => {
    if (initialQuickLogin) return initialQuickLogin;
    if (previewMode) return makePreviewQuickLogin(false);
    return null;
  });
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const [copiedTarget, setCopiedTarget] = useState<'code' | 'url' | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [keyInput, setKeyInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [unlockingKey, setUnlockingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [googleOpening, setGoogleOpening] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const closeRef = useRef<HTMLButtonElement>(null);
  const keepSignedInRef = useRef(keepSignedIn);
  keepSignedInRef.current = keepSignedIn;

  const trimmedKey = keyInput.trim();
  const needsPin = trimmedKey.startsWith('BC1P-');

  const dismissRemindLater = useCallback(() => {
    if (previewMode) {
      if (window.location.hash === PREVIEW_HASH) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      onExitPreview();
    }
    remindLater();
  }, [previewMode, onExitPreview, remindLater]);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        dismissRemindLater();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dismissRemindLater]);

  const startQrListener = useCallback(async () => {
    if (previewMode) {
      setQuickLogin(makePreviewQuickLogin(keepSignedInRef.current));
      setQrError(null);
      return;
    }
    if (!realDesktop) return;
    setQrLoading(true);
    setQrError(null);
    try {
      const status = await desktopApi.authQuickLoginStart(keepSignedInRef.current);
      setQuickLogin(status);
    } catch (err) {
      setQrError(err instanceof Error ? err.message : 'Unable to start Wi-Fi quick sign-in.');
    } finally {
      setQrLoading(false);
    }
  }, [previewMode, realDesktop]);

  useEffect(() => {
    if (tab !== 'qr') return;
    if (!initialQuickLogin) {
      void startQrListener();
    }
    return () => {
      if (realDesktop && !previewMode && !initialQuickLogin) {
        void desktopApi.authQuickLoginStop().catch(() => {});
      }
    };
  }, [tab, realDesktop, previewMode, initialQuickLogin, startQrListener]);

  useEffect(() => {
    if (!quickLogin?.active || !quickLogin.expiresAtMs) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [quickLogin?.active, quickLogin?.expiresAtMs]);

  const handleTogglePersistence = async (nextKeep: boolean) => {
    setKeepSignedIn(nextKeep);
    setActionError(null);
    if (previewMode) {
      setQuickLogin((prev) => (prev ? { ...prev, keepSignedIn: nextKeep } : prev));
      return;
    }
    if (quickLogin?.active && tab === 'qr' && (realDesktop || initialQuickLogin)) {
      try {
        const updated = await desktopApi.authQuickLoginSetKeep(nextKeep);
        setQuickLogin(updated);
      } catch {
        // Non-fatal if listener expired; local state remains updated.
      }
    }
  };

  const handleCopy = async (text: string, target: 'code' | 'url') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
      window.setTimeout(() => setCopiedTarget((cur) => (cur === target ? null : cur)), 1800);
    } catch {
      // Clipboard API can be unavailable in non-secure test contexts.
    }
  };

  const handleUnlockKey = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!trimmedKey) {
      setKeyError('Paste a BC1K- or BC1P- session key first.');
      return;
    }
    if (needsPin && pinInput.trim().length < 4) {
      setKeyError('Enter the 4+ character PIN for this BC1P- key.');
      return;
    }

    if (previewMode) {
      setKeyError('Preview mode: run inside BitChord Desktop to unlock a real session key.');
      return;
    }

    setUnlockingKey(true);
    setKeyError(null);
    try {
      const result = await desktopApi.authUnlockWithOneKey(
        trimmedKey,
        needsPin ? pinInput : null,
        keepSignedIn,
      );
      qc.setQueryData(ytAuthQueryKey, result.auth);
      void qc.invalidateQueries({ queryKey: ytAuthQueryKey });
      void qc.invalidateQueries({ queryKey: ['desktop', 'session-meta'] });
      setOpen(false);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Could not unlock this 1-Key Session.');
    } finally {
      setUnlockingKey(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setActionError(null);
    if (previewMode) {
      setActionError('Preview mode: Google Sign-In opens a desktop window in the installed app.');
      return;
    }
    setGoogleOpening(true);
    try {
      await desktopApi.openYtSignIn(keepSignedIn);
      setOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to open Google sign-in window.');
    } finally {
      setGoogleOpening(false);
    }
  };

  const handleContinueWithoutSigningIn = async () => {
    setActionError(null);
    try {
      if (!previewMode) {
        const nextMeta = await desktopApi.authSetSkipSignInPrompt(true);
        qc.setQueryData(['desktop', 'session-meta'], nextMeta);
      }
      if (previewMode) {
        if (window.location.hash === PREVIEW_HASH) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }
        onExitPreview();
      }
      setOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to save sign-in preference.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[calc(var(--z-modal)+2)] flex items-end justify-center bg-black/45 p-4 backdrop-blur-xs animate-fade sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-signin-title"
      aria-describedby="quick-signin-subtitle"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) dismissRemindLater();
      }}
    >
      <div
        className="flex max-h-[min(94vh,820px)] w-[min(460px,95vw)] flex-col overflow-hidden rounded-[22px] border border-(--labelDivider) bg-(--systemStandardThickMaterialSover) text-primary shadow-[0_24px_64px_rgba(0,0,0,0.48)] animate-zoom"
        style={{ backdropFilter: 'saturate(200%) blur(26px)' }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-(--labelDivider) px-5 pt-3.5 pb-3">
          <div className="min-w-0">
            <h2 id="quick-signin-title" className="type-[700_18px/22px] text-primary">
              Sign in to BitChord
            </h2>
            <p id="quick-signin-subtitle" className="mt-0.5 type-footnote text-secondary">
              Sync your YouTube Music library via phone QR, a 1-Key Session, or Google.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={dismissRemindLater}
            aria-label="Close quick sign-in"
            className="grid min-h-[44px] min-w-[44px] flex-none place-items-center rounded-full text-secondary transition-colors hover:bg-quinary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key"
          >
            <X size={18} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-3">
          {/* Persistence mode toggle: Temporary session vs Keep me signed in */}
          <div>
            <div
              role="radiogroup"
              aria-label="Session persistence"
              className="grid grid-cols-2 gap-1 rounded-[14px] border border-(--labelDivider) bg-quaternary p-1"
            >
              <button
                type="button"
                role="radio"
                aria-checked={!keepSignedIn}
                onClick={() => void handleTogglePersistence(false)}
                className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-[13px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key ${
                  !keepSignedIn
                    ? 'bg-page text-primary shadow-xs'
                    : 'text-secondary hover:text-primary'
                }`}
              >
                <Clock size={15} aria-hidden="true" />
                <span>Temporary session</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={keepSignedIn}
                onClick={() => void handleTogglePersistence(true)}
                className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-[13px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key ${
                  keepSignedIn
                    ? 'bg-page text-primary shadow-xs'
                    : 'text-secondary hover:text-primary'
                }`}
              >
                <ShieldCheck size={15} aria-hidden="true" />
                <span>Keep me signed in</span>
              </button>
            </div>
            <p className="mt-1.5 px-1 type-caption-1 text-secondary">
              {keepSignedIn
                ? 'Saved encrypted on this PC across app restarts.'
                : 'Held in memory only and cleared automatically when you close BitChord.'}
            </p>
          </div>

          {/* Method Switcher */}
          <div
            role="tablist"
            aria-label="Quick sign-in methods"
            className="grid grid-cols-2 gap-1 rounded-[12px] border border-(--labelDivider) bg-quinary p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'qr'}
              onClick={() => setTab('qr')}
              className={`flex min-h-[44px] items-center justify-center gap-2 rounded-[9px] px-3 text-[13px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key ${
                tab === 'qr'
                  ? 'bg-page text-primary shadow-xs'
                  : 'text-secondary hover:text-primary'
              }`}
            >
              <QrCode size={16} aria-hidden="true" />
              <span>QR &amp; Code</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'key'}
              onClick={() => setTab('key')}
              className={`flex min-h-[44px] items-center justify-center gap-2 rounded-[9px] px-3 text-[13px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key ${
                tab === 'key'
                  ? 'bg-page text-primary shadow-xs'
                  : 'text-secondary hover:text-primary'
              }`}
            >
              <KeyRound size={16} aria-hidden="true" />
              <span>1-Key Session</span>
            </button>
          </div>

          {/* Tab Panel */}
          {tab === 'qr' ? (
            <div role="tabpanel" aria-label="QR and unique code sign-in" className="space-y-3">
              {qrLoading && !quickLogin?.active ? (
                <div className="flex min-h-[216px] flex-col items-center justify-center rounded-[16px] border border-(--labelDivider) bg-quinary/70 p-4 text-center">
                  <RefreshCw size={20} className="animate-spin text-secondary" aria-hidden="true" />
                  <p className="mt-2 type-callout text-secondary">Starting local Wi-Fi receiver...</p>
                </div>
              ) : qrError ? (
                <div
                  role="alert"
                  className="space-y-3 rounded-[16px] border border-red/30 bg-red/10 p-4 text-left"
                >
                  <p className="type-callout text-primary">{qrError}</p>
                  <button
                    type="button"
                    onClick={() => void startQrListener()}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-pill bg-page px-4 text-[13px] font-semibold text-primary shadow-xs transition-opacity hover:opacity-90"
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                    <span>Retry Wi-Fi Setup</span>
                  </button>
                </div>
              ) : quickLogin?.active && quickLogin.qrUrl ? (
                <div className="flex flex-col items-center rounded-[16px] border border-(--labelDivider) bg-quinary/60 p-3.5 text-center">
                  <QrCodeSvg value={quickLogin.qrUrl} size={144} label="BitChord Wi-Fi quick sign-in QR code" />

                  <div className="mt-3 flex w-full flex-col items-center gap-2">
                    <PairingCodeBoxes
                      value={quickLogin.code}
                      readOnly
                      ariaLabel={
                        quickLogin.code ? `Pairing code ${quickLogin.code}` : 'Pairing code unavailable'
                      }
                    />
                    {quickLogin.code && (
                      <button
                        type="button"
                        aria-label="Copy pairing code"
                        onClick={() => void handleCopy(quickLogin.code!, 'code')}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[12px] border border-(--labelDivider) bg-page px-3.5 text-[13px] font-medium text-primary transition-colors hover:bg-quaternary"
                      >
                        {copiedTarget === 'code' ? (
                          <Check size={15} className="text-green" aria-hidden="true" />
                        ) : (
                          <Copy size={15} aria-hidden="true" />
                        )}
                        <span>{copiedTarget === 'code' ? 'Copied' : 'Copy'}</span>
                      </button>
                    )}
                  </div>

                  <p className="mt-2 max-w-[360px] type-caption-1 text-secondary">
                    Scan on your phone on the same Wi-Fi, or enter this code from another BitChord
                    Desktop in Settings &gt; Accounts.
                  </p>

                  <div className="mt-2 flex w-full items-center justify-between gap-2 rounded-[10px] border border-(--labelDivider) bg-page/70 px-3 py-1 text-left">
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-secondary">
                      {quickLogin.qrUrl}
                    </code>
                    <button
                      type="button"
                      onClick={() => void handleCopy(quickLogin.qrUrl!, 'url')}
                      aria-label="Copy pairing URL"
                      className="inline-flex min-h-[44px] flex-none items-center gap-1 rounded-[8px] px-2.5 text-[12px] font-medium text-primary hover:bg-quinary"
                    >
                      {copiedTarget === 'url' ? 'Copied' : 'Copy link'}
                    </button>
                  </div>

                  <div className="mt-1.5 flex w-full items-center justify-between px-1 text-[12px] text-secondary">
                    <span>
                      Expires in{' '}
                      <strong className="font-mono text-primary">
                        {formatRemainingMs(quickLogin.expiresAtMs, nowMs)}
                      </strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => void startQrListener()}
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[10px] px-2.5 font-medium text-primary transition-colors hover:bg-quaternary"
                    >
                      <RefreshCw size={13} aria-hidden="true" />
                      <span>New code</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <form
              role="tabpanel"
              aria-label="1-Key Session sign-in"
              onSubmit={(ev) => void handleUnlockKey(ev)}
              className="space-y-3 rounded-[16px] border border-(--labelDivider) bg-quinary/60 p-4"
            >
              <div>
                <label htmlFor="one-key-input" className="block type-callout-emphasized text-primary">
                  Paste 1-Key Session token
                </label>
                <p className="mt-0.5 type-caption-1 text-secondary">
                  Starts with <code className="font-mono">BC1K-</code> or PIN-locked{' '}
                  <code className="font-mono">BC1P-</code>.
                </p>
                <textarea
                  id="one-key-input"
                  rows={3}
                  value={keyInput}
                  onChange={(ev) => {
                    setKeyInput(ev.target.value);
                    setKeyError(null);
                  }}
                  placeholder="BC1K-... or BC1P-..."
                  spellCheck={false}
                  autoComplete="off"
                  className="mt-2 w-full rounded-[12px] border border-(--labelDivider) bg-page px-3 py-2.5 font-mono text-[12px] text-primary placeholder:text-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key"
                />
              </div>

              {needsPin && (
                <div>
                  <label htmlFor="one-key-pin-input" className="block type-callout-emphasized text-primary">
                    Key PIN
                  </label>
                  <input
                    id="one-key-pin-input"
                    type="password"
                    value={pinInput}
                    onChange={(ev) => {
                      setPinInput(ev.target.value);
                      setKeyError(null);
                    }}
                    placeholder="Enter 4+ character PIN"
                    autoComplete="off"
                    className="mt-1.5 min-h-[44px] w-full rounded-[12px] border border-(--labelDivider) bg-page px-3 py-2 text-[14px] text-primary placeholder:text-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key"
                  />
                </div>
              )}

              {keyError && (
                <p role="alert" className="type-footnote text-red">
                  {keyError}
                </p>
              )}

              <button
                type="submit"
                disabled={unlockingKey}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-pill bg-key-bg px-4 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key"
              >
                <KeyRound size={16} aria-hidden="true" />
                <span>{unlockingKey ? 'Unlocking session...' : 'Unlock & Sign In'}</span>
              </button>
            </form>
          )}

          {actionError && (
            <p role="alert" className="px-1 type-footnote text-red">
              {actionError}
            </p>
          )}

          <button
            type="button"
            disabled={googleOpening}
            onClick={() => void handleGoogleSignIn()}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-pill border border-(--labelDivider) bg-quaternary px-4 text-[14px] font-semibold text-primary transition-colors hover:bg-tracklist-hover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key"
          >
            <LogIn size={16} aria-hidden="true" />
            <span>{googleOpening ? 'Opening Google Sign-In...' : 'Sign in with Google'}</span>
          </button>
        </div>

        {/* Bottom dismissal bar: Remind me later vs Continue without signing in */}
        <div className="grid grid-cols-1 border-t border-(--labelDivider) sm:grid-cols-2">
          <button
            type="button"
            onClick={dismissRemindLater}
            className="flex min-h-[44px] w-full items-center justify-center px-4 text-[14px] font-medium text-primary transition-colors hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-key"
          >
            Remind me later
          </button>
          <button
            type="button"
            onClick={() => void handleContinueWithoutSigningIn()}
            className="flex min-h-[44px] w-full items-center justify-center border-t border-(--labelDivider) px-4 text-[14px] font-normal text-secondary transition-colors hover:bg-primary/8 hover:text-primary sm:border-t-0 sm:border-l focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-key"
          >
            Continue without signing in
          </button>
        </div>
      </div>
    </div>
  );
}
