# ADR-054: PM-082 responsive, DPI, and high-contrast adaptation

## Status

Implemented as a CSS-only Web/Windows adaptation; no media, API, or persistence changes.

## Decision

The shell uses fluid `clamp()` spacing/typography, bounded grid/flex tracks, `min-width: 0`, and narrow breakpoints that stack controls and keep touch targets operable. The preview already switches from desktop two-column to narrow stacked layout. The page prevents accidental horizontal overflow while allowing intentional inner scrollers for timeline, metadata, and version lists.

Windows High Contrast/forced-colors mode maps surfaces, text, borders, links, highlights, and focus indicators to system colors and removes decorative shadows so controls remain distinguishable. Reduced-motion users receive effectively disabled transitions/animations and non-smooth scrolling. CSS pixels are used throughout, so Windows DPI scaling is handled by the platform without bitmap-sized layout assumptions.

## Acceptance

- narrow viewport layouts do not require horizontal page scrolling;
- controls retain visible focus and usable touch targets;
- forced-colors mode has system-color borders, text, surfaces, and focus;
- reduced-motion mode does not rely on animation to communicate state;
- no original file is edited or written by these presentation changes.
