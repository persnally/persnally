"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/* Sticky nav: borderless while at rest at the top; the hairline appears once
   content scrolls beneath it.

   Scrolling down condenses the bar to the mark alone, centred — reading gets the
   full width back. Scrolling up restores it, so navigation is always one gesture
   away without ever being dismissed outright.

   The mark genuinely travels rather than cross-fading between two bars: the
   distance to centre is measured once and applied as a transform, so nothing
   reflows mid-animation and the movement stays on the compositor. */

const CONDENSE_AFTER = 96; // px — above this the bar is always full, so the top of the page is never condensed
const NAV_LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#trust", label: "Trust" },
  { href: "#pricing", label: "Pricing" },
];

const DIRECTION_NOISE = 4; // px — ignore sub-pixel jitter and trackpad rubber-banding

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [condensed, setCondensed] = useState(false);
  const [shift, setShift] = useState(0);

  const barRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const condensedRef = useRef(false);
  /* The mark's resting centre, relative to the bar. Cached because it can only
     be read while no transform is applied. */
  const restingCentre = useRef<number | null>(null);

  /* How far the mark must travel to sit dead centre of the bar.
     Both measurements come from the same origin — the bar's own box. An earlier
     version mixed offsetLeft with clientWidth, whose origins differ by the bar's
     horizontal padding, and the mark landed exactly one padding off centre. */
  const measure = useCallback(() => {
    const bar = barRef.current;
    const mark = markRef.current;
    if (!bar || !mark) return;
    const b = bar.getBoundingClientRect();
    if (!condensedRef.current) {
      const m = mark.getBoundingClientRect();
      restingCentre.current = m.left + m.width / 2 - b.left;
    }
    if (restingCentre.current === null) return;
    setShift(b.width / 2 - restingCentre.current);
  }, []);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (barRef.current) ro.observe(barRef.current);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    condensedRef.current = condensed;
  }, [condensed]);

  useEffect(() => {
    let last = window.scrollY;
    let frame = 0;

    const read = () => {
      frame = 0;
      const y = window.scrollY;
      setScrolled(y > 8);

      const delta = y - last;
      if (Math.abs(delta) < DIRECTION_NOISE) return;
      last = y;
      // Near the top there is nothing to reclaim, so stay full regardless of
      // direction — otherwise a short flick at the top flickers the bar.
      setCondensed(y > CONDENSE_AFTER && delta > 0);
    };

    // Scroll fires far faster than paint; coalescing to one read per frame keeps
    // this off the critical path.
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };

    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Everything eases on one curve and one duration so the parts read as a single
  // movement rather than several animations that happen to overlap.
  const ease = "cubic-bezier(0.22, 1, 0.36, 1)";
  const move = `transform 620ms ${ease}, opacity 380ms ${ease}`;

  return (
    <header
      className={`sticky top-0 z-50 border-b bg-paper/90 backdrop-blur-sm transition-colors duration-300 ${
        scrolled ? "border-ink/20" : "border-transparent"
      }`}
    >
      <div
        ref={barRef}
        className="relative mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6"
      >
        <Link
          href="/"
          aria-label="Persnally home"
          className="nav-morph flex items-center gap-2.5 transition-opacity hover:opacity-70"
          style={{ transform: `translateX(${condensed ? shift : 0}px)`, transition: move, willChange: "transform" }}
        >
          <span ref={markRef} className="block size-[30px] shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/persnally-mark.svg" alt="" aria-hidden width={30} height={30} className="size-[30px]" />
          </span>
          {/* Collapses its own width as it goes, so the mark lands exactly centred
              instead of centring the pair and looking a few pixels off. */}
          <span
            className="nav-morph overflow-hidden whitespace-nowrap font-display text-[22px] tracking-tight text-ink"
            style={{
              maxWidth: condensed ? 0 : 220,
              opacity: condensed ? 0 : 1,
              transition: `max-width 620ms ${ease}, opacity 300ms ${ease}`,
            }}
          >
            persnally<span className="text-electric">.</span>
          </span>
        </Link>

        <nav
          className="nav-morph hidden items-center gap-7 font-mono text-[12px] uppercase tracking-[0.12em] text-mute md:flex"
          style={{
            transform: condensed ? "translateY(-8px)" : "none",
            opacity: condensed ? 0 : 1,
            transition: move,
            pointerEvents: condensed ? "none" : undefined,
          }}
          aria-hidden={condensed}
        >
          {/* pointer-events alone would leave these tabbable while invisible —
              focusable content inside aria-hidden is a WCAG violation, and a
              keyboard user would be tabbing through a bar that isn't there. */}
          {NAV_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="transition-colors hover:text-ink"
              tabIndex={condensed ? -1 : undefined}
            >
              {label}
            </a>
          ))}
        </nav>

        <a
          href="#start"
          className="nav-morph inline-block rounded-[2px] bg-electric px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-paper transition-colors hover:bg-electric-deep"
          style={{
            transform: condensed ? "translateY(-8px)" : "none",
            opacity: condensed ? 0 : 1,
            transition: move,
            pointerEvents: condensed ? "none" : undefined,
          }}
          aria-hidden={condensed}
          tabIndex={condensed ? -1 : undefined}
        >
          Get started
        </a>
      </div>
    </header>
  );
}
