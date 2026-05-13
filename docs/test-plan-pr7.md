# Test Plan — PR #7 (responsive 3-pane shell + chapter summary + pagination + cache)

## Scope (what changed)

- `<html>` / `<body>` are now `h-full overflow-hidden`; ThreadShell is `h-dvh overflow-hidden`. Each pane scrolls internally so the chat composer stays glued to the bottom regardless of how tall the working plan card grows.
- Below `lg` (1024px): the desktop 3-col grid is replaced with a top app bar (hamburger + Chat/Read tabs). FileTree becomes a slide-in drawer; selecting a chapter or lesson auto-switches to Read.
- Viewer has three modes:
  - **Lesson** — markdown body + prev/next footer cards across the whole syllabus + `idx/total` counter in the breadcrumb.
  - **Chapter summary** (NEW) — chapter title + ordered lesson list with first-paragraph previews.
  - **Syllabus overview** — chapter cards (default).
- New `lesson_cache: Record<lessonId, content>` Zustand slice. Hydrated from `/api/threads/:id/snapshot` on mount. Lesson view reads cache first, falls back to snapshot row, never refetches the DB. Cleared only on hard reload.
- FileTree caret toggle separated from chapter title. Title click routes to chapter summary.

## Test environment

- Reusable populated thread: `http://localhost:3000/threads/c965ad20-5d68-4474-bcff-1735e5485a7f` (6 chapters, 18 lessons, all committed).
- `pnpm web:dev` on :3000, `pnpm api:dev` on :3001 already running. Snapshot endpoint serving 200.

## Primary flow (one continuous recording, ~90s)

### A. Desktop — sticky composer + chapter summary + pagination + cache

A1. Open the thread URL at desktop width (≥1280px). Verify:
- ✅ FileTree (left), ChatPane (center), Viewer (right) all visible — three columns.
- ✅ Composer input is visible at the bottom edge of the chat column, NOT pushed off-screen.
- ✅ The page itself does not scroll (no body scrollbar) — only inner panes scroll.

A2. Click the **Working plan** card header in the chat to expand it (so all 18 lessons render). Verify:
- ✅ The composer remains pinned to the bottom of the viewport.
- ✅ The chat column has its own scrollbar; scrolling it does NOT move the FileTree or Viewer.
- ❌ **Failure mode:** if PR #7 isn't applied, the composer scrolls off-screen as the working plan grows.

A3. In the FileTree, click the **chapter title** "Mathematical Foundations for Machine Learning" (NOT the caret). Verify:
- ✅ Right pane switches to **chapter summary** mode.
- ✅ Header reads `Machine Learning… › Mathematical Foundations for Machine Learning`.
- ✅ A list of 3 lesson cards renders, each with a number badge (1/2/3), title, and a non-empty first-paragraph preview.
- ❌ **Failure mode:** if PR #7 isn't applied, the click would only toggle expand/collapse of the chapter (no right-pane change).

A4. Click the FIRST lesson card in the chapter summary ("Linear Algebra Essentials"). Verify:
- ✅ Right pane switches to **lesson view** with markdown headings.
- ✅ Breadcrumb shows position counter `4/18` (chapter 2, lesson 1 across the syllabus).
- ✅ Footer shows two pagination cards: `Previous · Introduction to Machine Learning… › Real-World Applications…` and `Next · Mathematical Foundations… › Calculus and Optimization`.

A5. Open Chrome DevTools → Network → filter `snapshot`. Click the **Next** pagination card. Verify:
- ✅ Right pane updates to "Calculus and Optimization", counter `5/18`.
- ✅ Network tab shows ZERO new `/api/threads/.../snapshot` requests fired.
- ❌ **Failure mode:** without the cache slice the lesson swap would still work (snapshot already has content) but I'm verifying the cache hit path explicitly. A fresh `snapshot` request on every click would prove the cache is bypassed.

A6. Click **Previous** twice. Verify:
- ✅ Lands on "What is Machine Learning?" (counter `1/18`); Previous button is hidden, Next still present.
- ✅ Still no network requests fired.

### B. Mobile — drawer + tabs (one continuous portion of the same recording)

B1. Toggle Chrome's device toolbar (Ctrl+Shift+M) and pick **iPhone 14** (390×844). Reload. Verify:
- ✅ A new top app bar appears with: hamburger icon, syllabus title + thread short id, and a `Chat` / `Read` tab toggle.
- ✅ Only ONE pane is visible at a time (default: Chat).
- ✅ Composer input is visible at the bottom of the viewport.

B2. Tap the hamburger icon. Verify:
- ✅ FileTree slides in from the left as a drawer overlay with a dim backdrop covering the rest of the screen.
- ✅ Tapping the backdrop closes the drawer with a slide-out animation.

B3. Open the drawer again, tap the chapter title "Supervised Learning Algorithms". Verify:
- ✅ Drawer closes automatically.
- ✅ Active tab switches from `Chat` to `Read` automatically.
- ✅ Right pane shows the chapter summary for "Supervised Learning Algorithms".
- ❌ **Failure mode:** if `useEffect` watching `activeChapterId` was missing, the user would still see the chat (no auto-switch) and have to manually tap the Read tab.

B4. Tap the first lesson card ("Regression Techniques"). Verify:
- ✅ Lesson view renders with markdown.
- ✅ Counter shows `7/18` in the breadcrumb.
- ✅ Footer prev/next pagination cards stack vertically (single column on mobile).

B5. Tap the `Chat` tab. Verify:
- ✅ Chat pane reappears with full transcript.
- ✅ Read pane is hidden (single-pane).
- ✅ Composer is still pinned to the bottom of the viewport (mobile keyboard area is reserved by `h-dvh`).

## Concrete pass/fail summary

| # | Assertion | Pass criteria | Fails if |
|---|---|---|---|
| A1 | Three-column desktop, no body scroll | All panes visible; `document.body.scrollHeight === window.innerHeight` | Body has its own scrollbar, panes overflow page |
| A2 | Sticky composer w/ working plan expanded | Composer at bottom; chat scroll independent | Composer scrolls off; page-level scrollbar |
| A3 | Chapter-title click → chapter summary | Right pane shows N lesson cards w/ previews | Right pane unchanged; only caret expands |
| A4 | Pagination cards present | Footer shows prev+next w/ chapter+title | No nav element below lesson body |
| A5 | Cache hit on lesson swap | 0 new `snapshot` requests in Network | Fresh request on every lesson click |
| A6 | Position counter correct | `1/18` for first lesson, `18/18` for last | Counter wrong or missing |
| B1 | Mobile app bar + tabs at <1024px | Hamburger + Chat/Read tabs visible | Desktop 3-col still showing |
| B2 | Drawer open/close | Slide-in transform; backdrop dismisses | No drawer or no backdrop |
| B3 | Auto-switch to Read on selection | Drawer closes, tab=Read, summary visible | User stuck on Chat tab |
| B4 | Mobile lesson view | Single-pane lesson; pagination stacks | Layout broken, content cut off |
| B5 | Mobile composer pinned | Composer at bottom of viewport | Composer hidden or off-screen |

## Out of scope

- Triggering the agent end-to-end (already proven in PR #4 testing report).
- Realtime DELETE / chapter race (proven in PR #3).
- Visual color regression (proven in PR #6 screenshots).
