import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();

// CORS configuration
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:5174', // Vite dev server
    'http://localhost:5173',
    '*'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Configuration - Replace with your actual values
const config = {
  VERIFY_TOKEN: "kapturewaba",
  ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN || "your_access_token_here",
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID || "your_phone_number_id_here",
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN || "kapturewaba",
  API_VERSION: "v21.0", // Update to latest version
  BASE_URL: "https://graph.facebook.com"
};

// In-memory storage for call sessions (use database in production)
const activeCalls = new Map();
const callPermissions = new Map(); // Store user permissions

// API endpoint to get SDP answer for a specific call (polling alternative to WebSocket)
app.get("/api/call-sdp/:call_id", (req, res) => {
  const { call_id } = req.params;
  const callData = activeCalls.get(call_id);
  
  if (callData && callData.sdp_answer) {
    res.json({
      success: true,
      call_id: call_id,
      sdp_answer: callData.sdp_answer,
      status: callData.status
    });
  } else {
    res.status(404).json({
      error: "Call not found or SDP answer not available yet"
    });
  }
});

// Meta webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === config.VERIFY_TOKEN) {
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

  try {
    if (body.object === "whatsapp_business_account") {
      body.entry?.forEach(entry => {
        entry.changes?.forEach(change => {
          if (change.field === "calls") {
            handleCallWebhook(change.value);
          }
        });
      });
    }
  } catch (error) {
    console.error("Error processing webhook:", error);
  }

  // Always respond 200 within 20 seconds
  res.sendStatus(200);
});

// Handle different call webhook events
function handleCallWebhook(callData) {
  console.log("Processing call webhook:", callData);

  // Handle call events (connect, terminate)
  if (callData.calls) {
    callData.calls.forEach(call => {
      switch (call.event) {
        case "connect":
          handleCallConnect(call);
          break;
        case "terminate":
          handleCallTerminate(call);
          break;
        default:
          console.log("Unknown call event:", call.event);
      }
    });
  }

  // Handle call status updates (ringing, accepted, rejected)
  if (callData.statuses) {
    callData.statuses.forEach(status => {
      handleCallStatus(status);
    });
  }
}

function handleCallConnect(call) {
  console.log(`📞 Call connecting: ${call.id}`);
  console.log(`From: ${call.from} To: ${call.to}`);
  
  // Store call session info
  activeCalls.set(call.id, {
    ...call,
    status: "connecting",
    startTime: new Date().toISOString()
  });

  // Handle SDP Answer for WebRTC connection
  if (call.session && call.session.sdp) {
    console.log("📡 SDP Answer received for WebRTC connection");
    
    // Send SDP answer to frontend via WebSocket or store for polling
    const webhookEvent = {
      type: 'call_connect',
      call_id: call.id,
      sdp: call.session.sdp,
      timestamp: new Date().toISOString()
    };
    
    // If WebSocket server is available, broadcast to connected clients
    broadcastToWebSocketClients(webhookEvent);
    
    // Also store the SDP answer for the frontend to retrieve
    activeCalls.set(call.id, {
      ...activeCalls.get(call.id),
      sdp_answer: call.session.sdp,
      status: "sdp_answer_received"
    });
  }
}

function handleCallStatus(status) {
  console.log(`📊 Call status update: ${status.id} - ${status.status}`);
  
  const callSession = activeCalls.get(status.id);
  if (callSession) {
    callSession.status = status.status.toLowerCase();
    callSession.lastUpdate = new Date().toISOString();
    activeCalls.set(status.id, callSession);
  }

  // Send status update to frontend
  const webhookEvent = {
    type: 'call_status',
    call_id: status.id,
    status: status.status,
    timestamp: new Date().toISOString()
  };
  
  broadcastToWebSocketClients(webhookEvent);

  switch (status.status) {
    case "RINGING":
      console.log(`🔔 Call ${status.id} is ringing`);
      break;
    case "ACCEPTED":
      console.log(`✅ Call ${status.id} was accepted`);
      break;
    case "REJECTED":
      console.log(`❌ Call ${status.id} was rejected`);
      break;
  }
}

