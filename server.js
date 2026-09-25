const express = require('express');
const cors = require('cors');
const app = express();

// OpenAI-compatible providers — all use the same /chat/completions format.
// The base URL is chosen here on the server (never taken from the browser),
// so the proxy can only ever call these three hosts.
const PROVIDERS = {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com',
    openrouter: 'https://openrouter.ai/api/v1'
};
const DEFAULT_MODEL = {
    openai: 'gpt-5.6-terra',
    deepseek: 'deepseek-chat',
    openrouter: null // OpenRouter always needs an explicit model ID
};

app.use(express.static(__dirname));
// The system prompt alone is ~60-80 KB and long sources add more — express's
// default 100 KB JSON limit can reject requests with a 413, so raise it.
app.use(express.json({ limit: '20mb' }));
app.use('/api/generate-script', cors({ origin: '*' }));

async function callProvider({ provider, key, model, systemPrompt, userPrompt }) {
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
    };
    if (provider === 'openrouter') {
        headers['HTTP-Referer'] = 'http://localhost';
        headers['X-Title'] = 'ScriptGen Scene Generator';
    }
    const makeBody = (jsonMode) => JSON.stringify({
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    });

    const url = `${PROVIDERS[provider]}/chat/completions`;
    let response = await fetch(url, { method: 'POST', headers, body: makeBody(true) });

    // Some models (especially via OpenRouter) reject JSON mode — retry once without it.
    if (response.status === 400) {
        const errText = await response.clone().text();
        if (/response_format|json_object|json mode/i.test(errText)) {
            response = await fetch(url, { method: 'POST', headers, body: makeBody(false) });
        }
    }
    return response;
}

app.post('/api/generate-script', async (req, res) => {
    // "openaiKey" is kept as the field name for backward compatibility —
    // it holds whichever provider's key the page sends.
    const { openaiKey, systemPrompt, userPrompt, model } = req.body;
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
        const response = await callProvider({ provider, key, model: chosenModel, systemPrompt, userPrompt });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(response.status).json({ error: `${provider} error: ${errText.slice(0, 200)}` });
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) return res.status(502).json({ error: `No content in ${provider} response` });

        // Token usage in the terminal helps compare cost between models.
        const u = data.usage || {};
        console.log(`[${new Date().toISOString()}] ${provider}/${chosenModel} ${Date.now() - started}ms · in ${u.prompt_tokens ?? '?'} / out ${u.completion_tokens ?? '?'} tokens`);

        res.json({ content, model: data.model || chosenModel, usage: data.usage || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} (providers: ${Object.keys(PROVIDERS).join(', ')})`));