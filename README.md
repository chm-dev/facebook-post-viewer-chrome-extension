# Plain Facebook Post

Chrome extension (Manifest V3). On a Facebook post/photo/video/reel URL it hides the page,
extracts the media + text from the page's embedded data, and replaces the page with a plain
gallery (arrows, swipe, ← → keys, "n / total" counter) and the description. Origin and referer
are unchanged, so fbcdn media loads normally.

## Install
1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open a public post URL while logged out.

Toolbar icon toggles the extension (badge "off" = disabled); the tab reloads.

## How it works
- **Photo list:** the post page lists only some photos (`all_subattachments`, 5 here). The rest
  are discovered by fetching `/photo/?fbid=<id>&set=pcb.<postId>` pages and following
  `nextMediaAfterNodeId` / `prevMediaBeforeNodeId`. Fetches need a browser-like `Accept` header,
  otherwise Facebook returns a data-less shell page.
- **Mobile:** with a mobile User-Agent Facebook serves a different page with no embedded data.
  `background.js` installs a `declarativeNetRequest` rule that sends a desktop User-Agent to
  facebook.com (removed when the extension is toggled off).
- **URL:** navigating updates the URL with `history.replaceState` to the current photo's
  `/photo/?fbid=…&set=…` URL; the first photo restores the original post URL.
- If nothing can be extracted within ~6 s the original page is shown untouched.

## Known limits
- Facebook's data format changes often; heuristics live in `scan()` in `content.js`.
- Photo sets are circular on Facebook. Opening a photo URL directly (not via the post) shows the
  set in a rotated order starting from a neighbour of that photo.
- Video-only posts have no navigation; DASH-only videos may show only a poster.
