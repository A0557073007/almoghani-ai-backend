# ALMOGHANI AI Backend

## Live chat

The homepage uses `chat.css` and `chat.js` for its responsive text and voice chat. Deploy those files with `index.html`, and deploy this backend over HTTPS so the Socket.IO endpoint and browser microphone APIs are available.

Set `OPENAI_API_KEY` and a strong `CHAT_ADMIN_TOKEN` in the backend environment. For local development, these can be set in an ignored `.env` file. Generate an administrator token with `openssl rand -hex 32`; administrators enter that token in the chat's admin panel.

Rooms, recent messages, bans, and moderation settings are held in server memory and reset when the backend restarts. Chat names are anonymous and are not authenticated accounts, so name-based bans are not identity-proof. Voice uses browser WebRTC peer-to-peer connections and a public STUN server, with a maximum of eight participants per room; because audio is peer-to-peer, moderation cannot enforce microphone muting against a modified client. Production deployments needing persistent identity/moderation, larger rooms, or guaranteed voice muting should add durable storage and a WebRTC SFU/TURN service.

The socket endpoint allows the website origins `https://almoghani.net` and `https://www.almoghani.net`, matching the existing API CORS policy.
