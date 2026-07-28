import { useEffect, useState } from "react";

/**
 * A second-resolution clock, for elapsed times that must visibly move.
 *
 * `useNowMinute` is the right tool for settled-state resolution, where a
 * minute is the natural grain. It is the wrong tool for "Claude working ·
 * 07m 31s", which reads as frozen if it only advances once a minute. The two
 * coexist rather than one replacing the other.
 *
 * The timer stops with the last consumer, so a page with no live run on
 * screen is not re-rendering once a second in the background.
 */
export function useNowMs(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now;
}
