// ==UserScript==
// @name         CloneVoice Audio Automation
// @namespace    videocreation-automation
// @version      1.4
// @description  Pastes a scene's narration/dialogue into CloneVoice's Create Audio flow — title, reference language, script — waits for manual voice selection, sets emotion style, and generates the audio. v1.3: original v1.0 flow, plus the generator's "Automation" loop (receives the next scene directly, reports which scene finished).
// @match        https://app.clonevoice.ai/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // CONFIG — edit these without touching the engine logic below.
  // ============================================================
  const CONFIG = {
    // Maps the generator's language dropdown values to the exact visible
    // option text in CloneVoice's language picker. If CloneVoice adds/renames
    // a language, fix the right-hand value here.
    languageMap: {
      "English": "English",
      "Vietnamese": "Vietnamese",
      "Japanese": "Japanese",
      "Korean": "Korean",
      "Chinese (Simplified)": "Chinese",
      "Spanish": "Spanish",
      "French": "French",
      "Thai": "Thai",
      "Indonesian": "Indonesian"
    },

    validEmotionValues: ["default", "calm", "happy", "confident", "warm"],

    timeouts: {
      languageDropdown: 10000,
      languageOption: 8000,
      voiceSelection: 120000, // generous — this is a manual step, the person needs time to browse and pick a voice
      emotionSelectAppear: 15000
    },

    // v1.4: AUTO-RUN — like the VideoExpress script, watch the clipboard and
    // start on its own when a NEW scene from "Copy → CloneVoice" shows up,
    // so the floating button doesn't need clicking. Clipboard reads only
    // work while this tab is focused, so it starts when you switch to it.
    autoRun: {
      enabled: true,
      pollIntervalMs: 1500,
      maxCopyAgeMs: 10 * 60 * 1000 // ignore scenes copied more than 10 min ago (stops an old clipboard re-running on page reload)
    },

    // v1.4: hide the Glasp browser-extension popup on this site — it sits
    // on top of CloneVoice's buttons. Set false to keep it.
    hideGlaspToaster: true
  };

  // ============================================================
  // v1.4: scenes already run — remembered across page reloads (this browser
  // only), so the same copied scene is never generated twice.
  // ============================================================
  const PROCESSED_KEY = 'cvAutomationProcessed';
  function hashStr(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }
  function loadProcessed() {
    try { return JSON.parse(localStorage.getItem(PROCESSED_KEY) || '[]'); } catch (e) { return []; }
  }
  function wasProcessed(raw) { return loadProcessed().includes(hashStr(raw)); }
  function markProcessed(raw) {
    try {
      const list = loadProcessed().filter(h => h !== hashStr(raw));
      list.push(hashStr(raw));
      localStorage.setItem(PROCESSED_KEY, JSON.stringify(list.slice(-50)));
    } catch (e) { /* storage blocked — auto-run still works, just without reload memory */ }
  }

  function hideGlaspToaster() {
    if (!CONFIG.hideGlaspToaster) return;
    const style = document.createElement('style');
    style.textContent = '.glasp-extension-toaster{display:none !important;pointer-events:none !important;}';
    (document.head || document.documentElement).appendChild(style);
  }

  // ============================================================
  // ENGINE — generic helpers, mirrors the VideoExpress script's approach.
  // ============================================================

  function log(msg) {
    console.log('[CV-Automation]', msg);
    updateStatus(msg);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    return el.offsetParent !== null;
  }

  function findBestMatch(selector) {
    const all = document.querySelectorAll(selector);
    if (all.length === 0) return null;
    for (const el of all) {
      if (isVisible(el)) return el;
    }
    return all[0];
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

  // Polls a predicate function until it returns a truthy value (usually an
  // element) — used for cases with no stable selector, like the emotion
  // select which has no data-agent-id and a dynamically-generated id.
  function waitForCondition(fn, timeoutMs = 15000, intervalMs = 200) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const result = fn();
        if (result) return resolve(result);
        if (Date.now() - start >= timeoutMs) {
          return reject(new Error('Timed out waiting for condition'));
        }
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  function waitForAttributeChange(el, attr, fromValue, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const check = () => el.getAttribute(attr) !== fromValue;
      if (check()) return resolve();

      const observer = new MutationObserver(() => {
        if (check()) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(el, { attributes: true, attributeFilter: [attr] });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for [${attr}] to change from "${fromValue}"`));
      }, timeoutMs);
    });
  }

  // More reliable than watching a trigger button's own attributes (which can
  // be stale/static depending on how the framework re-renders it) — waits
  // for a specific DOM node to be fully removed from the document. Radix UI
  // dialogs (confirmed in use here, per the console warning) unmount their
  // [role="dialog"] element entirely on close, which this detects directly.
  function waitForElementRemoved(el, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const check = () => !document.body.contains(el);
      if (check()) return resolve();

      const observer = new MutationObserver(() => {
        if (check()) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error('Timed out waiting for dialog to close'));
      }, timeoutMs);
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

  function findLanguageOption(desiredText) {
    const buttons = document.querySelectorAll('[data-agent-id^="option.audio.reference-language."]');
    for (const btn of buttons) {
      const nameSpan = btn.querySelector('span.truncate');
      if (nameSpan && nameSpan.textContent.trim() === desiredText) return btn;
    }
    return null;
  }

  // The emotion-style select has no data-agent-id and a dynamically
  // generated id — so instead of relying on either, find it by its
  // distinctive set of option values, which is far more stable.
  function findEmotionSelect() {
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      const vals = Array.from(sel.options).map(o => o.value);
      if (vals.includes('calm') && vals.includes('warm') && vals.includes('default')) {
        return sel;
      }
    }
    return null;
  }

  // ============================================================
  // FLOATING BUTTON + STATUS UI
  // ============================================================

  let statusEl;
  function injectButton() {
    const btn = document.createElement('button');
    btn.textContent = '⚡ Paste & Generate Audio';
    btn.style.cssText = `
      position:fixed; bottom:20px; right:20px; z-index:999998;
      background:#7E4FE6; color:#fff; border:none; padding:12px 18px;
      border-radius:8px; font-family:sans-serif; font-size:13px; font-weight:600;
      cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,.3);
    `;
    btn.onclick = () => runFlow(); // (v1.3: wrapped so the click event isn't taken as a payload)
    document.body.appendChild(btn);

    statusEl = document.createElement('div');
    statusEl.style.cssText = `
      position:fixed; bottom:66px; right:20px; z-index:999998;
      background:#222; color:#fff; padding:8px 12px; border-radius:6px;
      font-family:monospace; font-size:11px; max-width:280px; display:none;
    `;
    document.body.appendChild(statusEl);
  }

  function updateStatus(msg) {
    if (!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.textContent = msg;
  }

  // ============================================================
  // RETURN-TO-GENERATOR — same postMessage approach as the VideoExpress
  // script. v1.3: also sends the scene number, so the generator's
  // Automation loop knows which line finished and sends the next one.
  // ============================================================

  function returnToGeneratorTab(payload) {
    if (!window.opener || window.opener.closed) {
      log('Audio generation started. (No generator tab reference found — switch back manually.)');
      return;
    }
    try {
      window.opener.postMessage({
        type: 've-automation-complete',
        ts: Date.now(),
        sceneNumber: payload && payload.sceneNumber != null ? payload.sceneNumber : null
      }, '*');
      log('Audio generation started. Notified the generator tab — look for a notification, or switch back manually.');
    } catch (e) {
      console.error('[CV-Automation] postMessage to generator tab failed:', e);
      log('Audio generation started. Could not notify the generator tab automatically — switch back manually.');
    }
  }

  // ============================================================
  // THE FLOW — unchanged from v1.0, except the payload can now also be
  // handed in directly by the Automation loop (then the clipboard isn't read).
  // ============================================================

  let isRunning = false; // v1.3: lets an Automation scene wait for the current run

  async function runFlow(providedPayload) {
    let payload = providedPayload;
    if (!payload) {
      try {
        const clip = await navigator.clipboard.readText();
        payload = JSON.parse(clip);
        if (!payload.script) throw new Error('missing script field');
        markProcessed(clip);
      } catch (e) {
        alert('Could not read a valid scene payload from the clipboard. Click "Copy → CloneVoice" on your scene generator first, then click this button.');
        return;
      }
    }

    if (isRunning) {
      log('Already running — wait for the current scene to finish.');
      return;
    }
    markProcessed(JSON.stringify(payload)); // never auto-run this same scene again
    isRunning = true;
    try {
      log('Clicking Create Audio...');
      const createAudioBtn = await waitForElement('a[href*="/audio/create"] button');
      createAudioBtn.click();

      log('Setting audio name...');
      const titleInput = await waitForElement('[data-agent-id="input.audio.title"]');
      const firstFiveWords = payload.script.trim().split(/\s+/).slice(0, 5).join(' ');
      setNativeValue(titleInput, `Scene ${payload.sceneNumber} - ${firstFiveWords}`);

      log('Opening language dropdown...');
      const langTrigger = await waitForElement('[data-agent-id="select.audio.reference-language"]');
      langTrigger.click();

      log('Searching for the right language...');
      const searchInput = await waitForElement('[data-agent-id="input.audio.reference-language.search"]', CONFIG.timeouts.languageDropdown);
      const desiredLangText = CONFIG.languageMap[payload.language] || 'English';
      setNativeValue(searchInput, desiredLangText);

      const langOption = await waitForCondition(
        () => findLanguageOption(desiredLangText),
        CONFIG.timeouts.languageOption
      );
      langOption.click();

      log('Clicking Select Voice...');
      const voiceBtn = await waitForElement('[data-agent-id="select.audio.voice"]');
      voiceBtn.click();

      log('Waiting for the voice-selection dialog to open...');
      const voiceDialog = await waitForElement('[role="dialog"]', 10000);

      if (payload.voiceId) {
        log(`Selecting voice directly (id: ${payload.voiceId})...`);
        const exactVoiceBtn = await waitForElement(`[data-agent-id="action.voice.select.${payload.voiceId}"]`, 10000);
        exactVoiceBtn.click();
        log('Waiting for the dialog to close after selection...');
        await waitForElementRemoved(voiceDialog, 15000);
      } else {
        log('No voiceId provided — waiting for you to pick a voice and close the dialog manually...');
        await waitForElementRemoved(voiceDialog, CONFIG.timeouts.voiceSelection);
      }

      log('Pasting narration script...');
      const scriptArea = await waitForElement('[data-agent-id="textarea.audio.script"]');
      setNativeValue(scriptArea, payload.script);

      log('Clicking Create New Audio...');
      const submitBtn = await waitForElement('[data-agent-id="action.audio.submit"]');
      submitBtn.click();

      log('Setting emotion style...');
      const emotionSelect = await waitForCondition(
        () => findEmotionSelect(),
        CONFIG.timeouts.emotionSelectAppear
      );
      const desiredEmotion = payload.emotionStyle || 'default';
      const finalEmotion = CONFIG.validEmotionValues.includes(desiredEmotion) ? desiredEmotion : 'default';
      setNativeValue(emotionSelect, finalEmotion);

      log('Clicking Generate Audio...');
      const generateBtn = await waitForElement('[data-agent-id="action.audio.generate"]');
      generateBtn.click();

      log('Done — audio generation started.');
      isRunning = false;
      returnToGeneratorTab(payload);
    } catch (err) {
      console.error('[CV-Automation] Failed:', err);
      alert('Automation stopped: ' + err.message + '\n\nCheck the console for details — the site\'s HTML may have changed, or a step timed out.');
    } finally {
      isRunning = false;
    }
  }

  // ============================================================
  // v1.3: AUTOMATION — the generator (with its "Automation" box ticked)
  // sends the next scene straight to this tab once the previous line has
  // finished. It then runs the exact same flow as the button above.
  // ============================================================
  window.addEventListener('message', async (event) => {
    const d = event.data;
    if (!d || d.type !== 'cv-automation-run') return;
    const payload = d.payload;
    if (!payload || !payload.script) return;
    log(`Automation: received scene ${payload.sceneNumber} from the generator.`);
    // If the previous run is still finishing, wait for it (up to 5 min).
    const start = Date.now();
    while (isRunning && Date.now() - start < 300000) await sleep(500);
    await runFlow(payload);
  });

  // ============================================================
  // v1.4: AUTO-RUN POLLING — checks the clipboard every 1.5s while this tab
  // is focused; runs a scene payload it hasn't run before. The floating
  // button stays as a manual fallback (it always runs, even a repeat).
  // ============================================================
  function startAutoRunPolling() {
    if (!CONFIG.autoRun.enabled) return;
    setInterval(async () => {
      if (isRunning || !document.hasFocus()) return;
      let raw;
      try { raw = await navigator.clipboard.readText(); } catch (e) { return; } // permission not granted yet / no focus
      if (!raw || raw[0] !== '{' || wasProcessed(raw)) return;
      let payload;
      try { payload = JSON.parse(raw); } catch (e) { return; }
      if (!payload || !payload.script) return; // not a CloneVoice scene payload
      if (payload.copiedAt && Date.now() - payload.copiedAt > CONFIG.autoRun.maxCopyAgeMs) {
        markProcessed(raw); // stale copy — ignore for good
        return;
      }
      markProcessed(raw);
      log(`Auto-run: new scene ${payload.sceneNumber} found on the clipboard.`);
      await runFlow(payload);
    }, CONFIG.autoRun.pollIntervalMs);
    log('👀 Watching clipboard — click "Copy → CloneVoice" in the generator and this tab runs it automatically.');
  }

  hideGlaspToaster();
  injectButton();
  startAutoRunPolling();
})();
