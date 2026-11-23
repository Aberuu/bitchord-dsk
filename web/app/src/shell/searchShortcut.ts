export const MUSIC_SEARCH_SELECTOR = 'input[data-music-search="true"]';
export const FULLSCREEN_SEARCH_SELECTOR = 'input[data-fullscreen-search="true"]';

/** True when a keydown triggers the global search focus shortcut (Ctrl/Cmd+K or Ctrl/Cmd+F). */
export function isSearchFocusShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'defaultPrevented'>,
): boolean {
  if (event.defaultPrevented || event.altKey || event.shiftKey) return false;
  if (!(event.ctrlKey || event.metaKey)) return false;
  const key = event.key.toLowerCase();
  return key === 'k' || key === 'f';
}

export function isMacPlatform(platform = typeof navigator !== 'undefined' ? navigator.platform : ''): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function searchShortcutHint(platform?: string): string {
  return isMacPlatform(platform) ? '⌘K' : 'Ctrl K';
}

/** Finds the active mounted music search input, preferring fullscreen search when open and ignoring local page filters like Settings. */
export function findMusicSearchInput(root: ParentNode = document): HTMLInputElement | null {
  const fullscreen = Array.from(root.querySelectorAll<HTMLInputElement>(FULLSCREEN_SEARCH_SELECTOR));
  if (fullscreen.length > 0) {
    return fullscreen.find((el) => !el.disabled && el.getClientRects().length > 0) ?? fullscreen[fullscreen.length - 1] ?? null;
  }
  const candidates = Array.from(root.querySelectorAll<HTMLInputElement>(MUSIC_SEARCH_SELECTOR));
  if (candidates.length === 0) return null;
  return candidates.find((el) => !el.disabled && el.getClientRects().length > 0) ?? candidates[candidates.length - 1] ?? null;
}

export function focusAndSelectInput(field: HTMLInputElement): void {
  field.focus();
  if (field.value.length > 0) field.select();
}
