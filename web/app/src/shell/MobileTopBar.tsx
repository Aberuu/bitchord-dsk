import { Menu, Settings } from 'lucide-react';
import { PrefetchLink, PrefetchNavLink } from '@/components/PrefetchLink';
import { LogoMark } from '@/components/icons/LogoMark';
import { useUi } from '@/state/ui';
import { BackButton } from './BackButton';

/** Below 484px the sidebar folds into this compact header + bottom glass pill navigation. */
export function MobileTopBar() {
  const setDrawerOpen = useUi((s) => s.setDrawerOpen);
  return (
    <header className="hidden max-sm:absolute max-sm:inset-x-0 max-sm:top-0 max-sm:z-[calc(var(--z-web-chrome)-2)] max-sm:grid max-sm:h-(--mobile-top-bar-height) max-sm:grid-cols-[minmax(88px,auto)_1fr_minmax(88px,auto)] max-sm:items-center max-sm:px-2 max-sm:glass-material">
      <div className="flex items-center">
        <button
          type="button"
          className="grid size-11 place-items-center rounded-full text-primary hover:bg-quinary"
          aria-label="Open menu"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu size={22} strokeWidth={2} aria-hidden="true" />
        </button>
        <BackButton
          hideWhenDisabled
          iconSize={22}
          className="grid size-11 place-items-center rounded-full text-primary transition-colors hover:bg-quinary active:scale-95"
        />
      </div>
      <PrefetchLink
        to="/home"
        className="inline-flex items-center gap-1.5 justify-self-center type-[700_16px/20px]"
        aria-label="BitChord, Home"
      >
        <LogoMark size={20} className="text-primary" />
        <span>BitChord</span>
      </PrefetchLink>
      <div className="flex items-center justify-end">
        <PrefetchNavLink
          to="/settings"
          className="grid size-11 place-items-center rounded-full text-secondary hover:bg-quinary hover:text-primary aria-[current=page]:text-key"
          aria-label="Settings"
        >
          <Settings size={20} strokeWidth={2} aria-hidden="true" />
        </PrefetchNavLink>
      </div>
    </header>
  );
}
