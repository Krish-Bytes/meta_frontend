const state = {
  config: null,
  clients: new Map(),
  log: [],
  chats: new Map(),
  activeChat: null,
};

function fmtLastSeen(ts) {
  if (!ts) return "last seen recently";
  const delta = Math.max(0, Date.now() / 1000 - ts);
  if (delta < 10) return "last seen just now";
  if (delta < 60) return `last seen ${Math.floor(delta)}s ago`;
  if (delta < 3600) return `last seen ${Math.floor(delta / 60)}m ago`;
  return `last seen ${new Date(ts * 1000).toLocaleTimeString()}`;
}

function presenceText(row) {
  if (row.hidden) return "last seen not available";
  if (row.online) return "online";
  return fmtLastSeen(row.lastSeenAt);
}

function logLine(text) {
  state.log.unshift(`${new Date().toLocaleTimeString()} · ${text}`);
  state.log = state.log.slice(0, 40);
  const ol = document.getElementById("log");
  ol.innerHTML = state.log.map((x) => `<li>${x}</li>`).join("");
}

class PhoneClient {
  constructor(user) {
    this.user = user;
    this.ws = null;
    this.heartbeatTimer = null;
    this.contacts = [];
    this.connected = false;
    this.heartbeatsOn = false;
    this.visibility = user.visibility || "everyone";
  }

  connect() {
    if (this.connected && this.heartbeatsOn && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_err) {
        /* ignore */
      }
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ type: "auth", userId: this.user.id }));
    };
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "hello") {
        this.connected = true;
        this.heartbeatsOn = true;
        this.contacts = msg.contacts;
        this.startHeartbeats();
        render();
      }
      if (msg.type === "presence") {
        const row = this.contacts.find((c) => c.userId === msg.userId);
        if (row) {
          Object.assign(row, msg);
        }
        logLine(
          `${this.user.name} received push: ${msg.displayName} → ${presenceText(msg)} (${msg.reason})`
        );
        render();
      }
      if (msg.type === "chat") {
        const isFromMe = msg.from === this.user.id;
        const otherUserId = isFromMe ? msg.to : msg.from;
        const chatKey = `${this.user.id}:${otherUserId}`;
        if (!state.chats.has(chatKey)) {
          state.chats.set(chatKey, []);
        }
        state.chats.get(chatKey).push(msg);
        if (state.activeChat && state.activeChat.clientUserId === this.user.id && state.activeChat.contactUserId === otherUserId) {
          renderChat();
        }
      }
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.stopHeartbeats();
      render();
    };
  }

  startHeartbeats() {
    this.stopHeartbeats();
    const every = (state.config.heartbeatHintSeconds || 2) * 1000;
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatsOn && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, every);
  }

  stopHeartbeats() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  killBattery() {
    this.heartbeatsOn = false;
    this.stopHeartbeats();
    logLine(`${this.user.name}: battery died — socket left open, heartbeats stopped`);
    render();
  }

  airplane() {
    this.heartbeatsOn = false;
    this.stopHeartbeats();
    if (this.ws) this.ws.close();
    logLine(`${this.user.name}: airplane mode — TCP close (clean disconnect + debounce)`);
  }

  setVisibility(v) {
    this.visibility = v;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "visibility", visibility: v }));
    }
  }
}

function renderMetrics(m) {
  const keys = [
    ["onlineUsers", "Online users"],
    ["activeSessions", "Sessions"],
    ["heartbeats", "Heartbeats (no fan-out)"],
    ["state_broadcasts", "State pushes"],
    ["ttl_expiries", "Dead-phone TTLs"],
  ];
  document.getElementById("metrics").innerHTML = keys
    .map(
      ([k, label]) =>
        `<div class="metric"><span>${label}</span><strong>${m[k] ?? 0}</strong></div>`
    )
    .join("");
}

