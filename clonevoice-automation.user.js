// ==UserScript==
// @name         CloneVoice Audio Automation
// @namespace    videocreation-automation
// @version      1.1
// @description  Pastes a scene's narration/dialogue into CloneVoice's Create Audio flow — title, reference language, script — selects the voice, sets emotion style, and generates the audio. v1.1: also accepts scenes sent directly by the generator's "Automation" loop and reports back which scene finished.
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
      emotionSelectAppear: 15000,
      waitForPreviousRun: 300000 // v1.1: an Automation scene that arrives mid-run waits up to 5 min for the current one
    }
  };

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
    // v1.1: wrapped so the click event isn't passed in as a "payload".
    btn.onclick = () => runFlow();
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
  // script. v1.1: sends its own message type plus the scene number, so the
  // generator's Automation loop knows WHICH line just finished and sends
  // the next one.
  // ============================================================

  function returnToGeneratorTab(payload) {
    if (!window.opener || window.opener.closed) {
      log('Audio generation started. (No generator tab reference found — switch back manually.)');
      return;
    }
    try {
      window.opener.postMessage({
        type: 'cv-automation-complete',
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
  // THE FLOW
  // ============================================================

  // v1.1: only one run at a time (manual button + Automation messages).
  let isRunning = false;

  // v1.1: `providedPayload` comes from the generator's Automation loop.
  // Without it (the floating button), the payload is read from the clipboard
  // exactly as before.
  async function runFlow(providedPayload) {
    if (isRunning) {
      log('Already running — ignoring this trigger.');
      return;
    }

    let payload = providedPayload;
    if (!payload) {
      try {
        const clip = await navigator.clipboard.readText();
        payload = JSON.parse(clip);
        if (!payload.script) throw new Error('missing script field');
      } catch (e) {
        alert('Could not read a valid scene payload from the clipboard. Click "Copy → CloneVoice" on your scene generator first, then click this button.');
        return;
      }
    }

    isRunning = true;
    try {
      log(`Scene ${payload.sceneNumber != null ? payload.sceneNumber : '?'}: clicking Create Audio...`);
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
      isRunning = false; // free up BEFORE notifying, so the next Automation scene isn't blocked
      returnToGeneratorTab(payload);
    } catch (err) {
      console.error('[CV-Automation] Failed:', err);
      alert('Automation stopped: ' + err.message + '\n\nCheck the console for details — the site\'s HTML may have changed, or a step timed out.');
    } finally {
      isRunning = false;
    }
  }

  // ============================================================
  // v1.1: AUTOMATION LOOP — the generator (with its "Automation" box
  // ticked) sends the next scene straight to this tab via postMessage once
  // the previous line has finished. No clipboard and no tab focus needed.
  // ============================================================
  window.addEventListener('message', async (event) => {
    const d = event.data;
    if (!d || d.type !== 'cv-automation-run') return;
    if (window.opener && event.source !== window.opener) return; // only our generator tab
    const payload = d.payload;
    if (!payload || !payload.script) {
      console.warn('[CV-Automation] Automation message had no valid scene payload:', d);
      return;
    }
    log(`Automation: received scene ${payload.sceneNumber != null ? payload.sceneNumber : '?'} from the generator.`);
    // If a previous run is still finishing, wait for it rather than dropping this scene.
    try {
      await waitForCondition(() => !isRunning, CONFIG.timeouts.waitForPreviousRun, 500);
    } catch (e) {
      log('Automation: previous run never finished — skipping this scene.');
      return;
    }
    await runFlow(payload);
  });

  injectButton();
})();
