# Changelog

## 0.6.0 — 2026-10-02

- Redesigned the workspace as a private editorial library: a Library home with shortcuts to real notes, warm reading surfaces, a new brand mark and favicon, and refreshed light and dark themes.
- Focus mode hides the sidebar, tabs, and context panel for distraction-free reading, editing, or split view; press Escape or the focus button to return.
- Redesigned login page with the existing passkey, username, and 30-day sign-in options.
- Library returns to the home tab without closing open drafts; empty tabs are named "Library", including for screen readers.
- Keyboard and screen-reader improvements: a skip link, arrow-key navigation between tabs, and focus kept inside the mobile file drawer and context overlay.
- Fixed the preview being rebuilt on every workspace update, which discarded focus, text selection, and code-copy feedback.
- The decorative sidebar text is hidden on screens 860px tall or less so the file tree keeps its room.
- Opening a note in preview now keeps the top margin when the document begins with frontmatter.

## 0.5.0 — 2026-10-01

- Passkey login compatible with bookmarkd: point `--passkey-db` at a copy of bookmarkd's `auth.db` (or the shared file) and set `--public-url`; passkeys registered for the shared RP ID sign in without re-registration. Verification uses bookmarkd's own `bookmarkd-auth` crate.
- **Keep me signed in for 30 days** on the login page (password and passkey). Without it, sessions end with the browser and expire after 12 hours. Sessions are now stored as token hashes in `--data-dir`, so restarts and updates no longer sign users out; changing the login settings or revoking a passkey ends the affected sessions.
- Optional `--username` / `OBSIDIAN_WEB_USERNAME`; when set, the login page asks for a username and password. Without it the login page is unchanged.
- In-app updates: check GitHub Releases manually or on a daily/weekly schedule, read release notes, and install with checksum and version verification, in-place restart, and `obsidian-web update check|install|rollback` on the command line.
- Security: with `--no-auth`, only `localhost`, `*.localhost`, and IP-literal `Host` headers are accepted, and a browser `Origin` must match, blocking DNS-rebinding access to the Vault.
- Renaming a note keeps its `.md` extension; case-only renames now work on case-insensitive filesystems; folders cannot be moved inside themselves.
- Folders can be renamed, moved, and moved to trash from a menu in the sidebar.
- The search index updates only the changed paths instead of rebuilding the whole Vault after each write; the UI no longer refetches the file tree after every save and coalesces refresh bursts.
- Editor highlighting uses the app palette in both color schemes, without underlined headings, and highlights YAML frontmatter.
- Search runs while typing; open tabs and the split ratio are restored after a reload (drafts are not persisted, and signing out clears the saved tabs).
- Smaller UI fixes: platform-correct shortcut labels, hidden zero counts on attachment-only folders, a Browse files button on the mobile start screen, accurate connection wording on the login screen, and Escape no longer closes panels when the editor uses it.

## 0.4.1 — 2026-09-06

- Preserve the visible content position when switching between edit, preview, and split modes using Markdown source-line anchors.
- Restore positions within wrapped editor lines and rendered blocks, and keep the document bottom anchored across mode changes.
- Reconcile late-loading preview images until the user interacts with the preview; new notes start at the top.
- Added desktop and mobile regression tests for mid-document, bottom-of-document, and file-switch behavior.

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
