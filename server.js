const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.static(__dirname));   // ← add this line
app.use(express.json());
app.use('/api/generate-script', cors({ origin: '*' }));

app.post('/api/generate-script', async (req, res) => {
    const { openaiKey, systemPrompt, userPrompt, model } = req.body;

    if (!openaiKey || !systemPrompt || !userPrompt) {
        return res.status(400).json({ error: 'Missing openaiKey, systemPrompt, or userPrompt' });
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openaiKey}`
            },
            body: JSON.stringify({
                model: model || 'gpt-5.6-terra',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                response_format: { type: 'json_object' }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(response.status).json({ error: `OpenAI error: ${errText.slice(0, 200)}` });
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) return res.status(502).json({ error: 'No content in OpenAI response' });

        res.json({ content });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));