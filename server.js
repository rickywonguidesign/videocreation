const express = require('express');
const cors = require('cors');
const { YoutubeTranscript } = require('youtube-transcript');
const app = express();

app.use(express.static(__dirname));   // ← add this line
app.use(express.json());
app.use('/api/generate-script', cors({ origin: '*' }));
app.use('/api/youtube-transcript', cors({ origin: '*' }));

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

// GET /api/youtube-transcript?videoId=<11-char id>&lang=<optional, e.g. "en">
// Responds 200 { transcript: "plain text, captions joined with spaces" }
// Responds 4xx/5xx { error: "message" } on any failure.
app.get('/api/youtube-transcript', async (req, res) => {
    const { videoId, lang } = req.query;

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Missing or invalid videoId' });
    }

    try {
        const segments = await YoutubeTranscript.fetchTranscript(
            videoId,
            lang ? { lang } : undefined
        );

        const transcript = segments
            .map(s => s.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!transcript) {
            return res.status(404).json({ error: 'No transcript text returned for this video' });
        }

        res.json({ transcript });
    } catch (err) {
        // Common causes: captions disabled for this video, video is private/
        // age-restricted/region-locked, or YouTube changed something the
        // library scrapes against (keep the youtube-transcript package
        // updated if this starts failing broadly). No extra prefix here —
        // the frontend adds its own "Could not fetch transcript:" wrapper,
        // so this stays just the underlying reason (e.g. "captions
        // disabled on this video").
        res.status(502).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));