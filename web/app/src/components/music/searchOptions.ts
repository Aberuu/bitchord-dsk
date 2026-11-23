import type { MusicItem, SearchResults, Shelf, Suggestions } from '@/data/music/types';

export type SearchOption =
  | { kind: 'query'; text: string; typed: string; rest: string }
  | { kind: 'item'; item: MusicItem };

const ITEM_PRIORITY: Record<MusicItem['kind'], number> = {
  song: 0,
  video: 1,
  album: 2,
  artist: 3,
  playlist: 4,
  'spotify-playlist': 5,
  episode: 6,
  podcast: 7,
  unknown: 8,
};

/**
 * Builds dropdown options with playable songs first, other music entities next,
 * and plain text query completions underneath.
 */
export function buildSuggestionOptions(suggestions: Suggestions | undefined): SearchOption[] {
  if (!suggestions) return [];
  const sortedItems = suggestions.items
    .map((item, order) => ({ item, order, rank: ITEM_PRIORITY[item.kind] ?? 8 }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ item }) => ({ kind: 'item' as const, item }));
  const queries = suggestions.queries.map((q) => ({ kind: 'query' as const, ...q }));
  return [...sortedItems, ...queries];
}

/** Search result shelves with Songs first so tracks lead the results page. */
export function buildSearchShelves(results: SearchResults): Shelf[] {
  const shelf = (title: string, items: MusicItem[], layout: Shelf['layout']): Shelf | null =>
    items.length ? { title, strapline: null, layout, items, seeAll: null } : null;
  return [
    shelf('Songs', results.songs, 'tracks'),
    shelf('Artists', results.artists, 'circle'),
    shelf('Albums', results.albums, 'square'),
    shelf('Playlists', results.playlists, 'square'),
    shelf('Videos', results.videos, 'video'),
  ].filter((s): s is Shelf => !!s);
}
