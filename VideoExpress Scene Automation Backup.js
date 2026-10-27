// ==UserScript==
// @name         VideoExpress Scene Automation
// @namespace    videocreation-automation
// @version      1.1
// @description  Pastes a scene's Image Prompt + Video/Audio Prompt into VideoExpress's Create Video From Prompt modal, sets options, and drives it through Create Image -> Create Video. Auto-runs as soon as a new scene payload appears on the clipboard — no button click needed after the first one.
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
      use_consistent_character: true,
      shared: false,
      advanced_mode: true,
      enhance_video_prompt: true,
      manual_video_length: true,
      talking_video: false
    },
    videoDurationRange: { min: 3, max: 10 },
    timeouts: {
      referenceImage: 15000,          // max wait for the FIRST reference image (required — this must be manually selected in the UI before running)
      secondReferenceImageGrace: 5000, // short grace period for a SECOND reference image (2-character scenes) — proceeds either way after this
      imageGeneration: 60000,
      imageSlideSelected: 30000
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
  function waitForElement(selector, timeoutMs = 15000) {
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
  // Resolves true/false rather than rejecting — used for the "wait a bit, then
  // proceed regardless" cases, like the optional second reference image.
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
  let lastProcessedRaw = null;
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
    if (!force && raw !== null && raw === lastProcessedRaw) {
      return; // already ran this exact scene payload — nothing new to do
    }
    isRunning = true;
    if (raw) lastProcessedRaw = raw;
    try {
      await runFlow(payload);
    } finally {
      isRunning = false;
      // Previously this re-showed the "👀 Watching clipboard..." idle
      // indicator 4s after every run, which is what kept stomping the
      // "Done — video generation started." message and made the status
      // box feel like it was stuck permanently displaying something.
      // updateStatus() below now auto-hides the box on its own after a
      // few seconds of no new message, so there's nothing left to do here
      // — the "Done" line (or an error) just sits, then fades on its own.
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
  // Every call to updateStatus() (including the idle "👀 Watching
  // clipboard..." message and every log() line during a run) now
  // auto-hides the status box 5s after whichever message was shown LAST
  // — each new message pushes the hide-timer back out, so a fast-moving
  // run keeps the box visible step to step and only fades once things go
  // quiet, instead of it sitting on screen forever like before.
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
  function returnToGeneratorTab() {
    if (!window.opener || window.opener.closed) {
      log('Video generation started. (No generator tab reference found — switch back manually. This happens if VideoExpress was opened by hand rather than via the generator\'s button.)');
      return;
    }
    // Chrome/Edge block window.focus() on regular background tabs entirely —
    // it only works for popup-style windows, regardless of user gesture. So
    // instead of fighting that, tell the generator tab it's done via
    // postMessage; the generator itself uses a real Notification, which IS
    // allowed to bring a tab to front when clicked (that's what it's for).
    try {
      window.opener.postMessage({ type: 've-automation-complete', ts: Date.now() }, '*');
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
      // selecting the reference photo (which happens after this function runs)
      // resets them on VideoExpress's own side, confirmed by manual testing.
      // They're set once, separately, after that reference-photo step instead —
      // see runFlow(). Setting them here first would just be wasted/undone work.
      ["use_consistent_character", cb.use_consistent_character],
      ["shared", cb.shared],
      ["advanced_mode", cb.advanced_mode],
      ["manual_video_length", cb.manual_video_length],
      ["talking_video", cb.talking_video],
    ];
    async function applyCheckboxes() {
      for (const [name, desired] of checkboxDefs) {
        await setCheckbox(await waitForElement(`input[type='checkbox'][name='${name}']`), desired, `${name} (${passLabel})`);
      }
    }
    await applyCheckboxes();
    const durationEl = await waitForElement('input#opt_video_duration');
    const duration = clamp(Math.round(payload.duration || 8), CONFIG.videoDurationRange.min, CONFIG.videoDurationRange.max);
    setNativeValue(durationEl, String(duration));
    // Note: no re-verification pass after this — each checkbox and the style
    // select each get exactly one set attempt, per your request. If the site
    // reverts something afterward (e.g. duration triggering a re-render),
    // this won't catch it — check the console for the final on-page state
    // rather than assuming this function's log lines reflect what's really
    // showing at the end.
  }
  async function runFlow(payload) {
    // payload is always provided now — triggerRun() (auto-poll or the manual
    // button) reads and validates the clipboard before calling this, so
    // there's exactly one clipboard read per attempt instead of two.
    try {
      const alreadyOpen = findBestMatch('#formGenerateFromPrompt') || findBestMatch('.bbm-modal.bbm-modal--open textarea#opt_prompt');
      if (alreadyOpen) {
        log('Modal already open — skipping the panel click, continuing with the rest of the flow.');
      } else {
        log('Opening Create Video From Prompt modal...');
        const openPanel = await waitForElement('.panel.panel-default.js-panel-button.button-generate-from-prompt', 10000);
        openPanel.click();
      }
      log('Pasting Image Prompt...');
      const imagePromptEl = await waitForElement('textarea#opt_prompt');
      setNativeValue(imagePromptEl, payload.image);
      log('Pasting Video/Audio Prompt...');
      const videoPromptEl = await waitForElement('textarea#opt_video_prompt');
      setNativeValue(videoPromptEl, payload.videoAudio);
      await applyAllFormOptions(payload, 'single pass');
      // A reference photo must be manually selected per character in the UI
      // before running this — the automation can't know which library photo
      // belongs to which character. This checks each reference slot (Photo 1,
      // Photo 2) SEPARATELY and in sequence, so existing photos from a reused
      // modal are kept by default, and only a slot you actually touch gets a
      // patient wait for its new selection to settle.
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
      // The blank/unselected state of a reference slot renders this exact
      // placeholder icon as its <img src>; once a real photo is chosen, the
      // src changes to that photo's own URL. Checking this BEFORE the 5s
      // manual-change window lets us skip the wait entirely when a photo is
      // already sitting in the slot (e.g. a reused modal) — there's nothing
      // to wait for, so move straight to the next slot/step instead of
      // pausing for 5s every single time regardless of state.
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
      for (const slot of refSlots) {
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
      // NEW: no reference photo in either slot means this scene isn't using a
      // consistent character at all — leaving the checkbox checked with both
      // slots empty can block Create Image or send a malformed request. Turn
      // it off before proceeding, same as the other checkbox fix-ups below.
      const bothRefPhotosEmpty = refSlots.every(slot => !slot.el || !slotHasImage(slot.el));
      if (bothRefPhotosEmpty) {
        log('No reference photos in either slot — unchecking "Use consistent character" before generating.');
        await setCheckbox(await waitForElement("input[type='checkbox'][name='use_consistent_character']"), false, 'use_consistent_character (no reference photos)');
      }
      // These two are set HERE, not earlier — selecting the reference photo
      // above is what resets them on VideoExpress's side (confirmed by manual
      // testing), so setting them before that point is pointless. One click
      // each, right after the actual trigger, nothing after this touches them again.
      const cbFinal = CONFIG.checkboxDesiredState;
      await setCheckbox(await waitForElement("input[type='checkbox'][name='auto_enhance_prompt']"), cbFinal.auto_enhance_prompt, 'auto_enhance_prompt (after reference photo)');
      await setCheckbox(await waitForElement("input[type='checkbox'][name='enhance_video_prompt']"), cbFinal.enhance_video_prompt, 'enhance_video_prompt (after reference photo)');
      // The site's own slide counter (aria-label="N / N") reliably tells us
      // when a genuinely NEW slide was added — more precise than guessing
      // from image URLs or the "selected" class alone, since a leftover
      // slide from an earlier scene could already have that class.
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
        // No reference photos => VideoExpress renders a single plain slide
        // with just an <img> directly inside .swiper-slide-active — never
        // the two-way "pair" comparison markup (.swiper-slide-pair /
        // .swiper-slide-pair-item.selected) that the branch below waits on.
        // That pair/selected structure only appears in consistent-character
        // mode, so waiting for it here hung forever. There's nothing to
        // "select" in this mode — the one slide IS the result — so just
        // confirm it's actually rendered with a real (non-loading) image.
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
        // Two candidate images render side by side per data-pair-index (0
        // and 1), both starting on the loading placeholder. Rather than
        // just waiting for the site (or a manual click) to mark one
        // ".selected", actively watch both and auto-click whichever one
        // finishes rendering FIRST — see waitAndAutoSelectFirstReadyPairItem
        // above. If that never manages to land a "selected" state (markup
        // never appeared, or the click didn't do what we expected), fall
        // back to the old passive wait so a manual pick still works.
        const autoPicked = await waitAndAutoSelectFirstReadyPairItem(CONFIG.timeouts.imageSlideSelected);
        if (!autoPicked) {
          console.warn('[VE-Automation] Auto-select of the first-ready pair image didn\'t land — falling back to waiting for a manual/site selection.');
          // Scoped to .swiper-slide-active specifically — swiper keeps every past
          // slide in the DOM (just transformed off-screen), so checking the whole
          // document for ANY .selected class was matching a leftover from an
          // earlier scene instantly, never actually waiting for the new one.
          // Requires the exact class combination on the parent slide (visible,
          // active, AND fully-visible) — not just "active" alone — so we only
          // match a slide that's genuinely settled into view, not one still
          // mid-transition.
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
      // Second touchpoint for this specific checkbox — image generation/selection
      // between here and the earlier check may reset it again. One click, right
      // before Create Video, so nothing after this can undo it before submission.
      await setCheckbox(await waitForElement("input[type='checkbox'][name='enhance_video_prompt']"), CONFIG.checkboxDesiredState.enhance_video_prompt, 'enhance_video_prompt (before Create Video)');
      log('Clicking Create Video...');
      log('Waiting for the Create Video button to become visible...');
      const createVideoBtn = await waitForElement('button.button-generate-video-submit:not(.hidden)');
      createVideoBtn.click();
      log('Done — video generation started.');
      returnToGeneratorTab();
    } catch (err) {
      console.error('[VE-Automation] Failed:', err);
      alert('Automation stopped: ' + err.message + '\n\nCheck the console for details — the site\'s HTML may have changed, or a step timed out.');
    }
  }
  injectButton();
  startAutoRunPolling();
})();