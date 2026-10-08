(() => {
  const SERVER_URL = "https://almoghani-ai-backend-production.up.railway.app";
  const byId = id => document.getElementById(id);
  const button = byId("almChatBtn");
  const panel = byId("almChatPanel");
  const notice = byId("almChatNotice");
  const messages = byId("almChatMessages");
  const users = byId("almChatUsers");
  const audioContainer = byId("almChatAudio");
  const nameInput = byId("almChatName");
  const roomInput = byId("almChatRoom");
  const messageInput = byId("almChatInput");
  const peers = new Map();
  let socket;
  let localStream;
  let currentUserId;
  let isAdmin = false;
  let isMuted = false;
  let chatEnabled = true;
  let voiceEnabled = true;
  let voiceJoined = false;
  let members = [];

  try {
    nameInput.value = localStorage.getItem("almoghani-chat-name") || "";
  } catch {}

  function setNotice(text = "") {
    notice.textContent = text;
  }

  function setConnection(text) {
    byId("almChatConnection").textContent = text;
  }

  function closePanel() {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    button.setAttribute("aria-expanded", "false");
  }

  button.addEventListener("click", () => {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    button.setAttribute("aria-expanded", "true");
    byId("almAiPanel")?.classList.remove("open");
  });
  byId("almChatClose").addEventListener("click", closePanel);
  byId("almAiBtn")?.addEventListener("click", closePanel);

  function addMessage(message) {
    const item = document.createElement("article");
    item.className = `alm-chat-message${message.userId === currentUserId ? " own" : ""}`;
    item.dataset.messageId = message.id;
    const header = document.createElement("header");
    const name = document.createElement("strong");
    name.textContent = message.name || "زائر";
    const time = document.createElement("time");
    time.textContent = new Date(message.createdAt).toLocaleTimeString("ar", {
      hour: "2-digit",
      minute: "2-digit"
    });
    header.append(name, time);
    if (isAdmin) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "alm-chat-delete";
      remove.textContent = "حذف";
      remove.setAttribute("aria-label", "حذف الرسالة");
      remove.addEventListener("click", () => {
        adminAction({ action: "delete-message", messageId: message.id });
      });
      header.append(remove);
    }
    const text = document.createElement("div");
    text.textContent = message.text;
    item.append(header, text);
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
  }

  function renderMessages(history = []) {
    messages.replaceChildren();
    history.forEach(addMessage);
  }

  function renderUsers() {
    users.replaceChildren();
    members.forEach(member => {
      const row = document.createElement("div");
      row.className = "alm-admin-user";
      const label = document.createElement("span");
      label.textContent = member.name + (member.userId === currentUserId ? " (أنت)" : "");
      row.append(label);
      if (isAdmin && member.userId !== currentUserId) {
        const mute = document.createElement("button");
        mute.type = "button";
        mute.textContent = member.muted ? "إلغاء الكتم" : "كتم";
        mute.addEventListener("click", () => {
          adminAction({
            action: member.muted ? "unmute" : "mute",
            targetId: member.userId
          });
        });
        const ban = document.createElement("button");
        ban.type = "button";
        ban.textContent = "حظر";
        ban.addEventListener("click", () => {
          if (window.confirm(`حظر ${member.name} من هذه الغرفة؟`)) {
            adminAction({ action: "ban", targetId: member.userId });
          }
        });
        row.append(mute, ban);
      }
      users.append(row);
    });
    renderVoiceMembers();
  }

  function renderVoiceMembers() {
    const voiceMembers = byId("almVoiceMembers");
    const voiceIds = new Set([...peers.keys()]);
    if (voiceJoined && currentUserId) voiceIds.add(currentUserId);
    const names = members.filter(member => voiceIds.has(member.userId)).map(member => member.name);
    voiceMembers.textContent = names.length ? `المشاركون: ${names.join("، ")}` : "لا يوجد مشاركون صوتيون.";
  }

  function updateAdminControls(state = {}) {
    chatEnabled = state.chatEnabled ?? chatEnabled;
    voiceEnabled = state.voiceEnabled ?? voiceEnabled;
    byId("almChatAdmin").hidden = !isAdmin;
    byId("almChatAdminLogin").hidden = isAdmin;
    byId("almChatVisibility").textContent = chatEnabled ? "إخفاء الدردشة" : "إظهار الدردشة";
    byId("almVoiceVisibility").textContent = voiceEnabled ? "إغلاق الصوت" : "فتح الصوت";
    byId("almChatForm").hidden = !chatEnabled;
    byId("almChatMessages").hidden = !chatEnabled;
    byId("almVoiceJoin").disabled = !voiceEnabled || !socket?.connected || isMuted || voiceJoined;
  }

  function updateMemberMuted(userId, muted) {
    members = members.map(member => member.userId === userId ? { ...member, muted } : member);
    renderUsers();
  }

  function adminAction(action) {
    if (!socket?.connected || !isAdmin) return;
    socket.emit("admin:action", action, response => {
      if (response?.error) setNotice(response.error);
    });
  }

  function createPeer(userId) {
    if (peers.has(userId) || !localStream) return peers.get(userId);
    const peer = {
      connection: new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      }),
      pendingIce: []
    };
    peers.set(userId, peer);
    localStream.getTracks().forEach(track => peer.connection.addTrack(track, localStream));
    peer.connection.onicecandidate = event => {
      if (event.candidate) {
        socket.emit("voice:signal", { targetId: userId, type: "ice", data: event.candidate });
      }
    };
    peer.connection.ontrack = event => {
      let audio = byId(`alm-audio-${userId}`);
      if (!audio) {
        audio = document.createElement("audio");
        audio.id = `alm-audio-${userId}`;
        audio.autoplay = true;
        audio.playsInline = true;
        audioContainer.append(audio);
      }
      audio.srcObject = event.streams[0];
      audio.play().catch(() => setNotice("اضغط على الصفحة لتفعيل تشغيل الصوت."));
    };
    peer.connection.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(peer.connection.connectionState)) removePeer(userId);
    };
    renderVoiceMembers();
    return peer;
  }

  function removePeer(userId) {
    const peer = peers.get(userId);
    peer?.connection.close();
    peers.delete(userId);
    byId(`alm-audio-${userId}`)?.remove();
    renderVoiceMembers();
  }

  async function startOffer(userId) {
    const peer = createPeer(userId);
    if (!peer) return;
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      socket.emit("voice:signal", { targetId: userId, type: "offer", data: peer.connection.localDescription });
    } catch {
      setNotice("تعذر بدء الاتصال الصوتي بأحد المشاركين.");
    }
  }

  async function handleSignal(signal) {
    if (!voiceJoined || !localStream) return;
    const peer = createPeer(signal.userId);
    if (!peer) return;
    try {
      if (signal.type === "offer") {
        await peer.connection.setRemoteDescription(signal.data);
        const answer = await peer.connection.createAnswer();
        await peer.connection.setLocalDescription(answer);
        await Promise.all(peer.pendingIce.map(candidate => peer.connection.addIceCandidate(candidate)));
        peer.pendingIce = [];
        socket.emit("voice:signal", {
          targetId: signal.userId,
          type: "answer",
          data: peer.connection.localDescription
        });
      } else if (signal.type === "answer") {
        await peer.connection.setRemoteDescription(signal.data);
        await Promise.all(peer.pendingIce.map(candidate => peer.connection.addIceCandidate(candidate)));
        peer.pendingIce = [];
      } else if (signal.type === "ice") {
        if (peer.connection.remoteDescription) {
          await peer.connection.addIceCandidate(signal.data);
        } else {
          peer.pendingIce.push(signal.data);
        }
      }
    } catch {
      removePeer(signal.userId);
      setNotice("انقطع الاتصال الصوتي. حاول مغادرة الغرفة ثم الانضمام مجدداً.");
    }
  }

  async function leaveVoice(notifyServer = true) {
    if (notifyServer && socket?.connected) socket.emit("voice:leave");
    voiceJoined = false;
    peers.forEach(peer => peer.connection.close());
    peers.clear();
    audioContainer.replaceChildren();
    localStream?.getTracks().forEach(track => track.stop());
    localStream = undefined;
    byId("almVoiceJoin").disabled = !voiceEnabled || !socket?.connected || isMuted;
    byId("almVoiceMute").disabled = true;
    byId("almVoiceLeave").disabled = true;
    byId("almVoiceMute").textContent = "كتم الميكروفون";
    renderVoiceMembers();
  }

  function connect() {
    if (socket) socket.disconnect();
    currentUserId = undefined;
    isAdmin = false;
    const adminToken = byId("almChatAdminToken").value;
    const requestedAdmin = Boolean(adminToken);
    socket = window.io(SERVER_URL, {
      auth: { adminToken },
      transports: ["websocket", "polling"]
    });
    setConnection("جارٍ الاتصال…");
    socket.on("connect", () => {
      setConnection("متصل");
      const room = roomInput.value.trim() || "عام";
      const name = nameInput.value.trim();
      socket.emit("chat:join", { room, name }, response => {
        if (response?.error) {
          setNotice(response.error);
          setConnection("غير منضم");
          return;
        }
        currentUserId = response.userId;
        isAdmin = response.isAdmin;
        chatEnabled = response.chatEnabled;
        voiceEnabled = response.voiceEnabled;
        members = response.users.map(member => ({ ...member, muted: false }));
        isMuted = response.muted;
        renderMessages(response.messages);
        renderUsers();
        updateAdminControls(response);
        byId("almChatAdminToken").value = "";
        setNotice(requestedAdmin && !isAdmin ? "رمز المسؤول غير صحيح." : "");
        try {
          localStorage.setItem("almoghani-chat-name", name);
        } catch {}
      });
    });
    socket.on("connect_error", () => {
      setConnection("تعذر الاتصال");
      setNotice("تعذر الاتصال بخادم الدردشة. تحقق من اتصال الإنترنت.");
    });
    socket.on("disconnect", () => {
      setConnection("غير متصل");
      leaveVoice(false);
      updateAdminControls();
    });
    socket.on("chat:message", addMessage);
    socket.on("chat:message-deleted", ({ messageId }) => {
      messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)?.remove();
    });
    socket.on("chat:presence", ({ users: currentMembers }) => {
      members = currentMembers.map(member => ({
        ...member,
        muted: members.find(current => current.userId === member.userId)?.muted || false
      }));
      renderUsers();
    });
    socket.on("admin:member-updated", ({ userId, muted }) => updateMemberMuted(userId, muted));
    socket.on("chat:room-state", updateAdminControls);
    socket.on("chat:muted", ({ muted }) => {
      isMuted = muted;
      if (localStream) localStream.getAudioTracks().forEach(track => { track.enabled = !muted; });
      byId("almVoiceJoin").disabled = !voiceEnabled || !socket.connected || muted || voiceJoined;
      byId("almVoiceMute").textContent = muted ? "تم كتمك" : "كتم الميكروفون";
      if (muted) leaveVoice();
      setNotice(muted ? "قام المسؤول بكتمك في هذه الغرفة." : "تم إلغاء كتمك.");
    });
    socket.on("chat:banned", () => {
      setNotice("تم حظرك من هذه الغرفة.");
      setConnection("تم الحظر");
    });
    socket.on("voice:peer-joined", ({ userId }) => {
      if (voiceJoined) startOffer(userId);
    });
    socket.on("voice:peer-left", ({ userId }) => removePeer(userId));
    socket.on("voice:signal", handleSignal);
    socket.on("voice:closed", () => {
      leaveVoice(false);
      setNotice("أغلق المسؤول الغرفة الصوتية.");
    });
  }

  byId("almChatJoin").addEventListener("click", () => {
    if (!nameInput.value.trim()) {
      setNotice("أدخل اسماً أولاً.");
      nameInput.focus();
      return;
    }
    connect();
  });

  byId("almChatForm").addEventListener("submit", event => {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text || !socket?.connected) return;
    socket.emit("chat:message", { text }, response => {
      if (response?.error) setNotice(response.error);
    });
    messageInput.value = "";
    messageInput.focus();
  });

  document.querySelectorAll(".alm-chat-tabs button").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".alm-chat-tabs button").forEach(button => {
        button.classList.toggle("active", button === tab);
      });
      const voice = tab.dataset.tab === "voice";
      byId("almChatTextView").hidden = voice;
      byId("almChatVoiceView").hidden = !voice;
    });
  });

  byId("almVoiceJoin").addEventListener("click", async () => {
    if (!socket?.connected || isMuted) {
      setNotice("انضم إلى الدردشة أولاً للسماح بالصوت.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice("المتصفح لا يدعم الوصول إلى الميكروفون.");
      return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      socket.emit("voice:join", response => {
        if (response?.error) {
          localStream?.getTracks().forEach(track => track.stop());
          localStream = undefined;
          setNotice(response.error);
          return;
        }
        voiceJoined = true;
        isMuted = false;
        byId("almVoiceJoin").disabled = true;
        byId("almVoiceMute").disabled = false;
        byId("almVoiceLeave").disabled = false;
        setNotice("أنت متصل صوتياً.");
        response.participants.forEach(startOffer);
        renderVoiceMembers();
      });
    } catch {
      setNotice("لم يتم السماح باستخدام الميكروفون.");
    }
  });

  byId("almVoiceMute").addEventListener("click", () => {
    isMuted = !isMuted;
    localStream?.getAudioTracks().forEach(track => { track.enabled = !isMuted; });
    byId("almVoiceMute").textContent = isMuted ? "تشغيل الميكروفون" : "كتم الميكروفون";
  });
  byId("almVoiceLeave").addEventListener("click", () => leaveVoice());
  byId("almChatAdminForm").addEventListener("submit", event => {
    event.preventDefault();
    if (!nameInput.value.trim()) {
      setNotice("أدخل اسمك ثم انضم إلى الغرفة.");
      return;
    }
    connect();
  });
  byId("almChatVisibility").addEventListener("click", () => {
    adminAction({ action: "chat-visibility", enabled: !chatEnabled });
  });
  byId("almVoiceVisibility").addEventListener("click", () => {
    adminAction({ action: "voice-visibility", enabled: !voiceEnabled });
  });
  byId("almChatUnbanForm").addEventListener("submit", event => {
    event.preventDefault();
    const name = byId("almChatUnbanName").value.trim();
    if (!name) return;
    adminAction({ action: "unban", name });
    byId("almChatUnbanName").value = "";
  });
})();
