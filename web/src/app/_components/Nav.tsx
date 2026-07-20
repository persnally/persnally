"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { GithubIcon } from "@/components/ui/logos";

const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;
const GITHUB = "https://github.com/persnally/persnally";

/* Sticky nav: borderless while at rest at the top of the page; the hairline
   appears once content actually scrolls beneath it. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 border-b bg-paper/90 backdrop-blur-sm transition-colors duration-300 ${
        scrolled ? "border-ink/20" : "border-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <Link href="/" aria-label="Persnally home" className="transition-opacity hover:opacity-70">
          <span className="font-display text-[22px] tracking-tight text-ink">
            persnally<span className="text-electric">.</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-7 font-mono text-[12px] uppercase tracking-[0.12em] text-mute md:flex">
          <a href="#how" className="transition-colors hover:text-ink">
            How it works
          </a>
          <a href="#ask" className="transition-colors hover:text-ink">
            Ask it
          </a>
          <a href="#trust" className="transition-colors hover:text-ink">
            Your data
          </a>
          <a href="#pricing" className="transition-colors hover:text-ink">
            Pricing
          </a>
          <a href={GITHUB} {...EXT} className="flex items-center gap-1.5 transition-colors hover:text-ink">
            <GithubIcon className="size-3.5" />
            GitHub
          </a>
        </nav>
        <a
          href="#start"
          className="inline-block rounded-[2px] bg-electric px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-paper transition-colors hover:bg-electric-deep"
        >
          Get started
        </a>
      </div>
    </header>
  );
}
