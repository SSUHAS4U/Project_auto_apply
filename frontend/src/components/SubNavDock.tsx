import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Icon } from './Icon';

/**
 * The floating sub-navigation dock.
 *
 * Replaces the vertical list the sidebar used to expand under each module. That list pushed
 * everything below it down, so opening Auto Apply moved Jobs, Documents and Applications —
 * you had to re-find the thing you were aiming at. A dock sits above the page instead of
 * inside the layout, so nothing reflows when it appears.
 *
 * It is deliberately a NAVIGATION change only. Every route, every page and every handler is
 * untouched: these are the same <NavLink>s to the same paths that were in the sidebar, moved
 * and restyled. Nothing about how a page works can change, because nothing about a page was
 * edited.
 */

export type DockItem = { to: string; label: string; ico: string; end?: boolean };

export function SubNavDock({ items }: { items: DockItem[] }) {
  const { pathname } = useLocation();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // The sliding highlight, positioned from the real DOM rather than from an index. Computing
  // it as `index * width` breaks the moment an icon is a different size or the dock wraps —
  // measuring the actual element is the version that survives a style change.
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);

  // Which item is active. Matched here rather than relying on NavLink's own class, because the
  // highlight has to know WHICH element to measure, not merely that one of them is active.
  const activeIndex = items.reduce((best, item, i) => {
    const isMatch = item.end ? pathname === item.to : pathname.startsWith(item.to);
    if (!isMatch) return best;
    // Longest match wins: /auto-apply and /auto-apply/linkedin both prefix-match the second
    // path, and without this the highlight would sit on "Setup" while LinkedIn was open.
    const bestLen = best < 0 ? -1 : items[best].to.length;
    return item.to.length > bestLen ? i : best;
  }, -1);

  // useLayoutEffect, not useEffect: measuring after paint makes the pill visibly jump into
  // place on first render. This positions it before the browser draws.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || activeIndex < 0) { setPill(null); return; }
    const el = wrap.children[activeIndex] as HTMLElement | undefined;
    if (!el) { setPill(null); return; }
    setPill({ x: el.offsetLeft, w: el.offsetWidth });
  }, [activeIndex, items]);

  // Re-measure when the window resizes. Without this the highlight is stranded at its old
  // offset after a resize while the icons have moved underneath it.
  useEffect(() => {
    const onResize = () => {
      const wrap = wrapRef.current;
      const el = wrap?.children[activeIndex] as HTMLElement | undefined;
      if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    // aria-label, because a bar of unlabelled glyphs is unusable with a screen reader and
    // "i" for Indeed is not guessable even visually.
    <nav className="dock" aria-label="Section navigation">
      <div className="dock-inner" ref={wrapRef}>
        {pill && (
          // The highlight is one element that MOVES, not a class on each item. That is what
          // makes Setup -> LinkedIn glide sideways instead of blinking from one to the other.
          <span
            className="dock-pill"
            style={{ transform: `translateX(${pill.x}px)`, width: pill.w }}
            aria-hidden="true"
          />
        )}
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) => `dock-item ${isActive ? 'is-active' : ''}`}
            title={it.label}
            aria-label={it.label}
          >
            <Icon name={it.ico} size={17} />
            <span className="dock-dot" aria-hidden="true" />
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
