# Changelog

## 0.4.0 — 2026-09-06

- Added desktop split view with a resizable editor/preview divider, keyboard resizing, and a double-click reset.
- Preview follows unsaved drafts after a 200 ms typing pause (500 ms for notes over 100,000 characters), independently of disk saves.
- Preview updates preserve scroll position; switching between edit and split preserves the editor instance and undo history.
- Narrow screens fall back to edit/preview switching without losing drafts.
- Added code-block copy buttons on hover or keyboard focus, always visible on touch devices, with success/error feedback and a clipboard fallback.
- Added regression coverage for live drafts, resizing, scroll preservation, exact code copying, and clipboard failures.

## 0.3.0 — 2026-09-06

### Improved

- Redesigned the workspace with warmer surfaces, clearer typography, compact toolbars, and consistent light and dark themes.
- Added accessible mobile outline and backlink drawers, a note actions menu, and a visible sign-out control.
- Added outline navigation in reading and editing modes, with source line anchors and proper handling of frontmatter and fenced code.
- Added explicit search loading, empty, and error states.
- Loaded the Markdown editor on demand, reducing the initial JavaScript bundle from approximately 984 KB to 370 KB before compression.
- Updated the README screenshot.

### Fixed

- Creating a note now prompts before replacing an unsaved draft.
- External changes reconcile all open tabs, preserving dirty drafts and displaying conflicts.
- Stale file and search responses no longer replace newer selections or results.
- Signing out with unsaved drafts and replacing conflicting content require an explicit choice.
- Dialogs contain keyboard focus and restore focus when dismissed.
- Editor instances no longer share undo history between different note paths.

### Validation

- 26 Rust tests and 7 frontend unit tests passed.
- 21 desktop/mobile browser tests passed; 5 existing platform-specific cases remain skipped.
- Verified real filesystem background updates and layouts from 320 to 1440 pixels.
