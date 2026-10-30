/**
 * Leave-page guard for in-app navigation. Routing is by hash, so a link
 * click or the back button has already changed the address by the time App
 * hears about it; a page holding unsaved work registers a guard, and App asks
 * it before following the change. A guard that blocks puts the address back
 * (without a history entry or another hashchange) and typically opens its
 * own "leave without saving?" dialog, finishing with leaveTo().
 */

/** Decides on a pending navigation: true blocks it (the guard takes over), false lets it through. */
export type LeaveGuard = (nextHash: string) => boolean

let guard: LeaveGuard | null = null
let lastHash = window.location.hash

/** Installs (or with null, removes) the active page's guard. */
export function setLeaveGuard(next: LeaveGuard | null): void {
  guard = next
}

/**
 * Called on every hashchange: true when the page should follow the new
 * address, false when the guard kept the user where they were.
 */
export function allowHashChange(): boolean {
  const next = window.location.hash
  if (next !== lastHash && guard?.(next)) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}${lastHash}`)
    return false
  }
  lastHash = next
  return true
}

/** Navigates past the guard, once the user has chosen to leave. */
export function leaveTo(hash: string): void {
  guard = null
  window.location.hash = hash
}
