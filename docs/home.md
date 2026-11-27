# Home

Home is ORBIT's landing view: the page at `/` (and `/#home`), first in the page links, right before Assistant. It is a
simplified way to talk to the **same** persistent Assistant conversation (`docs/assistant.md`). It is not a new thread,
session, model mode or API: it sends with the Assistant's composer to `POST /assistant/messages` and reads
`GET /assistant`, exactly as the Assistant does.

## What it shows

- **The newest reply only.** The Assistant's newest stored message, when it is the Assistant's: finished, failed or still
  being written (a pending reply reads "Working…", as in the Assistant). No history list and no user-message bubbles. If the
  newest stored message is a prompt whose reply is not stored yet (sent from another device), Home says a reply is in
  progress (or that the message has no reply yet) and never shows the older reply as if it answered it. With no reply at all
  it shows a one-line idle note.
- **The same composer and status line** as the Assistant (`#aform`, `#astatus`): photos, Enter-to-send, the
  "Waiting for the reply…" and "A reply is in progress on another tab or device" states, error messages (as an alert), and the
  guard that pauses Send while a reply is running. There is one composer, so one draft and one photo tray for both views.
- **The newest reply's own parts**: confirmation cards (Confirm and Cancel), photo galleries, attached photos, warnings,
  errors and the Details footer, drawn by the Assistant's existing code (`assistantParts`, `showProposal`, safe Markdown).
  Nothing about approval or execution changes.
- **The Conversation state region** (`conversationState` in `src/web/index.html`): a small reusable region, the foundation for
  images, timelines, next steps and links to files or images. It takes structured items (`{ kind, label, href? }`, kinds
  `image`, `timeline`, `next`, `file`, `link`), writes every label as text and keeps a link only when it stays on this page.
  In this first pass nothing feeds it, so it shows its quiet empty state ("Nothing to show yet."). It never infers anything
  from reply text, calls a model or stores anything.
- Warnings about the conversation itself (kept in memory only, unreadable stored files) show on Home as on the Assistant.
  The Assistant's task-attention strip, the context divider and "Load earlier messages" are Assistant-only. (Whether Home
  should also show tasks that need attention is an open product question; for now they are seen on `/#assistant`.)
- Since Home, a task-attention update that arrives while this page's own send is waiting no longer redraws the
  conversation at once (that redraw dropped the "Working…" bubble, on the Assistant too); the strip catches up with the
  draw that shows the send's answer.

## How it works

Home is a presentation of the Assistant's own conversation element (`#alog`), not a copy: the page draws the conversation
once (`drawAssistant`), marks the node of the newest reply (`data-latest`, chosen by `homeLatest`), and on Home CSS shows
only that node, Home's own parts (`.homeonly`) and the conversation warnings. Hiding history is presentation only: nothing
is deleted or rewritten, and the Assistant (`/#assistant`) shows the full retained transcript, including every prompt sent
from Home. Because the same nodes and the same send state serve both views:

- a reply in flight is not repeated, lost or swapped when moving between Home and the Assistant (one request, one
  "Working…" bubble, replaced by the stored reply in both);
- a card or gallery exists once on the page, so it cannot be confirmed twice from two copies;
- the Assistant's scroll position is kept across a visit to Home (a reader at the newest message comes back to the newest);
- while this page's own send waits, a poll answer that does not hold that turn yet never puts the previous reply back on
  Home: Home says a reply is in progress until the turn is drawn.

The sidebar, its project selection, the side panel and the header are shared by every view, so they are the same on Home and
the Assistant at every width. Home, like the Assistant, is owner only: for anyone else the Home and Assistant links hide and
`/` falls back to Sessions.

## Narrow screens

The header now has four page links. At 360 px and below they use slimmer padding and the small text size so all four and the
sidebar's menu button still share one row (checked at 320 px by `test/app-shell-browser.test.ts`, and at 360 px by
`test/sessions-nav-browser.test.ts`).

Between 561 px and 699 px (short landscape phones such as 568×320, and small tablets) the links share the top row with the
brand and the theme button, so they use the same slimmer padding. Home, the Assistant and Jobs keep a one-row header there
(57 px at 568×320, as before Home was added; checked at 568×320, 600×360 and 667×375 by `test/app-shell-browser.test.ts`).
On Sessions below about 640 px the open session's title moves to its own row under the links instead of squeezing beside them,
which makes that header two rows (99 px at 568×320, the same as before Home was added; from about 600 px to 640 px it was one row
before the fourth link); the session picker stays on screen.

## Addresses

`/` with no fragment, or a fragment that names no page, opens Home; `/#home` does too (`/sessions#home` moves to `/#home`).
Every other address is unchanged: `/#assistant`, `/#jobs` and `/#jobs/<id>`, `/#plan`, `/#gallery`, `/sessions` and
`/sessions/<id>`, and the legacy `#chat` forms. Back/Forward and reload keep the view; the logo still reloads the page the
reader is on. There is no separate sign-in redirect in ORBIT's page: after the ChatGPT sign-in in the header, and on any
fresh open of `/`, the page is Home.

## Tests

`test/home-page.test.ts`. Always run: the routing table, the page-link order, `homeLatest` and `conversationState` (empty
state, no sample data, text-only labels, same-page links only). In Playwright's Chromium against a scripted fake of ORBIT's
routes (skipped without Playwright): Home as the default with the menu order; deep links, reload, Back/Forward and the
logo; consecutive sends from Home showing only the newest reply while the Assistant keeps every turn, also after a reload; a
send held open across switches (one request, no duplicate, draft kept); a reply in progress from another device; a refused
send; a card and a gallery on the newest reply, present once and confirmed once; sidebar and project parity at desktop and
320 px; the kept scroll position; and a non-owner falling back to Sessions.

Not covered automatically: a real model streaming into a pending reply (the fake stores the reply when released), real
iPhone Safari, and screen-reader output. Manual checks on a deployed ORBIT, as the owner:

1. Open `/`: Home is selected, first in the links; the newest Assistant reply shows with no history; the Conversation state
   region says "Nothing to show yet."
2. Send a message from Home, switch to the Assistant while "Working…" shows, then back: one prompt, one reply.
3. Open `/#assistant`: the prompt sent from Home is in the transcript.
4. On a phone, open the sidebar from Home and from the Assistant, pick a project in one and check the other.
