require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const path = require("path");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const Stripe = require("stripe");

const app = express();
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_CENTS = 499; // $4.99
const COOKIE_NAME = "paid_token";
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1 year

if (!API_KEY) {
  console.warn("WARNING: ANTHROPIC_API_KEY is not set.");
}
if (!STRIPE_SECRET_KEY) {
  console.warn("WARNING: STRIPE_SECRET_KEY is not set.");
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// In-memory store of tokens/sessions that have paid.
// NOTE: this resets on server restart and does not work across multiple
// instances. Fine for a single small Render instance; swap for a real
// database (or Stripe Customer + subscription lookups) if you scale out.
const paidTokens = new Set();
const paidCheckoutSessions = new Set();

// Stripe webhook needs the RAW body, so this route must be registered
// BEFORE express.json()/express.static() body-parsing middleware touches it.
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(500).send("Webhook not configured.");
    }

    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.payment_status === "paid") {
        paidCheckoutSessions.add(session.id);
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

function isPaid(req) {
  const token = req.cookies?.[COOKIE_NAME];
  return !!token && paidTokens.has(token);
}

function requirePayment(req, res, next) {
  if (isPaid(req)) return next();
  return res.status(402).json({ error: "Payment required.", paymentRequired: true });
}

// Tells the frontend whether this browser is already unlocked.
app.get("/api/payment-status", (req, res) => {
  res.json({ paid: isPaid(req) });
});

// Creates a Stripe Checkout session for the one-time unlock.
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Payments are not configured on the server." });
    }
    const origin = `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: PRICE_CENTS,
            product_data: {
              name: "Chart, Explained. — Unlimited access",
              description: "One-time payment, unlimited chart analyses on this browser.",
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=1`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    res.status(500).json({ error: "Could not start checkout." });
  }
});

// Called when the browser lands back on the site after Stripe Checkout.
// Verifies payment server-side (don't trust the redirect alone), then
// issues an unguessable cookie token that unlocks future requests.
app.get("/api/verify-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Payments are not configured on the server." });
    }
    const { session_id } = req.query;
    if (!session_id) {
      return res.status(400).json({ error: "Missing session_id." });
    }

    let paid = paidCheckoutSessions.has(session_id);
    if (!paid) {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      paid = session.payment_status === "paid";
      if (paid) paidCheckoutSessions.add(session_id);
    }

    if (!paid) {
      return res.status(402).json({ error: "Payment not completed.", paid: false });
    }

    const token = crypto.randomBytes(32).toString("hex");
    paidTokens.add(token);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE_MS,
    });
    res.json({ paid: true });
  } catch (err) {
    console.error("Error verifying session:", err);
    res.status(500).json({ error: "Could not verify payment." });
  }
});

app.post("/api/analyze", requirePayment, upload.single("image"), async (req, res) => {
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
        max_tokens: 1500,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
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
                text: "This is a screenshot of a financial chart — a stock, index, forex pair, or crypto, on any timeframe from 1-minute to monthly (it may be from a trading platform like MetaTrader). First, identify the instrument and timeframe from any visible labels, and describe plainly what happened: direction and rough size of the move, and any notable pattern (gap, breakout, reversal, range, etc). Then search the web for recent news, earnings, economic data, or central bank decisions around the relevant date/time that plausibly explain the move. If the chart is a short intraday timeframe and the move is small, say plainly that this scale of move is normal short-term noise, rather than inventing a news explanation. Be clear any explanation is the publicly reported likely cause, not a certain one. Keep the whole answer under 200 words, no markdown headers, plain prose in 2-3 short paragraphs.",
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
