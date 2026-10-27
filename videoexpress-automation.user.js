// ==UserScript==
// @name         VideoExpress Scene Automation
// @namespace    videocreation-automation
// @version      1.6
// @description  Pastes a scene's Image Prompt + Video/Audio Prompt into VideoExpress's Create Video From Prompt modal, sets options, auto-picks the reference photo from the library, and drives it through Create Image -> Create Video. Auto-runs as soon as a new scene payload appears on the clipboard — no button click needed after the first one.
// @match        https://app.videoexpress.ai/*
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  // ============================================================
  // CONFIG — edit these to change behavior without touching the
  // engine logic below. Mirrors videoexpress-automation-flow.json.
  // ============================================================
  const CONFIG = {
    requireManualConfirmation: false, // set true to pause after image generation, before Create Video
    characterStyleMap: {
      "Human": "human",
      "2D": "2d",
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
      auto_enhance_prompt: true,
      image_creative_mode: true, // NEW (v1.3): ticked right BEFORE use_consistent_character
      use_consistent_character: true,
      shared: false,
      advanced_mode: true,
      enhance_video_prompt: true,
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
      libraryStep: 300000,            // 5 min — max wait for each step of the Reference Photo library picker
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
  // FLOATING BUTTON + STATUS UI
  // ============================================================
  let statusEl;
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
  async function selectReferencePhotoFromLibrary(slotIndex, ident, charName) {
    const rp = CONFIG.referencePhoto;
    const t = CONFIG.timeouts.libraryStep;
    const btnText = rp.slotButtonText[slotIndex];
    const label = `${btnText}${charName ? ` (${charName})` : ''}`;
    try {
      log(`${label}: opening the library...`);
      const refBtn = await waitForVisibleElement(
        rp.buttonSelector,
        t,
        el => el.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === btnText.toLowerCase()
      );
      refBtn.click();

      const folderSelector = `.library-item.library-folder.button-folder[data-id="${rp.libraryFolderId}"]`;
      const imageSelector = `[data-ident="${ident}"]`;
      const visibleMatch = (sel) => Array.from(document.querySelectorAll(sel)).find(isVisible) || null;
      log(`${label}: waiting for "My Artistly Images" folder...`);
      // The library may remember the last-open folder (e.g. on the second
      // pick), so accept either the folder tile OR the image already showing.
      const libraryReady = await waitForCondition(() => visibleMatch(folderSelector) || visibleMatch(imageSelector), t);
      if (!libraryReady) throw new Error(`Timed out waiting for folder ${rp.libraryFolderId} or image ${ident}`);
      if (!visibleMatch(imageSelector)) {
        await sleep(300); // let the library list finish rendering before clicking
        visibleMatch(folderSelector).click();
      }

      log(`${label}: selecting image ${ident}...`);
      const image = await waitForVisibleElement(imageSelector, t);
      await sleep(300);
      image.click();

      log(`${label}: clicking Choose...`);
      const chooseBtn = await waitForVisibleElement(
        rp.chooseButtonSelector,
        t,
        el => el.textContent.trim().toLowerCase() === 'choose' && !el.disabled
      );
      await sleep(200);
      chooseBtn.click();

      // Give the library modal a moment to close before the flow moves on.
      await waitForCondition(() => !isVisible(chooseBtn), 5000);
      await sleep(300);
      log(`${label}: selected.`);
      return true;
    } catch (err) {
      console.warn(`[VE-Automation] ${label} library pick failed — continuing with the normal flow (you can still pick one manually in the 5s window):`, err);
      log(`${label}: auto-pick failed — continuing (see console).`);
      return false;
    }
  }
  // NEW (v1.4): clears every reference slot that still holds a photo (e.g.
  // left over from the previous scene in a reused modal) by clicking each
  // visible trash/"Clear selection" button. Re-queries after every click,
  // since clearing one slot can re-render the others.
  async function clearReferencePhotoSlots() {
    const sel = CONFIG.referencePhoto.clearButtonSelector;
    const visibleClear = () => Array.from(document.querySelectorAll(sel)).find(isVisible) || null;
    let cleared = 0;
    for (let guard = 0; guard < 4; guard++) {
      const btn = visibleClear();
      if (!btn) break;
      btn.click();
      cleared++;
      // Wait for that button to hide (slot emptied) before looking again.
      await waitForCondition(() => !isVisible(btn), 3000);
      await sleep(300);
    }
    log(cleared
      ? `Reference Photo: cleared ${cleared} existing photo(s) before choosing.`
      : 'Reference Photo: no existing photos to clear.');
  }
  // NEW (v1.5): true when the generator says this scene has no characters
  // (referencePhotos is an empty list). An older generator that doesn't send
  // referencePhotos at all is NOT treated as "no characters".
  function sceneHasNoCharacters(payload) {
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
    for (let i = 0; i < refs.length; i++) {
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
        if (name === 'use_consistent_character' && desired && el.checked && CONFIG.referencePhoto.enabled) {
          await sleep(300); // let the reference-photo UI appear after the checkbox toggles
          await selectReferencePhotosForScene(payload);
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
        log('Modal already open — skipping the panel click, continuing with the rest of the flow.');
      } else {
        log('Opening Create Video From Prompt modal...');
        const openPanel = await waitForElement('.panel.panel-default.js-panel-button.button-generate-from-prompt');
        openPanel.click();
      }
      log('Pasting Image Prompt...');
      const imagePromptEl = await waitForElement('textarea#opt_prompt');
      setNativeValue(imagePromptEl, payload.image);
      log('Pasting Video/Audio Prompt...');
      const videoPromptEl = await waitForElement('textarea#opt_video_prompt');
      setNativeValue(videoPromptEl, payload.videoAudio);
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
        log('Scene has no characters — "Use consistent character" left off, skipping reference photos.');
      }
      // v1.6: when the generator sent character photo IDs, the photos were
      // auto-picked — skip every 5s manual window. Only without any IDs
      // (older generator payload) does the 5s window still run.
      const hasRefIds = Array.isArray(payload.referencePhotos) && payload.referencePhotos.some(r => r && r.ident);
      if (hasRefIds) log('Reference photos set from character IDs — skipping the 5s manual windows.');
      for (const slot of ((noCharacters || hasRefIds) ? [] : refSlots)) {
        if (!slot.el) continue; // second slot may not exist if only one character in this scene
        if (slotAlreadyHasRealImage(slot.el)) {
          log(`${slot.label}: reference photo already selected (src isn't the blank placeholder) — skipping the 5s window.`);
          continue;
        }
        log(`${slot.label}: 5s window — click Reference Photo / Clear within it if you want to change it, otherwise it's kept as-is...`);
        let clickedInSlot = false;
        const slotListener = (e) => { if (slot.el.contains(e.target)) clickedInSlot = true; };
        document.addEventListener('click', slotListener, true);
        await sleep(5000);
        document.removeEventListener('click', slotListener, true);
        if (!clickedInSlot) {
          log(`${slot.label}: no change — ${slotHasImage(slot.el) ? 'keeping the existing image' : 'no image present, continuing anyway'}.`);
          continue;
        }
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
        if (!noCharacters) log('No reference photos in either slot — unchecking "Use consistent character" before generating.');
        await setCheckbox(await waitForElement("input[type='checkbox'][name='use_consistent_character']"), false, 'use_consistent_character (no reference photos)');
      }
      // Set AFTER the reference photo step, since selecting it resets these.
      const cbFinal = CONFIG.checkboxDesiredState;
      await setCheckbox(await waitForElement("input[type='checkbox'][name='auto_enhance_prompt']"), cbFinal.auto_enhance_prompt, 'auto_enhance_prompt (after reference photo)');
      await setCheckbox(await waitForElement("input[type='checkbox'][name='enhance_video_prompt']"), cbFinal.enhance_video_prompt, 'enhance_video_prompt (after reference photo)');
      // The site's own slide counter (aria-label="N / N") tells us when a
      // genuinely NEW slide was added.
      function getSwiperTotalCount() {
        const slide = document.querySelector('.swiper-slide[aria-label]');
        if (!slide) return 0;
        const match = (slide.getAttribute('aria-label') || '').match(/\/\s*(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      }
      const totalSlidesBefore = getSwiperTotalCount();
      log('Clicking Create Image...');
      const createImageBtn = await waitForElement('button.button-generate-image-submit');
      createImageBtn.click();
      log('Confirming image generation actually started...');
      const loadingStarted = await waitForAttributeContaining("img[src*='loading-paint3-horiz.gif']", 'src', 'loading-paint3-horiz.gif', 8000);
      if (!loadingStarted) {
        console.warn('[VE-Automation] Loading indicator never appeared after clicking Create Image — the click may not have registered, or the site changed. Proceeding anyway, but this scene may end up using a stale image.');
      }
      log('Waiting for image generation to finish...');
      await waitForAttributeNotContaining("img[src*='loading-paint3-horiz.gif']", 'src', 'loading-paint3-horiz.gif', CONFIG.timeouts.imageGeneration);
      log('Waiting for a genuinely new slide to appear...');
      const gotNewSlide = await waitForCondition(() => getSwiperTotalCount() > totalSlidesBefore, CONFIG.timeouts.imageSlideSelected);
      if (!gotNewSlide) {
        console.warn(`[VE-Automation] Slide count never rose above ${totalSlidesBefore} — continuing anyway.`);
      }
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
      // One click right before Create Video, so nothing after this can undo it.
      await setCheckbox(await waitForElement("input[type='checkbox'][name='enhance_video_prompt']"), CONFIG.checkboxDesiredState.enhance_video_prompt, 'enhance_video_prompt (before Create Video)');
      log('Waiting for the Create Video button to become visible...');
      const createVideoBtn = await waitForElement('button.button-generate-video-submit:not(.hidden)');
      log('Clicking Create Video...');
      createVideoBtn.click();
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
    await triggerRun({ payload, raw: JSON.stringify(payload), force: true });
  });
  injectButton();
  startAutoRunPolling();
})();
