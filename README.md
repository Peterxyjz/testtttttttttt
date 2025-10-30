# PolyGo React Call Test

This is a minimal Vite + React app to test the SignalR/WebRTC mesh calling against the deployed hub at `https://loopcraft.tech/eventRoomHub`.

Quick start

1. Open a terminal in `react-call-client`.
2. Install dependencies:

```bash
npm install
```

3. Run dev server:

```bash
npm run dev
```

4. Open the dev URL (http://localhost:3000) in multiple browser windows/devices and use the UI to `Join Room` and `Start Group Call`.

Notes

- This is a mesh approach (each client connects to every other). Works for small groups.
- TURN server not configured; you may need a TURN for NAT traversal.
- The HUB_URL is set to `https://loopcraft.tech/eventRoomHub`. Change `src/App.jsx` if you want to use a different hub.
