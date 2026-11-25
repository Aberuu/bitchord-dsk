import { Cast, Check, Monitor, RefreshCw, Tv, Volume2, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { castToDevice, stopCastingAndResumeLocal } from '@/desktop/castController';
import { useCast } from '@/desktop/castStore';
import { desktopApi, isTauriDesktop, type CastDevice } from '@/desktop/tauriBridge';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';

const PREVIEW_HASH = '#preview-cast';

const PREVIEW_DEVICES: CastDevice[] = [
  {
    id: 'chromecast:preview-tv',
    name: 'Living Room TV',
    model: 'Google TV',
    manufacturer: 'Google',
    protocol: 'chromecast',
    host: '192.168.1.88',
    port: 8009,
    avTransportUrl: null,
    renderingControlUrl: null,
  },
];

export function CastModal() {
  const open = useUi((s) => s.castModalOpen);
  const setOpen = useUi((s) => s.setCastModalOpen);
  const [previewMode, setPreviewMode] = useState(
    () => typeof window !== 'undefined' && window.location.hash === PREVIEW_HASH,
  );

  useEffect(() => {
    const syncHash = () => {
      const active = window.location.hash === PREVIEW_HASH;
      setPreviewMode(active);
      if (active) setOpen(true);
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, [setOpen]);

  if (!open && !previewMode) return null;
  return <CastModalContent previewMode={previewMode} onExitPreview={() => setPreviewMode(false)} />;
}

interface CastModalContentProps {
  previewMode: boolean;
  onExitPreview: () => void;
}

function CastModalContent({ previewMode, onExitPreview }: CastModalContentProps) {
  const setOpen = useUi((s) => s.setCastModalOpen);
  const support = useCast((s) => s.support);
  const session = useCast((s) => s.session);
  const storeDevices = useCast((s) => s.devices);
  const scanning = useCast((s) => s.scanning);
  const storeError = useCast((s) => s.error);
  const discoverDevices = useCast((s) => s.discoverDevices);
  const setError = useCast((s) => s.setError);
  const setVolume = usePlayer((s) => s.setVolume);
  const toggleMute = usePlayer((s) => s.toggleMute);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const hasNowPlaying = usePlayer((s) => s.nowPlaying !== null);

  const closeRef = useRef<HTMLButtonElement>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [miracastNotice, setMiracastNotice] = useState<string | null>(null);
  const [miracastBusy, setMiracastBusy] = useState(false);

  const closeModal = useCallback(() => {
    if (previewMode) {
      if (window.location.hash === PREVIEW_HASH) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      onExitPreview();
    }
    setOpen(false);
  }, [previewMode, onExitPreview, setOpen]);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    if (!previewMode) {
      void discoverDevices();
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeModal();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [discoverDevices, previewMode, closeModal]);

  const devices = previewMode && storeDevices.length === 0 ? PREVIEW_DEVICES : storeDevices;
  const desktop = isTauriDesktop();
  const showMiracast = desktop || previewMode || support.protocols.includes('miracast');

  const handleOpenWindowsCast = async () => {
    setMiracastNotice(null);
    setError(null);
    if (previewMode) {
      setMiracastNotice('Preview mode: opens Windows Cast (Win + K) in BitChord Desktop.');
      return;
    }
    setMiracastBusy(true);
    try {
      await desktopApi.castOpenWindowsCast();
      setMiracastNotice('Windows Cast panel opened. Select your wireless display (such as FTI 331) there.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMiracastBusy(false);
    }
  };

  const handleOpenWindowsSettings = async () => {
    setMiracastNotice(null);
    setError(null);
    if (previewMode) {
      setMiracastNotice('Preview mode: opens Windows Connectable Devices settings.');
      return;
    }
    try {
      await desktopApi.castOpenWindowsCastSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectDevice = async (device: CastDevice) => {
    if (session.connected && session.device?.id === device.id) return;
    if (!hasNowPlaying) {
      setError('Play a track first to cast audio to this TV.');
      return;
    }
    setPickingId(device.id);
    try {
      await castToDevice(device);
      closeModal();
    } catch {
      // Error state is published on useCast.
    } finally {
      setPickingId(null);
    }
  };

  const handleStopCasting = async () => {
    setStopping(true);
    try {
      await stopCastingAndResumeLocal();
      closeModal();
    } finally {
      setStopping(false);
    }
  };

  const remoteLevel = session.connected ? session.volume : muted ? 0 : volume;
  const subtitle = previewMode
    ? 'Wi-Fi · 192.168.1.42'
    : support.adapterName
      ? `${support.adapterName}${support.localIp ? ` · ${support.localIp}` : ''}`
      : 'Chromecast, DLNA, and Windows Wireless Display';

  return (
    <div
      className="fixed inset-0 z-[calc(var(--z-modal)-1)] flex items-end justify-center bg-black/45 p-4 backdrop-blur-xs animate-fade sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cast-modal-title"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) closeModal();
      }}
    >
      <div
        data-full-screen
        className="flex max-h-[90vh] w-[min(440px,95vw)] flex-col overflow-hidden rounded-[22px] border border-(--labelDivider) bg-(--systemStandardThickMaterialSover) p-4 text-primary shadow-[0_24px_64px_rgba(0,0,0,0.48)] backdrop-blur-2xl animate-zoom"
        style={{ backdropFilter: 'saturate(200%) blur(26px)' }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="mx-auto mb-2.5 h-1 w-9 rounded-full bg-secondary/40 sm:hidden" aria-hidden="true" />
        <div className="mb-3 flex items-center justify-between gap-2 px-1">
          <div className="min-w-0">
            <h2 id="cast-modal-title" className="type-[700_18px/22px] text-primary">
              Cast to TV
            </h2>
            <p className="mt-0.5 truncate type-caption-1 text-secondary">{subtitle}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void discoverDevices()}
              disabled={scanning || previewMode}
              aria-label="Scan for TVs"
              title="Scan for TVs and Cast receivers"
              className="grid min-h-[44px] min-w-[44px] place-items-center rounded-full border border-(--labelDivider) bg-quaternary text-secondary transition-colors hover:bg-quinary hover:text-primary disabled:opacity-50"
            >
              <RefreshCw
                size={15}
                className={scanning ? 'motion-safe:animate-spin' : undefined}
                aria-hidden="true"
              />
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={closeModal}
              aria-label="Close Cast to TV"
              className="grid min-h-[44px] min-w-[44px] place-items-center rounded-full border border-(--labelDivider) bg-quaternary text-secondary transition-colors hover:bg-quinary hover:text-primary"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto pr-0.5">
          {storeError && (
            <div
              role="alert"
              className="rounded-[14px] border border-red/35 bg-red/12 px-3.5 py-2.5 type-callout text-primary"
            >
              {storeError}
            </div>
          )}

          {showMiracast && (
            <div className="rounded-[16px] border border-(--labelDivider) bg-quaternary/75 p-3.5">
              <div className="flex items-start gap-3">
                <span className="grid size-10 flex-none place-items-center rounded-full bg-page text-primary shadow-xs">
                  <Monitor size={18} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] leading-[18px] font-semibold text-primary">
                    Windows Wireless Display (Miracast)
                  </p>
                  <p className="mt-1 text-[12.5px] leading-[17px] text-secondary">
                    Displays listed under Windows Cast (such as <strong className="font-semibold text-primary">FTI 331</strong>) connect via Wi-Fi Direct.
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={miracastBusy}
                  onClick={() => void handleOpenWindowsCast()}
                  className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-pill bg-key-bg px-4 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {miracastBusy ? 'Opening Windows Cast...' : 'Open Windows Cast (Win + K)'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleOpenWindowsSettings()}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-pill border border-(--labelDivider) bg-page px-3.5 text-[13px] font-medium text-primary transition-colors hover:bg-quinary"
                >
                  Cast Settings
                </button>
              </div>
              {miracastNotice && (
                <p role="status" className="mt-2.5 text-[12px] leading-[16px] text-secondary">
                  {miracastNotice}
                </p>
              )}
            </div>
          )}

          <div>
            <p className="mb-1.5 px-1 text-[12px] font-semibold text-secondary">
              Wi-Fi Smart TVs (Chromecast &amp; DLNA)
            </p>
            <div className="flex max-h-[220px] flex-col gap-2 overflow-y-auto scrollbar-compact">
              {devices.length === 0 ? (
                <div className="flex flex-col items-center rounded-[16px] border border-(--labelDivider) bg-quaternary/60 px-5 py-5 text-center">
                  <span className="grid size-10 place-items-center rounded-full bg-page text-secondary">
                    <Tv size={19} aria-hidden="true" />
                  </span>
                  <p className="mt-2.5 text-[14px] font-semibold text-primary">
                    {scanning ? 'Searching for Wi-Fi TVs...' : 'No Chromecast or DLNA TVs found'}
                  </p>
                  <p className="mt-1 text-[12.5px] leading-[17px] text-secondary">
                    {scanning
                      ? 'Scanning Wi-Fi and LAN for Chromecast and UPnP Smart TVs.'
                      : 'Ensure your TV and PC share the same Wi-Fi, or use Open Windows Cast (Win + K) above for Miracast displays.'}
                  </p>
                </div>
              ) : (
                devices.map((dev) => {
                  const connected = session.connected && session.device?.id === dev.id;
                  const connecting = pickingId === dev.id || (session.connecting && session.device?.id === dev.id);
                  const protocolLabel = dev.protocol === 'chromecast' ? 'Chromecast' : 'Smart TV (DLNA)';
                  return (
                    <button
                      key={dev.id}
                      type="button"
                      disabled={connecting}
                      onClick={() => void handleSelectDevice(dev)}
                      className={`flex min-h-[56px] w-full items-center gap-3.5 rounded-[16px] border px-3.5 py-2.5 text-start transition-colors ${
                        connected
                          ? 'border-key/45 bg-key/12'
                          : 'border-(--labelDivider) bg-quaternary/75 hover:bg-quaternary'
                      }`}
                    >
                      <span className="grid size-10 flex-none place-items-center rounded-full bg-page text-primary shadow-xs">
                        <Cast size={18} aria-hidden="true" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[14px] font-semibold text-primary">{dev.name}</span>
                          <span className="shrink-0 rounded-full border border-(--labelDivider) bg-page px-2 py-0.5 text-[10px] font-medium text-secondary">
                            {protocolLabel}
                          </span>
                        </span>
                        <span className="truncate text-[12px] text-secondary">
                          {connecting
                            ? 'Connecting...'
                            : connected
                              ? `Casting audio · ${dev.host}`
                              : [dev.model, dev.host].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {connected && <Check size={17} strokeWidth={2.5} className="text-green" aria-hidden="true" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {session.connected && (
            <>
              <div className="flex items-center gap-3 rounded-[16px] border border-(--labelDivider) bg-quaternary/75 px-3.5 py-3">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted || remoteLevel === 0 ? 'Unmute TV' : 'Mute TV'}
                  className="grid min-h-[44px] min-w-[44px] flex-none place-items-center rounded-full text-secondary transition-colors hover:text-primary"
                >
                  {muted || remoteLevel === 0 ? (
                    <VolumeX size={17} aria-hidden="true" />
                  ) : (
                    <Volume2 size={17} aria-hidden="true" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={muted ? 0 : remoteLevel}
                  aria-label="TV volume"
                  onChange={(ev) => setVolume(Number(ev.currentTarget.value))}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-secondary/30 accent-key"
                />
                <span className="w-10 text-right type-callout tabular-nums text-secondary">
                  {Math.round((muted ? 0 : remoteLevel) * 100)}%
                </span>
              </div>

              <button
                type="button"
                disabled={stopping}
                onClick={() => void handleStopCasting()}
                className="flex min-h-[44px] w-full items-center justify-center rounded-[14px] border border-red/30 bg-red/14 px-4 py-2.5 text-[14px] font-semibold text-red transition-colors hover:bg-red/22 disabled:opacity-50"
              >
                {stopping ? 'Returning playback to PC...' : 'Stop Casting & Play Here'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
