/*
 * Grouped inset rows matching BitChord's rounded card idiom across
 * Settings Hub, Playback, Equalizer, Integrations, and Listen Together.
 */

const row = 'relative flex items-center justify-between px-4 py-[13px] type-title-3 hairline-[16px]';
const integration = 'relative grid items-center gap-x-3.5 px-4 py-[13px] type-title-3 hairline-[56px]';
const field = 'w-[220px] flex-none rounded-[10px] border-0 bg-quaternary px-3 py-1.5 type-body text-primary';

export const settingsUi = {
  centered: 'mx-auto max-w-[calc(680px+2*var(--body-gutter))]',
  body: 'mx-(--body-gutter) mt-4 mb-[140px] max-w-[680px]',
  group: 'overflow-hidden rounded-[16px] bg-quinary',
  sectionHeader: 'mx-4 mt-7 mb-2 type-subhead-emphasized tracking-[0.04em] uppercase text-secondary',
  footer: 'mx-4 mt-2 type-callout text-secondary',

  row,
  controlRow: `${row} cursor-pointer gap-4`,
  rowText: 'flex min-w-0 flex-1 flex-col gap-0.5',
  rowDetail: 'type-callout text-secondary',
  value: 'inline-flex flex-none items-center gap-1.5 text-right type-body-reduced text-secondary',
  dot: 'size-2 rounded-full bg-green',

  download:
    'relative grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-[12px] hover:bg-quinary hairline-[60px]',
  updateDot: 'size-2.5 justify-self-center rounded-full bg-key',
  downloadText: 'flex min-w-0 flex-col gap-0.5',
  downloadTitle: 'type-title-3-emphasized text-key',
  downloadDetail: 'type-body text-secondary',
  chevron: 'text-tertiary',
  steps: 'mx-4 mt-2.5 list-decimal ps-[18px] type-body-tall text-secondary [&>li+li]:mt-1',

  integration: `${integration} grid-cols-[26px_minmax(0,1fr)_auto]`,
  integrationPlain: `${integration} grid-cols-[minmax(0,1fr)_auto]`,
  integrationIcon: 'grid size-[26px] place-items-center rounded-[7px] text-white',
  iconPlain: 'grid size-[26px] place-items-center text-primary',
  integrationName: 'min-w-0',
  linkRow: 'w-full cursor-pointer text-start transition-colors hover:bg-tracklist-hover',
  inlineButton: 'ml-2 rounded-pill bg-quaternary px-3 py-1 type-callout-emphasized text-primary transition-colors hover:bg-tracklist-hover disabled:opacity-50',
  inlineLink: 'text-key',

  switch: [
    'relative h-[26px] w-[46px] flex-none cursor-pointer appearance-none rounded-pill bg-quaternary transition-[background-color] duration-200 checked:bg-green',
    'after:absolute after:top-[3px] after:left-[3px] after:size-[20px] after:rounded-full after:bg-white after:shadow-[0_1px_3px_rgb(0_0_0/0.35)] after:transition-[translate] after:duration-200 checked:after:translate-x-[20px]',
  ].join(' '),
  input: field,
};
