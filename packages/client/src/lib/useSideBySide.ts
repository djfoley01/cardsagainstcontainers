/**
 * Decides whether the landing page should put its two panels side by side.
 *
 * The rule is "stack them unless stacking would need scrolling", which cannot
 * be expressed as a media query: the leaderboard's height depends on how many
 * people are on it, so any hardcoded max-height breakpoint would be wrong as
 * soon as a fourth player won a round.
 *
 * So it measures instead. The trick that keeps it stable is measuring the
 * *stacked* height even while laid out in a row — the sum of the two panels'
 * own heights plus the gap. That figure does not depend on the current mode,
 * so the decision cannot feed back into itself and oscillate.
 *
 * A hysteresis margin covers the residual wobble: panels reflow slightly
 * narrower in a row, so the two measurements are close but not identical, and
 * without a deadband a window dragged to exactly the threshold would flicker.
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface FitOptions {
  /** Below this width, always stack: two columns would be unusable. */
  minWidth?: number;
  /** Space taken by anything outside the two panels (header, footer, padding). */
  chrome?: number;
  /** Deadband, in pixels, to stop a drag near the threshold flickering. */
  hysteresis?: number;
}

export interface FitInput {
  viewportWidth: number;
  viewportHeight: number;
  /** Natural height of the first panel. */
  firstHeight: number;
  /** Natural height of the second panel. 0 means there is nothing to place. */
  secondHeight: number;
  /** Whether the panels are currently side by side, for the deadband. */
  current: boolean;
}

/**
 * The decision, separated from the DOM so it can be tested directly.
 *
 * Note the asymmetry: the switch into a row happens as soon as stacking would
 * overflow, but the switch back requires the stack to fit with room to spare.
 * Without that, dragging a window to exactly the threshold flickers.
 */
export function shouldSideBySide(
  { viewportWidth, viewportHeight, firstHeight, secondHeight, current }: FitInput,
  { minWidth = 960, chrome = 220, hysteresis = 48 }: FitOptions = {},
): boolean {
  // Too narrow for two columns, or nothing to put in the second one.
  if (viewportWidth < minWidth || secondHeight === 0) return false;

  const stackedHeight = firstHeight + secondHeight + chrome;
  return current ? stackedHeight > viewportHeight - hysteresis : stackedHeight > viewportHeight;
}

export function useSideBySide(
  first: RefObject<HTMLElement | null>,
  second: RefObject<HTMLElement | null>,
  { minWidth = 960, chrome = 220, hysteresis = 48 }: FitOptions = {},
): boolean {
  const [sideBySide, setSideBySide] = useState(false);

  const measure = useCallback(() => {
    const a = first.current;
    const b = second.current;
    setSideBySide((current) =>
      shouldSideBySide(
        {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          firstHeight: a?.offsetHeight ?? 0,
          secondHeight: b?.offsetHeight ?? 0,
          current,
        },
        { minWidth, chrome, hysteresis },
      ),
    );
  }, [first, second, minWidth, chrome, hysteresis]);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);

    // The panels change height on their own too: a new leader appearing, or an
    // error message showing under the form.
    const observer = new ResizeObserver(measure);
    if (first.current) observer.observe(first.current);
    if (second.current) observer.observe(second.current);

    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [measure, first, second]);

  return sideBySide;
}
