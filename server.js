const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const http = require("http");
const { randomUUID, timingSafeEqual } = require("crypto");
const { Server } = require("socket.io");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(express.json({ limit: "20kb" }));

const corsOptions = {
  origin: [
    "https://almoghani.net",
    "https://www.almoghani.net"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

const io = new Server(server, {
  cors: {
    origin: corsOptions.origin,
    methods: ["GET", "POST"]
  },
  allowRequest: (request, callback) => {
    const origin = request.headers.origin;
    callback(null, !origin || corsOptions.origin.includes(origin));
  },
  maxHttpBufferSize: 100_000
});

const rooms = new Map();
const messageRateLimits = new Map();
const voiceSignalTypes = new Set(["offer", "answer", "ice"]);
const asObject = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const asCallback = value => typeof value === "function" ? value : () => {};

function normalizeRoomName(value) {
  return String(value || "عام").normalize("NFKC").trim().slice(0, 40) || "عام";
}

function normalizeUserName(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 32);
}

function getRoom(name) {
  for (const [roomName, room] of rooms) {
    if (
      room.members.size === 0 &&
      room.bannedNames.size === 0 &&
      room.emptySince &&
      Date.now() - room.emptySince > 5 * 60 * 1000
    ) {
      rooms.delete(roomName);
    }
  }
  if (!rooms.has(name)) {
    if (rooms.size >= 100) {
      for (const [roomName, room] of rooms) {
        if (room.members.size === 0 && room.bannedNames.size === 0) rooms.delete(roomName);
      }
    }
    if (rooms.size >= 100) return null;
    rooms.set(name, {
      messages: [],
      members: new Map(),
      voiceParticipants: new Set(),
      bannedNames: new Set(),
      mutedUsers: new Set(),
      chatEnabled: true,
      voiceEnabled: true,
      emptySince: undefined
    });
  }
  return rooms.get(name);
}

function isAdminTokenValid(token) {
  const expected = process.env.CHAT_ADMIN_TOKEN || "";
  if (!expected || typeof token !== "string") return false;
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function leaveVoice(socket, room, notify = true) {
  if (!socket || !room || !room.voiceParticipants.delete(socket.id)) return;
  if (notify) {
    io.to(`chat:${socket.data.roomName}`).emit("voice:peer-left", { userId: socket.id });
  }
}

function removeFromRoom(socket) {
  const roomName = socket.data.roomName;
  if (!roomName) return;
  const room = rooms.get(roomName);
  if (room) {
    leaveVoice(socket, room);
    room.members.delete(socket.id);
    if (room.members.size === 0) room.emptySince = Date.now();
    io.to(`chat:${roomName}`).emit("chat:presence", {
      users: [...room.members.values()].map(({ userId, name }) => ({ userId, name }))
    });
  }
  socket.leave(`chat:${roomName}`);
  delete socket.data.roomName;
  delete socket.data.name;
}

function canModerate(socket) {
  return socket.data.isAdmin === true;
}

io.use((socket, next) => {
  socket.data.isAdmin = isAdminTokenValid(socket.handshake.auth?.adminToken);
  next();
});

io.on("connection", socket => {
  socket.on("chat:join", (payload, callback) => {
    payload = asObject(payload);
    const acknowledge = asCallback(callback);
    const name = normalizeUserName(payload.name);
    const roomName = normalizeRoomName(payload.room);
    if (!name) return acknowledge({ error: "أدخل اسماً للانضمام إلى الدردشة." });

    removeFromRoom(socket);
    const room = getRoom(roomName);
    if (!room) return acknowledge({ error: "عدد الغرف النشطة ممتلئ حالياً." });
    const normalizedName = name.toLocaleLowerCase();
    if (room.bannedNames.has(normalizedName)) {
      return acknowledge({ error: "لا يمكنك الانضمام إلى هذه الغرفة." });
    }

    socket.data.roomName = roomName;
    socket.data.name = name;
    room.emptySince = undefined;
    socket.join(`chat:${roomName}`);
    room.members.set(socket.id, { userId: socket.id, name });
    acknowledge({
      userId: socket.id,
      name,
      isAdmin: canModerate(socket),
      messages: room.chatEnabled ? room.messages : [],
      users: [...room.members.values()],
      voiceParticipants: [...room.voiceParticipants],
      chatEnabled: room.chatEnabled,
      voiceEnabled: room.voiceEnabled,
      muted: room.mutedUsers.has(socket.id)
    });
    io.to(`chat:${roomName}`).emit("chat:presence", {
      users: [...room.members.values()].map(({ userId, name: memberName }) => ({
        userId,
        name: memberName
      }))
    });
    if (canModerate(socket)) {
      socket.emit("admin:rooms", [...rooms.keys()]);
    }
  });

  socket.on("chat:message", (payload, callback) => {
    payload = asObject(payload);
    const acknowledge = asCallback(callback);
    const roomName = socket.data.roomName;
    const room = rooms.get(roomName);
    if (!room || !room.chatEnabled) return acknowledge({ error: "الدردشة النصية مغلقة حالياً." });
    if (room.mutedUsers.has(socket.id)) return acknowledge({ error: "تم كتمك في هذه الغرفة." });

    const now = Date.now();
    const recentMessages = (messageRateLimits.get(socket.id) || []).filter(time => now - time < 5000);
    if (recentMessages.length >= 5) return acknowledge({ error: "أرسلت رسائل كثيرة. حاول بعد قليل." });
    recentMessages.push(now);
    messageRateLimits.set(socket.id, recentMessages);

    const text = String(payload.text || "").trim().slice(0, 1000);
    if (!text) return acknowledge({ error: "اكتب رسالة قبل الإرسال." });
    const message = {
      id: randomUUID(),
      userId: socket.id,
      name: socket.data.name,
      text,
      createdAt: new Date().toISOString()
    };
    room.messages.push(message);
    if (room.messages.length > 100) room.messages.shift();
    io.to(`chat:${roomName}`).emit("chat:message", message);
    acknowledge({ ok: true });
  });

  socket.on("voice:join", (...args) => {
    const acknowledge = asCallback(args.at(-1));
    const roomName = socket.data.roomName;
    const room = rooms.get(roomName);
    if (!room || !room.voiceEnabled) return acknowledge({ error: "الغرفة الصوتية مغلقة حالياً." });
    if (room.mutedUsers.has(socket.id)) return acknowledge({ error: "تم كتمك في هذه الغرفة." });
    if (room.voiceParticipants.size >= 8 && !room.voiceParticipants.has(socket.id)) {
      return acknowledge({ error: "وصلت الغرفة الصوتية إلى الحد الأقصى للمشاركين." });
    }
    if (room.voiceParticipants.has(socket.id)) {
      return acknowledge({ participants: [...room.voiceParticipants].filter(id => id !== socket.id) });
    }
    room.voiceParticipants.add(socket.id);
    const participants = [...room.voiceParticipants].filter(id => id !== socket.id);
    acknowledge({ participants });
    socket.to(`chat:${roomName}`).emit("voice:peer-joined", { userId: socket.id });
  });

  socket.on("voice:leave", () => {
    leaveVoice(socket, rooms.get(socket.data.roomName));
  });

  socket.on("voice:signal", input => {
    const payload = asObject(input);
    const room = rooms.get(socket.data.roomName);
    if (!room || !room.voiceParticipants.has(socket.id)) return;
    const { targetId, type, data } = payload;
    if (
      typeof targetId !== "string" ||
      !voiceSignalTypes.has(type) ||
      !room.voiceParticipants.has(targetId) ||
      data === undefined
    ) return;
    let serialized;
    try {
      serialized = JSON.stringify(data);
    } catch {
      return;
    }
    if (serialized.length > 64_000) return;
    io.to(targetId).emit("voice:signal", { userId: socket.id, type, data });
  });

  socket.on("admin:action", (input, callback) => {
    const payload = asObject(input);
    const acknowledge = asCallback(callback);
    if (!canModerate(socket)) return acknowledge({ error: "غير مصرح لك بتنفيذ هذا الإجراء." });
    const roomName = socket.data.roomName;
    const room = rooms.get(roomName);
    if (!room) return acknowledge({ error: "انضم إلى غرفة أولاً." });

    const targetId = String(payload.targetId || "");
    const target = room.members.get(targetId);
    switch (payload.action) {
      case "delete-message": {
        const messageId = String(payload.messageId || "");
        const index = room.messages.findIndex(message => message.id === messageId);
        if (index === -1) return acknowledge({ error: "الرسالة غير موجودة." });
        room.messages.splice(index, 1);
        io.to(`chat:${roomName}`).emit("chat:message-deleted", { messageId });
        break;
      }
      case "mute":
      case "unmute": {
        if (!target) return acknowledge({ error: "المستخدم غير موجود في الغرفة." });
        if (payload.action === "mute") {
          room.mutedUsers.add(targetId);
          io.to(targetId).emit("chat:muted", { muted: true });
          leaveVoice(io.sockets.sockets.get(targetId), room);
        } else {
          room.mutedUsers.delete(targetId);
          io.to(targetId).emit("chat:muted", { muted: false });
        }
        io.to(`chat:${roomName}`).emit("admin:member-updated", {
          userId: targetId,
          muted: room.mutedUsers.has(targetId)
        });
        break;
      }
      case "ban": {
        if (!target) return acknowledge({ error: "المستخدم غير موجود في الغرفة." });
        room.bannedNames.add(target.name.toLocaleLowerCase());
        room.mutedUsers.delete(targetId);
        io.to(targetId).emit("chat:banned");
        io.sockets.sockets.get(targetId)?.disconnect(true);
        break;
      }
      case "unban": {
        const name = normalizeUserName(payload.name).toLocaleLowerCase();
        if (!name) return acknowledge({ error: "أدخل اسم المستخدم لرفع الحظر." });
        room.bannedNames.delete(name);
        break;
      }
      case "chat-visibility":
      case "voice-visibility": {
        const enabled = payload.enabled === true;
        if (payload.action === "chat-visibility") room.chatEnabled = enabled;
        else {
          room.voiceEnabled = enabled;
          if (!enabled) {
            for (const participantId of [...room.voiceParticipants]) {
              leaveVoice(io.sockets.sockets.get(participantId), room);
              io.to(participantId).emit("voice:closed");
            }
          }
        }
        io.to(`chat:${roomName}`).emit("chat:room-state", {
          chatEnabled: room.chatEnabled,
          voiceEnabled: room.voiceEnabled
        });
        break;
      }
      default:
        return acknowledge({ error: "إجراء إداري غير معروف." });
    }
    acknowledge({ ok: true });
  });

  socket.on("disconnect", () => {
    removeFromRoom(socket);
    messageRateLimits.delete(socket.id);
  });
});

app.get("/", (req, res) => {
  res.json({
    name: "ALMOGHANI AI",
    status: "running"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({
        error: "اكتب سؤالك أولاً."
      });
    }

    if (message.length > 2000) {
      return res.status(400).json({
        error: "السؤال طويل جدًا."
      });
    }

    const response = await openai.responses.create({
      model: "gpt-5-mini",

      instructions: `
أنت ALMOGHANI AI، مساعد عربي لموقع ALMOGHANI.

أجب باللغة العربية الواضحة والمختصرة ما لم يطلب المستخدم غير ذلك.

الموقع يهتم بالمحتوى الإسلامي مثل:
القرآن الكريم، السيرة النبوية، الأحاديث، الحج،
الأذكار، الفقه، العقيدة، الصحابة، العبادات،
الأسرة والأخلاق الإسلامية.

في المسائل الدينية:
- لا تختلق آية أو حديثًا أو مصدرًا.
- ميّز بين الأحكام المتفق عليها والمسائل التي فيها خلاف معتبر.
- لا تقدم نفسك كمفتٍ.
- إذا كان السؤال يحتاج فتوى شخصية، وضح أن الإجابة معلومات عامة وأن الأفضل الرجوع إلى عالم أو جهة إفتاء موثوقة.

يمكنك أيضًا الإجابة عن الأسئلة العامة المفيدة للزائر.
`,

      input: message
    });

    res.json({
      reply: response.output_text || "تعذر الحصول على إجابة."
    });

  } catch (error) {

    console.error(
      "CHAT_ERROR:",
      error?.status,
      error?.message
    );

    res.status(500).json({
      error: "تعذر الاتصال بـ ALMOGHANI AI حاليًا."
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ALMOGHANI AI running on port ${PORT}`);
});
