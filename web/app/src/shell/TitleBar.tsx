import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowUpCircle, Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isTauriDesktop } from '@/desktop/tauriBridge';
import { useUi } from '@/state/ui';
import { SidebarToggleButton } from './SidebarToggleButton';

const captionBtn =
  'grid h-9 w-[46px] place-items-center text-secondary transition-colors duration-100 hover:bg-quinary hover:text-primary';

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const desktop = isTauriDesktop();
  const hasPendingUpdate = useUi((s) => s.hasPendingUpdate);
  const updateModalOpen = useUi((s) => s.updateModalOpen);
  const setUpdateModalOpen = useUi((s) => s.setUpdateModalOpen);

  useEffect(() => {
    if (!desktop) return;
    const win = getCurrentWindow();
    void win.isMaximized().then(setMaximized).catch(() => {});
    let unlisten: (() => void) | undefined;
    let mounted = true;
    void win
      .onResized(() => {
        void win.isMaximized().then((m) => {
          if (mounted) setMaximized(m);
        });
      })
      .then((fn) => {
        if (mounted) unlisten = fn;
        else fn();
      });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [desktop]);

  if (!desktop) return null;

  const win = getCurrentWindow();
  return (
    <header
      className="absolute inset-x-0 top-0 z-[calc(var(--z-web-chrome)+2)] flex h-9 items-center bg-transparent select-none"
      data-tauri-drag-region
    >
      <div className="hidden h-full w-(--web-navigation-compact-width) flex-none items-center justify-center sm:flex">
        <SidebarToggleButton className={captionBtn} />
      </div>
      <div className="h-full flex-1" data-tauri-drag-region onDoubleClick={() => void win.toggleMaximize()} />
      <div className="flex h-full flex-none items-center">
        {hasPendingUpdate && !updateModalOpen && (
          <button
            type="button"
            className="mr-1 inline-flex h-6 items-center gap-1 rounded-pill bg-key/18 px-2.5 text-[11px] font-semibold text-key transition-colors hover:bg-key/28"
            aria-label="Open Software Update"
            title="Software Update available"
            onClick={() => setUpdateModalOpen(true)}
          >
            <ArrowUpCircle size={12} aria-hidden="true" />
            Update
          </button>
        )}
        <button
          type="button"
          className={captionBtn}
          aria-label="Minimize window"
          onClick={() => void win.minimize()}
        >
          <Minus size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={captionBtn}
          aria-label={maximized ? 'Restore window' : 'Maximize window'}
          onClick={() => void win.toggleMaximize()}
        >
          {maximized ? (
            <Copy size={12} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <Square size={12} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="grid h-9 w-[46px] place-items-center text-secondary transition-colors duration-100 hover:bg-red hover:text-white"
          aria-label="Close window"
          onClick={() => void win.close()}
        >
          <X size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
