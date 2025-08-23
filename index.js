import express from "express";

const app = express();
app.use(express.json());

// Meta webhook verification
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "kapturewaba";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified ✅");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Receiving webhook events
app.post("/webhook", (req, res) => {
  const body = req.body;
  console.log("Received webhook event:", JSON.stringify(body, null, 2));

  // Always respond 200 within 20 seconds
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));
