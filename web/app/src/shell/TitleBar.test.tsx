// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchField } from '@/components/music/SearchField';
import { resetNavigationHistory, useNavigationHistory } from '@/lib/navigationHistory';
import { TitleBar } from './TitleBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockIsDesktop = true;

vi.mock('@/desktop/tauriBridge', () => ({
  isTauriDesktop: () => mockIsDesktop,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
  }),
}));

vi.mock('@/data/music/queries', () => ({
  useSuggestions: () => ({
    data: {
      queries: [{ text: 'janji palsu', typed: 'janji', rest: ' palsu' }],
      items: [],
    },
  }),
}));

vi.mock('react-router', () => ({
  useNavigate: () => () => {},
}));

describe('TitleBar, SearchField borders, and OLED black dark theme tokens', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockIsDesktop = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resetNavigationHistory();
  });

  it('renders TitleBar as a transparent overlay with Back button and no divider border or surface split', () => {
    act(() => {
      root.render(<TitleBar />);
    });

    const header = host.querySelector('header')!;
    expect(header.className).toContain('absolute');
    expect(header.className).toContain('bg-transparent');
    expect(header.className).not.toContain('border-b');
    expect(header.querySelector('.glass-material')).toBeNull();
    expect(header.innerHTML).not.toContain('bg-(--scrollablePageBG)');

    const backBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!;
    expect(backBtn).toBeTruthy();
    expect(backBtn.disabled).toBe(true);

    act(() => {
      useNavigationHistory.setState({
        items: [
          { key: '1', path: '/home', pathname: '/home' },
          { key: '2', path: '/artist/UCfeast', pathname: '/artist/UCfeast' },
        ],
        cursor: 1,
        lastNonSettingsPath: '/artist/UCfeast',
        scrollPositions: {},
      });
    });
    expect(backBtn.disabled).toBe(false);
    expect(backBtn.title).toContain('Esc');
  });

  it('returns null for TitleBar outside Tauri desktop', () => {
    mockIsDesktop = false;
    act(() => {
      root.render(<TitleBar />);
    });
    expect(host.querySelector('header')).toBeNull();
  });

  it('uses refined smoked glass divider styling instead of bright white inset ring on SearchField dropdown', () => {
    act(() => {
      root.render(<SearchField initial="janji" onSearch={() => {}} />);
    });

    const input = host.querySelector<HTMLInputElement>('input[data-music-search="true"]')!;
    act(() => {
      input.focus();
    });

    const listbox = host.querySelector('[role="listbox"]')!;
    expect(listbox.className).toContain('border-vibrant-divider/80');
    expect(listbox.className).not.toContain('#ffffff33');
  });
});
