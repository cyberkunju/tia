import { useEffect, useRef, useState } from "react";

// The AIDA launcher occupies this bottom-right region (px). Keep in sync with AppShell.
const TAB_W = 48;
const TAB_H = 165;
const GAP = 14;

/**
 * Dynamic collision avoidance with the bottom-right AIDA tab.
 * Returns a ref + an `avoid` px value that is non-zero ONLY while the element's
 * bottom-right actually overlaps the tab. Recomputes on any scroll/resize, so the
 * element shifts when it would collide and snaps back when it no longer does.
 */
export function useTabAvoidance<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [avoid, setAvoid] = useState(0);

  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const tabLeft = window.innerWidth - TAB_W;
      const tabTop = window.innerHeight - TAB_H;
      const overlaps = r.right > tabLeft && r.bottom > tabTop && r.top < window.innerHeight;
      setAvoid(overlaps ? TAB_W + GAP : 0);
    };
    const onChange = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", onChange, true); // capture: catch nested scrollers
    window.addEventListener("resize", onChange);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
    };
  }, []);

  return { ref, avoid };
}
