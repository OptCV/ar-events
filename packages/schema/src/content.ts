/**
 * Canonical geometry of built-in content (Phase 3 M11, ADR-029). The editor draws these, and the P4 compilers must
 * produce the same sizes. All are centred on the node origin, standing in the node's XY plane and facing +Z, before
 * the node transform; meters.
 */

/** Shapes are 1 m unit shapes; their size comes from the node scale. box 1×1×1; sphere Ø 1; cylinder Ø 1 × 1 along +Y; plane 1×1 in XY. */
export const PRIMITIVE_UNIT_METERS = 1;
export const PRIMITIVE_DEFAULT_COLOR = '#9aa5b1';
/** New shapes start at 20 cm (scale 0.2). */
export const PRIMITIVE_START_SCALE = 0.2;

/** Text: `style.sizeMeters` is the height of one line box; lines are centred; width follows the text. */
export const TEXT_DEFAULTS = { text: 'Your text', color: '#17202a', sizeMeters: 0.05 } as const;

/** Panels: a white card of this width; height follows the title and body. */
export const PANEL_WIDTH_METERS = 0.3;
export const PANEL_DEFAULTS = { title: 'Title', body: 'Write something here.' } as const;
