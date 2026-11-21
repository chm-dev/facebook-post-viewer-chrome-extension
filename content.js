(() => {
  "use strict";

  // ---- Is this a single-post URL? -------------------------------------------------
  const POST_PATHS = [
    /\/posts\//, /\/permalink\.php/, /\/story\.php/, /\/photo(\.php|\/)?/, /\/photos\//,
    /\/videos\//, /\/watch\/?$/, /\/reel\//, /\/share\/[pvr]\//, /\/groups\/[^/]+\/(posts|permalink)\//,
    /\/pfbid[0-9A-Za-z]+/
  ];
  const isPost = POST_PATHS.some((re) => re.test(location.pathname)) ||
    /^\/(watch)\/?$/.test(location.pathname) && new URLSearchParams(location.search).has("v");
  if (!isPost) return;

  // ---- Hide the page ASAP to avoid flashing Facebook UI ----------------------------
  const hider = document.createElement("style");
  hider.textContent = "html{visibility:hidden!important;background:#111!important}";
  document.documentElement.appendChild(hider);
  const unhide = () => hider.remove();

  chrome.storage.local.get("enabled").then(({ enabled = true }) => {
    if (!enabled) return unhide();
    start();
  }, unhide);

  // ---- Startup: wait for data, then render ------------------------------------------
  const ORIGINAL_URL = location.href;
  const START_PARAMS = new URLSearchParams(location.search);
  const START_FBID = /^\/photo(\.php)?\/?$/.test(location.pathname) ? START_PARAMS.get("fbid") : null;

  function start() {
    let done = false;
    const attempt = (force) => {
      if (done) return;
      const init = initialState(document);
      if (!init.items.length && !init.text) return;
      // Open Graph only gives a single image; give the real data time to arrive first.
      if (init.ogOnly && !force) return;
      done = true;
      render(init);
    };
    const onReady = () => {
      attempt(false);
      if (done) return;
      const mo = new MutationObserver(() => attempt(false));
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => attempt(true), 2500);
      setTimeout(() => { mo.disconnect(); if (!done) unhide(); }, 6000);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onReady, { once: true });
    else onReady();
  }

  // ---- Data extraction --------------------------------------------------------------
  const CDN = /^https:\/\/[^/]*(fbcdn\.net|fbsbx\.com)\//;
  const SKIP_KEYS = /comment|feedback|related|reaction|suggest|sponsor|profile_picture|actors|owner|page_logo|emoji/i;
  const IMG_KEYS = ["photo_image", "viewer_image", "image", "large_share_image", "fullscreen_image"];

  /** Scan the embedded Relay JSON of a (live or parsed) Facebook document. */
  function scan(doc) {
    const photos = new Map();   // id -> {uri, area}
    const videos = new Map();   // id -> {src, poster}
    const texts = [];
    let order = null, count = 0, nextId = null, prevId = null;

    for (const s of doc.querySelectorAll('script[type="application/json"]')) {
      const t = s.textContent;
      if (!t || t.length < 50) continue;
      let json;
      try { json = JSON.parse(t); } catch { continue; }
      walk(json, 0, null);
    }

    function walk(node, depth, parentType) {
      if (!node || typeof node !== "object" || depth > 60) return;
      if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1, parentType); return; }

      const type = node.__typename;
      if (type === "Comment") return;

      if (type === "Photo" && node.id) {
        for (const k of IMG_KEYS) {
          const img = node[k];
          if (img && typeof img.uri === "string" && CDN.test(img.uri)) {
            const area = (img.width || 0) * (img.height || 0);
            const prev = photos.get(node.id);
            if (!prev || area >= prev.area) photos.set(node.id, { uri: img.uri, area });
          }
        }
      }
      if ((type === "Video" || node.browser_native_hd_url || node.browser_native_sd_url) && (node.id || node.videoId)) {
        const src = node.browser_native_hd_url || node.browser_native_sd_url;
        if (src) {
          const poster = node.preferred_thumbnail?.image?.uri || node.thumbnailImage?.uri || null;
          videos.set(node.id || node.videoId, { src, poster });
        }
      }
      if (node.message && typeof node.message.text === "string" && node.message.text.trim()) texts.push(node.message.text);

      // Post -> ordered list of photo ids (may list fewer than `count`).
      if (!order && node.all_subattachments && Array.isArray(node.all_subattachments.nodes)) {
        order = node.all_subattachments.nodes.map((n) => n && n.media && n.media.id).filter(Boolean);
        count = node.all_subattachments.count || order.length;
      }
      // Photo page -> neighbours in the photo set.
      if (!nextId && node.nextMediaAfterNodeId && node.nextMediaAfterNodeId.id) nextId = node.nextMediaAfterNodeId.id;
      if (!prevId && node.prevMediaBeforeNodeId && node.prevMediaBeforeNodeId.id) prevId = node.prevMediaBeforeNodeId.id;

      for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === "object" && !SKIP_KEYS.test(k)) walk(v, depth + 1, type);
      }
    }

    const og = (p) => doc.querySelector(`meta[property="${p}"]`)?.content || "";
    return { photos, videos, texts, order, count, nextId, prevId, og };
  }

  /** Set token (e.g. "pcb.123") that makes photo pages know their siblings. */
  function findSetToken(doc) {
    const fromUrl = START_PARAMS.get("set");
    if (fromUrl) return fromUrl;
    const html = doc.documentElement.innerHTML;
    const m = html.match(/mediaset_token\W+(pcb\.\d+)/) ||
      html.match(/mediasetToken\W+(pcb\.\d+)/) ||
      html.match(/set=(pcb\.\d+)/);
    return m ? m[1] : "";
  }

  function initialState(doc) {
    const s = scan(doc);
    const text = (s.texts[0] || s.og("og:description") || "").trim();
    const state = { text, items: [], hint: 0, headDone: true, tailDone: true, set: "", ogOnly: false, index: 0 };

    if (START_FBID) {
      // Started on a single photo page: neighbours are discovered through next/prev links.
      state.set = findSetToken(doc);
      state.items = [{ kind: "image", id: START_FBID, src: s.photos.get(START_FBID)?.uri || null }];
      state.headDone = state.tailDone = !state.set;
      return state;
    }
    if (s.order && s.order.length) {
      // Post with a photo set.
      state.set = findSetToken(doc);
      state.items = s.order.map((id) => ({ kind: "image", id, src: s.photos.get(id)?.uri || null }));
      state.hint = s.count;
      state.tailDone = !state.set;
      return state;
    }
    // Videos / single photo / anything else: no navigation.
    for (const [id, v] of s.videos) state.items.push({ kind: "video", id, src: v.src, poster: v.poster });
    const posters = new Set([...s.videos.values()].map((v) => v.poster).filter(Boolean));
    if (!state.items.length) {
      for (const [id, p] of s.photos) if (!posters.has(p.uri)) state.items.push({ kind: "image", id, src: p.uri });
    }
    if (!state.items.length) {
      const v = s.og("og:video:secure_url") || s.og("og:video:url") || s.og("og:video");
      const img = s.og("og:image");
      if (v) state.items.push({ kind: "video", id: "og", src: v, poster: img });
      else if (img) state.items.push({ kind: "image", id: "og", src: img });
      state.ogOnly = state.items.length > 0;
    }
    return state;
  }

  // ---- Photo pages (fetched lazily for neighbours / missing image URLs) -----------------
  const infoCache = new Map();
  function photoUrl(id, set) {
    return `${location.origin}/photo/?fbid=${encodeURIComponent(id)}` + (set ? `&set=${encodeURIComponent(set)}` : "");
  }
  function loadInfo(id, set) {
    if (!infoCache.has(id)) {
      const p = (async () => {
        // Without a browser-like Accept header Facebook returns a data-less shell page.
        const res = await fetch(photoUrl(id, set), {
          credentials: "include",
          headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        const s = scan(doc);
        return { src: s.photos.get(id)?.uri || null, nextId: s.nextId, prevId: s.prevId };
      })();
      p.catch(() => infoCache.delete(id));
      infoCache.set(id, p);
    }
    return infoCache.get(id);
  }

  // ---- Rendering + gallery ----------------------------------------------------------------
  function render(state) {
    window.stop(); // stop Facebook from loading/running anything further
    const root = document.documentElement;
    root.replaceChildren();
    root.removeAttribute("class");
    root.removeAttribute("style");
    const head = document.createElement("head");
    const body = document.createElement("body");
    root.append(head, body);

    const title = document.createElement("title");
    title.textContent = (state.text.split("\n")[0] || "Post").slice(0, 80);
    head.appendChild(title);
    const viewport = document.createElement("meta");
    viewport.name = "viewport"; viewport.content = "width=device-width, initial-scale=1";
    head.appendChild(viewport);
    // Page-level styles must live in the light DOM; shadow-root CSS can't reach <body>.
    const pageStyle = document.createElement("style");
    pageStyle.textContent = "html,body{margin:0!important;padding:0!important;background:#000!important}";
    head.appendChild(pageStyle);

    // Shadow root keeps any straggling Facebook CSS out of our UI.
    const host = document.createElement("div");
    body.appendChild(host);
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        .wrap{box-sizing:border-box;min-height:100vh;background:#111;color:#e8e8e8;
          font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
        .col{max-width:900px;margin:0 auto;display:flex;flex-direction:column}
        .stage{position:relative;height:80vh;height:80dvh;background:#000;touch-action:pan-y;user-select:none;
          display:flex;align-items:center;justify-content:center}
        .media{max-width:100%;max-height:100%;object-fit:contain;display:block}
        .msg{color:#888}
        .nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;
          border:0;background:rgba(0,0,0,.55);color:#fff;font:28px/1 system-ui,sans-serif;cursor:pointer;
          display:flex;align-items:center;justify-content:center;padding:0}
        .nav:hover{background:rgba(255,255,255,.25)}
        .nav[disabled]{display:none}
        .prev{left:8px}.next{right:8px}
        .count{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.55);color:#fff;border-radius:12px;
          padding:2px 10px;font-size:14px}
        .text{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:16px}
        .single .nav,.single .count{display:none}
      </style>
      <div class="wrap"><div class="col">
        <div class="stage">
          <span class="msg"></span>
          <button class="nav prev" aria-label="Previous" disabled>&#8249;</button>
          <button class="nav next" aria-label="Next" disabled>&#8250;</button>
          <span class="count"></span>
        </div>
        <p class="text"></p>
      </div></div>`;
    const $ = (sel) => shadow.querySelector(sel);
    const stage = $(".stage"), msg = $(".msg"), prevBtn = $(".prev"), nextBtn = $(".next");
    const count = $(".count"), textEl = $(".text"), col = $(".col");
    textEl.textContent = state.text;
    textEl.hidden = !state.text;

    // -- gallery state
    const items = state.items;
    let idx = 0, shown = null, tailP = null, headP = null;
    const multi = () => items.length > 1 || !state.tailDone || !state.headDone;
    col.classList.toggle("single", !multi());

    const fill = (item, info) => { if (info.src && !item.src) item.src = info.src; };

    async function ensureSrc(item) {
      if (item.src || item.kind !== "image") return;
      try { fill(item, await loadInfo(item.id, state.set)); } catch { /* shown as error */ }
    }
    function extendTail() {
      if (state.tailDone) return Promise.resolve(false);
      if (!tailP) tailP = (async () => {
        try {
          const last = items[items.length - 1];
          const info = await loadInfo(last.id, state.set);
          fill(last, info);
          if (info.nextId && !items.some((x) => x.id === info.nextId)) {
            items.push({ kind: "image", id: info.nextId, src: null });
            return true;
          }
        } catch { /* network/parse error: stop extending */ }
        state.tailDone = true;
        return false;
      })().finally(() => { tailP = null; });
      return tailP;
    }
    function extendHead() {
      if (state.headDone) return Promise.resolve(false);
      if (!headP) headP = (async () => {
        try {
          const first = items[0];
          const info = await loadInfo(first.id, state.set);
          fill(first, info);
          if (info.prevId && !items.some((x) => x.id === info.prevId)) {
            items.unshift({ kind: "image", id: info.prevId, src: null });
            idx++;
            return true;
          }
        } catch { /* ignore */ }
        state.headDone = true;
        return false;
      })().finally(() => { headP = null; });
      return headP;
    }

    function updateChrome() {
      const total = Math.max(items.length, state.hint);
      const more = !state.tailDone || !state.headDone;
      count.textContent = `${idx + 1} / ${total}${more && total === items.length ? "+" : ""}`;
      prevBtn.disabled = idx <= 0 && state.headDone;
      nextBtn.disabled = idx >= items.length - 1 && state.tailDone;
      col.classList.toggle("single", !multi());
    }

    function preload(item) {
      if (item && item.kind === "image") ensureSrc(item).then(() => { if (item.src) new Image().src = item.src; });
    }

    async function show(i) {
      // Moving past the known ends: try to discover more photos first.
      if (i >= items.length) { await extendTail(); i = Math.min(i, items.length - 1); }
      if (i < 0) { await extendHead(); i = 0; }
      idx = Math.max(0, Math.min(i, items.length - 1));
      const item = items[idx];
      const token = (shown = {});
      updateChrome();

      // Keep URL in sync with the current photo (original URL for the first one).
      try {
        if (idx === 0 && START_FBID === null) history.replaceState(null, "", ORIGINAL_URL);
        else if (item.kind === "image" && item.id !== "og") history.replaceState(null, "", photoUrl(item.id, state.set));
      } catch { /* ignore */ }

      await ensureSrc(item);
      if (shown !== token) return; // user already moved on
      for (const el of stage.querySelectorAll(".media")) el.remove();
      msg.textContent = "";
      if (!item.src) { msg.textContent = "Could not load this photo."; }
      else {
        let el;
        if (item.kind === "video") {
          el = document.createElement("video");
          el.controls = true; el.preload = "metadata"; el.playsInline = true;
          if (item.poster) el.poster = item.poster;
        } else {
          el = document.createElement("img");
          el.decoding = "async";
        }
        el.className = "media";
        el.src = item.src;
        stage.prepend(el);
      }
      updateChrome();
      preload(items[idx + 1]); preload(items[idx - 1]);
      // Look further ahead/behind so the counter and arrows stay accurate.
      if (idx >= items.length - 2) extendTail().then(updateChrome);
      if (idx <= 1) extendHead().then(updateChrome);
    }

    const go = (d) => show(idx + d);
    prevBtn.addEventListener("click", () => go(-1));
    nextBtn.addEventListener("click", () => go(1));
    window.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    });
    let sx = null, sy = null;
    stage.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    stage.addEventListener("touchend", (e) => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      sx = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    }, { passive: true });

    show(0);

    // Remove anything Facebook scripts still manage to inject into the page.
    new MutationObserver(() => {
      for (const c of [...root.children]) if (c !== head && c !== body) c.remove();
    }).observe(root, { childList: true });
    new MutationObserver(() => {
      for (const c of [...body.children]) if (c !== host) c.remove();
    }).observe(body, { childList: true });

    unhide();
  }
})();
