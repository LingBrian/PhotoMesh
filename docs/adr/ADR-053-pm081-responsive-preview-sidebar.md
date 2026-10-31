# ADR-053: PM-081 responsive preview sidebar and keyboard access

## Status

Implemented in the existing Web preview dialog; no media or API behavior changes.

## Decision

The preview is a modal dialog with a labeled media stage and a labeled metadata/editor sidebar. Desktop uses a two-column layout; narrow viewports stack the stage above the sidebar. The dialog preserves the invoking asset-card focus on close, supports previous/next photo navigation, and uses explicit accessible names, live status/error regions, alternative text, and read-only original indicators.

Keyboard handling now closes on Escape, navigates with Left/Right arrows when focus is not in an editor control, and traps Tab/Shift+Tab within visible dialog controls. Focused controls remain available on narrow layouts; CSS media rules avoid horizontal overflow and retain usable navigation targets.

## Acceptance

- dialog has modal semantics, accessible labels, status/error announcements, and image alt text;
- opening and closing preserves focus; Escape and keyboard navigation work;
- Tab focus does not escape the dialog while open;
- desktop and narrow layouts retain media, metadata, and editor controls without horizontal overflow;
- no original bytes are modified or written by the UI slice.
