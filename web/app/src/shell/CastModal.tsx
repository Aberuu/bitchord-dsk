import { Cast, Check, Monitor, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { castToDevice, stopCastingAndResumeLocal } from '@/desktop/castController';
import { useCast } from '@/desktop/castStore';
import { desktopApi, isTauriDesktop, type CastDevice } from '@/desktop/tauriBridge';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';

const PREVIEW_HASH = '#preview-cast';
const PREVIEW_DEVICES_HASH = '#preview-cast-devices';

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

type PreviewKind = 'none' | 'searching' | 'devices';

function readPreviewKind(): PreviewKind {
  if (typeof window === 'undefined') return 'none';
  if (window.location.hash === PREVIEW_DEVICES_HASH) return 'devices';
  if (window.location.hash === PREVIEW_HASH) return 'searching';
  return 'none';
}

export function CastModal() {
  const open = useUi((s) => s.castModalOpen);
  const setOpen = useUi((s) => s.setCastModalOpen);
  const [previewKind, setPreviewKind] = useState<PreviewKind>(readPreviewKind);

  useEffect(() => {
    const syncHash = () => {
      const next = readPreviewKind();
      setPreviewKind(next);
      if (next !== 'none') setOpen(true);
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, [setOpen]);

  if (!open && previewKind === 'none') return null;
  return (
    <CastModalContent
      previewKind={previewKind}
      onExitPreview={() => setPreviewKind('none')}
    />
  );
}

interface CastModalContentProps {
  previewKind: PreviewKind;
  onExitPreview: () => void;
}

function CastModalContent({ previewKind, onExitPreview }: CastModalContentProps) {
  const setOpen = useUi((s) => s.setCastModalOpen);
  const support = useCast((s) => s.support);
  const session = useCast((s) => s.session);
  const storeDevices = useCast((s) => s.devices);
  const storeScanning = useCast((s) => s.scanning);
  const storeError = useCast((s) => s.error);
  const discoverDevices = useCast((s) => s.discoverDevices);
  const setError = useCast((s) => s.setError);
  const setVolume = usePlayer((s) => s.setVolume);
  const toggleMute = usePlayer((s) => s.toggleMute);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const hasNowPlaying = usePlayer((s) => s.nowPlaying !== null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [windowsNotice, setWindowsNotice] = useState<string | null>(null);
  const [windowsBusy, setWindowsBusy] = useState(false);

  const previewMode = previewKind !== 'none';
  const scanning = previewKind === 'searching' ? true : storeScanning;
  const devices =
    previewKind === 'devices' && storeDevices.length === 0 ? PREVIEW_DEVICES : storeDevices;
  const desktop = isTauriDesktop();
  const showWindowsCast = desktop || previewMode || support.protocols.includes('miracast');

  const closeModal = useCallback(() => {
    if (previewMode) {
      if (
        window.location.hash === PREVIEW_HASH ||
        window.location.hash === PREVIEW_DEVICES_HASH
      ) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      onExitPreview();
    }
    setOpen(false);
  }, [previewMode, onExitPreview, setOpen]);

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
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

  const handleOpenWindowsCast = async () => {
    setWindowsNotice(null);
    setError(null);
    if (previewMode) {
      setWindowsNotice('Windows Cast panel opens here in BitChord Desktop.');
      return;
    }
    setWindowsBusy(true);
    try {
      await desktopApi.castOpenWindowsCast();
      setWindowsNotice('Windows Cast opened. Choose a wireless display from the system panel.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWindowsBusy(false);
    }
  };

  const handleSelectDevice = async (device: CastDevice) => {
    if (session.connected && session.device?.id === device.id) return;
    if (!hasNowPlaying) {
      setError('Play a track first to cast audio to this device.');
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

  return (
    <div
      className="fixed inset-0 z-[calc(var(--z-modal)-1)] flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs animate-fade"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cast-modal-title"
      aria-describedby="cast-modal-subtitle"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) closeModal();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="flex max-h-[88vh] w-[min(372px,92vw)] flex-col overflow-hidden rounded-[22px] border border-(--labelDivider) bg-(--systemStandardThickMaterialSover) text-primary shadow-[0_24px_64px_rgba(0,0,0,0.48)] outline-none backdrop-blur-2xl animate-zoom"
        style={{ backdropFilter: 'saturate(200%) blur(28px)' }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-4 text-center">
          <h2
            id="cast-modal-title"
            className="text-[17px] leading-[22px] font-semibold tracking-[-0.015em] text-primary"
          >
            Cast
          </h2>
          <p id="cast-modal-subtitle" className="mt-1 text-[13px] leading-[18px] text-secondary">
            Play on a Chromecast or Google Cast speaker
          </p>
        </div>

        <div className="border-t border-(--labelDivider)" />

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-5 scrollbar-compact">
          {storeError && (
            <div
              role="alert"
              className="rounded-[12px] border border-red/30 bg-red/10 px-3.5 py-2.5 text-center text-[12.5px] leading-[17px] text-primary"
            >
              {storeError}
            </div>
          )}

          {devices.length === 0 ? (
            <div className="flex flex-col items-center py-4 text-center">
              {scanning && (
                <span
                  aria-hidden="true"
                  className="mb-3 inline-block size-4 rounded-full border-[1.5px] border-secondary/30 border-t-primary motion-safe:animate-spin"
                />
              )}
              <p className="text-[15px] leading-[20px] font-medium text-primary">
                {scanning ? 'Looking for devices...' : 'No devices found'}
              </p>
              <p className="mt-1.5 max-w-[270px] text-[13px] leading-[18px] text-secondary">
                Your PC and the receiver need to be on the same Wi-Fi network.
              </p>

              {!scanning && (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    disabled={previewMode}
                    onClick={() => void discoverDevices()}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill bg-primary/8 px-4 text-[13px] font-medium text-primary transition-colors hover:bg-primary/14 disabled:opacity-50"
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                    Search again
                  </button>
                  {showWindowsCast && (
                    <button
                      type="button"
                      disabled={windowsBusy}
                      onClick={() => void handleOpenWindowsCast()}
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill bg-primary/8 px-4 text-[13px] font-medium text-secondary transition-colors hover:bg-primary/14 hover:text-primary disabled:opacity-50"
                    >
                      <Monitor size={14} aria-hidden="true" />
                      {windowsBusy ? 'Opening...' : 'Windows Cast'}
                    </button>
                  )}
                </div>
              )}

              {windowsNotice && (
                <p role="status" className="mt-3 max-w-[280px] text-[12px] leading-[17px] text-secondary">
                  {windowsNotice}
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                {devices.map((dev) => {
                  const connected = session.connected && session.device?.id === dev.id;
                  const connecting =
                    pickingId === dev.id || (session.connecting && session.device?.id === dev.id);
                  const secondary = connecting
                    ? 'Connecting...'
                    : connected
                      ? 'Casting'
                      : dev.model ?? (dev.protocol === 'chromecast' ? 'Google Cast' : 'Smart TV');
                  return (
                    <button
                      key={dev.id}
                      type="button"
                      disabled={connecting}
                      onClick={() => void handleSelectDevice(dev)}
                      className={`flex min-h-[54px] w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-start transition-colors ${
                        connected ? 'bg-primary/12' : 'bg-primary/6 hover:bg-primary/10'
                      }`}
                    >
                      <span className="grid size-9 flex-none place-items-center rounded-full bg-primary/10 text-primary">
                        <Cast size={16} aria-hidden="true" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[14px] leading-[19px] font-medium text-primary">
                          {dev.name}
                        </span>
                        <span className="truncate text-[12px] leading-[16px] text-secondary">
                          {secondary}
                        </span>
                      </span>
                      {connected && (
                        <Check size={17} strokeWidth={2.4} className="flex-none text-primary" aria-hidden="true" />
                      )}
                    </button>
                  );
                })}
              </div>

              {session.connected && (
                <div className="flex flex-col gap-2 pt-1">
                  <div className="flex items-center gap-2.5 rounded-[14px] bg-primary/6 px-3 py-2">
                    <button
                      type="button"
                      onClick={toggleMute}
                      aria-label={muted || remoteLevel === 0 ? 'Unmute receiver' : 'Mute receiver'}
                      className="grid min-h-[44px] min-w-[44px] flex-none place-items-center rounded-full text-secondary transition-colors hover:text-primary"
                    >
                      {muted || remoteLevel === 0 ? (
                        <VolumeX size={16} aria-hidden="true" />
                      ) : (
                        <Volume2 size={16} aria-hidden="true" />
                      )}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={muted ? 0 : remoteLevel}
                      aria-label="Receiver volume"
                      onChange={(ev) => setVolume(Number(ev.currentTarget.value))}
                      className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-secondary/30 accent-primary"
                    />
                    <span className="w-9 text-right text-[12px] tabular-nums text-secondary">
                      {Math.round((muted ? 0 : remoteLevel) * 100)}%
                    </span>
                  </div>

                  <button
                    type="button"
                    disabled={stopping}
                    onClick={() => void handleStopCasting()}
                    className="flex min-h-[44px] w-full items-center justify-center rounded-[12px] bg-red/12 px-4 text-[14px] font-medium text-red transition-colors hover:bg-red/18 disabled:opacity-50"
                  >
                    {stopping ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                </div>
              )}

              <div className="flex items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={scanning || previewMode}
                  onClick={() => void discoverDevices()}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill px-3 text-[12.5px] font-medium text-secondary transition-colors hover:bg-primary/8 hover:text-primary disabled:opacity-50"
                >
                  <RefreshCw
                    size={13}
                    className={scanning ? 'motion-safe:animate-spin' : undefined}
                    aria-hidden="true"
                  />
                  {scanning ? 'Searching...' : 'Search again'}
                </button>
                {showWindowsCast && (
                  <button
                    type="button"
                    disabled={windowsBusy}
                    onClick={() => void handleOpenWindowsCast()}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill px-3 text-[12.5px] font-medium text-secondary transition-colors hover:bg-primary/8 hover:text-primary disabled:opacity-50"
                  >
                    <Monitor size={13} aria-hidden="true" />
                    Windows Cast
                  </button>
                )}
              </div>

              {windowsNotice && (
                <p role="status" className="text-center text-[12px] leading-[16px] text-secondary">
                  {windowsNotice}
                </p>
              )}
            </>
          )}
        </div>

        <div className="border-t border-(--labelDivider)">
          <button
            type="button"
            onClick={closeModal}
            className="flex min-h-[48px] w-full items-center justify-center text-[15px] font-semibold text-primary transition-colors hover:bg-primary/6"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
