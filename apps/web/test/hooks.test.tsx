import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTabAvoidance } from "../src/hooks";

// The AIDA tab occupies a 48px-wide region at the bottom-right; when an element
// overlaps it the hook returns 48 + 14 = 62 px of avoidance, otherwise 0.
const AVOID_PX = 62;

type Rect = Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">;

function rect(r: Rect): DOMRect {
  return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
}

/** A fake element whose bounding box we fully control. */
function fakeEl(r: DOMRect): HTMLElement {
  return { getBoundingClientRect: () => r } as unknown as HTMLElement;
}

async function fireResize() {
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    // let the rAF scheduled by the hook's onChange handler run
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe("useTabAvoidance", () => {
  it("defaults to 0 avoidance and exposes a ref", () => {
    const { result } = renderHook(() => useTabAvoidance<HTMLDivElement>());
    expect(result.current.avoid).toBe(0);
    expect(result.current.ref).toHaveProperty("current");
  });

  it("returns avoidance when the element overlaps the bottom-right tab", async () => {
    const { result } = renderHook(() => useTabAvoidance<HTMLDivElement>());
    const w = window.innerWidth;
    const h = window.innerHeight;
    // A box anchored to the bottom-right corner overlaps the tab region.
    result.current.ref.current = fakeEl(
      rect({ left: w - 60, right: w, top: h - 60, bottom: h, width: 60, height: 60 }),
    );

    await fireResize();
    expect(result.current.avoid).toBe(AVOID_PX);
  });

  it("returns 0 when the element sits far from the tab", async () => {
    const { result } = renderHook(() => useTabAvoidance<HTMLDivElement>());
    result.current.ref.current = fakeEl(
      rect({ left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10 }),
    );

    await fireResize();
    expect(result.current.avoid).toBe(0);
  });

  it("recomputes as the element moves in and out of the tab region", async () => {
    const { result } = renderHook(() => useTabAvoidance<HTMLDivElement>());
    const w = window.innerWidth;
    const h = window.innerHeight;

    result.current.ref.current = fakeEl(
      rect({ left: w - 40, right: w, top: h - 40, bottom: h, width: 40, height: 40 }),
    );
    await fireResize();
    expect(result.current.avoid).toBe(AVOID_PX);

    // move it away → avoidance snaps back to 0
    result.current.ref.current = fakeEl(
      rect({ left: 0, right: 20, top: 0, bottom: 20, width: 20, height: 20 }),
    );
    await fireResize();
    expect(result.current.avoid).toBe(0);
  });
});
