// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { findMusicSearchInput, focusAndSelectInput, isSearchFocusShortcut, searchShortcutHint } from './searchShortcut';

describe('isSearchFocusShortcut', () => {
  it('matches Ctrl+K and Cmd+K across case', () => {
    expect(isSearchFocusShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false })).toBe(true);
    expect(isSearchFocusShortcut({ key: 'K', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, defaultPrevented: false })).toBe(true);
  });

  it('continues to match Ctrl+F / Cmd+F', () => {
    expect(isSearchFocusShortcut({ key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false })).toBe(true);
  });

  it('ignores Alt, Shift, bare k, or already prevented events', () => {
    expect(isSearchFocusShortcut({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false })).toBe(false);
    expect(isSearchFocusShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, defaultPrevented: false })).toBe(false);
    expect(isSearchFocusShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, defaultPrevented: false })).toBe(false);
    expect(isSearchFocusShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: true })).toBe(false);
  });
});

describe('findMusicSearchInput', () => {
  it('targets data-music-search and skips local Settings search inputs', () => {
    document.body.innerHTML = `
      <input type="search" placeholder="Search settings" />
      <input type="search" data-music-search="true" value="janji palsu" />
    `;
    const found = findMusicSearchInput();
    expect(found?.getAttribute('data-music-search')).toBe('true');
    expect(found?.value).toBe('janji palsu');

    if (found) {
      focusAndSelectInput(found);
      expect(document.activeElement).toBe(found);
      expect(found.selectionStart).toBe(0);
      expect(found.selectionEnd).toBe('janji palsu'.length);
    }
  });

  it('returns null when only Settings search is mounted', () => {
    document.body.innerHTML = `<input type="search" placeholder="Search settings" />`;
    expect(findMusicSearchInput()).toBeNull();
  });
});

describe('searchShortcutHint', () => {
  it('formats platform shortcut badge cleanly', () => {
    expect(searchShortcutHint('Win32')).toBe('Ctrl K');
    expect(searchShortcutHint('MacIntel')).toBe('⌘K');
  });
});