function handleCallTerminate(call) {
  console.log(`📞❌ Call terminated: ${call.id}`);
  console.log(`Duration: ${call.duration}s, Status: ${call.status}`);
  
  // Send termination event to frontend
  const webhookEvent = {
    type: 'call_terminate',
    call_id: call.id,
    duration: call.duration,
    status: call.status,
    timestamp: new Date().toISOString()
  };
  
  broadcastToWebSocketClients(webhookEvent);
  
  // Clean up call session
  activeCalls.delete(call.id);
}

// API endpoint to initiate a call
app.post("/api/make-call", async (req, res) => {
  try {
    const { to, sdp_offer, tracking_data } = req.body;

    if (!to) {
      return res.status(400).json({ error: "Phone number (to) is required" });
    }

    if (!sdp_offer) {
      return res.status(400).json({ error: "SDP offer is required for WebRTC connection" });
    }

    // Check if user has granted call permissions
    if (!callPermissions.has(to)) {
      return res.status(403).json({ 
        error: "Call permission not granted by user. Request permission first.",
        action: "request_permission",
        code: 138006
      });
    }

    const callData = {
      messaging_product: "whatsapp",
      to: to,
      action: "connect",
      session: {
        sdp_type: "offer",
        sdp: sdp_offer // Use the actual SDP offer from frontend
      }
    };

    // Add tracking data if provided
    if (tracking_data) {
      callData.biz_opaque_callback_data = tracking_data;
    }

    const response = await axios.post(
      `${config.BASE_URL}/${config.API_VERSION}/${config.PHONE_NUMBER_ID}/calls`,
      callData,
      {
        headers: {
          'Authorization': `Bearer ${config.ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log("📞 Call initiated successfully:", response.data);

    // Store call info
    if (response.data.calls && response.data.calls[0]) {
      const callId = response.data.calls[0].id;
      activeCalls.set(callId, {
        id: callId,
        to: to,
        status: "initiated",
        createdAt: new Date().toISOString(),
        tracking_data: tracking_data
      });
    }

    res.json({
      success: true,
      call_id: response.data.calls[0]?.id,
      data: response.data
    });

  } catch (error) {
    console.error("Error making call:", error.response?.data || error.message);
    
    // Handle specific error codes
    if (error.response?.data?.error?.code === 138006) {
      return res.status(403).json({ 
        error: "User has not granted call permission",
        code: 138006,
        action: "request_permission"
      });
    }

    res.status(500).json({ 
      error: "Failed to initiate call",
      details: error.response?.data || error.message 
    });
  }
});

// API endpoint to terminate a call
app.post("/api/terminate-call", async (req, res) => {
  try {
    const { call_id } = req.body;

    if (!call_id) {
      return res.status(400).json({ error: "Call ID is required" });
    }

    const terminateData = {
      messaging_product: "whatsapp",
      call_id: call_id,
      action: "terminate"
    };

    const response = await axios.post(
      `${config.BASE_URL}/${config.API_VERSION}/${config.PHONE_NUMBER_ID}/calls`,
      terminateData,
      {
        headers: {
          'Authorization': `Bearer ${config.ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log("📞❌ Call terminated successfully:", response.data);

    // Clean up local call data
    activeCalls.delete(call_id);

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    console.error("Error terminating call:", error.response?.data || error.message);
    res.status(500).json({ 
      error: "Failed to terminate call",
      details: error.response?.data || error.message 
    });
  }
});

// API endpoint to request call permission from user
app.post("/api/request-call-permission", async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to) {
      return res.status(400).json({ error: "Phone number (to) is required" });
    }

    const permissionMessage = message || 
      "Hi! We'd like to be able to call you on WhatsApp for better support. Would you like to allow calls from our business?";

    // Send a message requesting call permission
    const messageData = {
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: permissionMessage }
    };

    const response = await axios.post(
      `${config.BASE_URL}/${config.API_VERSION}/${config.PHONE_NUMBER_ID}/messages`,
      messageData,
      {
        headers: {
          'Authorization': `Bearer ${config.ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log("📨 Call permission request sent:", response.data);

    res.json({
      success: true,
      message: "Call permission request sent",
      data: response.data
    });

  } catch (error) {
    console.error("Error requesting call permission:", error.response?.data || error.message);
    res.status(500).json({ 
      error: "Failed to request call permission",
      details: error.response?.data || error.message 
    });
  }
});

// API endpoint to manually grant call permission (for testing)
app.post("/api/grant-call-permission", (req, res) => {
  const { phone_number } = req.body;
  
  if (!phone_number) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  callPermissions.set(phone_number, {
    granted: true,
    timestamp: new Date().toISOString()
  });

  console.log(`✅ Call permission granted for ${phone_number}`);
  
  res.json({
    success: true,
    message: `Call permission granted for ${phone_number}`
  });
});

// API endpoint to get active calls
app.get("/api/calls", (req, res) => {
  const calls = Array.from(activeCalls.entries()).map(([id, data]) => ({
    call_id: id,
    ...data
  }));

  res.json({
    active_calls: calls,
    total_count: calls.length
  });
});

// API endpoint to get call permissions
app.get("/api/call-permissions", (req, res) => {
  const permissions = Array.from(callPermissions.entries()).map(([phone, data]) => ({
    phone_number: phone,
    ...data
  }));

  res.json({
    permissions: permissions,
    total_count: permissions.length
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    active_calls: activeCalls.size,
    call_permissions: callPermissions.size
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Calling API server running on port ${PORT}`);
  console.log(`📞 Endpoints available:`);
  console.log(`   POST /api/make-call - Initiate a call (now accepts sdp_offer)`);
  console.log(`   POST /api/terminate-call - Terminate a call`);
  console.log(`   POST /api/request-call-permission - Request call permission`);
  console.log(`   POST /api/grant-call-permission - Grant call permission (testing)`);
  console.log(`   GET  /api/calls - Get active calls`);
  console.log(`   GET  /api/call-sdp/:call_id - Get SDP answer for call`);
  console.log(`   GET  /api/call-permissions - Get call permissions`);
  console.log(`   GET  /health - Health check`);
});

// WebSocket clients for real-time updates
const wsClients = new Set();

// Function to broadcast webhook events to connected WebSocket clients
function broadcastToWebSocketClients(event) {
  const message = JSON.stringify(event);
  wsClients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending WebSocket message:', error);
        wsClients.delete(client);
      }
    } else {
      wsClients.delete(client);
    }
  });
}

