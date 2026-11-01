const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const app = express();

// ---------------------------------------------------------------------------
// HTTP to the AI provider — Node's https module instead of global fetch.
// Node's built-in fetch gives up if the provider hasn't started answering
// within 5 minutes ("fetch failed" / UND_ERR_HEADERS_TIMEOUT). A big story plan
// on a high-reasoning model can think longer than that before replying, so
// the provider calls use plain https with a 20-minute limit instead.
// ---------------------------------------------------------------------------
const AI_TIMEOUT_MS = 20 * 60 * 1000;
function httpRequest(url, { method = 'GET', headers = {}, body = null } = {}, timeoutMs = AI_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request(u, { method, headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const r = {
                    status: res.statusCode,
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    text: async () => text,
                    json: async () => JSON.parse(text),
                    clone: () => r
                };
                resolve(r);
            });
            res.on('error', reject);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`The AI provider did not answer within ${Math.round(timeoutMs / 60000)} minutes`)));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}
// One automatic retry for a dropped connection (not for timeouts or real errors).
async function aiFetch(url, opts) {
    try {
        return await httpRequest(url, opts);
    } catch (err) {
        if (/ECONNRESET|socket hang up|EPIPE|ECONNREFUSED|EAI_AGAIN/i.test(`${err.code || ''} ${err.message}`)) {
            return httpRequest(url, opts);
        }
        throw err;
    }
}

// OpenAI-compatible providers — all use the same /chat/completions format.
// The base URL is chosen here on the server (never taken from the browser),
// so the proxy can only ever call these three hosts.
const PROVIDERS = {
    openai: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com',
    openrouter: 'https://openrouter.ai/api/v1'
};
const DEFAULT_MODEL = {
    openai: 'gpt-5.6-terra',
    deepseek: 'deepseek-chat',
    openrouter: null // OpenRouter always needs an explicit model ID
};
// Reasoning level ("low" | "medium" | "high") chosen per task by the page's
// GPT-6 model plan. Sent only when given; if a model rejects it, the request
// is retried once without it.
const EFFORTS = new Set(['low', 'medium', 'high']);

app.use(express.static(__dirname));
// The system prompt alone is ~60-80 KB and long sources add more — express's
// default 100 KB JSON limit can reject requests with a 413, so raise it.
app.use(express.json({ limit: '20mb' }));
app.use('/api/generate-script', cors({ origin: '*' }));
app.use('/api/models', cors({ origin: '*' }));

function providerHeaders(provider, key) {
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
    };
    if (provider === 'openrouter') {
        headers['HTTP-Referer'] = 'http://localhost';
        headers['X-Title'] = 'ScriptGen Scene Generator';
    }
    return headers;
}

// Chat Completions first (works for every provider). Retries once without the
// reasoning level and once without JSON mode if the model rejects them.
async function callChat({ provider, key, model, systemPrompt, userPrompt, effort }) {
    const headers = providerHeaders(provider, key);
    let useEffort = EFFORTS.has(effort);
    let useJson = true;
    const makeBody = () => JSON.stringify({
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        ...(useJson ? { response_format: { type: 'json_object' } } : {}),
        ...(useEffort ? (provider === 'openrouter' ? { reasoning: { effort } } : { reasoning_effort: effort }) : {})
    });
    const url = `${PROVIDERS[provider]}/chat/completions`;
    let response = await aiFetch(url, { method: 'POST', headers, body: makeBody() });
    for (let tries = 0; tries < 2 && response.status === 400; tries++) {
        const errText = await response.clone().text();
        if (useEffort && /reasoning/i.test(errText)) useEffort = false;
        else if (useJson && /response_format|json_object|json mode/i.test(errText)) useJson = false;
        else break;
        response = await aiFetch(url, { method: 'POST', headers, body: makeBody() });
    }
    if (!response.ok) return { ok: false, status: response.status, errText: await response.text(), usedEffort: useEffort };
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const u = data.usage || {};
    return { ok: true, content, model: data.model || model, usage: { input: u.prompt_tokens, output: u.completion_tokens }, usedEffort: useEffort, api: 'chat' };
}

