// Drives the Sessions page's header session picker (src/web/index.html) from Playwright tests: the session button opens
// a picker holding New session, the list of sessions, Show archived, and Rename / Archive for the open session.

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function openSessionPicker(p: any): Promise<void> {
  if ((await p.getAttribute("#sessbtn", "aria-expanded")) !== "true") await p.click("#sessbtn");
  await p.waitForSelector("#sesspicker:not([hidden])");
}
// Picks a session from the picker, as a reader would (the picker closes and the session opens).
export async function pickSession(p: any, id: string): Promise<void> {
  await openSessionPicker(p);
  await p.click(`#sesslist .sitem[data-id="${id}"]`);
}
// Clicks one of the picker's actions: "#tnew" (New session), "#trename" or "#tarchive" (Archive / Restore).
export async function sessionAction(p: any, selector: string): Promise<void> {
  await openSessionPicker(p);
  await p.click(selector);
}
// The page's own addresses (the fake servers serve the page at each of them, as ORBIT does).
export const isPagePath = (pathname: string): boolean => pathname === "/" || pathname === "/sessions" || /^\/sessions\/[^/]{0,200}$/.test(pathname);
