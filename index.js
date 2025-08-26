import express from "express";
import axios from "axios";
import cors from "cors";
import { WebSocketServer } from "ws";
import http from "http";
import multer from "multer";
import session from "express-session";
import querystring from "querystring";

const app = express();
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());
app.use(
  session({
    secret: "super-secret-key",
    resave: false,
    saveUninitialized: true,
  })
);


const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI = "https://webhook-service-meta.onrender.com/auth/tiktok/callback"; // must match TikTok app settings



// HTTP + WS server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const wsClients = new Set();
wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
});

function broadcast(message) {
  const data = JSON.stringify(message);
  wsClients.forEach((client) => client.readyState === client.OPEN && client.send(data));
}

// Config
const config = {
  VERIFY_TOKEN: "kapturewaba",
  ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  API_VERSION: "v21.0",
  BASE_URL: "https://graph.facebook.com",
};

// In-memory storage
const activeCalls = new Map();

// Webhook verification
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === config.VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

// Webhook for WhatsApp calls
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.object !== "whatsapp_business_account") return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === "calls") {
        const calls = change.value.calls || [];
        for (const call of calls) {
          const callId = call.id;
          const direction = call.direction || "INBOUND";

          if (call.event === "connect" && call.session?.sdp && direction === "USER_INITIATED") {
            // Store SDP offer from WhatsApp
            activeCalls.set(callId, { sdp_offer: call.session.sdp, status: "incoming" });
            broadcast({ type: "incoming_call", call_id: callId, from: call.from, sdp: call.session.sdp });
          }

          if (call.event === "terminate") {
            activeCalls.delete(callId);
            broadcast({ type: "call_terminated", call_id: callId });
          }

          if (["accepted", "rejected", "ringing"].includes(call.event)) {
            broadcast({ type: "call_status", call_id: callId, status: call.event.toUpperCase() });
          }
        }
      }
    }
  }
});

// Frontend sends SDP answer to pre-accept
app.post("/api/preaccept-call", async (req, res) => {
  const { call_id, sdp } = req.body;
  if (!call_id || !sdp) return res.status(400).json({ error: "call_id and sdp required" });

  try {
    await axios.post(
      `${config.BASE_URL}/${config.API_VERSION}/${config.PHONE_NUMBER_ID}/calls`,
      {
        messaging_product: "whatsapp",
        call_id,
        action: "pre_accept",
        session: { sdp_type: "answer", sdp },
      },
      { headers: { Authorization: `Bearer ${config.ACCESS_TOKEN}` } }
    );
    activeCalls.set(call_id, { ...activeCalls.get(call_id), sdp_answer: sdp, status: "preaccepted" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept call after WebRTC connection is ready
app.post("/api/accept-call", async (req, res) => {
  const { call_id, sdp } = req.body;
  if (!call_id || !sdp) return res.status(400).json({ error: "call_id and sdp required" });

  try {
    await axios.post(
      `${config.BASE_URL}/${config.API_VERSION}/${config.PHONE_NUMBER_ID}/calls`,
      {
        messaging_product: "whatsapp",
        call_id,
        action: "accept",
        session: { sdp_type: "answer", sdp },
      },
      { headers: { Authorization: `Bearer ${config.ACCESS_TOKEN}` } }
    );
    activeCalls.set(call_id, { ...activeCalls.get(call_id), status: "accepted" });
    broadcast({ type: "call_status", call_id, status: "ACCEPTED" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Terminate call
app.post("/api/terminate-call", async (req, res) => {
  const { call_id } = req.body;
  if (!call_id) return res.status(400).json({ error: "call_id required" });

  try {
    await axios.post(
      `${config.BASE_URL}/${config.API_VERSION}/${config.PHONE_NUMBER_ID}/calls`,
      { messaging_product: "whatsapp", call_id, action: "terminate" },
      { headers: { Authorization: `Bearer ${config.ACCESS_TOKEN}` } }
    );
    activeCalls.delete(call_id);
    broadcast({ type: "call_terminated", call_id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/make-call", async (req, res) => {
    const { to, sdp_offer, tracking_data } = req.body;
    if (!to || !sdp_offer) return res.status(400).json({ error: "Phone number and SDP offer required" });
  
    try {
      const callData = {
        messaging_product: "whatsapp",
        to,
        action: "connect",
        session: { sdp_type: "offer", sdp: sdp_offer }
      };
      if (tracking_data) callData.biz_opaque_callback_data = tracking_data;
  
      const response = await axios.post(
        `${config.BASE_URL}/${config.API_VERSION}/${config.PHONE_NUMBER_ID}/calls`,
        callData,
        { headers: { Authorization: `Bearer ${config.ACCESS_TOKEN}` } }
      );
  
      const callId = response.data.calls[0]?.id;
      if (callId) activeCalls.set(callId, { sdp_offer, status: "initiated", direction: "BUSINESS_INITIATED" });
  
      res.json({ success: true, call_id: callId });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: "Failed to initiate call", details: err.message });
    }
  });


  const upload = multer({ dest: "uploads/" });

app.post("/api/upload-recording", upload.single("recording"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No recording uploaded" });
  }

  console.log("File saved:", req.file.path);
  console.log("Extra fields:", req.body); // call_id, duration, timestamp

  res.json({ success: true, file: req.file.filename });
});

app.get("/auth/tiktok", (req, res) => {
  const state = Math.random().toString(36).substring(2);
  req.session.tiktok_oauth_state = state;

  const authUrl =
    "https://open-api.tiktok.com/platform/oauth/connect/?" +
    querystring.stringify({
      client_key: CLIENT_KEY,
      response_type: "code",
      scope: "user.info.basic",
      redirect_uri: REDIRECT_URI,
      state,
    });

  res.redirect(authUrl);
});


app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state } = req.query;

  if (state !== req.session.tiktok_oauth_state) {
    return res.status(403).send("Invalid state");
  }

  try {
    const response = await axios.post(
      "https://open.tiktokapis.com/v2/oauth/token/",
      querystring.stringify({
        client_key: CLIENT_KEY,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const data = response.data;
    console.log(data)
    // data includes access_token, refresh_token, open_id, etc.
    res.json(data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Error exchanging code for tokens");
  }
});

  

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
