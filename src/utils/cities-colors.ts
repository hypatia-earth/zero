/**
 * Host-side mapping from named cities color (dialog presentation) to the
 * RGB triplet aurora persists. Aurora is color-name-agnostic — the worker
 * sees `[r,g,b]` only. Both the dialog and aurora-service share this
 * dictionary so name → RGB stays consistent.
 *
 * The named-color enum is presentation-only post-F-A; aurora's schema
 * persists the RGB triplet directly. The chip metadata in
 * `auroraOptionsSchema.layers.cities.opts.color._meta.options` carries the
 * same named values for the dialog's chip selector.
 */

export type CityColorName = 'white' | 'black' | 'darkred' | 'gold';

export const CITY_COLORS_RGB: Record<CityColorName, [number, number, number]> = {
  white:   [1, 1, 1],
  black:   [0, 0, 0],
  darkred: [0.55, 0.05, 0.05],
  gold:    [0.85, 0.65, 0.13],
};

/** Find a named cities color whose RGB matches `rgb`, or undefined. */
export function nameForCityRgb(rgb: readonly number[]): CityColorName | undefined {
  for (const [name, val] of Object.entries(CITY_COLORS_RGB)) {
    if (val[0] === rgb[0] && val[1] === rgb[1] && val[2] === rgb[2]) {
      return name as CityColorName;
    }
  }
  return undefined;
}
