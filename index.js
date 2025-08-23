import express from "express";
import axios from "axios";

const app = express();
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
    // Here you would integrate with your WebRTC stack
    // Example: processSDPAnswer(call.session.sdp, call.id);
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

    // Check if user has granted call permissions
    if (!callPermissions.has(to)) {
      return res.status(403).json({ 
        error: "Call permission not granted by user. Request permission first.",
        action: "request_permission"
      });
    }

    // Create SDP offer (simplified example)
    const defaultSDP = sdp_offer || `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=extmap-allow-mixed
a=msid-semantic: WMS
m=audio 9 UDP/TLS/RTP/SAVPF 111 103 104 9 0 8 106 105 13 110 112 113 126
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:4ZcD
a=ice-pwd:2/1muCWoOi3uQClrzz5UaqTuF
a=ice-options:trickle
a=fingerprint:sha-256 75:74:5A:A6:A4:E5:52:F4:A7:67:4C:01:C7:EE:91:3F:21:3D:A2:E3:53:7B:6F:30:86:F2:30:FF:A6:22:D9:35
a=setup:actpass
a=mid:0
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid
a=extmap:5 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id
a=extmap:6 urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id
a=sendrecv
a=msid:- 
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=rtcp-fb:111 transport-cc
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:103 ISAC/16000
a=rtpmap:104 ISAC/32000
a=rtpmap:9 G722/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:106 CN/32000
a=rtpmap:105 CN/16000
a=rtpmap:13 CN/8000
a=rtpmap:110 telephone-event/48000
a=rtpmap:112 telephone-event/32000
a=rtpmap:113 telephone-event/16000
a=rtpmap:126 telephone-event/8000`;

    const callData = {
      messaging_product: "whatsapp",
      to: to,
      action: "connect",
      session: {
        sdp_type: "offer",
        sdp: defaultSDP
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
  console.log(`   POST /api/make-call - Initiate a call`);
  console.log(`   POST /api/terminate-call - Terminate a call`);
  console.log(`   POST /api/request-call-permission - Request call permission`);
  console.log(`   POST /api/grant-call-permission - Grant call permission (testing)`);
  console.log(`   GET  /api/calls - Get active calls`);
  console.log(`   GET  /api/call-permissions - Get call permissions`);
  console.log(`   GET  /health - Health check`);
});

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