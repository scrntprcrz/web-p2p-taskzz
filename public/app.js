function meshApp() {
	function randomId() {
		const epoch = Date.now();
		const rand = Math.random().toString(36).slice(2, 10);
		let uid = _.uniqueId("anon_");
		try {
			uid =
				typeof window !== "undefined" && window.__MESH_PEER8
					? String(window.__MESH_PEER8)
					: _.uniqueId("anon_");
		} catch {}
		return `${epoch}-${uid}-${rand}`;
	}

	function makeLocalDB(ns) {
		const safeParse = (s) => {
			try {
				return JSON.parse(s || "{}");
			} catch {
				return {};
			}
		};
		const load = () => safeParse(localStorage.getItem(ns));
		const save = (obj) =>
			localStorage.setItem(ns, JSON.stringify(obj || {}));
		if (!localStorage.getItem(ns)) localStorage.setItem(ns, "{}");
		return {
			async allDocs({ include_docs }) {
				const store = load();
				const rows = Object.keys(store).map((id) => ({
					id,
					key: id,
					doc: include_docs ? store[id] : undefined,
				}));
				return { rows };
			},
			async get(id) {
				const store = load();
				if (!store[id]) throw new Error("not_found");
				return store[id];
			},
			async put(doc) {
				if (!doc || !doc._id) throw new Error("bad_doc");
				const store = load();
				store[doc._id] = doc;
				save(store);
				return { ok: true, id: doc._id };
			},
			async bulkDocs(arr) {
				const store = load();
				for (const d of arr || []) {
					if (!d || !d._id) continue;
					if (d._deleted) delete store[d._id];
					else store[d._id] = d;
				}
				save(store);
				return { ok: true };
			},
		};
	}

	const SAFARI = (() => {
		try {
			const ua = navigator.userAgent || "";
			return /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
		} catch {
			return false;
		}
	})();

	function short(s, n = 180) {
		try {
			s = String(s);
		} catch {
			s = "";
		}
		return s.length > n ? s.slice(0, n) + "…" : s;
	}

	function buildIceServers() {
		const stun = [{ urls: "stun:stun.l.google.com:19302" }];
		const turnCfg = Array.isArray(window.TURN_CONFIG)
			? window.TURN_CONFIG
			: [];
		return [].concat(stun, turnCfg);
	}

	function arrayBufferToString(buf) {
		try {
			if (typeof TextDecoder !== "undefined") {
				return new TextDecoder("utf-8").decode(new Uint8Array(buf));
			}
		} catch {}
		let result = "";
		const chunk = 0x8000;
		const u8 = new Uint8Array(buf);
		for (let i = 0; i < u8.length; i += chunk) {
			result += String.fromCharCode.apply(
				null,
				u8.subarray(i, i + chunk)
			);
		}
		try {
			return decodeURIComponent(escape(result));
		} catch {
			return result;
		}
	}

	return {
		peerId: `peer-${Math.random().toString(36).substr(2, 5)}-${Date.now()}`,
		notes: [],
		newNoteText: "",
		searchQuery: "",
		selectMode: false,
		selectedIds: new Set(),
		openPeers: 0,
		tick: 0,
		db: null,
		socket: null,
		peers: new Map(),
		remoteClocks: {},
		snapshotRequested: false,
		seenDocClocks: new Set(),
		searchDebounceTimer: null,
		_fuse: null,
		pendingCandidates: new Map(),

		conzole: console,

		wait(ms) {
			return new Promise((res) => setTimeout(res, ms));
		},

		async ensureDataChannelsOpen(timeoutMs = 3000) {
			const start = Date.now();
			while (Date.now() - start < timeoutMs) {
				for (const { dc } of this.peers.values()) {
					if (dc && dc.readyState === "open") return true;
				}
				await this.wait(100);
			}
			return false;
		},

		async parseDcPayload(data) {
			try {
				if (typeof data === "string") {
					this.conzole.debug("[dc] payload:string", short(data));
					return data;
				}
				if (data && typeof Blob !== "undefined") {
					const isBlob =
						data instanceof Blob ||
						(data &&
							data.constructor &&
							data.constructor.name === "Blob");
					if (isBlob && data.text) {
						const t = await data.text();
						this.conzole.debug("[dc] payload:blob->text", short(t));
						return t;
					}
				}
				if (data && data instanceof ArrayBuffer) {
					const t = arrayBufferToString(data);
					this.conzole.debug(
						"[dc] payload:arraybuffer->text",
						short(t)
					);
					return t;
				}
				if (data && data.buffer && data.byteLength !== undefined) {
					const t = arrayBufferToString(data.buffer);
					this.conzole.debug(
						"[dc] payload:typedarray->text",
						short(t)
					);
					return t;
				}
			} catch (e) {
				this.conzole.error(
					"[dc] parse error",
					e && e.message ? e.message : e
				);
			}
			this.conzole.warn("[dc] payload:unknown");
			return "";
		},

		queueIce(peerId, candidate) {
			if (!candidate) return;
			const arr = this.pendingCandidates.get(peerId) || [];
			arr.push(candidate);
			this.pendingCandidates.set(peerId, arr);
		},

		async flushIce(peerId, pc) {
			const arr = this.pendingCandidates.get(peerId);
			if (!arr || !arr.length) return;
			for (const c of arr) {
				try {
					if (c) await pc.addIceCandidate(new RTCIceCandidate(c));
				} catch (err) {
					this.conzole.error("flushIce addIceCandidate error", err);
				}
			}
			this.pendingCandidates.delete(peerId);
		},

		generateClock() {
			return `${Date.now()}:${this.peerId}`;
		},
		parseClock(str) {
			if (!str) return [0, ""];
			const idx = str.indexOf(":");
			const ts = parseInt(str.slice(0, idx), 10);
			const pid = str.slice(idx + 1);
			return [ts, pid];
		},
		compareClock(a, b) {
			if (a === b) return 0;
			const [t1, p1] = this.parseClock(a);
			const [t2, p2] = this.parseClock(b);
			if (t1 < t2) return -1;
			if (t1 > t2) return 1;
			return p1 < p2 ? -1 : 1;
		},

		maxLocalClock() {
			//A
			if (!this.notes || this.notes.length === 0) {
				return `0:${this.peerId}`;
			}
			let max = null;
			for (const n of this.notes) {
				if (!max || this.compareClock(n.clock, max) > 0) max = n.clock;
			}
			return max || `0:${this.peerId}`;
		},
		async init() {
			this.db = makeLocalDB("mesh_crdt_db");
			try {
				if (typeof window !== "undefined")
					window.__MESH_PEER8 = this.peerId.slice(0, 8);
			} catch {}
			this.conzole.info("[init] peer", {
				peerId: this.peerId,
				safari: SAFARI,
			});
			await this.refreshNotes();

			try {
				this.socket = io();
			} catch (e) {
				this.conzole.error("Socket.IO error", e);
			}
			if (this.socket) {
				this.socket.on("connect", () => {
					this.conzole.info("[socket] connected");
					this.socket.emit("join", { peerId: this.peerId });
				});
				this.socket.on("peers", ({ peers }) => {
					this.conzole.info("[socket] peers", peers);
					peers.forEach((pid) => this.connectToPeer(pid));
				});
				this.socket.on("peer-join", ({ peerId }) => {
					this.conzole.info("[socket] peer-join", peerId);
					this.connectToPeer(peerId);
				});
				this.socket.on("peer-leave", ({ peerId }) => {
					this.conzole.info("[socket] peer-leave", peerId);
					this.removePeer(peerId);
				});
				this.socket.on("signal", ({ to, from, data }) => {
					if (to === this.peerId) {
						this.handleSignal(from, data);
					}
				});
			}

			if (window.toastr) this.configureToastr();

			if (!this._tickerInterval) {
				this._tickerInterval = setInterval(() => {
					this.tick++;
				}, 30000);
			}

			try {
				await this.syncAll();
			} catch (e) {
				this.conzole.warn("[init] syncAll failed", e);
			}
		},

		async refreshNotes() {
			try {
				const res = await this.db.allDocs({ include_docs: true });
				const list = [];
				res.rows.forEach((row) => {
					const doc = row.doc;
					if (!doc) return;
					if (doc.type === "task" && !doc.deleted) {
						list.push({
							id: doc._id,
							text: doc.text,
							createdAt: doc.createdAt,
							updatedAt: doc.updatedAt,
							doneAt: doc.doneAt,
							doneBy: doc.doneBy,
							createdBy: doc.createdBy,
							clock: doc.clock,
							deleted: !!doc.deleted,
							status:
								doc.status ||
								(doc.doneAt ? "complete" : "pending"),
							priority: doc.priority || "medium",
							assignee: doc.assignee || null,
						});
					}
				});
				this.notes = _.sortBy(list, (x) => x.createdAt || 0);
				this.conzole.info("[refresh] notes", {
					count: this.notes.length,
				});
				this.rebuildSearchIndex();
				this.tick++;
			} catch (err) {
				this.conzole.error("refreshNotes error", err);
			}
		},

		async createNote() {
			const text = String(this.newNoteText || "").trim();
			if (!text) return;

			const now = Date.now();
			const id = randomId();
			const clock = this.generateClock();
			const createdBy = this.peerId.slice(0, 8);
			const doc = {
				_id: id,
				type: "task",
				text,
				createdAt: now,
				updatedAt: now,
				doneAt: null,
				doneBy: null,
				createdBy,
				clock,
				deleted: false,
				status: "pending",
				priority: "medium",
				assignee: createdBy,
				history: [
					{
						at: now,
						by: createdBy,
						action: "create",
						from: null,
						to: "pending",
					},
				],
			};
			try {
				await this.db.put(doc);
				this.seenDocClocks.add(`${id}:${clock}`);
				await this.refreshNotes();
				this.broadcastMessage({ t: "doc", doc: this.stripDoc(doc) });
				if (window.toastr)
					toastr.success(`Added: “${text}”`, this.displayName());
			} catch (err) {
				this.conzole.error("createNote error", err);
				if (window.toastr)
					toastr.error("Error creating note", this.displayName());
			}
			this.newNoteText = "";
			this.tick++;
		},

		async completeNote(id) {
			try {
				const doc = await this.db.get(id);
				const now = Date.now();
				const clock = this.generateClock();
				const by = this.peerId.slice(0, 8);
				const prev =
					doc.status || (doc.doneAt ? "complete" : "pending");
				doc.doneAt = now;
				doc.doneBy = by;
				doc.updatedAt = now;
				doc.clock = clock;
				doc.deleted = false;
				doc.status = "complete";
				doc.history = Array.isArray(doc.history) ? doc.history : [];
				doc.history.push({
					at: now,
					by,
					action: "status",
					from: prev,
					to: "complete",
				});
				await this.db.put(doc);
				this.seenDocClocks.add(`${id}:${clock}`);
				await this.refreshNotes();
				this.broadcastMessage({ t: "doc", doc: this.stripDoc(doc) });
				if (window.toastr)
					toastr.info(`Completed: “${doc.text}”`, this.displayName());
				this.tick++;
			} catch (err) {
				this.conzole.error("completeNote error", err);
				if (window.toastr)
					toastr.error("Error completing note", this.displayName());
			}
		},

		async deleteNote(id) {
			try {
				let doc;
				try {
					doc = await this.db.get(id);
				} catch {
					const clock = this.generateClock();
					const tomb = { id, clock, deleted: true, type: "task" };
					this.seenDocClocks.add(`${id}:${clock}`);
					this.broadcastMessage({ t: "doc", doc: tomb });
					if (window.toastr)
						toastr.warning(`Deleted: “${id}”`, this.displayName());
					return;
				}
				const clock = this.generateClock();
				const now = Date.now();
				const by = this.peerId.slice(0, 8);
				doc.deleted = true;
				doc.clock = clock;
				doc.updatedAt = now;
				doc.history = Array.isArray(doc.history) ? doc.history : [];
				doc.history.push({
					at: now,
					by,
					action: "delete",
					from: doc.status || null,
					to: "deleted",
				});
				await this.db.put(doc);
				this.seenDocClocks.add(`${id}:${clock}`);
				await this.refreshNotes();
				this.broadcastMessage({ t: "doc", doc: this.stripDoc(doc) });
				if (window.toastr)
					toastr.warning(
						`Deleted: “${doc.text}”`,
						this.displayName()
					);
				this.tick++;
			} catch (err) {
				this.conzole.error("deleteNote error", err);
				if (window.toastr)
					toastr.error("Error deleting note", this.displayName());
			}
		},

		async completeSelected() {
			const ids = Array.from(this.selectedIds);
			for (const id of ids) await this.completeNote(id);
			this.selectedIds.clear();
		},
		async completeAllPending() {
			const ids = this.getPending().map((n) => n.id);
			for (const id of ids) await this.completeNote(id);
		},
		async deleteAllPending() {
			const ids = this.getPending().map((n) => n.id);
			for (const id of ids) await this.deleteNote(id);
		},
		async deleteAllDone() {
			const ids = this.getDone().map((n) => n.id);
			for (const id of ids) await this.deleteNote(id);
		},

		displayName() {
			return this.peerId.slice(0, 8);
		},
		fmtTime(ts) {
			try {
				return luxon.DateTime.fromMillis(ts)
					.setLocale("en")
					.toLocaleString(luxon.DateTime.DATETIME_SHORT_WITH_SECONDS);
			} catch {
				return "";
			}
		},
		relativeFrom(ts) {
			try {
				const _ = this.tick;
				return (
					luxon.DateTime.fromMillis(ts)
						.setLocale("en")
						.toRelative({ padding: 0 }) || ""
				);
			} catch {
				return "";
			}
		},

		baseFiltered() {
			if (!this.searchQuery.trim()) return [...this.notes];
			const q = this.searchQuery.trim();
			if (this._fuse) {
				try {
					return this._fuse.search(q).map((r) => r.item);
				} catch (e) {
					this.conzole.error("[fuse] search error", e);
				}
			}
			const qLower = q.toLowerCase();
			return this.notes.filter(
				(n) =>
					n.text.toLowerCase().includes(qLower) ||
					(n.createdBy &&
						n.createdBy.toLowerCase().includes(qLower)) ||
					(n.doneBy && n.doneBy.toLowerCase().includes(qLower))
			);
		},
		getPending() {
			return this.baseFiltered().filter((n) => !n.doneAt);
		},
		getDone() {
			return this.baseFiltered().filter((n) => n.doneAt);
		},

		onSearchChanged() {
			clearTimeout(this.searchDebounceTimer);
			this.searchDebounceTimer = setTimeout(() => {
				this.conzole.debug("[search] applied:", this.searchQuery);
			}, 180);
		},

		stripDoc(doc) {
			return {
				id: doc._id || doc.id,
				text: doc.text,
				createdAt: doc.createdAt,
				updatedAt: doc.updatedAt,
				doneAt: doc.doneAt,
				doneBy: doc.doneBy,
				createdBy: doc.createdBy,
				clock: doc.clock,
				deleted: !!doc.deleted,
				type: "task",
				status: doc.status || (doc.doneAt ? "complete" : "pending"),
				priority: doc.priority || "medium",
				assignee: doc.assignee || null,
				history: Array.isArray(doc.history) ? doc.history : [],
			};
		},

		async applyRemoteDoc(doc) {
			const id = doc.id;
			let local = null;
			try {
				local = await this.db.get(id);
			} catch {}
			const localClock = local ? local.clock : null;
			if (!local || this.compareClock(doc.clock, localClock) > 0) {
				const newDoc = _.assign({}, doc, { _id: id, type: "task" });
				try {
					await this.db.put(newDoc);
					this.conzole.debug("[applyRemoteDoc] applied", {
						id,
						clock: doc.clock,
					});
					await this.refreshNotes();
				} catch (err) {
					this.conzole.error("applyRemoteDoc error", err);
					if (window.toastr)
						toastr.error(
							"Error applying remote",
							this.displayName()
						);
				}
			} else {
				this.conzole.debug("[applyRemoteDoc] skipped older", {
					id,
					remote: doc.clock,
					local: localClock,
				});
			}
		},

		async handleDcMessage(raw) {
			let msg;
			try {
				msg = JSON.parse(raw);
			} catch (e) {
				this.conzole.error("invalid dc message", e);
				return;
			}
			if (msg.to && msg.to !== this.peerId) return;
			this.conzole.debug("[dc] message", { t: msg.t });

			switch (msg.t) {
				case "hello": {
					this.remoteClocks[msg.from] = msg.maxClock;
					const reply = {
						t: "helloReply",
						from: this.peerId,
						to: msg.from,
						maxClock: this.maxLocalClock(),
					};
					this.conzole.debug("[dc] send:helloReply", reply);
					this.broadcastTo(msg.from, reply);
					this.maybeRequestSnapshot();
					break;
				}
				case "helloReply": {
					this.remoteClocks[msg.from] = msg.maxClock;
					this.conzole.debug("[dc] helloReply", {
						from: msg.from,
						maxClock: msg.maxClock,
					});
					this.maybeRequestSnapshot();
					break;
				}
				case "snapshot:request": {
					if (msg.to === this.peerId) this.sendSnapshot(msg.from);
					break;
				}
				case "snapshot": {
					if (msg.to && msg.to !== this.peerId) break;
					const docs = msg.docs || [];
					let applied = 0;
					for (const doc of docs) {
						const id_clock = `${doc.id}:${doc.clock}`;
						if (!this.seenDocClocks.has(id_clock)) {
							this.seenDocClocks.add(id_clock);
							await this.applyRemoteDoc(doc);
							applied++;
							this.broadcastMessage({
								t: "doc",
								doc,
								silent: true,
							});
						}
					}
					if (applied > 0 && window.toastr) {
						toastr.info(
							`Snapshot applied: ${applied} change(s)`,
							this.displayName()
						);
					}
					break;
				}
				case "doc": {
					const doc = msg.doc;
					if (!doc || !doc.clock) break;
					const key = `${doc.id}:${doc.clock}`;
					if (this.seenDocClocks.has(key)) break;
					this.seenDocClocks.add(key);
					await this.applyRemoteDoc(doc);
					this.broadcastMessage(msg);
					if (!msg.silent) this.showRemoteToast(doc, "doc");
					break;
				}
				case "clear:all": {
					await this.clearLocalDB();
					if (window.toastr) {
						const who = msg.from
							? `by ${String(msg.from).slice(0, 8)}`
							: "";
						toastr.warning(
							`Database cleared ${who}`,
							this.displayName()
						);
					}
					break;
				}
				default:
					break;
			}
		},

		async clearLocalDB() {
			try {
				localStorage.setItem("mesh_crdt_db", JSON.stringify({}));
				this.notes = [];
				if (window.toastr)
					toastr.warning(
						"Local database cleared",
						this.displayName()
					);
			} catch (err) {
				this.conzole.error("clearLocalDB error", err);
				if (window.toastr)
					toastr.error("Error clearing database", this.displayName());
			}
		},

		async sendSnapshot(targetPeerId) {
			try {
				const res = await this.db.allDocs({ include_docs: true });
				const docs = _.values(res.rows)
					.map((r) => r.doc)
					.filter(Boolean)
					.filter((d) => d.type === "task")
					.map((d) => this.stripDoc(d));
				const msg = {
					t: "snapshot",
					from: this.peerId,
					to: targetPeerId,
					docs,
				};
				this.conzole.debug("[dc] send:snapshot", {
					to: targetPeerId,
					count: docs.length,
				});
				this.broadcastTo(targetPeerId, msg);
				if (window.toastr)
					toastr.info(
						`Snapshot sent (${docs.length})`,
						this.displayName()
					);
			} catch (err) {
				this.conzole.error("sendSnapshot error", err);
				if (window.toastr)
					toastr.error("Error sending snapshot", this.displayName());
			}
		},

		// Reemplaza tu maybeRequestSnapshot() por este
		maybeRequestSnapshot() {
			//B
			if (this.snapshotRequested) return;
			let bestPeer = null;
			let bestClock = null;
			for (const [peerId, clock] of Object.entries(this.remoteClocks)) {
				if (!bestClock || this.compareClock(clock, bestClock) > 0) {
					bestPeer = peerId;
					bestClock = clock;
				}
			}
			if (!bestPeer) {
				this.conzole.debug("[snapshot] no bestPeer");
				return;
			}

			const myMax = this.maxLocalClock();
			const localEmpty = !this.notes || this.notes.length === 0;

			if (localEmpty || this.compareClock(bestClock, myMax) > 0) {
				const req = {
					t: "snapshot:request",
					from: this.peerId,
					to: bestPeer,
				};
				this.conzole.debug("[dc] send:snapshot:request", {
					to: bestPeer,
					reason: localEmpty ? "empty" : "behind",
					bestClock,
					myMax,
				});
				this.broadcastTo(bestPeer, req);
				this.snapshotRequested = true;
			} else {
				this.conzole.debug("[snapshot] up-to-date", {
					bestPeer,
					bestClock,
					myMax,
				});
			}
		},
		async connectToPeer(remoteId) {
			if (!remoteId || remoteId === this.peerId) return;
			if (this.peers.has(remoteId)) return;
			const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
			const entry = { pc, dc: null };
			this.peers.set(remoteId, entry);
			pc.onicecandidate = (e) => {
				if (e && e.candidate) {
					this.conzole.debug(
						"[ice] local candidate",
						short(e.candidate.candidate, 200)
					);
					this.emitSignal(remoteId, {
						type: "candidate",
						candidate: e.candidate,
					});
				}
			};
			pc.oniceconnectionstatechange = () => {
				this.conzole.info("[ice] state", {
					remoteId,
					state: pc.iceConnectionState,
				});
			};
			pc.ondatachannel = (ev) => {
				this.conzole.info("[dc] ondatachannel", {
					remoteId,
					label: ev && ev.channel && ev.channel.label,
				});
				this.wireDataChannel(remoteId, ev.channel, pc);
			};
			pc.onconnectionstatechange = () => {
				const st = pc.connectionState;
				this.conzole.info("[pc] state", { remoteId, state: st });
				if (["disconnected", "failed", "closed"].includes(st)) {
					this.removePeer(remoteId);
				}
			};
			const initiator = this.peerId < remoteId;
			if (initiator) {
				this.conzole.debug("[webrtc] initiator", { remoteId });
				const dc = pc.createDataChannel("mesh", { ordered: true });
				this.wireDataChannel(remoteId, dc, pc);
				const offer = await pc.createOffer();
				this.conzole.debug("[sdp] offer", {
					sdp: short(offer.sdp, 300),
				});
				await pc.setLocalDescription(offer);
				this.emitSignal(remoteId, offer);
			}
			this.refreshOpenPeers();
		},

		wireDataChannel(remoteId, dc, pc) {
			const entry = this.peers.get(remoteId) || { pc, dc: null };
			entry.dc = dc;
			entry.pc = pc;
			this.peers.set(remoteId, entry);
			try {
				dc.binaryType = "arraybuffer";
			} catch (_) {}
			dc.onopen = () => {
				this.conzole.info("[dc] open", { remoteId });
				this.refreshOpenPeers();
				const msg = {
					t: "hello",
					from: this.peerId,
					maxClock: this.maxLocalClock(),
					safari: SAFARI ? 1 : 0,
				};
				this.conzole.debug("[dc] send:hello", msg);
				this.broadcastTo(remoteId, msg);
			};
			dc.onmessage = async (e) => {
				const raw = await this.parseDcPayload(e.data);
				this.conzole.debug("[dc] recv raw", short(raw));
				await this.handleDcMessage(raw);
			};
			dc.onerror = (e) =>
				this.conzole.error(
					"[dc] error",
					remoteId,
					e && (e.message || e.name || e)
				);
			dc.onclose = () => {
				this.conzole.warn("[dc] close", { remoteId });
				this.removePeer(remoteId);
			};
		},

		emitSignal(to, data) {
			if (!this.socket) return;
			this.conzole.debug("[signal] out", { to, type: data && data.type });
			this.socket.emit("signal", { from: this.peerId, to, data });
		},

		handleSignal(from, data) {
			this.conzole.debug("[signal] in", {
				from,
				type: data && data.type,
			});
			const entry = this.peers.get(from);
			if (!entry) return;
			const pc = entry.pc;

			const safeSetRemote = async (desc) => {
				try {
					await pc.setRemoteDescription(desc);
				} catch (e1) {
					try {
						await pc.setRemoteDescription(
							new RTCSessionDescription(desc)
						);
					} catch (e2) {
						this.conzole.error(
							"[sdp] setRemoteDescription error",
							e1,
							e2
						);
					}
				}
			};

			(async () => {
				if (data.type === "offer") {
					this.conzole.debug("[sdp] offer recv", { from });
					await safeSetRemote(data);
					await this.flushIce(from, pc);
					try {
						const answer = await pc.createAnswer();
						this.conzole.debug("[sdp] answer", {
							to: from,
							sdp: short(answer.sdp, 300),
						});
						await pc.setLocalDescription(answer);
						this.emitSignal(from, answer);
					} catch (err) {
						this.conzole.error("[sdp] answer error", err);
					}
				} else if (data.type === "answer") {
					this.conzole.debug("[sdp] answer recv", { from });
					await safeSetRemote(data);
					await this.flushIce(from, pc);
				} else if (data.type === "candidate") {
					if (!pc.remoteDescription || !pc.remoteDescription.type) {
						this.queueIce(from, data.candidate);
						return;
					}
					try {
						if (data.candidate)
							await pc.addIceCandidate(
								new RTCIceCandidate(data.candidate)
							);
					} catch (err) {
						this.conzole.error("addIceCandidate error", err);
					}
				}
			})();
		},

		refreshOpenPeers() {
			let n = 0;
			for (const { dc } of this.peers.values()) {
				if (dc && dc.readyState === "open") n++;
			}
			this.openPeers = n;
		},

		broadcastMessage(msg) {
			const payload = JSON.stringify(msg);
			for (const { dc } of this.peers.values()) {
				if (dc && dc.readyState === "open") dc.send(payload);
			}
		},
		broadcastTo(peerId, msg) {
			const entry = this.peers.get(peerId);
			if (!entry) return;
			const dc = entry.dc;
			if (dc && dc.readyState === "open") dc.send(JSON.stringify(msg));
		},
		removePeer(remoteId) {
			const entry = this.peers.get(remoteId);
			if (!entry) return;
			try {
				entry.dc && entry.dc.close();
			} catch {}
			try {
				entry.pc && entry.pc.close();
			} catch {}
			this.peers.delete(remoteId);
			this.pendingCandidates.delete(remoteId);
			this.refreshOpenPeers();
		},

		async clearAll() {
			await this.clearLocalDB();
			this.notes = [];
			this.broadcastMessage({ t: "clear:all", from: this.peerId });
		},

		configureToastxxxr() {
			try {
				if (!window.toastr) return;
				window.toastr.options = Object.assign(
					{},
					window.toastr.options,
					{
						positionClass: "toast-bottom-left",
						preventDuplicates: true,
						progressBar: true,
						timeOut: 16000,
						extendedTimeOut: 15000,
						closeButton: false,
						newestOnTop: false,
						toastClass: "toast toast-dark",
						escapeHtml: false,
					}
				);
			} catch (e) {
				this.conzole.warn("[toastr] configuration failed:", e);
			}
		},
		configureToastr() {
			try {
				if (!window.toastr) return;
				window.toastr.options = Object.assign(
					{},
					window.toastr.options,
					{
						positionClass: "toast-bottom-left",
						preventDuplicates: true,
						progressBar: true,
						timeOut: 3000,
						extendedTimeOut: 1500,
						closeButton: false,
						newestOnTop: true,
						toastClass: "toast toast-dark",
						escapeHtml: false,
					}
				);
				const cont = document.getElementById("toast-container");
				if (cont) cont.style.zIndex = "2147483647";
				if (!document.getElementById("toastr-dark-style")) {
					const style = document.createElement("style");
					style.id = "toastr-dark-style";
					style.textContent = `
#toast-container { z-index:2147483647 !important; }
#toast-container .toast,
#toast-container .toast.toast-dark{
  background-color:#000 !important;
  color:#fff !important;
}
#toast-container .toast .toast-title{
  display:flex; align-items:center; gap:.5rem;
  color:#fff !important; font-weight:700
}
#toast-container .toast .toast-message{ color:#f1f1f1 !important }
          `.trim();
					document.head.appendChild(style);
				}
			} catch (e) {
				this.conzole.warn("[toastr] configuration failed:", e);
			}
		},
		showRemoteToast(doc, actionHint) {
			if (!window.toastr) return;
			const text =
				doc && doc.text ? doc.text : doc && doc.id ? doc.id : "";
			const author = doc.doneBy || doc.createdBy || "";
			const title = this.displayName();
			if (doc.deleted)
				toastr.warning(
					`Deleted: “${text}” ${author ? "by " + author : ""}`,
					title
				);
			else if (doc.doneAt)
				toastr.info(
					`Completed: “${text}” ${author ? "by " + author : ""}`,
					title
				);
			else
				toastr.success(
					`Added: “${text}” ${author ? "by " + author : ""}`,
					title
				);
			this.conzole.debug("[toast] remote:", actionHint || "doc", {
				id: doc?.id,
				deleted: !!doc?.deleted,
				doneAt: !!doc?.doneAt,
			});
		},

		rebuildSearchIndex() {
			try {
				if (!window.Fuse) {
					this._fuse = null;
					return;
				}
				this._fuse = new window.Fuse(this.notes, {
					keys: ["text", "createdBy", "doneBy"],
					threshold: 0.4,
					ignoreLocation: true,
				});
				this.conzole.info(
					"[fuse] index rebuilt with",
					this.notes.length,
					"items"
				);
			} catch (e) {
				this.conzole.error("[fuse] error rebuilding index:", e);
				this._fuse = null;
			}
		},
		searchWithFuse(query) {
			if (!query || !query.trim()) return [...this.notes];
			if (!this._fuse) return this.baseFiltered();
			return this._fuse.search(query.trim()).map((r) => r.item);
		},

		async forcePushMyState() {
			if (window.toastr)
				toastr.info("Pushing state to peers…", this.displayName());
			this.conzole.info(
				"[forcePushMyState] starting authoritative push…"
			);
			let total = 0;
			for (const [peerId, entry] of this.peers.entries()) {
				const dc = entry && entry.dc;
				if (dc && dc.readyState === "open") {
					this.broadcastTo(peerId, {
						t: "clear:all",
						from: this.peerId,
						to: peerId,
					});
					await this.wait(50);
					await this.sendSnapshot(peerId);
					total++;
				}
			}
			if (window.toastr)
				toastr.success(
					`Push completed. Peers: ${total}`,
					this.displayName()
				);
			this.conzole.info(
				"[forcePushMyState] done. Peers affected:",
				total
			);
		},

		async syncNow() {
			try {
				if (window.toastr) toastr.info("Syncing…", this.displayName());
				const ok = await this.ensureDataChannelsOpen(2000);
				if (!ok) {
					if (window.toastr)
						toastr.warning(
							"No connected peers",
							this.displayName()
						);
					this.conzole.info("[syncNow] no open data channels");
					return;
				}
				this.conzole.info("[syncNow] manual handshake");
				for (const [peerId, entry] of this.peers.entries()) {
					const dc = entry && entry.dc;
					if (dc && dc.readyState === "open") {
						const msg = {
							t: "hello",
							from: this.peerId,
							maxClock: this.maxLocalClock(),
							to: peerId,
						};
						this.conzole.debug(
							"[syncNow] hello ->",
							peerId,
							"maxClock:",
							msg.maxClock
						);
						this.broadcastTo(peerId, msg);
					}
				}
				this.snapshotRequested = false;
				this.maybeRequestSnapshot();
				if (window.toastr)
					toastr.success("Sync complete", this.displayName());
				this.conzole.info("[syncNow] done.");
			} catch (e) {
				this.conzole.error("[syncNow] error", e);
				if (window.toastr)
					toastr.error("Synchronization error", this.displayName());
			}
		},

		async syncAll() {
			await this.syncNow();
		},

		logPeers() {
			const rows = [];
			for (const [peerId, entry] of this.peers.entries()) {
				rows.push({ peerId, dcState: entry?.dc?.readyState || "none" });
			}
			this.conzole.table(rows);
			return rows;
		},

		toggleSelectMode() {
			this.selectMode = !this.selectMode;
			this.conzole.debug(
				"[select] mode:",
				this.selectMode ? "on" : "off"
			);
			if (!this.selectMode) this.selectedIds.clear();
		},

		toggleSelect(id) {
			if (!id) return;
			if (this.selectedIds.has(id)) {
				this.selectedIds.delete(id);
			} else {
				this.selectedIds.add(id);
			}
			this.conzole.debug(
				"[select] selectedIds size:",
				this.selectedIds.size
			);
		},

		isSelected(id) {
			return this.selectedIds.has(id);
		},
	};
}
