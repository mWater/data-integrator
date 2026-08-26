import type { LocalizeString } from "ez-localize"

declare global {
  /**
   * Translate a string in the active locale. Always used as a tagged template,
   * e.g. T`Ran ${count} jobs`. Assigned by applyLocale before the first render.
   */
  const T: LocalizeString
}

export {}
