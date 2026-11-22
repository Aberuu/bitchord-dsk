import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router';

interface SubpageHeaderProps {
  title: string;
  backTo?: string;
  backLabel?: string;
}

export function SubpageHeader({ title, backTo = '/settings', backLabel = 'Back to Settings' }: SubpageHeaderProps) {
  const navigate = useNavigate();

  const handleBack = () => {
    if (backTo) {
      void navigate(backTo);
    } else if (window.history.length > 1) {
      void navigate(-1);
    } else {
      void navigate('/settings');
    }
  };

  return (
    <header className="mx-(--body-gutter) mt-6 mb-4 flex flex-col gap-3">
      <button
        type="button"
        onClick={handleBack}
        aria-label={backLabel}
        title={backLabel}
        className="grid size-10 place-items-center rounded-full bg-quinary text-primary transition-colors hover:bg-quaternary active:scale-95"
      >
        <ChevronLeft size={22} strokeWidth={2.2} aria-hidden="true" />
      </button>
      <h1 className="type-header-emphasized text-primary">{title}</h1>
    </header>
  );
}
