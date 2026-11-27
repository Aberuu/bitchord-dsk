import { Check, CheckCircle2, Copy, QrCode, RefreshCw, ShieldCheck, Smartphone, Wifi, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { QrCodeSvg } from '@/components/QrCodeSvg';
import {
  desktopApi,
  isDesktopShell,
  type DesktopPairingOfferView,
  type PairedMobileRecord,
} from '@/desktop/tauriBridge';
import { useSpotifySignedIn } from '@/extension/useSpotifyAuth';
import { useYtAuth } from '@/extension/useYtAuth';
import { useUi } from '@/state/ui';

const PREVIEW_HASH = '#preview-desktop-pair';

function formatCountdown(expiresAtMs: number | null, nowMs: number): string {
  if (!expiresAtMs) return '3:00';
  const remainingSec = Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function makePreviewOffer(includeSpotify: boolean): DesktopPairingOfferView {
  return {
    active: true,
    offerId: 'preview0123456789',
    code: '7K4-9MP',
    qrUri:
      'bitchord://pair?v=1&h=192.168.1.42&p=48221&id=preview0123456789&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&c=7K49MP',
    lanIp: '192.168.1.42',
    port: 48221,
    desktopName: 'BitChord Desktop',
    includeSpotify,
    expiresAtMs: Date.now() + 180_000,
  };
}

export interface DesktopPairMobileModalProps {
  forceDesktop?: boolean;
  initialOffer?: DesktopPairingOfferView | null;
  initialSpotifySignedIn?: boolean;
}

export function DesktopPairMobileModal({
  forceDesktop = false,
  initialOffer = null,
  initialSpotifySignedIn,
}: DesktopPairMobileModalProps = {}) {
  const open = useUi((s) => s.pairMobileOpen);
  const setOpen = useUi((s) => s.setPairMobileOpen);
  const [previewMode, setPreviewMode] = useState(
    () => typeof window !== 'undefined' && window.location.hash === PREVIEW_HASH,
  );

  const realDesktop = isDesktopShell();
  const enabled = forceDesktop || realDesktop || previewMode;

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

  if (!enabled || (!open && !previewMode)) return null;

  return (
    <DesktopPairMobileModalContent
      previewMode={previewMode}
      realDesktop={realDesktop}
      initialOffer={initialOffer}
      initialSpotifySignedIn={initialSpotifySignedIn}
      onClose={() => {
        if (previewMode) {
          if (window.location.hash === PREVIEW_HASH) {
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
          }
          setPreviewMode(false);
        }
        setOpen(false);
      }}
    />
  );
}

interface ContentProps {
  previewMode: boolean;
  realDesktop: boolean;
  initialOffer: DesktopPairingOfferView | null;
  initialSpotifySignedIn?: boolean;
  onClose: () => void;
}

function DesktopPairMobileModalContent({
  previewMode,
  realDesktop,
  initialOffer,
  initialSpotifySignedIn,
  onClose,
}: ContentProps) {
  const yt = useYtAuth();
  const detectedSpotify = useSpotifySignedIn();
  const spotifySignedIn = initialSpotifySignedIn ?? detectedSpotify;
  const setQuickSignInOpen = useUi((s) => s.setQuickSignInOpen);

  const [includeSpotify, setIncludeSpotify] = useState(false);
  const [offer, setOffer] = useState<DesktopPairingOfferView | null>(() => {
    if (initialOffer) return initialOffer;
    if (previewMode) return makePreviewOffer(false);
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedDevice, setPairedDevice] = useState<PairedMobileRecord | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const closeRef = useRef<HTMLButtonElement>(null);
  const ytSignedIn =
    previewMode || Boolean(initialOffer) || (yt.state === 'ready' && yt.auth.signedIn);

  const startPairingOffer = useCallback(
    async (withSpotify: boolean) => {
      setPairedDevice(null);
      setError(null);
      if (previewMode) {
        setOffer(makePreviewOffer(withSpotify));
        return;
      }
      if (!realDesktop && !initialOffer) return;
      setLoading(true);
      try {
        const nextOffer = await desktopApi.pairingStartDesktopQr(withSpotify);
        setOffer(nextOffer);
      } catch (err) {
        setOffer(null);
        setError(
          err instanceof Error
            ? err.message
            : 'Unable to start local Wi-Fi pairing server.',
        );
      } finally {
        setLoading(false);
      }
    },
    [previewMode, realDesktop, initialOffer],
  );

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (initialOffer || previewMode || !realDesktop || !ytSignedIn) return;
    void startPairingOffer(false);
    return () => {
      void desktopApi.pairingStopDesktopQr().catch(() => {});
    };
  }, [initialOffer, previewMode, realDesktop, ytSignedIn, startPairingOffer]);

  useEffect(() => {
    if (!realDesktop || previewMode) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void desktopApi
      .onMobilePaired((record) => {
        if (!active) return;
        setPairedDevice(record);
        setOffer(null);
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [realDesktop, previewMode]);

  useEffect(() => {
    if (!offer?.active || !offer.expiresAtMs || pairedDevice) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [offer?.active, offer?.expiresAtMs, pairedDevice]);

  const isExpired = Boolean(offer?.expiresAtMs && nowMs >= offer.expiresAtMs && !pairedDevice);

  const handleToggleSpotify = (next: boolean) => {
    setIncludeSpotify(next);
    void startPairingOffer(next);
  };

  const handleCopyCode = async () => {
    if (!offer?.code) return;
    try {
      await navigator.clipboard.writeText(offer.code);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      // Clipboard API may be unavailable in restricted contexts.
    }
  };

  return (
    <div
      className="fixed inset-0 z-[calc(var(--z-modal)+2)] flex items-end justify-center bg-black/45 p-4 backdrop-blur-xs animate-fade sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pair-mobile-title"
      aria-describedby="pair-mobile-subtitle"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[min(94vh,780px)] w-[min(460px,95vw)] flex-col overflow-hidden rounded-[22px] border border-(--labelDivider) bg-(--systemStandardThickMaterialSover) text-primary shadow-[0_24px_64px_rgba(0,0,0,0.48)] animate-zoom"
        style={{ backdropFilter: 'saturate(200%) blur(26px)' }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-(--labelDivider) px-5 pt-4 pb-3.5">
          <div className="min-w-0">
            <h2 id="pair-mobile-title" className="type-[700_18px/22px] text-primary">
              Pair Mobile Device
            </h2>
            <p id="pair-mobile-subtitle" className="mt-1 type-footnote text-secondary">
              Scan with BitChord on Android to transfer your session and pair over Wi-Fi.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close mobile pairing dialog"
            className="grid min-h-[44px] min-w-[44px] flex-none place-items-center rounded-full text-secondary transition-colors hover:bg-quinary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key"
          >
            <X size={18} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {!ytSignedIn ? (
            <div className="space-y-3 rounded-[16px] border border-(--labelDivider) bg-quinary/70 p-4">
              <div className="flex items-center gap-2 text-primary">
                <Smartphone size={18} aria-hidden="true" />
                <span className="type-body-emphasized">Sign in on Desktop first</span>
              </div>
              <p className="type-callout text-secondary">
                Sign in to YouTube Music on this computer before generating a pairing QR code for your phone.
              </p>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  setQuickSignInOpen(true);
                }}
                className="inline-flex min-h-[44px] items-center justify-center rounded-pill bg-key-bg px-4 text-[14px] font-semibold text-white transition-opacity hover:opacity-90"
              >
                Open Quick Sign-In
              </button>
            </div>
          ) : pairedDevice ? (
            <div
              role="status"
              className="flex flex-col items-center space-y-3 rounded-[18px] border border-green/35 bg-green/10 px-5 py-6 text-center"
            >
              <CheckCircle2 size={38} className="text-green" aria-hidden="true" />
              <div className="space-y-1">
                <p className="type-title-2-emphasized text-primary">
                  Connected to {pairedDevice.deviceName}
                </p>
                <p className="type-callout text-secondary">
                  Platform: {pairedDevice.platform.toUpperCase()}. Your phone is now signed in and paired on local Wi-Fi.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void startPairingOffer(includeSpotify)}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill border border-(--labelDivider) bg-page px-4 text-[13px] font-semibold text-primary transition-colors hover:bg-quinary"
                >
                  <QrCode size={15} aria-hidden="true" />
                  <span>Pair Another Device</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex min-h-[44px] items-center rounded-pill bg-key-bg px-5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
                >
                  Done
                </button>
              </div>
            </div>
          ) : loading ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center rounded-[16px] border border-(--labelDivider) bg-quinary/70 p-5 text-center">
              <RefreshCw size={22} className="animate-spin text-secondary" aria-hidden="true" />
              <p className="mt-2.5 type-callout text-secondary">
                Starting encrypted Wi-Fi pairing session...
              </p>
            </div>
          ) : error ? (
            <div
              role="alert"
              className="space-y-3 rounded-[16px] border border-red/30 bg-red/10 p-4 text-left"
            >
              <p className="type-body-emphasized text-primary">{error}</p>
              <p className="type-callout text-secondary">
                Verify this PC is connected to Wi-Fi or Ethernet and Windows Firewall allows BitChord on private networks.
              </p>
              <button
                type="button"
                onClick={() => void startPairingOffer(includeSpotify)}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-pill bg-page px-4 text-[13px] font-semibold text-primary shadow-xs transition-opacity hover:opacity-90"
              >
                <RefreshCw size={14} aria-hidden="true" />
                <span>Retry Pairing Setup</span>
              </button>
            </div>
          ) : isExpired ? (
            <div className="flex min-h-[240px] flex-col items-center justify-center space-y-3 rounded-[16px] border border-(--labelDivider) bg-quinary/70 p-5 text-center">
              <p className="type-title-3-emphasized text-primary">This pairing QR expired</p>
              <p className="max-w-[320px] type-callout text-secondary">
                Each QR code works once and expires after 3 minutes to protect your session.
              </p>
              <button
                type="button"
                onClick={() => void startPairingOffer(includeSpotify)}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-pill bg-key-bg px-5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90"
              >
                <RefreshCw size={15} aria-hidden="true" />
                <span>Generate New QR</span>
              </button>
            </div>
          ) : offer?.active && offer.qrUri ? (
            <>
              <div className="flex flex-col items-center rounded-[18px] border border-(--labelDivider) bg-quinary/65 p-4 text-center">
                <QrCodeSvg
                  value={offer.qrUri}
                  size={220}
                  label="BitChord Desktop to Mobile pairing QR code"
                />

                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <div className="rounded-[12px] border border-(--labelDivider) bg-page px-3.5 py-2 font-mono text-[19px] font-bold tracking-[0.14em] text-primary">
                    {offer.code ?? '------'}
                  </div>
                  {offer.code && (
                    <button
                      type="button"
                      onClick={() => void handleCopyCode()}
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[12px] border border-(--labelDivider) bg-page px-3 text-[13px] font-medium text-primary transition-colors hover:bg-quaternary"
                    >
                      {copiedCode ? (
                        <Check size={15} className="text-green" aria-hidden="true" />
                      ) : (
                        <Copy size={15} aria-hidden="true" />
                      )}
                      <span>{copiedCode ? 'Copied' : 'Copy'}</span>
                    </button>
                  )}
                </div>

                <div className="mt-2.5 flex items-center justify-center gap-1.5 type-caption-1 text-secondary">
                  <Wifi size={13} aria-hidden="true" />
                  <span>
                    {offer.lanIp}:{offer.port}
                  </span>
                </div>

                <div className="mt-2 flex w-full items-center justify-between border-t border-(--labelDivider) pt-2.5 text-[12px] text-secondary">
                  <span>
                    Expires in{' '}
                    <strong className="font-mono text-primary">
                      {formatCountdown(offer.expiresAtMs, nowMs)}
                    </strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => void startPairingOffer(includeSpotify)}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[10px] px-3 font-medium text-primary transition-colors hover:bg-quaternary"
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    <span>Refresh QR</span>
                  </button>
                </div>
              </div>

              {spotifySignedIn && (
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-[14px] border border-(--labelDivider) bg-quinary/60 px-3.5 py-2 text-[13px] text-primary">
                  <input
                    type="checkbox"
                    checked={includeSpotify}
                    onChange={(ev) => handleToggleSpotify(ev.currentTarget.checked)}
                    className="size-4 accent-key"
                  />
                  <span>Also transfer active Spotify session to mobile</span>
                </label>
              )}

              <div className="flex items-start gap-2 rounded-[12px] px-1 text-[12px] text-secondary">
                <ShieldCheck size={15} className="mt-0.5 flex-none text-secondary" aria-hidden="true" />
                <span>
                  End-to-end encrypted on your local Wi-Fi. Decryption key stays strictly inside the QR code and never leaves your devices.
                </span>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
