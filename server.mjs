import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import os from "os";
import open from "open";

const app = express();
app.use(express.static("public"));

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer);

const peers = new Map();

io.on("connection", (socket) => {
	socket.on("join", ({ peerId }) => {
		if (!peerId) return;

		socket.data.peerId = peerId;
		peers.set(peerId, socket.id);
		const list = [...peers.keys()].filter((p) => p !== peerId);
		socket.emit("peers", { peers: list });
		socket.broadcast.emit("peer-join", { peerId });
	});

	socket.on("signal", ({ to, from, data }) => {
		if (!to || !from || !data) return;
		const toSid = peers.get(to);
		if (toSid) {
			io.to(toSid).emit("signal", { to, from, data });
		}
	});

	socket.on("disconnect", (reason) => {
		const { peerId } = socket.data || {};

		if (peerId && peers.get(peerId) === socket.id) {
			peers.delete(peerId);
			socket.broadcast.emit("peer-leave", { peerId });
		}
	});
});

function getLocalIPv4() {
	const nets = os.networkInterfaces();
	for (const name of Object.keys(nets)) {
		for (const net of nets[name] || []) {
			if (net.family === "IPv4" && !net.internal) {
				return net.address;
			}
		}
	}
	return "127.0.0.1";
}

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

httpServer.listen(PORT, HOST, async () => {
	const ip = getLocalIPv4();
	const homeUrl = `http://127.0.0.1:${PORT}`;
	const localUrl = `http://localhost:${PORT}`;
	const lanUrl = `http://${ip}:${PORT}`;
	console.log(`[server] ${localUrl} (local)`);
	console.log(`[server] ${homeUrl} (local)`);
	console.log(`[server] ${lanUrl} (LAN)`);
	try {
		await open(localUrl);
	} catch (err) {
		console.error("[server] Failed to open browser:", err.message);
	}
});
