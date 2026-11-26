import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router';
import {
  isEscBackRoute,
  performBackNavigation,
  useCanGoBack,
  useCurrentRoutePath,
} from '@/lib/navigationHistory';

interface BackButtonProps {
  className: string;
  iconSize?: number;
  hideWhenDisabled?: boolean;
}

export function BackButton({
  className,
  iconSize = 17,
  hideWhenDisabled = false,
}: BackButtonProps) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const pathname = useCurrentRoutePath();

  if (hideWhenDisabled && !canGoBack) {
    return null;
  }

  const resolvedPath =
    pathname || (typeof window !== 'undefined' ? window.location.pathname : '/home');
  const title = isEscBackRoute(resolvedPath) ? 'Back (Esc)' : 'Back (Alt+Left)';

  return (
    <button
      type="button"
      className={className}
      disabled={!canGoBack}
      aria-label="Back"
      title={canGoBack ? title : 'No previous page'}
      onClick={() => {
        if (!canGoBack) return;
        const current =
          typeof window !== 'undefined'
            ? {
                pathname: resolvedPath,
                search: window.location.search,
                hash: window.location.hash,
              }
            : { pathname: resolvedPath };
        performBackNavigation(navigate, current, 'button');
      }}
    >
      <ChevronLeft size={iconSize} strokeWidth={2.1} aria-hidden="true" />
    </button>
  );
}
