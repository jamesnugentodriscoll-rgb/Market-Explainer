require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.warn("WARNING: ANTHROPIC_API_KEY is not set.");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image was uploaded." });
    }
    if (!API_KEY) {
      return res.status(500).json({ error: "Server is missing its API key." });
    }

    const base64 = req.file.buffer.toString("base64");
    const mediaType = req.file.mimetype;

    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
      return res.status(400).json({ error: "Please upload a PNG, JPG, WEBP, or GIF image." });
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system:
          "You are a sharp, experienced markets analyst who reads price charts the way a professional trading-desk analyst would: fluent in both technical structure (trend, support/resistance, volume, candlestick patterns, breakouts, divergences) and the fundamental/macro backdrop (earnings, guidance, economic data, central bank decisions, geopolitical events). You are precise about what the chart actually shows versus what you're inferring, and you never state a cause as certain when it's a plausible, publicly reported explanation.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              {
                type: "text",
                text: "This is a screenshot of a financial chart — a stock, index, forex pair, or crypto, on any timeframe from 1-minute to monthly (it may be from a trading platform like MetaTrader). Read it carefully: identify the instrument and timeframe from any visible labels/axes, then describe the price action precisely — direction and rough size of the move, where it sits relative to recent structure (breaking a range, testing a prior high/low, gapping, reversing a trend), and any notable candlestick or volume pattern. Then search the web for the most relevant recent news, earnings, guidance, economic data releases, or central bank action around the relevant date/time that plausibly explains the move — search for the specific instrument and date, not just generic market news. If the timeframe is short and the move is small, say plainly this scale of move is normal short-term noise rather than reaching for a news explanation. Be explicit that any cause given is the publicly reported likely explanation, not a certainty — markets often move for multiple overlapping reasons. Keep the whole answer under 220 words, no markdown headers, plain prose in 2-3 tight paragraphs.",
              },
            ],
          },
        ],
      }),
    });

    const raw = await anthropicRes.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error("Non-JSON response:", raw.slice(0, 500));
      return res.status(502).json({ error: "Unexpected response from the AI service." });
    }

    if (!anthropicRes.ok) {
      console.error("Anthropic API error:", data);
      return res.status(502).json({ error: data?.error?.message || "The AI service returned an error." });
    }

    const text = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
      .trim();

    if (!text) {
      return res.status(502).json({ error: "No analysis came back. Try a clearer screenshot." });
    }

    res.json({ analysis: text });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Something went wrong on the server." });
  }
});

app.listen(PORT, () => {
  console.log(`Market Explainer running on http://localhost:${PORT}`);
});
