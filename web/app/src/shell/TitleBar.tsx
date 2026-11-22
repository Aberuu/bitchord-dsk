import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isTauriDesktop } from '@/desktop/tauriBridge';

const captionBtn =
  'grid h-9 w-[46px] place-items-center text-secondary transition-colors duration-100 hover:bg-quinary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key';

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const desktop = isTauriDesktop();

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
      className="relative z-[calc(var(--z-web-chrome)+2)] flex h-9 flex-none items-center justify-end border-b border-divider/60 bg-transparent select-none"
      data-tauri-drag-region
    >
      <div className="h-full flex-1" data-tauri-drag-region onDoubleClick={() => void win.toggleMaximize()} />
      <div className="flex h-full flex-none items-center">
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
          className="grid h-9 w-[46px] place-items-center text-secondary transition-colors duration-100 hover:bg-red hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key"
          aria-label="Close window"
          onClick={() => void win.close()}
        >
          <X size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
