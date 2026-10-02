// Client half of the dsh-phone-bridge package.
//
// This file is the built client artifact. DSH's client-modules scanner expects
// exports["./client"] to contain a `window.__ModuleLoader__.load({...})` bundle
// (that is what the official packages ship after their build step). Hand-writing
// that envelope avoids needing a bundler for a plugin this small.
//
// Two things live here:
//   1. A hover button at the end of each Session row in the left sidebar - the
//      list declared as `sidebar.workspaces.session.row.action`, which also
//      carries the shipped archive (order 100) and pin (order 200) buttons. We
//      take order 300 so we land after them.
//   2. A bin panel opened from a sidebar-footer button, listing what is in the
//      trash with per-entry restore and purge.
//
// Both talk to routes this same package registers on its host half (index.js):
// that half owns the whole "move the session aside into ~/.dsh/deleted-sessions
// rather than really deleting it" lifecycle - the running-session guard, the
// projection-cache cleanup, and the original-path record that makes restore
// possible. The client half only draws and calls, so the package is
// self-contained and needs no other plugin installed.

window.__ModuleLoader__.load({
	id: "dsh-phone-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");

		const ROW_SLOT = "sidebar.workspaces.session.row.action";
		const FOOTER_SLOT = "sidebar.footer.action";
		const OVERLAY_SLOT = "shell.overlay";
		const API = "/phone-bridge";
		const STYLE_ID = "dsh-phone-bridge-style";

		// The client root context, kept so React components (which do not receive
		// it as a prop) can reach client services such as `sessions`.
		let hostCtx = null;

		// Row action buttons and the settings row get their look from CSS modules
		// private to the packages that own them, so this package brings its own
		// rules. Colors ride on `currentColor` and translucent overlays so the
		// panel follows whatever theme is active instead of hard-coding one.
		function ensureStyle() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = [
				".dsh-purge-action {",
				"  display: inline-flex; align-items: center; justify-content: center;",
				"  width: 22px; height: 22px; padding: 0;",
				"  border: none; border-radius: 4px;",
				"  background: transparent; color: inherit;",
				"  cursor: pointer; opacity: .7;",
				"  transition: opacity .12s ease, background-color .12s ease;",
				"}",
				".dsh-purge-action:hover {",
				"  opacity: 1; background-color: rgba(255, 90, 90, .16); color: #ff6b6b;",
				"}",
				".dsh-purge-action:disabled { opacity: .35; cursor: default; }",
				".dsh-trash-footer {",
				"  display: flex; align-items: center; gap: 6px;",
				"  width: 100%; padding: 6px 8px; border: none; border-radius: 6px;",
				"  background: transparent; color: inherit; cursor: pointer;",
				"  font: inherit; text-align: left; opacity: .8;",
				"}",
				".dsh-trash-footer:hover { opacity: 1; background-color: rgba(127,127,127,.14); }",
				".dsh-trash-backdrop {",
				"  position: fixed; inset: 0; z-index: 60;",
				"  background: rgba(0,0,0,.45);",
				"  display: flex; align-items: center; justify-content: center;",
				"}",
				".dsh-trash-panel {",
				"  width: min(620px, 90vw); max-height: 78vh; overflow: auto;",
				"  background: #22232a; color: #e8e8ea;",
				"  border: 1px solid rgba(255,255,255,.12);",
				"  border-radius: 10px; padding: 16px 18px;",
				"  box-shadow: 0 14px 44px rgba(0,0,0,.5);",
				"}",
				".dsh-trash-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }",
				".dsh-trash-title { font-size: 15px; font-weight: 600; }",
				".dsh-trash-sub { font-size: 12px; opacity: .6; }",
				".dsh-trash-close { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 18px; opacity: .6; line-height: 1; }",
				".dsh-trash-close:hover { opacity: 1; }",
				".dsh-trash-empty { padding: 22px 0; text-align: center; font-size: 13px; opacity: .6; }",
				".dsh-trash-row {",
				"  display: flex; align-items: center; gap: 10px;",
				"  padding: 9px 4px; border-top: 1px solid rgba(255,255,255,.09);",
				"}",
				".dsh-trash-info { flex: 1; min-width: 0; }",
				".dsh-trash-name { font-size: 13px; word-break: break-all; }",
				".dsh-trash-meta { font-size: 11px; opacity: .55; margin-top: 2px; word-break: break-all; }",
				".dsh-trash-btn {",
				"  border: 1px solid rgba(255,255,255,.2); background: transparent; color: inherit;",
				"  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;",
				"}",
				".dsh-trash-btn:hover { background: rgba(127,127,127,.2); }",
				".dsh-trash-btn:disabled { opacity: .4; cursor: default; }",
				".dsh-trash-btn.danger { border-color: rgba(255,90,90,.5); color: #ff8a8a; }",
				".dsh-trash-btn.danger.armed { background: rgba(255,90,90,.25); border-color: rgba(255,90,90,.85); color: #ffb3b3; }",
				".dsh-trash-status { margin-top: 10px; font-size: 12px; opacity: .75; min-height: 16px; }",
			].join("\n");
			document.head.appendChild(style);
		}

		function TrashIcon({ size }) {
			const px = size || 14;
			return React.createElement(
				"svg",
				{
					width: px, height: px, viewBox: "0 0 16 16", fill: "none",
					stroke: "currentColor", strokeWidth: 1.4,
					strokeLinecap: "round", strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				React.createElement("path", { d: "M2.5 4.5h11" }),
				React.createElement("path", { d: "M5.5 4.5V3.3c0-.4.3-.8.8-.8h3.4c.5 0 .8.4.8.8v1.2" }),
				React.createElement("path", { d: "M4.1 4.5l.6 8c0 .5.4.9.9.9h4.8c.5 0 .9-.4.9-.9l.6-8" }),
				React.createElement("path", { d: "M6.7 7.1v4M9.3 7.1v4" }),
			);
		}

		function formatBytes(bytes) {
			const value = Number(bytes);
			if (!Number.isFinite(value) || value <= 0) return "0 B";
			const units = ["B", "KB", "MB", "GB"];
			let current = value;
			let index = 0;
			while (current >= 1024 && index < units.length - 1) {
				current /= 1024;
				index += 1;
			}
			return current.toFixed(index === 0 || current >= 10 ? 0 : 1) + " " + units[index];
		}

		// Timestamps arrive as UTC (ISO string or epoch millis). The panel renders
		// them in the machine's own zone, otherwise the clock reads 8 hours early
		// for a UTC+8 user.
		function formatLocalTime(value) {
			if (!value) return "";
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return String(value);
			const pad = (n) => String(n).padStart(2, "0");
			return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
				+ " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		async function postJson(url, body) {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body || {}),
			});
			let data = null;
			try {
				data = await response.json();
			} catch {
				// leave data null; the caller reports the HTTP status
			}
			if (!data) throw new Error("HTTP " + response.status);
			return data;
		}

		// ---- Sidebar row: delete ----------------------------------------------

		/**
		 * Hover button on one Session row. `sessionId` and `displayTitle` are the
		 * owner props the sidebar hands every entry in this list.
		 */
		function DeleteSessionRowButton({ sessionId, displayTitle }) {
			const [busy, setBusy] = React.useState(false);

			async function onClick(event) {
				// The slot docs say clicks inside the strip stay in the strip, but
				// stopping propagation costs nothing and protects the row from
				// opening the conversation behind the button.
				event.preventDefault();
				event.stopPropagation();
				if (busy) return;

				const name = displayTitle || "这个会话";
				if (!window.confirm(
					"删除会话「" + name + "」？\n\n" +
					"它会移进回收站，可以从侧边栏底部的回收站面板恢复。",
				)) return;

				setBusy(true);
				try {
					const data = await postJson(API + "/delete", { sessionId });
					if (data.ok) {
						window.location.reload();
						return;
					}
					window.alert("删除失败：" + (data.error || "未知错误"));
				} catch (error) {
					window.alert("删除失败：" + (error && error.message ? error.message : String(error)));
				} finally {
					setBusy(false);
				}
			}

			return React.createElement(
				"button",
				{
					type: "button",
					className: "dsh-purge-action",
					title: "删除这个会话（移入回收站）",
					"aria-label": "删除会话",
					disabled: busy,
					onClick,
				},
				React.createElement(TrashIcon, { size: 14 }),
			);
		}

		// ---- A tiny store so the footer button can open the overlay panel -----

		const panel = {
			open: false,
			listeners: new Set(),
			set(next) {
				panel.open = next;
				for (const listener of panel.listeners) listener();
			},
			subscribe(listener) {
				panel.listeners.add(listener);
				return () => panel.listeners.delete(listener);
			},
			get() {
				return panel.open;
			},
		};

		function usePanelOpen() {
			return React.useSyncExternalStore(panel.subscribe, panel.get);
		}

		// ---- Sidebar footer: trash entry --------------------------------------

		function TrashFooterButton() {
			return React.createElement(
				"button",
				{
					type: "button",
					className: "dsh-trash-footer",
					title: "查看回收站",
					onClick: () => panel.set(true),
				},
				React.createElement(TrashIcon, { size: 14 }),
				React.createElement("span", null, "回收站"),
			);
		}

		// ---- Overlay: the trash panel ----------------------------------------

		function TrashPanel() {
			const open = usePanelOpen();
			const [entries, setEntries] = React.useState([]);
			const [totalBytes, setTotalBytes] = React.useState(0);
			const [status, setStatus] = React.useState("");
			const [busyName, setBusyName] = React.useState("");
			// Which entry is awaiting its second confirming click. Kept as panel state
			// so purging never opens a native dialog.
			const [pendingPurge, setPendingPurge] = React.useState("");

			const load = React.useCallback(async () => {
				try {
					const response = await fetch(API + "/trash");
					const data = await response.json();
					if (data && data.ok) {
						setEntries(data.entries || []);
						setTotalBytes(data.totalBytes || 0);
					} else {
						setEntries([]);
						setTotalBytes(0);
						setStatus("读取回收站失败：" + ((data && data.error) || "未知错误"));
					}
				} catch (error) {
					setEntries([]);
					setTotalBytes(0);
					setStatus("读取回收站失败：" + (error && error.message ? error.message : String(error)));
				}
			}, []);

			React.useEffect(() => {
				if (!open) return;
				setStatus("");
				void load();
			}, [open, load]);

			if (!open) return null;

			function closePanel() {
				// Drop any half-confirmed purge so reopening does not start armed.
				setPendingPurge("");
				panel.set(false);
			}

			async function restore(name) {
				setBusyName(name);
				try {
					const data = await postJson(API + "/restore", { name });

					if (!data.ok) {
						setStatus("恢复失败：" + (data.error || "未知错误"));
						await load();
						return;
					}

					// The files are back and the host index sees them, but the sidebar
					// renders its own workspace snapshot and does not rescan on its own.
					//
					// `unarchiveSession` is the client-side counterpart of the archive
					// that deletion performs, and it is what actually puts a session
					// back into the workspace grouping - the workspace controller then
					// pushes the change to the UI. `refreshProjections` on top of that
					// just re-reads the restored session's derived data (title etc).
					//
					// A reload is the last resort, only when the services are missing.
					let restoredToWorkspace = false;
					try {
						const uiWorkspace = hostCtx?.get?.("uiWorkspace");
						if (uiWorkspace && data.sessionId && typeof uiWorkspace.unarchiveSession === "function") {
							await uiWorkspace.unarchiveSession(data.sessionId);
							restoredToWorkspace = true;
						}
					} catch { /* not archived, or the service refused - try the rest */ }

					if (!restoredToWorkspace) {
						try {
							const workspaces = hostCtx?.get?.("workspaces");
							if (workspaces && data.sessionId && typeof workspaces.unarchiveSession === "function") {
								await workspaces.unarchiveSession(data.sessionId);
								restoredToWorkspace = true;
							}
						} catch { /* same */ }
					}

					try {
						const sessions = hostCtx?.get?.("sessions");
						if (sessions && data.sessionId && typeof sessions.refreshProjections === "function") {
							await sessions.refreshProjections(data.sessionId);
						}
					} catch { /* projections are cosmetic here */ }

					if (restoredToWorkspace) {
						setStatus("已恢复：" + (data.sessionId || name) + "。");
						await load();
						return;
					}

					setStatus("已恢复：" + (data.sessionId || name) + "，正在刷新界面…");
					setTimeout(() => { window.location.reload(); }, 600);
				} catch (error) {
					setStatus("恢复失败：" + (error && error.message ? error.message : String(error)));
				} finally {
					setBusyName("");
				}
			}

			async function purge(name) {
				// Confirm with a second click inside the panel rather than
				// window.confirm: the native dialog blocks the renderer synchronously
				// and has been observed leaving the composer unable to take focus
				// until the app is restarted.
				if (pendingPurge !== name) {
					setPendingPurge(name);
					setStatus("再点一次「彻底删除」确认这一项，不可恢复。");
					return;
				}
				setPendingPurge("");
				setBusyName(name);
				try {
					const data = await postJson(API + "/purge", { name });
					setStatus(data.ok
						? "已彻底删除 " + data.removed + " 项，释放 " + formatBytes(data.freedBytes)
						: "删除失败：" + (data.error || "未知错误"));
					await load();
				} catch (error) {
					setStatus("删除失败：" + (error && error.message ? error.message : String(error)));
				} finally {
					setBusyName("");
				}
			}

			const rows = entries.map((entry) =>
				React.createElement(
					"div",
					{ className: "dsh-trash-row", key: entry.name },
					React.createElement(
						"div",
						{ className: "dsh-trash-info" },
						React.createElement("div", { className: "dsh-trash-name" }, entry.sessionId || entry.name),
						React.createElement(
							"div",
							{ className: "dsh-trash-meta" },
							[
								formatBytes(entry.bytes),
								entry.deletedAt ? "删除于 " + formatLocalTime(entry.deletedAt) : "",
								entry.restorable ? "" : "无原位置记录，不可自动恢复",
							].filter(Boolean).join(" · "),
						),
					),
					React.createElement(
						"button",
						{
							type: "button",
							className: "dsh-trash-btn",
							disabled: !entry.restorable || busyName === entry.name,
							title: entry.restorable ? "恢复到原位置" : "这一项没有原位置记录",
							onClick: () => restore(entry.name),
						},
						"恢复",
					),
					React.createElement(
						"button",
						{
							type: "button",
							className: pendingPurge === entry.name
								? "dsh-trash-btn danger armed"
								: "dsh-trash-btn danger",
							disabled: busyName === entry.name,
							onClick: () => purge(entry.name),
						},
						pendingPurge === entry.name ? "确认删除？" : "彻底删除",
					),
				),
			);

			return React.createElement(
				"div",
				{ className: "dsh-trash-backdrop", onClick: closePanel },
				React.createElement(
					"div",
					{ className: "dsh-trash-panel", onClick: (event) => event.stopPropagation() },
					React.createElement(
						"div",
						{ className: "dsh-trash-head" },
						React.createElement("div", null,
							React.createElement("div", { className: "dsh-trash-title" }, "回收站"),
							React.createElement("div", { className: "dsh-trash-sub" },
								entries.length + " 项 · 共 " + formatBytes(totalBytes) + " · ~/.dsh/deleted-sessions/"),
						),
						React.createElement("button", {
							type: "button", className: "dsh-trash-close", title: "关闭",
							onClick: closePanel,
						}, "\u00d7"),
					),
					entries.length === 0
						? React.createElement("div", { className: "dsh-trash-empty" }, "回收站是空的。")
						: React.createElement("div", null, rows),
					React.createElement("div", { className: "dsh-trash-status" }, status),
				),
			);
		}

		/** Required service: the UI slot registry. */
		const inject = ["slots"];

		/**
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			hostCtx = ctx;
			ensureStyle();

			ctx.slots.inject(ROW_SLOT, function* () {
				yield ctx.slots.register(
					{ name: ROW_SLOT, id: "dsh-purge", order: 300 },
					DeleteSessionRowButton,
				);
			});

			ctx.slots.inject(FOOTER_SLOT, function* () {
				yield ctx.slots.register(
					{ name: FOOTER_SLOT, id: "dsh-trash", order: 100, label: "回收站" },
					TrashFooterButton,
				);
			});

			ctx.slots.inject(OVERLAY_SLOT, function* () {
				yield ctx.slots.register(
					{ name: OVERLAY_SLOT, id: "dsh-trash-panel", order: 100 },
					TrashPanel,
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
