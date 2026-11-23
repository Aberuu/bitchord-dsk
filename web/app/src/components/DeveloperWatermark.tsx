import { ArrowUpRight } from 'lucide-react';
import type { MouseEvent } from 'react';
import { getEmbeddedWatermark, openExternalUrl } from '@/desktop/watermark';
import { settingsUi } from '@/pages/settingsStyles';

function GitHubMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="flex-none"
    >
      <path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 4.64 3.01 8.58 7.18 9.97.52.1.72-.23.72-.51v-1.8c-2.92.63-3.54-1.24-3.54-1.24-.48-1.21-1.17-1.53-1.17-1.53-.95-.65.07-.64.07-.64 1.05.08 1.61 1.08 1.61 1.08.94 1.6 2.46 1.14 3.06.87.09-.68.37-1.14.67-1.4-2.33-.26-4.78-1.17-4.78-5.19 0-1.15.41-2.09 1.08-2.82-.11-.27-.47-1.33.1-2.78 0 0 .88-.28 2.89 1.08A10.1 10.1 0 0 1 12 6.58c.89 0 1.79.12 2.63.35 2.01-1.36 2.89-1.08 2.89-1.08.57 1.45.21 2.51.1 2.78.67.73 1.08 1.67 1.08 2.82 0 4.03-2.46 4.92-4.8 5.18.38.33.72.97.72 1.96v2.9c0 .28.19.61.72.51A10.5 10.5 0 0 0 22.5 12C22.5 6.2 17.8 1.5 12 1.5Z" />
    </svg>
  );
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

function handleExternalClick(ev: MouseEvent<HTMLAnchorElement>, url: string) {
  ev.preventDefault();
  void openExternalUrl(url);
}

interface DeveloperWatermarkProps {
  variant: 'sidebar' | 'footer' | 'rows';
  version?: string;
}

export function DeveloperWatermark({ variant, version }: DeveloperWatermarkProps) {
  const wm = getEmbeddedWatermark();
  if (!wm.integrityValid || !wm.credit) return null;

  const repoDisplay = stripProtocol(wm.githubRepoUrl);
  const profileDisplay = stripProtocol(wm.githubProfileUrl);

  if (variant === 'sidebar') {
    return (
      <div
        data-watermark="visible"
        className="flex items-center justify-between gap-2 pt-0.5 type-callout text-secondary"
      >
        <span className="min-w-0 truncate">{wm.credit}</span>
        <a
          href={wm.githubRepoUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(ev) => handleExternalClick(ev, wm.githubRepoUrl)}
          aria-label={`${wm.credit}, ${wm.githubRepoUrl}`}
          title={wm.githubRepoUrl}
          className="inline-flex min-h-[28px] flex-none items-center gap-1.5 rounded-[6px] px-1.5 py-0.5 text-secondary transition-colors hover:bg-quinary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-key"
        >
          <GitHubMark size={13} />
          <span>{wm.author}</span>
        </a>
      </div>
    );
  }

  if (variant === 'rows') {
    return (
      <>
        <a
          href={wm.githubProfileUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(ev) => handleExternalClick(ev, wm.githubProfileUrl)}
          data-watermark="visible"
          className={`${settingsUi.integration} ${settingsUi.linkRow} min-h-[48px] no-underline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-key`}
        >
          <span className={settingsUi.iconPlain}>
            <GitHubMark size={18} />
          </span>
          <span className={settingsUi.rowText}>
            <span className="type-title-3 text-primary">{wm.credit}</span>
            <span className={settingsUi.rowDetail}>{profileDisplay}</span>
          </span>
          <ArrowUpRight size={16} className="text-tertiary" aria-hidden="true" />
        </a>

        <a
          href={wm.githubRepoUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(ev) => handleExternalClick(ev, wm.githubRepoUrl)}
          className={`${settingsUi.integration} ${settingsUi.linkRow} min-h-[48px] no-underline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-key`}
        >
          <span className={settingsUi.iconPlain}>
            <GitHubMark size={18} />
          </span>
          <span className={settingsUi.rowText}>
            <span className="type-title-3 text-primary">GitHub Repository</span>
            <span className={settingsUi.rowDetail}>{repoDisplay}</span>
          </span>
          <ArrowUpRight size={16} className="text-tertiary" aria-hidden="true" />
        </a>
      </>
    );
  }

  return (
    <footer
      data-watermark="visible"
      className="mt-7 flex flex-col items-center gap-1 text-center type-callout text-secondary"
    >
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
        {version && <span>BitChord Desktop {version}</span>}
        {version && <span aria-hidden="true">·</span>}
        <span>{wm.credit}</span>
      </div>
      <a
        href={wm.githubRepoUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(ev) => handleExternalClick(ev, wm.githubRepoUrl)}
        className="inline-flex min-h-[44px] max-w-full items-center gap-1.5 rounded-pill px-3 py-2 text-secondary no-underline transition-colors hover:bg-quinary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-key"
      >
        <GitHubMark size={14} />
        <span className="truncate underline decoration-divider underline-offset-4">{repoDisplay}</span>
      </a>
    </footer>
  );
}
