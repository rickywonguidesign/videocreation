// ==UserScript==
// @name         VideoExpress Scene Automation
// @namespace    videocreation-automation
// @version      3.1
// @description  Pastes a scene's Image Prompt + Video/Audio Prompt into VideoExpress's Create Video From Prompt modal, sets options, auto-picks the reference photo from the library, and drives it through Create Image -> Create Video. Auto-runs as soon as a new scene payload appears on the clipboard — no button click needed after the first one.
// @match        https://app.videoexpress.ai/*
// @grant        none
// @noframes
// ==/UserScript==
(function () {
  'use strict';
  // v1.8: SINGLE-INSTANCE GUARD. If this script is installed twice in
  // Tampermonkey (e.g. an old copy pasted as a new script), or the page has
  // iframes, every copy ran the whole flow at the same time — clicking each
  // button twice and opening two library popups. Only the first copy on the
  // top-level page runs now; any other copy stops here.
  if (window.top !== window.self) return;
  if (window.__veAutomationLoaded) {
    console.warn('[VE-Automation] Another copy of this script is already running on this page (v' + window.__veAutomationLoaded + ') — this copy will stay idle. Open Tampermonkey and disable/delete the duplicate script.');
    return;
  }
  window.__veAutomationLoaded = '3.1';
  // ============================================================
  // CONFIG — edit these to change behavior without touching the
  // engine logic below. Mirrors videoexpress-automation-flow.json.
  // ============================================================
  const CONFIG = {
    requireManualConfirmation: false, // set true to pause after image generation, before Create Video
    characterStyleMap: {
      "Human": "human",
      "2D": "2d",
      "2.5D": "2d", // v2.6: VideoExpress has no 2.5D option — 2.5D is a drawn style, so it uses 2D
      "3D": "3d",
      "Photorealistic (Cinematic)": "photorealistic",
      "Other": "other"
    },
    checkboxDesiredState: {
      // Note: VideoExpress has been observed reverting auto_enhance_prompt and
      // enhance_video_prompt on its own when use_consistent_character is on.
      // Per request, each checkbox now gets exactly ONE click attempt, no
      // repeated fighting — if the site reverts it afterward, it stays
      // reverted, and the console warning will show that mismatch.
      // auto_enhance_prompt: v2.9 — always UNTICKED by the script ("Automatically enhance my image prompt"),
      // before "Use consistent character" is ticked, and again whenever VideoExpress re-ticks it. See forceAutoEnhanceOff().
      image_creative_mode: true, // NEW (v1.3): ticked right BEFORE use_consistent_character
      use_consistent_character: true,
      shared: false,
      advanced_mode: true,
      // enhance_video_prompt: v2.5 — always UNTICKED by the script ("Automatically enhance my video prompt"),
      // so VideoExpress uses the generator's video prompt exactly as written. See forceEnhanceVideoOff().
      manual_video_length: true,
      talking_video: false
    },
    // Right after "Use consistent character" is ticked, open the Reference
    // Photo library, go into the folder below, pick each character's image
    // and click Choose. Since v1.3 the image IDs come from the generator
    // (each character's "VideoExpress reference photo ID"), sent in the
    // clipboard payload as referencePhotos: [{ name, ident }, ...]:
    //   1st character -> "Reference Photo"   button
    //   2nd character -> "Reference Photo 2" button
    // Set enabled:false to go back to picking reference photos by hand.
    referencePhoto: {
      enabled: true,
      buttonSelector: 'button.button-reference-photo2', // both slot buttons share this class...
      slotButtonText: ['Reference Photo', 'Reference Photo 2'], // ...so they're told apart by their text
      libraryFolderId: '345403',   // "My Artistly Images"
      fallbackImageIdent: '46129371', // only used if the payload has NO referencePhotos field (older generator)
      chooseButtonSelector: 'button.btn-primary.button-submit',
      clearButtonSelector: 'button.button-select-image-clear' // trash icon, "Clear selection" — clicked on every scene before choosing
    },
    videoDurationRange: { min: 3, max: 10 },
    timeouts: {
      element: 300000,                // v1.6: 5 minutes — max wait for any required page element
      referenceImage: 15000,          // max wait for the FIRST reference image (required — this must be manually selected in the UI before running)
      secondReferenceImageGrace: 5000, // short grace period for a SECOND reference image (2-character scenes) — proceeds either way after this
      libraryStep: 60000,             // v1.7: 1 min per library step — a wrong selector now fails fast (with a console report) instead of hanging 5 min
      slotButton: 30000,              // v1.7: max wait for the "Reference Photo" / "Reference Photo 2" button
      imageGeneration: 300000,        // 5 min
      imageSlideSelected: 300000      // 5 min
    },
    autoRun: {
      enabled: true,       // set false to fall back to fully manual (click the button every time)
      pollIntervalMs: 1500 // how often to check the clipboard for a new, not-yet-run payload
    }
  };
  // ============================================================
  // ENGINE — generic helpers. Shouldn't need to edit below here
  // unless VideoExpress's actual behavior changes (not just selectors).
  // ============================================================
  function log(msg) {
    console.log('[VE-Automation]', msg);
    updateStatus(msg);
  }
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  function isVisible(el) {
    // offsetParent is null for display:none elements (and a few other cases,
    // but those are rare here) — a cheap, reliable-enough visibility check.
    return el.offsetParent !== null;
  }
  function findBestMatch(selector) {
    const all = document.querySelectorAll(selector);
    if (all.length === 0) return null;
    for (const el of all) {
      if (isVisible(el)) return el;
    }
    return all[0]; // fall back to the first match if none appear visible yet
  }
  function waitForElement(selector, timeoutMs = CONFIG.timeouts.element) {
    return new Promise((resolve, reject) => {
      const existing = findBestMatch(selector);
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const el = findBestMatch(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for element: ${selector}`));
      }, timeoutMs);
    });
  }
  // Like waitForElement, but ONLY resolves once a matching element is actually
  // visible (waitForElement falls back to a hidden match immediately). Needed
  // for the library picker modal, whose markup can exist in the DOM hidden
  // before it's actually shown. Optional `filter` narrows matches further
  // (e.g. by button text).
  function waitForVisibleElement(selector, timeoutMs = CONFIG.timeouts.element, filter) {
    return new Promise((resolve, reject) => {
      const find = () => {
        for (const el of document.querySelectorAll(selector)) {
          if (isVisible(el) && (!filter || filter(el))) return el;
        }
        return null;
      };
      const existing = find();
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const el = find();
        if (el) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for visible element: ${selector}`));
      }, timeoutMs);
    });
  }
  // Detects the loading state actually STARTING — used before waiting for it
  // to finish, so a leftover "already loaded" image from a reused modal can't
  // be mistaken for a fresh generation that hasn't happened yet.
  function waitForAttributeContaining(selector, attr, substring, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const el = document.querySelector(selector);
        return !!(el && (el.getAttribute(attr) || '').includes(substring));
      };
      if (check()) return resolve(true);
      const observer = new MutationObserver(() => {
        if (check()) {
          observer.disconnect();
          resolve(true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [attr] });
      setTimeout(() => {
        observer.disconnect();
        resolve(false); // non-fatal — caller decides what to do if this never appears
      }, timeoutMs);
    });
  }
  function waitForAttributeNotContaining(selector, attr, forbiddenSubstring, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const el = document.querySelector(selector);
        // If the element is gone entirely, or its attribute no longer contains
        // the forbidden substring, we consider the wait satisfied.
        if (!el || !(el.getAttribute(attr) || '').includes(forbiddenSubstring)) {
          return true;
        }
        return false;
      };
      if (check()) return resolve();
      const observer = new MutationObserver(() => {
        if (check()) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [attr] });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for ${selector} [${attr}] to stop containing "${forbiddenSubstring}"`));
      }, timeoutMs);
    });
  }
  function countMatching(selector) {
    return document.querySelectorAll(selector).length;
  }
  // Polls a predicate function until it returns truthy, or the timeout hits —
  // resolves true/false rather than rejecting, since callers decide what a
  // false result means (e.g. "keep going anyway" vs "actually stop").
  function waitForCondition(fn, timeoutMs = 15000, intervalMs = 200) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (fn()) return resolve(true);
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(check, intervalMs);
      };
      check();
    });
  }
  function waitForMinCount(selector, minCount, timeoutMs) {
    return new Promise((resolve) => {
      if (countMatching(selector) >= minCount) return resolve(true);
      const observer = new MutationObserver(() => {
        if (countMatching(selector) >= minCount) {
          observer.disconnect();
          resolve(true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src', 'style'] });
      setTimeout(() => {
        observer.disconnect();
        resolve(countMatching(selector) >= minCount);
      }, timeoutMs);
    });
  }
  function waitForClassOnAny(selector, className, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const els = document.querySelectorAll(selector);
        for (const el of els) {
          if (el.classList.contains(className)) return el;
        }
        return null;
      };
      const found = check();
      if (found) return resolve(found);
      const observer = new MutationObserver(() => {
        const el = check();
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for .${className} on ${selector}`));
      }, timeoutMs);
    });
  }
  // ------------------------------------------------------------------
  // PAIR-IMAGE AUTO-SELECT — some scenes render TWO candidate images side
  // by side instead of one: one ".swiper-slide-pair-item" per
  // data-pair-index ("0" and "1"), each starting on the SAME loading
  // placeholder ("/img/loading-paint3-horiz.gif"). Previously the flow
  // just waited for a ".selected" class to show up on one of them, which
  // needed either a manual click or the site to pick one on its own. This
  // instead watches both images directly and clicks whichever one's <img
  // src> stops being the loading placeholder FIRST, so the faster-
  // finishing render gets auto-selected instead of sitting there waiting.
  // ------------------------------------------------------------------
  const PAIR_ITEM_SELECTOR =
    '.swiper-slide.swiper-slide-pair.swiper-slide-visible.swiper-slide-active.swiper-slide-fully-visible .swiper-slide-pair-item';
  function findActivePairItems() {
    return Array.from(document.querySelectorAll(PAIR_ITEM_SELECTOR));
  }
  function pairItemImageSrc(pairItem) {
    const img = pairItem.querySelector('img');
    return (img && (img.getAttribute('src') || img.src)) || '';
  }
  function pairItemIsLoading(pairItem) {
    const src = pairItemImageSrc(pairItem);
    return !src || src.includes('loading-paint3-horiz.gif');
  }
  // Resolves true once a pair item has been picked (either it was already
  // ".selected", or this function clicked whichever one finished loading
  // first and confirmed the "selected" class actually landed on it).
  // Resolves false on timeout, or if the click never resulted in the
  // "selected" class appearing — either way the caller falls back to its
  // own wait rather than assuming a pick silently succeeded.
  function waitAndAutoSelectFirstReadyPairItem(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let observer;
      let timer;
      function finish(result) {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        clearTimeout(timer);
        resolve(result);
      }
      function tryPick() {
        if (settled) return;
        const items = findActivePairItems();
        if (items.length < 2) return; // pair markup not rendered yet (or this isn't a pair scene)
        const alreadySelected = items.find(item => item.classList.contains('selected'));
        if (alreadySelected) {
          log(`Pair image already selected (index ${alreadySelected.getAttribute('data-pair-index')}) — nothing to auto-pick.`);
          return finish(true);
        }
        const winner = items.find(item => !pairItemIsLoading(item));
        if (!winner) return; // both still loading — keep watching
        log(`Pair image (index ${winner.getAttribute('data-pair-index')}) finished rendering first — auto-selecting it.`);
        winner.click();
        // Give the click a moment to actually register as "selected" — if
        // it never does, the click target guessed here (the pair-item
        // container) may not be what the site listens on.
        waitForCondition(() => winner.classList.contains('selected'), 3000).then((selected) => {
          if (!selected) {
            console.warn('[VE-Automation] Clicked the first-ready pair image, but it never gained the "selected" class — the real click target may be different (e.g. the <img> itself, or a hidden button) than what this automation guessed.');
          }
          finish(selected);
        });
      }
      observer = new MutationObserver(tryPick);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
      timer = setTimeout(() => finish(false), timeoutMs);
      tryPick(); // in case both are already ready (or one preselected) by the time we start watching
    });
  }
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
                : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function setCheckbox(el, desired, label) {
    if (el.checked !== desired) {
      el.click(); // click() rather than toggling .checked directly, so any listeners fire
      await sleep(200); // give the site's own JS a moment to settle before we move on / read back state
    }
    if (el.checked !== desired) {
      console.warn(`[VE-Automation] Checkbox "${label}" did not reach desired state (wanted ${desired}, got ${el.checked}) — possible selector mismatch or site JS interference.`);
    }
  }
  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }
  function pauseForUser(message) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:999999;
        display:flex; align-items:center; justify-content:center;
      `;
      overlay.innerHTML = `
        <div style="background:#fff; padding:20px 24px; border-radius:8px; max-width:360px; font-family:sans-serif;">
          <p style="margin:0 0 14px; font-size:14px; color:#222;">${message}</p>
          <button id="ve-auto-continue" style="background:#7E4FE6; color:#fff; border:none; padding:8px 16px; border-radius:5px; cursor:pointer;">Continue</button>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('#ve-auto-continue').onclick = () => {
        overlay.remove();
        resolve();
      };
    });
  }
  // ============================================================
  // AUTO-RUN ENGINE — polls the clipboard for a new, not-yet-run scene
  // payload and kicks the flow off on its own, instead of waiting for a
  // click. Two hard browser limits this can't get around, both handled as
  // gracefully as possible rather than pretending they don't exist:
  //   1. The FIRST-ever clipboard read on this origin needs a real user
  //      gesture to get the "allow clipboard access" permission granted —
  //      that's a Chrome/Edge security rule, not something a page can skip.
  //      Once granted, it's remembered for the origin, and every read after
  //      that (including background polling) works with no further clicks.
  //   2. navigator.clipboard.readText() only works while this tab actually
  //      has focus — a backgrounded tab can't read the clipboard at all.
  //      So autorun fires the moment you switch to this tab with a fresh
  //      scene already copied, not while you're still on the generator tab.
  // The floating button is kept as a manual fallback/retry — clicking it is
  // what grants that first permission, and it always force-runs even if the
  // clipboard content matches whatever was already auto-run.
  // ============================================================
  let isRunning = false;
  // Every payload already run (from clipboard OR from the generator's
  // Automation loop), so an older scene still sitting on the clipboard is
  // never re-run when this tab regains focus.
  const processedRaws = new Set();
  let pollTimer = null;

  async function tryReadPayloadFromClipboard(alertOnFailure) {
    let raw;
    try {
      raw = await navigator.clipboard.readText();
    } catch (e) {
      if (alertOnFailure) {
        alert('Could not read the clipboard. Your browser may be blocking automatic clipboard access on this site — click this button once to grant it (a permission prompt may appear); after that, new scenes will run automatically without clicking anything.');
      }
      return null;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
      if (!payload.image || !payload.videoAudio) throw new Error('missing fields');
    } catch (e) {
      if (alertOnFailure) {
        alert('Could not read a valid scene payload from the clipboard. Click "⚡ Copy All → VideoExpress" on your scene generator first, then click this button (or just switch back to this tab — it checks automatically).');
      }
      return null;
    }
    return { payload, raw };
  }

  // Single entry point for both the auto-poll loop and the manual button —
  // guarantees only one flow runs at a time, and tracks which clipboard
  // content has already been run so the poll loop doesn't re-trigger the
  // same scene over and over every 1.5s. `force` (manual button only) skips
  // that dedup check, so a deliberate re-click always re-runs.
  async function triggerRun({ payload, raw, force }) {
    if (isRunning) {
      log('Already running — ignoring this trigger.');
      return;
    }
    if (isPaused) {
      // Keep the newest scene that arrived while paused; it starts on Play.
      if (pausedQueue && pausedQueue.raw === raw) return; // already waiting (clipboard re-check)
      if (!(raw !== null && processedRaws.has(raw) && !force)) {
        pausedQueue = { payload, raw };
        renderPauseBtn();
        log(`⏸ Paused — scene ${payload && payload.sceneNumber != null ? payload.sceneNumber : ''} will start when you press Play.`);
      }
      return;
    }
    if (!force && raw !== null && processedRaws.has(raw)) {
      return; // already ran this exact scene payload — nothing new to do
    }
    isRunning = true;
    if (raw) processedRaws.add(raw);
    try {
      await runFlow(payload);
    } finally {
      isRunning = false;
      // updateStatus() auto-hides the box on its own after a few seconds of
      // no new message — the "Done" line (or an error) just sits, then fades.
    }
  }

  function startAutoRunPolling() {
    if (!CONFIG.autoRun.enabled || pollTimer) return;
    pollTimer = setInterval(async () => {
      if (isRunning) return;
      if (!document.hasFocus()) return; // clipboard reads require focus — silently wait for it
      const result = await tryReadPayloadFromClipboard(false);
      if (!result) return;
      await triggerRun({ payload: result.payload, raw: result.raw, force: false });
    }, CONFIG.autoRun.pollIntervalMs);
    updateIdleStatus();
  }
  // ============================================================
  // v2.2: PAUSE / PLAY — a second floating button. While paused:
  //   • a scene that's running stops at its next step and waits there,
  //   • no new scene starts (clipboard or generator Automation) — a scene
  //     that arrives meanwhile is kept and starts when you press Play.
  // ============================================================
  let isPaused = false;
  let pausedQueue = null; // { payload, raw } that arrived while paused
  let pauseBtnEl = null;
  function renderPauseBtn() {
    if (!pauseBtnEl) return;
    pauseBtnEl.textContent = isPaused ? `▶ Play${pausedQueue ? ' (1 scene waiting)' : ''}` : '⏸ Pause';
    pauseBtnEl.style.background = isPaused ? '#E0A100' : '#444';
  }
  function togglePause() {
    isPaused = !isPaused;
    renderPauseBtn();
    log(isPaused ? '⏸ Paused — the current step finishes, then everything waits until you press Play.' : '▶ Resumed.');
    if (!isPaused && pausedQueue && !isRunning) {
      const q = pausedQueue;
      pausedQueue = null;
      renderPauseBtn();
      triggerRun({ payload: q.payload, raw: q.raw, force: false });
    }
  }
  // Called between the steps of a run: holds the run here while paused.
  async function checkPause() {
    if (!isPaused) return;
    updateStatus('⏸ Paused — press ▶ Play to continue.');
    while (isPaused) await sleep(300);
  }
  function injectPauseButton() {
    pauseBtnEl = document.createElement('button');
    pauseBtnEl.style.cssText = `
      position:fixed; bottom:20px; right:200px; z-index:999998;
      color:#fff; border:none; padding:12px 16px; border-radius:8px;
      font-family:sans-serif; font-size:13px; font-weight:600; cursor:pointer;
      box-shadow:0 4px 12px rgba(0,0,0,.3);
    `;
    pauseBtnEl.onclick = togglePause;
    document.body.appendChild(pauseBtnEl);
    renderPauseBtn();
  }

  // ============================================================
  // v2.7: ADD VIDEOS TO TIMELINE — a third floating button.
  //   1. Click "🎞 Add video to Timeline" → the script starts listening.
  //   2. YOU right-click a video (.library-item) and click "Add to Timeline"
  //      in its menu. The script remembers that video's data-ident.
  //   3. The script then does the same for every video with a BIGGER
  //      data-ident, one by one, smallest first: right-click → "Add to
  //      Timeline" → next… until no bigger data-ident is left.
  // Click the button again at any time to stop. ⏸ Pause also holds the loop.
  // ============================================================
  const TIMELINE = {
    itemSelector: '.library-item[data-ident]:not(.library-folder)',
    menuLinkSelector: 'a[data-action="add-to-timeline"]',
    menuWaitMs: 5000,      // max wait for the right-click menu to show
    betweenItemsMs: 1500   // pause after each "Add to Timeline" so the site can add the clip
  };
  let tlState = 'off';      // 'off' | 'listening' | 'running'
  let tlCurrentIdent = null; // data-ident of the last video added
  let tlCount = 0;
  let tlStop = false;
  let tlBtnEl = null;
  function renderTimelineBtn() {
    if (!tlBtnEl) return;
    tlBtnEl.textContent = tlState === 'off' ? '🎞 Add video to Timeline'
      : tlState === 'listening' ? (tlCurrentIdent != null ? `👂 Now click "Add to Timeline" (ID ${tlCurrentIdent}) · ✕` : '👂 Right-click the first video… · ✕')
      : `⏹ Stop timeline (${tlCount} added)`;
    tlBtnEl.style.background = tlState === 'off' ? '#1E7F5C' : tlState === 'listening' ? '#E0A100' : '#C62828';
  }
  function identOf(el) {
    const n = parseInt(el && el.getAttribute('data-ident'), 10);
    return isNaN(n) ? null : n;
  }
  // Right-click listener: remembers which video the user right-clicked.
  document.addEventListener('contextmenu', (e) => {
    if (tlState !== 'listening' || !e.isTrusted) return;
    const item = e.target && e.target.closest && e.target.closest(TIMELINE.itemSelector);
    if (!item) return;
    tlCurrentIdent = identOf(item);
    renderTimelineBtn();
    log(`Timeline: remembered video ${tlCurrentIdent} — now click "Add to Timeline".`);
  }, true);
  // Click listener: the user's own "Add to Timeline" click starts the loop.
  document.addEventListener('click', (e) => {
    if (tlState !== 'listening' || !e.isTrusted) return;
    const link = e.target && e.target.closest && e.target.closest(TIMELINE.menuLinkSelector);
    if (!link || tlCurrentIdent == null) return;
    tlState = 'running';
    tlCount = 1;
    renderTimelineBtn();
    log(`Timeline: video ${tlCurrentIdent} added by you — continuing with the next ones...`);
    setTimeout(runTimelineLoop, TIMELINE.betweenItemsMs); // let the site finish your click first
  }, true);
  // The visible video with the smallest data-ident that is bigger than `after`.
  function nextTimelineItem(after) {
    let best = null, bestId = null;
    for (const el of document.querySelectorAll(TIMELINE.itemSelector)) {
      if (!isVisible(el)) continue;
      const id = identOf(el);
      if (id == null || id <= after) continue;
      if (bestId == null || id < bestId) { best = el; bestId = id; }
    }
    return best ? { el: best, id: bestId } : null;
  }
  function visibleMenuLink() {
    return Array.from(document.querySelectorAll(TIMELINE.menuLinkSelector)).find(isVisible) || null;
  }
  // A real-looking right-click on the centre of the element.
  function rightClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, button: 2, buttons: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const target = document.elementFromPoint(opts.clientX, opts.clientY);
    const at = target && el.contains(target) ? target : el;
    at.dispatchEvent(new MouseEvent('mousedown', opts));
    at.dispatchEvent(new MouseEvent('mouseup', opts));
    at.dispatchEvent(new MouseEvent('contextmenu', opts));
  }
  async function runTimelineLoop() {
    try {
      while (!tlStop) {
        await checkPause();
        if (tlStop) break;
        const next = nextTimelineItem(tlCurrentIdent);
        if (!next) {
          log(`Timeline: done — ${tlCount} video(s) added. No video after ID ${tlCurrentIdent}.`);
          break;
        }
        // The menu from the previous item must be closed first, so the
        // "Add to Timeline" link found next really belongs to this video.
        await waitForCondition(() => !visibleMenuLink(), 2000, 100);
        log(`Timeline: right-clicking video ${next.id}...`);
        rightClick(next.el);
        const shown = await waitForCondition(() => visibleMenuLink(), TIMELINE.menuWaitMs, 100);
        if (!shown) throw new Error(`the right-click menu for video ${next.id} never showed "Add to Timeline"`);
        if (tlStop) break;
        tlCurrentIdent = next.id;
        visibleMenuLink().click();
        tlCount++;
        renderTimelineBtn();
        log(`Timeline: added video ${next.id} (${tlCount} so far).`);
        await sleep(TIMELINE.betweenItemsMs);
      }
      if (tlStop) log(`Timeline: stopped — ${tlCount} video(s) added, last ID ${tlCurrentIdent}.`);
    } catch (err) {
      console.error('[VE-Automation] Timeline loop failed:', err);
      log(`Timeline: stopped — ${err.message}. ${tlCount} video(s) added, last ID ${tlCurrentIdent}.`);
    } finally {
      tlState = 'off';
      tlStop = false;
      renderTimelineBtn();
    }
  }
  function toggleTimeline() {
    if (tlState === 'off') {
      tlState = 'listening';
      tlCurrentIdent = null;
      tlCount = 0;
      tlStop = false;
      log('Timeline: right-click the FIRST video, then click "Add to Timeline" — the rest follow automatically.');
    } else if (tlState === 'listening') {
      tlState = 'off';
      log('Timeline: cancelled.');
    } else {
      tlStop = true;
      log('Timeline: stopping after the current video...');
    }
    renderTimelineBtn();
  }
  function injectTimelineButton() {
    tlBtnEl = document.createElement('button');
    tlBtnEl.style.cssText = `
      position:fixed; bottom:20px; right:300px; z-index:999998;
      color:#fff; border:none; padding:12px 16px; border-radius:8px;
      font-family:sans-serif; font-size:13px; font-weight:600; cursor:pointer;
      box-shadow:0 4px 12px rgba(0,0,0,.3);
    `;
    tlBtnEl.onclick = toggleTimeline;
    document.body.appendChild(tlBtnEl);
    renderTimelineBtn();
  }

  // ============================================================
  // FLOATING BUTTON + STATUS UI
  // ============================================================
  let statusEl;
  // v2.0: an OLDER copy of this script (installed separately in Tampermonkey,
  // before the single-copy guard existed) can't be stopped from here — but
  // it can be detected: every copy adds its own "⚡ Paste & Generate" button.
  function warnIfDuplicateCopies() {
    const n = Array.from(document.querySelectorAll('button')).filter(b => (b.textContent || '').trim() === '⚡ Paste & Generate').length;
    if (n <= 1) return;
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:1000000;background:#C62828;color:#fff;padding:12px 18px;border-radius:8px;font:600 13px sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:560px;text-align:center;';
    banner.textContent = `⚠ ${n} copies of "VideoExpress Scene Automation" are running on this page — every click happens ${n} times (that's what opens several Select Image popups). Open Tampermonkey → Dashboard, keep only v2.0, delete/disable the others, then reload.`;
    banner.onclick = () => banner.remove();
    document.body.appendChild(banner);
    console.error('[VE-Automation] ' + banner.textContent);
  }
  function injectButton() {
    const btn = document.createElement('button');
    btn.textContent = '⚡ Paste & Generate';
    btn.style.cssText = `
      position:fixed; bottom:20px; right:20px; z-index:999998;
      background:#7E4FE6; color:#fff; border:none; padding:12px 18px;
      border-radius:8px; font-family:sans-serif; font-size:13px; font-weight:600;
      cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,.3);
    `;
    btn.onclick = async () => {
      const result = await tryReadPayloadFromClipboard(true);
      if (!result) return;
      await triggerRun({ payload: result.payload, raw: result.raw, force: true });
    };
    document.body.appendChild(btn);
    statusEl = document.createElement('div');
    statusEl.style.cssText = `
      position:fixed; bottom:66px; right:20px; z-index:999998;
      background:#222; color:#fff; padding:8px 12px; border-radius:6px;
      font-family:monospace; font-size:11px; max-width:280px; display:none;
    `;
    document.body.appendChild(statusEl);
  }
  // Every call to updateStatus() auto-hides the status box 5s after
  // whichever message was shown LAST — each new message pushes the
  // hide-timer back out, so a fast-moving run keeps the box visible step
  // to step and only fades once things go quiet.
  const STATUS_AUTOHIDE_MS = 5000;
  let statusHideTimer = null;
  function updateStatus(msg) {
    if (!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.textContent = msg;
    if (statusHideTimer) clearTimeout(statusHideTimer);
    statusHideTimer = setTimeout(() => {
      statusEl.style.display = 'none';
      statusHideTimer = null;
    }, STATUS_AUTOHIDE_MS);
  }
  function updateIdleStatus() {
    if (!statusEl || isRunning) return;
    updateStatus(CONFIG.autoRun.enabled
      ? '👀 Watching clipboard — copy a scene from the generator and this tab will pick it up automatically.'
      : 'Auto-run is off — click ⚡ Paste & Generate after copying a scene.');
  }
  // ============================================================
  // THE FLOW
  // ============================================================
  function returnToGeneratorTab(payload) {
    if (!window.opener || window.opener.closed) {
      log('Video generation started. (No generator tab reference found — switch back manually. This happens if VideoExpress was opened by hand rather than via the generator\'s button.)');
      return;
    }
    // Chrome/Edge block window.focus() on regular background tabs entirely —
    // so tell the generator tab it's done via postMessage; the generator
    // itself uses a real Notification, which IS allowed to bring a tab to front.
    try {
      window.opener.postMessage({ type: 've-automation-complete', ts: Date.now(), sceneNumber: payload && payload.sceneNumber != null ? payload.sceneNumber : null }, '*');
      log('Video generation started. Notified the generator tab — look for a notification, or switch back manually.');
    } catch (e) {
      console.error('[VE-Automation] postMessage to generator tab failed:', e);
      log('Video generation started. Could not notify the generator tab automatically — switch back manually.');
    }
  }
  function lookupCharacterStyle(rawStyle) {
    if (!rawStyle) return 'human';
    const normalized = String(rawStyle).trim().toLowerCase();
    for (const [key, value] of Object.entries(CONFIG.characterStyleMap)) {
      if (key.trim().toLowerCase() === normalized) return value;
    }
    console.warn(`[VE-Automation] No match for characterStyle "${rawStyle}" in characterStyleMap — falling back to "human". Check CONFIG.characterStyleMap keys match exactly what the generator sends.`);
    return 'human';
  }
  // ------------------------------------------------------------------
  // REFERENCE PHOTO LIBRARY PICK — runs right after the
  // "use_consistent_character" checkbox is ticked, once per character:
  //   1. Click "Reference Photo" (slot 1) or "Reference Photo 2" (slot 2)
  //   2. Wait for the "My Artistly Images" folder (data-id=345403) to show
  //      (skipped if the library already opened inside that folder)
  //   3. Click that folder
  //   4. Click the image div with data-ident=<that character's ID>
  //   5. Click "Choose" (button.btn-primary.button-submit)
  // Non-fatal: if any step times out, it logs a warning and the flow
  // continues — the existing 5s manual reference-photo window further down
  // still gives you a chance to pick one by hand.
  // ------------------------------------------------------------------
  // v1.7 helpers — the reference slot containers, and whether a slot shows
  // a real photo (src isn't the blank placeholder icon).
  const REF_SLOT_SELECTOR = '.consistent-character-image-container .grid-col .select-image-container';
  const REF_PLACEHOLDER_SRC = '/img/icon-image-horiz.png';
  function refSlotEl(slotIndex) {
    return document.querySelectorAll(REF_SLOT_SELECTOR)[slotIndex] || null;
  }
  function refSlotSrc(slotIndex) {
    const c = refSlotEl(slotIndex);
    const img = c && c.querySelector('img');
    return (img && (img.getAttribute('src') || img.src)) || '';
  }
  function refSlotFilled(slotIndex) {
    const src = refSlotSrc(slotIndex);
    return !!src && !src.includes(REF_PLACEHOLDER_SRC);
  }
  // Printed to the console whenever a pick fails, so the exact broken step
  // is visible (copy it to Claude if it keeps failing).
  function dumpLibraryDiagnostics(label, ident) {
    const rp = CONFIG.referencePhoto;
    const slotBtns = Array.from(document.querySelectorAll(rp.buttonSelector)).map(b => ({ text: b.textContent.replace(/\s+/g, ' ').trim(), visible: isVisible(b) }));
    const images = Array.from(document.querySelectorAll(`[data-ident="${ident}"]`)).map(el => ({ tag: el.tagName, cls: el.className, visible: isVisible(el) }));
    const folders = Array.from(document.querySelectorAll(`.library-item.library-folder[data-id="${rp.libraryFolderId}"]`)).map(el => ({ visible: isVisible(el) }));
    const chooseBtns = Array.from(document.querySelectorAll(rp.chooseButtonSelector)).map(b => ({ text: b.textContent.trim(), visible: isVisible(b), disabled: b.disabled }));
    const slots = Array.from(document.querySelectorAll(REF_SLOT_SELECTOR)).map((c, i) => ({ slot: i + 1, src: refSlotSrc(i) }));
    console.warn(`[VE-Automation] DIAGNOSTICS for ${label}:`, { slotButtons: slotBtns, imageMatches: images, folderTiles: folders, chooseButtons: chooseBtns, slots });
  }
  // v2.0: a "Select Image" library popup is found from its footer: every
  // open popup has its own visible "Choose" + "Close" buttons (stacked
  // popups each keep theirs). The popup root is the nearest ancestor of
  // "Choose" that also holds a "Close" button and the library tiles.
  function btnText(b) { return (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function libraryPopups() {
    const chooses = Array.from(document.querySelectorAll('button')).filter(b => isVisible(b) && btnText(b) === 'choose');
    const roots = [];
    for (const b of chooses) {
      let p = b.parentElement;
      while (p && p !== document.body) {
        const hasClose = Array.from(p.querySelectorAll('button')).some(x => btnText(x) === 'close');
        const looksLikePopup = p.querySelector('.library-item') || /modal/i.test(p.className || '');
        if (hasClose && looksLikePopup) break;
        p = p.parentElement;
      }
      if (p && p !== document.body && !roots.includes(p)) roots.push(p);
    }
    return roots; // DOM order — the last one is the newest / top-most
  }
  function openLibraryModals() { return libraryPopups(); }
  function openLibraryCount() { return libraryPopups().length; }
  // Closes every open library popup with its own "Close" button, newest
  // first, and waits until none is showing.
  async function closeOpenLibraries() {
    for (let guard = 0; guard < 6 && openLibraryCount() > 0; guard++) {
      const popups = libraryPopups();
      const top = popups[popups.length - 1];
      const closeBtn = Array.from(top.querySelectorAll('button')).find(b => isVisible(b) && btnText(b) === 'close');
      if (!closeBtn) break;
      closeBtn.click();
      await waitForCondition(() => !document.body.contains(top) || !isVisible(closeBtn), 2000);
      await sleep(300);
    }
  }
  function closestModal(el) {
    return (el && el.closest('.bbm-modal, .modal, [role="dialog"]')) || document;
  }
  async function selectReferencePhotoFromLibrary(slotIndex, ident, charName) {
    const rp = CONFIG.referencePhoto;
    const t = CONFIG.timeouts.libraryStep;
    const btnText = rp.slotButtonText[slotIndex];
    const label = `${btnText}${charName ? ` (${charName})` : ''}`;
    // Prefer matches inside the open library window; fall back to the whole
    // page in case the library isn't wrapped in a recognisable modal.
    const visibleIn = (root, sel) => Array.from(root.querySelectorAll(sel)).find(isVisible)
      || (root !== document ? Array.from(document.querySelectorAll(sel)).find(isVisible) : null) || null;
    try {
      // v1.9: NEVER open a second library popup. Ticking the checkboxes (or
      // the previous pick) can leave a library popup already open — clicking
      // "Reference Photo" on top of it stacked a second popup.
      await sleep(800); // give a spontaneously-opening popup time to appear
      if (openLibraryCount() > 0) {
        if (slotIndex === 0) {
          log(`${label}: a photo library popup is already open — using it instead of opening another.`);
        } else {
          log(`${label}: the previous library popup is still open — closing it first...`);
          await closeOpenLibraries();
        }
      }
      if (openLibraryCount() === 0) {
        unhideRefArea(`before clicking ${btnText}`);
        log(`${label}: opening the library for image ${ident}...`);
        const refBtn = await waitForVisibleElement(
          rp.buttonSelector,
          CONFIG.timeouts.slotButton,
          el => el.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === btnText.toLowerCase()
        );
        console.log(`[VE-Automation] ${label}: clicking slot button (open libraries before click: ${openLibraryCount()})`, refBtn);
        refBtn.click();
        await sleep(1500);
        const n = openLibraryCount();
        console.log(`[VE-Automation] ${label}: open library popups after click: ${n}`);
        if (n > 1) console.warn(`[VE-Automation] ${label}: ${n} library popups are open after ONE click — the site itself opened two.`);
      }

      const folderSelector = `.library-item.library-folder.button-folder[data-id="${rp.libraryFolderId}"]`;
      const imageSelector = `[data-ident="${ident}"]`;

      // Wait for the library to actually show items, then scope every
      // following lookup to THAT library window — so a leftover thumbnail or
      // a hidden second library elsewhere on the page can't be clicked.
      log(`${label}: waiting for the library to open...`);
      const firstItem = await waitForVisibleElement(`${folderSelector}, .library-item`, t);
      const popupsNow = libraryPopups();
      const lib = popupsNow.length ? popupsNow[popupsNow.length - 1] : closestModal(firstItem);
      await sleep(400); // let the list finish rendering

      if (visibleIn(lib, imageSelector)) {
        log(`${label}: library already inside the folder — skipping the folder click.`);
      } else {
        log(`${label}: opening "My Artistly Images" folder...`);
        const folder = await waitForCondition(() => visibleIn(lib, folderSelector), t);
        if (!folder) throw new Error(`Folder ${rp.libraryFolderId} never appeared in the library`);
        visibleIn(lib, folderSelector).click();
      }

      log(`${label}: selecting image ${ident}...`);
      const gotImage = await waitForCondition(() => visibleIn(lib, imageSelector), t);
      if (!gotImage) throw new Error(`Image ${ident} never appeared in the folder — check the ID in the generator`);
      await sleep(300);
      visibleIn(lib, imageSelector).click();

      log(`${label}: clicking Choose...`);
      const isChoose = el => isVisible(el) && el.textContent.trim().toLowerCase() === 'choose' && !el.disabled;
      const gotChoose = await waitForCondition(() => Array.from(lib.querySelectorAll(rp.chooseButtonSelector)).find(isChoose) || Array.from(document.querySelectorAll(rp.chooseButtonSelector)).find(isChoose), t);
      if (!gotChoose) throw new Error('"Choose" button never became clickable (was the image selected?)');
      const chooseBtn = Array.from(lib.querySelectorAll(rp.chooseButtonSelector)).find(isChoose) || Array.from(document.querySelectorAll(rp.chooseButtonSelector)).find(isChoose);
      await sleep(200);
      chooseBtn.click();

      // Confirm the photo actually landed in THIS slot.
      await waitForCondition(() => !isVisible(chooseBtn), 5000);
      if (openLibraryCount() > 0) {
        console.warn(`[VE-Automation] ${label}: a library popup is still open after Choose — closing it.`);
        await closeOpenLibraries();
      }
      const landed = await waitForCondition(() => refSlotFilled(slotIndex), 10000);
      await sleep(300);
      if (!landed) {
        // v1.8: warning only — never re-open the library because of this
        // check (that is what caused the double popups in v1.7).
        console.warn(`[VE-Automation] ${label}: Choose was clicked, but the slot preview didn't visibly change — continuing anyway.`);
      }
      log(`${label}: selected.`);
      return true;
    } catch (err) {
      console.warn(`[VE-Automation] ${label} library pick failed:`, err);
      dumpLibraryDiagnostics(label, ident);
      log(`${label}: auto-pick failed — ${err.message} (see console).`);
      return false;
    }
  }
  // v2.8: collects why VideoExpress may have refused "Create Image": any visible
  // error/alert/toast text, the prompt length vs the box's limit, and whether the
  // cursor was moved back into the prompt box (what forms do on a rejected field).
  function imageRefusalReason(promptEl, btn) {
    const ERR_SEL = '.alert, .alert-danger, .alert-warning, .error, .error-message, .invalid-feedback, .help-block, .text-danger, .toast, .toast-body, .noty_body, .swal2-html-container, .swal2-title, .notification, [role="alert"], .bbm-modal__section .message';
    const texts = Array.from(document.querySelectorAll(ERR_SEL)).filter(isVisible).map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 300 && !/two-factor|protect your account/i.test(t));
    const ml = promptEl ? parseInt(promptEl.getAttribute('maxlength') || '', 10) : NaN;
    return {
      message: texts[0] || '',
      allMessages: texts.slice(0, 5),
      length: promptEl ? promptEl.value.length : 0,
      maxLength: Number.isFinite(ml) ? ml : null,
      promptFocused: !!promptEl && document.activeElement === promptEl,
      buttonDisabled: !!(btn && (btn.disabled || btn.classList.contains('disabled')))
    };
  }
  // v3.0: after "Use consistent character" is ticked, VideoExpress should show the
  // Reference Photo / Reference Photo 2 slots. If the box looks ticked but the slots
  // stay hidden, the site didn't receive the tick the way it listens for it — so
  // nudge it the other ways a site can listen (change event, jQuery, clicking the
  // visible custom checkbox), then report which element is still hiding the slots.
  function refAreaEl() { return document.querySelector('.consistent-character-image-container'); }
  function refAreaShown() {
    const area = refAreaEl();
    if (!area || !isVisible(area)) return false;
    return Array.from(area.querySelectorAll(CONFIG.referencePhoto.buttonSelector)).some(isVisible);
  }
  function whatHidesRefArea() {
    const area = refAreaEl();
    if (!area) return 'the photo area (.consistent-character-image-container) is not on the page';
    for (let n = area; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || n.classList.contains('hidden') || n.classList.contains('d-none')) {
        return `<${n.tagName.toLowerCase()} class="${n.className}"> is hidden (${cs.display === 'none' ? 'display:none' : cs.visibility === 'hidden' ? 'visibility:hidden' : 'class hidden'})`;
      }
    }
    return 'the photo slots exist but no Reference Photo button is visible';
  }
  // v3.1: VideoExpress sometimes leaves class "hidden" on
  // <div class="… consistent-character-image-container hidden"> after the box is
  // ticked, so the Reference Photo buttons never show. Remove it ourselves.
  function unhideRefArea(when) {
    const area = refAreaEl();
    if (!area) return false;
    let changed = false;
    ['hidden', 'd-none'].forEach(c => { if (area.classList.contains(c)) { area.classList.remove(c); changed = true; } });
    if (getComputedStyle(area).display === 'none') { area.style.display = ''; if (getComputedStyle(area).display === 'none') area.style.display = 'grid'; changed = true; }
    if (changed) console.log(`[VE-Automation] Removed "hidden" from the Reference Photo area (${when}).`);
    return changed;
  }
  async function ensureReferenceAreaVisible(cbEl) {
    unhideRefArea('after ticking Use consistent character');
    if (await waitForCondition(refAreaShown, 1500, 150)) return true;
    console.warn('[VE-Automation] "Use consistent character" is ticked but the Reference Photo slots did not appear — ' + whatHidesRefArea() + '. Nudging VideoExpress...');
    const tries = [
      ['change event', () => { cbEl.dispatchEvent(new Event('input', { bubbles: true })); cbEl.dispatchEvent(new Event('change', { bubbles: true })); }],
      ['jQuery change', () => { const $ = window.jQuery || window.$; if ($ && $.fn && $.fn.trigger) $(cbEl).trigger('change'); }],
      ['re-tick via the visible checkbox', async () => {
        const vis = (cbEl.closest('label') && cbEl.closest('label').querySelector('span')) || cbEl.closest('label') || cbEl;
        vis.click(); await sleep(400);
        if (cbEl.checked) return; // the click didn't untick — leave it
        vis.click(); await sleep(400);
        if (!cbEl.checked) cbEl.click();
      }]
    ];
    for (const [label, fn] of tries) {
      try { await fn(); } catch (e) { console.warn('[VE-Automation] ' + label + ' failed:', e); }
      if (await waitForCondition(refAreaShown, 1500, 150)) { log(`Reference Photo slots appeared after a ${label}.`); return true; }
    }
    const why = whatHidesRefArea();
    log(`"Use consistent character" is ticked but VideoExpress did not show the Reference Photo slots — ${why}. Untick and tick the box by hand once to see if they appear.`);
    console.warn('[VE-Automation] Reference Photo slots still hidden: ' + why, { checked: cbEl.checked, area: refAreaEl() });
    return false;
  }
  // NEW (v1.4): clears every reference slot that still holds a photo (e.g.
  // left over from the previous scene in a reused modal) by clicking each
  // visible trash/"Clear selection" button. Re-queries after every click,
  // since clearing one slot can re-render the others.
  async function clearReferencePhotoSlots() {
    const sel = CONFIG.referencePhoto.clearButtonSelector;
    // v1.8: only the trash buttons of the reference-photo slots (falls back
    // to the whole page only if none are found there), and each button is
    // clicked AT MOST ONCE — previously a button that stayed visible after
    // clearing got clicked up to 4 times.
    const inRefArea = () => Array.from(document.querySelectorAll(`.consistent-character-image-container ${sel}`)).filter(isVisible);
    const anywhere = () => Array.from(document.querySelectorAll(sel)).filter(isVisible);
    const clicked = new Set();
    for (let guard = 0; guard < 2; guard++) {
      const candidates = (inRefArea().length ? inRefArea() : anywhere()).filter(b => !clicked.has(b));
      const btn = candidates[0];
      if (!btn) break;
      clicked.add(btn);
      btn.click();
      await waitForCondition(() => !isVisible(btn), 3000);
      await sleep(400);
    }
    log(clicked.size
      ? `Reference Photo: cleared ${clicked.size} existing photo(s) before choosing.`
      : 'Reference Photo: no existing photos to clear.');
  }
  // NEW (v1.5): true when the generator says this scene has no characters
  // (referencePhotos is an empty list). An older generator that doesn't send
  // referencePhotos at all is NOT treated as "no characters".
  function sceneHasNoCharacters(payload) {
    // v1.7: the generator now sends castCount — trust it when present, so a
    // scene WITH characters is never treated as empty just because no ID
    // was found for them (they then get the 5s manual window instead).
    if (typeof payload.castCount === 'number') return payload.castCount === 0;
    return Array.isArray(payload.referencePhotos) &&
      payload.referencePhotos.filter(r => r && r.ident).length === 0;
  }
  // Picks every reference photo this scene needs, in order: 1st character
  // into "Reference Photo", 2nd into "Reference Photo 2".
  async function selectReferencePhotosForScene(payload) {
    await clearReferencePhotoSlots(); // always start every scene from empty slots
    let refs;
    if (Array.isArray(payload.referencePhotos)) {
      refs = payload.referencePhotos.filter(r => r && r.ident).slice(0, 2);
    } else {
      // Older generator without per-character IDs — keep the v1.2 behavior.
      refs = CONFIG.referencePhoto.fallbackImageIdent
        ? [{ name: null, ident: CONFIG.referencePhoto.fallbackImageIdent }]
        : [];
    }
    if (!refs.length) {
      log('Reference Photo: this scene has no character photo IDs — skipping the library pick.');
      return;
    }
    console.log('[VE-Automation] Reference photos for this scene:', refs);
    for (let i = 0; i < refs.length; i++) {
      // v1.8: exactly ONE attempt per slot — no automatic retry (a retry
      // re-clicked "Reference Photo" while the first library popup was
      // still open, stacking two popups).
      const ok = await selectReferencePhotoFromLibrary(i, refs[i].ident, refs[i].name);
      if (!ok) break; // if slot 1 failed, slot 2's button likely isn't there either
    }
  }
  async function applyAllFormOptions(payload, passLabel) {
    log(`Setting character style, checkboxes, and duration (${passLabel})...`);
    const allStyleSelects = document.querySelectorAll('select.select-type');
    console.log(`[VE-Automation] Found ${allStyleSelects.length} element(s) matching 'select.select-type'`, allStyleSelects);
    const styleSelect = await waitForElement('select.select-type');
    console.log('[VE-Automation] payload.characterStyle is exactly:', JSON.stringify(payload.characterStyle));
    const mappedStyle = lookupCharacterStyle(payload.characterStyle);
    console.log('[VE-Automation] Mapped to:', mappedStyle);
    setNativeValue(styleSelect, mappedStyle);
    const cb = CONFIG.checkboxDesiredState;
    const checkboxDefs = [
      // auto_enhance_prompt and enhance_video_prompt are deliberately NOT here —
      // selecting the reference photo resets them on VideoExpress's own side.
      // They're set once, separately, after that step instead — see runFlow().
      ["image_creative_mode", cb.image_creative_mode], // NEW (v1.3): must come before use_consistent_character
      // NEW (v1.5): a scene with no characters leaves this OFF (unticks it if
      // a previous scene left it on), so no reference-photo steps run at all.
      ["use_consistent_character", cb.use_consistent_character && !sceneHasNoCharacters(payload)],
      ["shared", cb.shared],
      ["advanced_mode", cb.advanced_mode],
      ["manual_video_length", cb.manual_video_length],
      ["talking_video", cb.talking_video],
    ];
    async function applyCheckboxes() {
      for (const [name, desired] of checkboxDefs) {
        let el;
        try {
          el = await waitForElement(`input[type='checkbox'][name='${name}']`, name === 'image_creative_mode' ? 5000 : CONFIG.timeouts.element);
        } catch (e) {
          if (name !== 'image_creative_mode') throw e;
          console.warn('[VE-Automation] "Use Creative mode" checkbox not found — skipping it and continuing.');
          continue;
        }
        await setCheckbox(el, desired, `${name} (${passLabel})`);
        // Right after "Use consistent character" is ticked, pick each
        // character's reference photo from the library, then carry on.
        if (name === 'use_consistent_character' && desired && el.checked) {
          await sleep(300); // let the reference-photo UI appear after the checkbox toggles
          await ensureReferenceAreaVisible(el); // v3.0: make sure VideoExpress actually showed the photo slots
          if (CONFIG.referencePhoto.enabled) await selectReferencePhotosForScene(payload);
        }
      }
    }
    await applyCheckboxes();
    const durationEl = await waitForElement('input#opt_video_duration');
    const duration = clamp(Math.round(payload.duration || 8), CONFIG.videoDurationRange.min, CONFIG.videoDurationRange.max);
    setNativeValue(durationEl, String(duration));
  }
  async function runFlow(payload) {
    try {
      const alreadyOpen = findBestMatch('#formGenerateFromPrompt') || findBestMatch('.bbm-modal.bbm-modal--open textarea#opt_prompt');
      if (alreadyOpen) {
        await checkPause();
        log('Modal already open — skipping the panel click, continuing with the rest of the flow.');
      } else {
        await checkPause();
        log('Opening Create Video From Prompt modal...');
        const openPanel = await waitForElement('.panel.panel-default.js-panel-button.button-generate-from-prompt');
        openPanel.click();
      }
      await checkPause();
      log('Pasting Image Prompt...');
      const imagePromptEl = await waitForElement('textarea#opt_prompt');
      console.log(`[VE-Automation] Image prompt: ${String(payload.image || '').length} characters; video prompt: ${String(payload.videoAudio || '').length} characters.`);
      setNativeValue(imagePromptEl, payload.image);
      await checkPause();
      log('Pasting Video/Audio Prompt...');
      const videoPromptEl = await waitForElement('textarea#opt_video_prompt');
      setNativeValue(videoPromptEl, payload.videoAudio);
      // v2.9: "Automatically enhance my image prompt" is always switched OFF —
      // first (before "Use consistent character" is ticked), and again after the
      // reference photo step and right before Create Image, because VideoExpress
      // re-ticks it on its own.
      async function forceAutoEnhanceOff(when) {
        const el = document.querySelector("input[type='checkbox'][name='auto_enhance_prompt']");
        if (!el) { console.warn(`[VE-Automation] "Auto enhance image prompt" checkbox not found (${when}).`); return; }
        if (el.checked) {
          el.click();
          await sleep(250);
          if (el.checked) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
          console.log(`[VE-Automation] Unticked "Automatically enhance my image prompt" (${when}) → now ${el.checked ? 'STILL ticked' : 'off'}.`);
        }
      }
      await forceAutoEnhanceOff('start');
      // v2.5: "Automatically enhance my video prompt" must be OFF. Found by its
      // name, or by its label text if the site renames the field. VideoExpress
      // re-ticks it on its own (consistent character, reference photo, image
      // generation), so it's switched off again at each of those points.
      function findEnhanceVideoBox() {
        const byName = Array.from(document.querySelectorAll("input[type='checkbox'][name='enhance_video_prompt']"));
        const visible = byName.find(isVisible) || byName[0];
        if (visible) return visible;
        const label = Array.from(document.querySelectorAll('label')).find(l => /enhance my video prompt|enhance video prompt/i.test(l.textContent || ''));
        return label ? (label.querySelector("input[type='checkbox']") || (label.htmlFor && document.getElementById(label.htmlFor))) : null;
      }
      async function forceEnhanceVideoOff(when) {
        const el = findEnhanceVideoBox();
        if (!el) { console.warn(`[VE-Automation] "Enhance video prompt" checkbox not found (${when}).`); return; }
        if (el.checked) {
          el.click();
          await sleep(250);
          if (el.checked) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
          console.log(`[VE-Automation] Unticked "Automatically enhance my video prompt" (${when}) → now ${el.checked ? 'STILL ticked' : 'off'}.`);
        }
      }
      await forceEnhanceVideoOff('start');
      await applyAllFormOptions(payload, 'single pass');
      // Check each reference slot (Photo 1, Photo 2) separately. If the
      // library auto-pick above worked, the slot already has a real image and
      // the 5s manual window is skipped automatically.
      const refContainers = document.querySelectorAll('.consistent-character-image-container .grid-col .select-image-container');
      const refSlots = [
        { el: refContainers[0], label: 'Reference Photo 1' },
        { el: refContainers[1], label: 'Reference Photo 2 (optional)' }
      ];
      function slotHasImage(container) {
        if (!container) return false;
        const wrap = container.querySelector('.overflow-hidden.rounded');
        return !!(wrap && !wrap.classList.contains('hidden'));
      }
      const PLACEHOLDER_IMAGE_SRC = '/img/icon-image-horiz.png';
      function slotImageSrc(container) {
        if (!container) return '';
        const img = container.querySelector('img');
        return (img && (img.getAttribute('src') || img.src)) || '';
      }
      function slotAlreadyHasRealImage(container) {
        const src = slotImageSrc(container);
        return !!src && !src.includes(PLACEHOLDER_IMAGE_SRC);
      }
      const noCharacters = sceneHasNoCharacters(payload);
      if (noCharacters) {
        await checkPause();
        log('Scene has no characters (the generator sent castCount 0 — no one is listed in this clip) — "Use consistent character" left off.');
      }
      // v1.6: when the generator sent character photo IDs, the photos were
      // auto-picked — skip every 5s manual window. Only without any IDs
      // (older generator payload) does the 5s window still run.
      const hasRefIds = Array.isArray(payload.referencePhotos) && payload.referencePhotos.some(r => r && r.ident);
      if (hasRefIds) log('Reference photos set from character IDs — skipping the 5s manual windows.');
      for (const slot of ((noCharacters || hasRefIds) ? [] : refSlots)) {
        if (!slot.el) continue; // second slot may not exist if only one character in this scene
        if (slotAlreadyHasRealImage(slot.el)) {
          await checkPause();
          log(`${slot.label}: reference photo already selected (src isn't the blank placeholder) — skipping the 5s window.`);
          continue;
        }
        await checkPause();
        log(`${slot.label}: 5s window — click Reference Photo / Clear within it if you want to change it, otherwise it's kept as-is...`);
        let clickedInSlot = false;
        const slotListener = (e) => { if (slot.el.contains(e.target)) clickedInSlot = true; };
        document.addEventListener('click', slotListener, true);
        await sleep(5000);
        document.removeEventListener('click', slotListener, true);
        if (!clickedInSlot) {
          await checkPause();
          log(`${slot.label}: no change — ${slotHasImage(slot.el) ? 'keeping the existing image' : 'no image present, continuing anyway'}.`);
          continue;
        }
        await checkPause();
        log(`${slot.label}: change detected — waiting for the new selection to settle (take your time)...`);
        const settled = await waitForCondition(() => slotHasImage(slot.el), 180000);
        if (!settled) {
          console.warn(`[VE-Automation] ${slot.label} didn't settle within 3 minutes — continuing anyway.`);
        }
      }
      // No reference photo in either slot => turn consistent character off.
      // A no-character scene always counts as "empty", even if an old photo
      // is still sitting (hidden) in a slot — that keeps the single-image
      // wait below instead of waiting for pair images that never come.
      const bothRefPhotosEmpty = noCharacters || refSlots.every(slot => !slot.el || !slotHasImage(slot.el));
      if (bothRefPhotosEmpty) {
        if (!noCharacters) {
          const withId = Array.isArray(payload.referencePhotos) ? payload.referencePhotos.filter(r => r && r.ident).length : 0;
          const cast = typeof payload.castCount === 'number' ? payload.castCount : null;
          const reason = !withId
            ? `this scene's character${cast > 1 ? 's have' : ' has'} no VideoExpress reference photo ID in the generator — set it on the character card (Characters panel)`
            : `the reference photo pick from the library failed (see the console above)`;
          log(`No reference photo in either slot — ${reason}. Unticking "Use consistent character" before generating.`);
          console.warn(`[VE-Automation] Use consistent character switched OFF: ${reason}. castCount=${cast}, IDs sent=${withId}.`);
        }
        await setCheckbox(await waitForElement("input[type='checkbox'][name='use_consistent_character']"), false, 'use_consistent_character (no reference photos)');
      }
      // Set AFTER the reference photo step, since selecting it resets these.
      const cbFinal = CONFIG.checkboxDesiredState;
      await forceAutoEnhanceOff('after reference photo');
      await forceEnhanceVideoOff('after reference photo');
      // The site's own slide counter (aria-label="N / N") tells us when a
      // genuinely NEW slide was added.
      function getSwiperTotalCount() {
        const slide = document.querySelector('.swiper-slide[aria-label]');
        if (!slide) return 0;
        const match = (slide.getAttribute('aria-label') || '').match(/\/\s*(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      }
      const totalSlidesBefore = getSwiperTotalCount();
      await checkPause();
      log('Clicking Create Image...');
      const createImageBtn = await waitForElement('button.button-generate-image-submit');
      // v2.8: Did VideoExpress actually START an image? (loading picture, or a new slide).
      // If it refuses the request (prompt too long, no credits, a validation message…)
      // nothing starts — before v2.8 the script then waited 5 minutes for a slide that
      // never came. Now: one retry, then stop with the reason.
      const generationStarted = () => !!document.querySelector("img[src*='loading-paint3-horiz.gif']") || getSwiperTotalCount() > totalSlidesBefore;
      createImageBtn.click();
      await checkPause();
      log('Confirming image generation actually started...');
      let loadingStarted = await waitForCondition(generationStarted, 15000, 300);
      if (!loadingStarted) {
        const why = imageRefusalReason(imagePromptEl, createImageBtn);
        console.warn('[VE-Automation] Create Image did not start an image. Diagnostics:', why);
        log(`Create Image didn't start${why.message ? ` — VideoExpress says: "${why.message}"` : ''} — trying once more...`);
        await sleep(2000);
        if (!createImageBtn.disabled) createImageBtn.click();
        loadingStarted = await waitForCondition(generationStarted, 15000, 300);
        if (!loadingStarted) {
          const w2 = imageRefusalReason(imagePromptEl, createImageBtn);
          throw new Error(`VideoExpress did not start the image after clicking "Create Image" twice.\n\n` +
            (w2.message ? `VideoExpress message: "${w2.message}"\n` : '') +
            `Image prompt: ${w2.length} characters${w2.maxLength ? ` (this box allows ${w2.maxLength})` : ''}.\n` +
            (w2.promptFocused ? `VideoExpress put the cursor back in the Image Prompt box — it usually does that when it rejects the prompt (often because it is too long).\n` : '') +
            (w2.buttonDisabled ? `The Create Image button is disabled.\n` : '') +
            `\nTry clicking "Create Image" by hand to see VideoExpress's own message, then click ⚡ Paste & Generate to run this scene again.`);
        }
      }
      await checkPause();
      log('Waiting for image generation to finish...');
      await waitForAttributeNotContaining("img[src*='loading-paint3-horiz.gif']", 'src', 'loading-paint3-horiz.gif', CONFIG.timeouts.imageGeneration);
      await checkPause();
      log('Waiting for a genuinely new slide to appear...');
      const gotNewSlide = await waitForCondition(() => getSwiperTotalCount() > totalSlidesBefore, CONFIG.timeouts.imageSlideSelected);
      if (!gotNewSlide) {
        console.warn(`[VE-Automation] Slide count never rose above ${totalSlidesBefore} — continuing anyway.`);
      }
      await checkPause();
      log('Waiting for the new image to be selected...');
      if (bothRefPhotosEmpty) {
        // No reference photos => single plain slide, nothing to "select".
        const imageSlideReady = await waitForCondition(() => {
          const activeSlide = document.querySelector('.swiper-slide.swiper-slide-active.swiper-slide-visible.swiper-slide-fully-visible');
          const img = activeSlide && activeSlide.querySelector('img');
          const src = img && img.getAttribute('src');
          return !!(src && !src.includes('loading-paint3-horiz.gif'));
        }, CONFIG.timeouts.imageSlideSelected);
        if (!imageSlideReady) {
          console.warn('[VE-Automation] New image slide never became active/visible — continuing anyway.');
        }
      } else {
        // Two candidate images — auto-click whichever finishes rendering first.
        const autoPicked = await waitAndAutoSelectFirstReadyPairItem(CONFIG.timeouts.imageSlideSelected);
        if (!autoPicked) {
          console.warn('[VE-Automation] Auto-select of the first-ready pair image didn\'t land — falling back to waiting for a manual/site selection.');
          await waitForClassOnAny(
            '.swiper-slide.swiper-slide-pair.swiper-slide-visible.swiper-slide-active.swiper-slide-fully-visible .swiper-slide-pair-item',
            'selected',
            CONFIG.timeouts.imageSlideSelected
          );
        }
      }
      if (CONFIG.requireManualConfirmation) {
        await pauseForUser('Image generated — check it looks right, then continue to create the video.');
      }
      // Right before Create Video: image generation can re-tick them — switch them off again.
      await forceAutoEnhanceOff('before Create Video');
      await forceEnhanceVideoOff('before Create Video');
      await checkPause();
      log('Waiting for the Create Video button to become visible...');
      const createVideoBtn = await waitForElement('button.button-generate-video-submit:not(.hidden)');
      await checkPause();
      log('Clicking Create Video...');
      createVideoBtn.click();
      await checkPause();
      log('Done — video generation started.');
      returnToGeneratorTab(payload);
    } catch (err) {
      console.error('[VE-Automation] Failed:', err);
      alert('Automation stopped: ' + err.message + '\n\nCheck the console for details — the site\'s HTML may have changed, or a step timed out.');
    }
  }
  // v1.6: AUTOMATION LOOP — the generator (with its "Automation" box ticked)
  // sends the next scene straight to this tab via postMessage once the
  // previous one finishes. No clipboard and no tab focus needed.
  window.addEventListener('message', async (event) => {
    const d = event.data;
    if (!d || d.type !== 've-automation-run') return;
    if (window.opener && event.source !== window.opener) return; // only our generator tab
    const payload = d.payload;
    if (!payload || !payload.image || !payload.videoAudio) {
      console.warn('[VE-Automation] Automation message had no valid scene payload:', d);
      return;
    }
    log(`Automation: received scene ${payload.sceneNumber != null ? payload.sceneNumber : '?'} from the generator.`);
    // If a previous run is still finishing, wait for it rather than dropping this scene.
    await waitForCondition(() => !isRunning, CONFIG.timeouts.element, 500);
    const raw = JSON.stringify(payload);
    if (processedRaws.has(raw)) {
      log(`Automation: scene ${payload.sceneNumber} already ran (picked up from the clipboard) — not running it twice.`);
      return;
    }
    await triggerRun({ payload, raw, force: false });
  });
  injectButton();
  injectPauseButton();
  injectTimelineButton();
  setTimeout(warnIfDuplicateCopies, 3000); // after every copy has had time to add its button
  startAutoRunPolling();
})();
