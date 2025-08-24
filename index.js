import express from "express";
import axios from "axios";
import cors from "cors";
import { WebSocketServer } from "ws";

const app = express();

// CORS configuration
app.use(cors({ origin: "*", methods: ["GET","POST","PUT","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"], credentials: true }));
app.use(express.json());

// WebSocket clients
const wsClients = new Set();
const wss = new WebSocketServer({ port: 8080 });
wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
});

// Helper: broadcast to all clients
function broadcast(message) {
  const data = JSON.stringify(message);
  wsClients.forEach(client => client.readyState === client.OPEN && client.send(data));
}

// Config
const config = {
  VERIFY_TOKEN: "kapturewaba",
  ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN || "your_access_token_here",
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID || "your_phone_number_id_here",
  API_VERSION: "v21.0",
  BASE_URL: "https://graph.facebook.com"
};

// In-memory storage
const activeCalls = new Map();
const callPermissions = new Map();

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === config.VERIFY_TOKEN) {
    console.log("Webhook verified ✅");
    res.status(200).send(challenge);
  } else res.sendStatus(403);
});

// Webhook to receive Meta call events
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  console.log(body)
  if (body.object !== "whatsapp_business_account") return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === "calls") {
        const calls = change.value.calls || [];
        for (const call of calls) {
          const callId = call.id;

          if (call.event === "connect" && call.session?.sdp) {
            // Store SDP answer from Meta
            activeCalls.set(callId, {
              ...activeCalls.get(callId),
              sdp_answer: call.session.sdp,
              status: "connected"
            });
            broadcast({ type: "call_connect", call_id: callId, sdp: call.session.sdp });
          }

          if (call.event === "terminate") {
            activeCalls.delete(callId);
            broadcast({ type: "call_terminate", call_id: callId });
          }

          if (call.event === "ringing") {
            broadcast({ type: "call_status", call_id: callId, status: "RINGING" });
          }

          if (call.event === "accepted") {
            broadcast({ type: "call_status", call_id: callId, status: "ACCEPTED" });
          }

          if (call.event === "rejected") {
            broadcast({ type: "call_status", call_id: callId, status: "REJECTED" });
          }
        }
      }
    }
  }
});

// Get SDP answer for client polling (optional)
app.get("/api/call-sdp/:call_id", (req, res) => {
  const call = activeCalls.get(req.params.call_id);
  if (!call) return res.status(404).json({ error: "Call not found" });
  res.json({ sdp: call.sdp_answer });
});

// Initiate call
app.post("/api/make-call", async (req, res) => {
  try {
    const { to, sdp_offer, tracking_data } = req.body;
    if (!to || !sdp_offer) return res.status(400).json({ error: "Phone number and SDP offer required" });

    if (!callPermissions.has(to)) {
      return res.status(403).json({ error: "Call permission not granted", code: 138006 });
    }

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
    if (callId) activeCalls.set(callId, { sdp_offer, status: "initiated" });

    res.json({ success: true, call_id: callId });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to initiate call", details: err.message });
  }
});

// Terminate call
app.post("/api/terminate-call", async (req, res) => {
  const { call_id } = req.body;
  if (!call_id) return res.status(400).json({ error: "Call ID required" });
  try {
    await axios.post(
      `${config.BASE_URL}/${config.API_VERSION}/${config.PHONE_NUMBER_ID}/calls`,
      { messaging_product: "whatsapp", call_id, action: "terminate" },
      { headers: { Authorization: `Bearer ${config.ACCESS_TOKEN}` } }
    );
    activeCalls.delete(call_id);
    broadcast({ type: "call_terminate", call_id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grant call permission (demo/testing)
app.post("/api/grant-call-permission", (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) return res.status(400).json({ error: "Phone number required" });
  callPermissions.set(phone_number, { granted: true, timestamp: new Date().toISOString() });
  res.json({ success: true, message: `Permission granted for ${phone_number}` });
});

// List active calls
app.get("/api/calls", (req, res) => {
  const calls = Array.from(activeCalls.entries()).map(([id, data]) => ({ call_id: id, ...data }));
  res.json({ active_calls: calls, total_count: calls.length });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date(), active_calls: activeCalls.size });
});

app.listen(3000, () => console.log("🚀 Backend running on port 3000"));
