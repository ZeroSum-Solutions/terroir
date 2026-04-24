/** Milliliters per US fluid ounce. */
export const ML_PER_OZ = 29.5735;

/** Convert ml → oz (plain division; caller rounds/formats). */
export const mlToOz = (ml: number): number => ml / ML_PER_OZ;

/** Convert oz → ml, rounded to the nearest whole ml (matches the UI's input coercion). */
export const ozToMl = (oz: number): number => Math.round(oz * ML_PER_OZ);
