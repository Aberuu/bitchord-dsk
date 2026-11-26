import { ChevronLeft } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { performBackNavigation } from '@/lib/navigationHistory';

interface SubpageHeaderProps {
  title: string;
  backTo?: string;
  backLabel?: string;
}

export function SubpageHeader({ title, backTo = '/settings', backLabel = 'Back to Settings' }: SubpageHeaderProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleBack = () => {
    if (backTo === '/settings' && location.pathname.startsWith('/settings/')) {
      performBackNavigation(navigate, location, 'button');
      return;
    }
    if (backTo) {
      void navigate(backTo);
      return;
    }
    performBackNavigation(navigate, location, 'button');
  };

  return (
    <header className="mx-(--body-gutter) mt-6 mb-4 flex flex-col gap-3">
      <button
        type="button"
        onClick={handleBack}
        aria-label={backLabel}
        title={`${backLabel} (Esc)`}
        className="grid size-11 place-items-center rounded-full bg-quinary text-primary transition-colors hover:bg-quaternary active:scale-95"
      >
        <ChevronLeft size={22} strokeWidth={2.2} aria-hidden="true" />
      </button>
      <h1 className="type-header-emphasized text-primary">{title}</h1>
    </header>
  );
}