function render() {
  const root = document.getElementById("phones");
  root.innerHTML = "";
  for (const user of state.config.users) {
    const client = state.clients.get(user.id);
    const card = document.createElement("article");
    card.className = "phone";
    const rows = (client.contacts || [])
      .map((c) => {
        const klass = !c.hidden && c.online ? "online" : "";
        return `<div class="contact" onclick="openChat('${user.id}', '${c.userId}')" style="cursor: pointer;">
          <div class="avatar">${c.displayName[0]}</div>
          <div>
            <div class="who">${c.displayName}</div>
            <div class="when ${klass}">${presenceText(c)}</div>
          </div>
        </div>`;
      })
      .join("");
    card.innerHTML = `
      <div class="phone-bar">
        <div>
          <span class="status-dot ${client.connected ? "on" : ""}"></span>
          ${user.name}
          <div><small>${client.connected ? (client.heartbeatsOn ? "foreground + heartbeat" : "zombie socket (no heartbeat)") : "offline"}</small></div>
        </div>
      </div>
      <div class="contacts">${rows || "<p class='contact'>Not connected yet</p>"}</div>
      <div class="controls">
        <button class="primary" data-act="connect">Open WhatsApp</button>
        <button class="warn" data-act="battery">Kill battery (no WS close)</button>
        <button class="danger" data-act="air">Airplane mode</button>
        <select data-act="vis">
          <option value="everyone"${client.visibility === "everyone" ? " selected" : ""}>Last seen: everyone</option>
          <option value="contacts"${client.visibility === "contacts" ? " selected" : ""}>Last seen: contacts</option>
          <option value="nobody"${client.visibility === "nobody" ? " selected" : ""}>Last seen: nobody</option>
        </select>
      </div>
    `;
    card.querySelector('[data-act="connect"]').onclick = () => client.connect();
    card.querySelector('[data-act="battery"]').onclick = () => client.killBattery();
    card.querySelector('[data-act="air"]').onclick = () => client.airplane();
    card.querySelector('[data-act="vis"]').onchange = (e) => client.setVisibility(e.target.value);
    root.appendChild(card);
  }
  if (state.activeChat) {
    renderChat();
  }
}

function openChat(clientUserId, contactUserId) {
  state.activeChat = { clientUserId, contactUserId };
  document.getElementById("chat-modal").classList.remove("hidden");
  renderChat();
}

function closeChat() {
  state.activeChat = null;
  document.getElementById("chat-modal").classList.add("hidden");
}

function sendChatMessage() {
  if (!state.activeChat) return;
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;

  const client = state.clients.get(state.activeChat.clientUserId);
  if (client && client.connected && client.ws && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify({
      type: "chat",
      to: state.activeChat.contactUserId,
      text: text
    }));
    input.value = "";
  } else {
    alert("Not connected!");
  }
}

function renderChat() {
  if (!state.activeChat) return;
  const client = state.clients.get(state.activeChat.clientUserId);
  if (!client) return;
  const contact = (client.contacts || []).find((c) => c.userId === state.activeChat.contactUserId);
  if (!contact) return;

  document.getElementById("chat-avatar").textContent = contact.displayName[0];
  document.getElementById("chat-name").textContent = contact.displayName;
  
  const statusEl = document.getElementById("chat-status");
  statusEl.textContent = presenceText(contact);
  if (!contact.hidden && contact.online) {
    statusEl.className = "chat-status online";
  } else {
    statusEl.className = "chat-status";
  }

  const chatKey = `${state.activeChat.clientUserId}:${state.activeChat.contactUserId}`;
  const messages = state.chats.get(chatKey) || [];
  const msgContainer = document.getElementById("chat-messages");
  
  msgContainer.innerHTML = '<div class="message-demo-notice">Messages are ephemeral (not saved to disk).</div>' + 
    messages.map(msg => {
      const isFromMe = msg.from === client.user.id;
      const timeStr = new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      return `<div class="chat-message ${isFromMe ? 'outgoing' : 'incoming'}">
        <div class="chat-bubble">
          <div class="chat-text">${msg.text}</div>
          <div class="chat-time">${timeStr}${isFromMe ? ' <span class="chat-ticks">✓✓</span>' : ''}</div>
        </div>
      </div>`;
    }).join("");
  
  // Scroll to bottom
  msgContainer.scrollTop = msgContainer.scrollHeight;
}

async function boot() {
  state.config = await fetch("/api/config").then((r) => r.json());
  for (const user of state.config.users) {
    state.clients.set(user.id, new PhoneClient(user));
  }
  render();
  logLine("Connect a phone. Presence updates arrive only as WebSocket pushes.");
  setInterval(async () => {
    const m = await fetch("/api/metrics").then((r) => r.json());
    renderMetrics(m);
  }, 800);
}

boot();
