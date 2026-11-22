import { Menu, Settings } from 'lucide-react';
import { PrefetchLink, PrefetchNavLink } from '@/components/PrefetchLink';
import { LogoMark } from '@/components/icons/LogoMark';
import { useUi } from '@/state/ui';

/** Below 484px the sidebar folds into this compact header + bottom glass pill navigation. */
export function MobileTopBar() {
  const setDrawerOpen = useUi((s) => s.setDrawerOpen);
  return (
    <header className="hidden max-sm:absolute max-sm:inset-x-0 max-sm:top-0 max-sm:z-[calc(var(--z-web-chrome)-2)] max-sm:grid max-sm:h-(--mobile-top-bar-height) max-sm:grid-cols-[44px_1fr_44px] max-sm:items-center max-sm:px-3.5 max-sm:glass-material">
      <button
        type="button"
        className="grid size-11 place-items-center rounded-full text-primary hover:bg-quinary"
        aria-label="Open menu"
        onClick={() => setDrawerOpen(true)}
      >
        <Menu size={22} strokeWidth={2} aria-hidden="true" />
      </button>
      <PrefetchLink
        to="/home"
        className="inline-flex items-center gap-1.5 justify-self-center type-[700_16px/20px]"
        aria-label="BitChord, Home"
      >
        <LogoMark size={20} className="text-primary" />
        <span>BitChord</span>
      </PrefetchLink>
      <PrefetchNavLink
        to="/settings"
        className="grid size-11 place-items-center rounded-full text-secondary hover:bg-quinary hover:text-primary aria-[current=page]:text-key"
        aria-label="Settings"
      >
        <Settings size={20} strokeWidth={2} aria-hidden="true" />
      </PrefetchNavLink>
    </header>
  );
}