// Optional: Add WebSocket dependency and server
try {
  const WebSocket = require('ws');
  const wss = new WebSocket.Server({ port: 3001 });

  wss.on('connection', (ws) => {
    console.log('🔌 WebSocket client connected for real-time updates');
    wsClients.add(ws);
    
    ws.on('close', () => {
      console.log('🔌 WebSocket client disconnected');
      wsClients.delete(ws);
    });
    
    // Send initial connection confirmation
    ws.send(JSON.stringify({
      type: 'connection',
      message: 'Connected to WhatsApp calling service',
      timestamp: new Date().toISOString()
    }));
  });

  console.log('🔌 WebSocket server running on port 3001 for real-time updates');
} catch (error) {
  console.log('📝 WebSocket not available - clients will use polling instead');
  // Fallback: clients can poll the /api/call-sdp endpoint
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📞 Terminating all active calls...');
  // Terminate all active calls
  activeCalls.forEach(async (call, callId) => {
    try {
      await axios.post(
        `${config.BASE_URL}/${config.API_VERSION}/${config.PHONE_NUMBER_ID}/calls`,
        {
          messaging_product: "whatsapp",
          call_id: callId,
          action: "terminate"
        },
        {
          headers: {
            'Authorization': `Bearer ${config.ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error) {
      console.error(`Error terminating call ${callId}:`, error.message);
    }
  });
  
  process.exit(0);
});