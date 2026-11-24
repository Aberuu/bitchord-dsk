import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useUi } from '@/state/ui';

export function SidebarToggleButton({ className }: { className: string }) {
  const sidebarCompact = useUi((s) => s.sidebarCompact);
  const toggleSidebarCompact = useUi((s) => s.toggleSidebarCompact);
  const label = sidebarCompact ? 'Expand sidebar' : 'Collapse sidebar';

  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-controls="main-sidebar"
      aria-expanded={!sidebarCompact}
      title={`${label} (Ctrl+B)`}
      onClick={toggleSidebarCompact}
    >
      {sidebarCompact ? (
        <PanelLeftOpen size={17} strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <PanelLeftClose size={17} strokeWidth={1.8} aria-hidden="true" />
      )}
    </button>
  );
}
