// Custom Next.js server with Socket.io for real-time + a worker subprocess.
const { createServer } = require("node:http");
const next = require("next");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const { spawn } = require("node:child_process");

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => handle(req, res));
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    path: "/api/socket",
  });

  // Redis pub/sub bridge → socket.io rooms.
  // We psubscribe to wildcards and forward each message to the matching room.
  const sub = new Redis(process.env.REDIS_URL);
  sub.psubscribe("drop:*", "auction:*", "prices:tick");
  sub.on("pmessage", (_pattern, channel, message) => {
    const [kind, id] = channel.split(":");
    let payload;
    try { payload = JSON.parse(message); } catch { return; }
    if (kind === "drop") io.to(`drop:${id}`).emit("drop", payload);
    else if (kind === "auction") io.to(`auction:${id}`).emit("auction", payload);
    else if (kind === "prices") io.to("prices").emit("prices", payload);
  });

  // Broadcast watcher count to a room. Used for auction "N watching" feel.
  function broadcastWatchers(room) {
    if (!room.startsWith("auction:")) return;
    const n = io.sockets.adapter.rooms.get(room)?.size ?? 0;
    io.to(room).emit("watchers", { room, count: n });
  }

  io.on("connection", (socket) => {
    socket.on("join", (room) => {
      if (typeof room !== "string") return;
      // Only allow rooms we control. UUIDs are 36 chars but we accept >= 8 hex
      // to keep validation simple.
      if (!/^(drop|auction):[0-9a-f-]{8,}$/.test(room) && room !== "prices") return;
      socket.join(room);
      broadcastWatchers(room);
    });
    socket.on("leave", (room) => {
      socket.leave(room);
      broadcastWatchers(room);
    });
    socket.on("disconnecting", () => {
      // socket.rooms contains rooms it's about to leave (including its own id).
      for (const room of socket.rooms) broadcastWatchers(room);
    });
  });

  httpServer.listen(port, () => {
    console.log(`> PullVault on http://localhost:${port}`);
  });

  // Spawn worker process (auction closer + price ticker).
  // RUN_WORKERS=false disables this — useful for serverless deploys where you
  // run the worker on a separate container.
  if (process.env.RUN_WORKERS !== "false") {
    const worker = spawn("npx", ["tsx", "scripts/workers.ts"], {
      stdio: "inherit",
      env: process.env,
    });
    worker.on("exit", (code) => console.error(`worker exited (${code})`));
  }
});