// Responses API — used when an OpenAI model (e.g. some GPT-6 models) is only
// served there and refuses Chat Completions.
async function callResponses({ provider, key, model, systemPrompt, userPrompt, effort }) {
    const headers = providerHeaders(provider, key);
    let useEffort = EFFORTS.has(effort);
    let useJson = true;
    const makeBody = () => JSON.stringify({
        model,
        instructions: systemPrompt,
        input: userPrompt,
        ...(useJson ? { text: { format: { type: 'json_object' } } } : {}),
        ...(useEffort ? { reasoning: { effort } } : {})
    });
    const url = `${PROVIDERS[provider]}/responses`;
    let response = await aiFetch(url, { method: 'POST', headers, body: makeBody() });
    for (let tries = 0; tries < 2 && response.status === 400; tries++) {
        const errText = await response.clone().text();
        if (useEffort && /reasoning/i.test(errText)) useEffort = false;
        else if (useJson && /format|json/i.test(errText)) useJson = false;
        else break;
        response = await aiFetch(url, { method: 'POST', headers, body: makeBody() });
    }
    if (!response.ok) return { ok: false, status: response.status, errText: await response.text(), usedEffort: useEffort };
    const data = await response.json();
    let content = data.output_text;
    if (!content && Array.isArray(data.output)) {
        content = data.output
            .filter(item => item && item.type === 'message' && Array.isArray(item.content))
            .flatMap(item => item.content)
            .filter(c => c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string')
            .map(c => c.text)
            .join('');
    }
    const u = data.usage || {};
    return { ok: true, content, model: data.model || model, usage: { input: u.input_tokens, output: u.output_tokens }, usedEffort: useEffort, api: 'responses' };
}

const NEEDS_RESPONSES_RE = /responses api|\/v1\/responses|v1\/chat\/completions|not supported (?:in|with|on) (?:the )?chat|only supported (?:in|with|on)|use the responses/i;

// Models found to work only on the Responses API go straight there next time.
const RESPONSES_ONLY = new Set();

async function callProvider(args) {
    if (args.provider === 'openai' && RESPONSES_ONLY.has(args.model)) return callResponses(args);
    let result = await callChat(args);
    // An OpenAI model that's only available on the Responses API → use it.
    if (!result.ok && args.provider === 'openai' && [400, 404].includes(result.status) && NEEDS_RESPONSES_RE.test(result.errText || '')) {
        result = await callResponses(args);
        if (result.ok) RESPONSES_ONLY.add(args.model);
    }
    return result;
}

app.post('/api/generate-script', async (req, res) => {
    // "openaiKey" is kept as the field name for backward compatibility —
    // it holds whichever provider's key the page sends.
    const { openaiKey, systemPrompt, userPrompt, model, reasoningEffort } = req.body;
    const provider = PROVIDERS[req.body.provider] ? req.body.provider : 'openai';
    const key = openaiKey || process.env[`${provider.toUpperCase()}_API_KEY`];
    const chosenModel = model || DEFAULT_MODEL[provider];

    if (!key || !systemPrompt || !userPrompt) {
        return res.status(400).json({ error: 'Missing API key, systemPrompt, or userPrompt' });
    }
    if (!chosenModel) {
        return res.status(400).json({ error: `No model given for ${provider}` });
    }

    try {
        const started = Date.now();
        const result = await callProvider({ provider, key, model: chosenModel, systemPrompt, userPrompt, effort: reasoningEffort });

        if (!result.ok) {
            return res.status(result.status).json({ error: `${provider} error: ${String(result.errText || '').slice(0, 300)}` });
        }
        if (!result.content) return res.status(502).json({ error: `No content in ${provider} response` });

        // Token usage in the terminal helps compare cost between models.
        const u = result.usage || {};
        const effortNote = result.usedEffort && EFFORTS.has(reasoningEffort) ? ` (${reasoningEffort})` : '';
        console.log(`[${new Date().toISOString()}] ${provider}/${chosenModel}${effortNote} via ${result.api} ${Date.now() - started}ms · in ${u.input ?? '?'} / out ${u.output ?? '?'} tokens`);

        res.json({ content: result.content, model: result.model, api: result.api, usage: u });
    } catch (err) {
        const detail = [err.message, err.code, err.cause && (err.cause.code || err.cause.message)].filter(Boolean).join(' / ');
        console.error(`[${new Date().toISOString()}] ${provider}/${chosenModel} request failed: ${detail}`);
        res.status(502).json({ error: `Could not get an answer from ${provider} (${detail}). The model may be overloaded or the request too large — try again.` });
    }
});

// Lists the model IDs this key can use, so the page can pick the right
// GPT-6 IDs automatically (and show which ones are available).
app.post('/api/models', async (req, res) => {
    const provider = PROVIDERS[req.body && req.body.provider] ? req.body.provider : 'openai';
    const key = (req.body && req.body.openaiKey) || process.env[`${provider.toUpperCase()}_API_KEY`];
    if (!key) return res.status(400).json({ error: 'Missing API key' });
    try {
        const response = await aiFetch(`${PROVIDERS[provider]}/models`, { headers: providerHeaders(provider, key) }, 30000);
        if (!response.ok) return res.status(response.status).json({ error: `${provider} error: ${(await response.text()).slice(0, 200)}` });
        const data = await response.json();
        const ids = (Array.isArray(data.data) ? data.data : []).map(m => m && m.id).filter(Boolean);
        res.json({ ids });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Lets the page confirm it's talking to THIS version of the server (an old
// deploy still running is the usual reason a fix "doesn't work").
const SERVER_VERSION = '2026-11-01.2';
app.get('/api/health', cors({ origin: '*' }), (req, res) => {
    res.json({ ok: true, version: SERVER_VERSION, aiTimeoutMinutes: AI_TIMEOUT_MS / 60000, features: ['models', 'responses-fallback', 'reasoning-effort', 'long-timeout'] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${SERVER_VERSION} running on port ${PORT} (providers: ${Object.keys(PROVIDERS).join(', ')})`));
