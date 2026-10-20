/**
 * dsh-restart — browser half.
 *
 * Entry points, in priority order:
 *
 * 1. Native sidebar panel. Slots are hierarchical: this entry cannot register
 *    into "main" / "sidebar.panellist" directly — the host rejects that with
 *    `slot "main" is not declared (a parent entry's children table must
 *    declare it)`. It must subscribe with `slots.inject(name, cb)` and register
 *    from inside that callback, which is how the host's own panels do it.
 * 2. A floating button, mounted into the document when no slot ever arrives.
 *
 * Hard rules this file must keep:
 * - `apply` never throws: the whole body is guarded, so a browser-side defect
 *   can never take the application down.
 * - `ctx.slots` is never read as a property (the context is a proxy and an
 *   unprovided service throws); only `ctx.get(name)` is used.
 * - A failed registration must not suppress the fallback button.
 */
window.__ModuleLoader__.load({
	id: "dsh-restart",
	factory: (require) => {
		var React = require("react");
		var h = React.createElement;
		var PANEL_ID = "restart";
		var name = "dsh-restart";
		var inject = [];

		var settledBySlots = false;

		/** Read a service without tripping the context proxy. */
		function service(ctx, key) {
			try {
				if (ctx && typeof ctx.get === "function") return ctx.get(key);
			} catch (error) {
				return undefined;
			}
			return undefined;
		}

		function describe(value) {
			if (value === null) return "null";
			if (value === undefined) return "undefined";
			var type = typeof value;
			if (type !== "object" && type !== "function") return type + ":" + String(value);
			var keys;
			try {
				keys = Object.keys(value).slice(0, 20);
			} catch (error) {
				keys = ["<unreadable>"];
			}
			return type + "[" + keys.join(",") + "]";
		}

		function report(data) {
			try {
				fetch("/dsh-restart/diag", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(data),
					credentials: "same-origin",
				}).catch(function () {});
			} catch (error) {
				// Diagnostics must never break the plugin.
			}
		}

		/**
		 * Fire the restart request.
		 * @param askConfirm - Whether to ask first. The sidebar glyph passes
		 *   false so one click is enough; the in-panel button keeps the prompt.
		 */
		function requestRestart(askConfirm) {
			if (askConfirm !== false) {
				var ok = window.confirm("重启 DeepSeek Harness？\n\n当前会话会被中断，应用会自动重新启动。");
				if (!ok) return Promise.resolve({ skipped: true });
			}
			return fetch("/dsh-restart/restart", { method: "POST", credentials: "same-origin" })
				.then(function (response) {
					return response.json().catch(function () {
						return {};
					});
				})
				.catch(function (error) {
					return { error: String((error && error.message) || error) };
				});
		}

		function RestartPanel() {
			var phase = React.useState("idle");
			var current = phase[0];
			var setPhase = phase[1];
			var note = React.useState("");
			var text = note[0];
			var setText = note[1];
			function run() {
				if (current !== "idle") return;
				setPhase("running");
				setText("正在请求重启…");
				requestRestart().then(function (body) {
					if (body && body.status === "restarting") {
						setPhase("restarting");
						setText("应用正在重启，页面会自动断开。");
					} else if (body && body.skipped) {
						setPhase("idle");
						setText("");
					} else {
						setPhase("failed");
						setText((body && body.error) || "重启请求被拒绝");
					}
				});
			}
			var styles = {
				wrap: { padding: "20px", maxWidth: "560px", display: "flex", flexDirection: "column", gap: "12px" },
				hint: { fontSize: "13px", lineHeight: "1.6", opacity: 0.75 },
				button: {
					alignSelf: "flex-start",
					padding: "8px 18px",
					borderRadius: "8px",
					border: "1px solid currentColor",
					background: "transparent",
					color: "inherit",
					cursor: current === "idle" ? "pointer" : "default",
					fontSize: "14px",
					opacity: current === "idle" ? 1 : 0.55,
				},
			};
			return h(
				"div",
				{ style: styles.wrap },
				h("h2", { style: { fontSize: "16px", margin: 0 } }, "重启 DeepSeek Harness"),
				h(
					"p",
					{ style: styles.hint },
					"重启会关闭并重新启动整个应用，用于让插件更新等需要重启的改动生效。",
					h("br"),
					h("span", { style: { color: "var(--dsw-alias-text-warning, #d97706)" } }, "当前正在运行的任务会被中断。"),
				),
				h(
					"button",
					{ type: "button", style: styles.button, onClick: run, disabled: current !== "idle" },
					current === "idle" ? "重启应用" : "正在重启…",
				),
				text ? h("p", { style: styles.hint }, text) : null,
			);
		}

		function dropFallback() {
			try {
				var existing = document.getElementById("dsh-restart-fab");
				if (existing !== null) existing.remove();
			} catch (error) {
				// Nothing to remove.
			}
		}

		/** The floating entry point: no slot service involved. */
		function mountFallback() {
			if (settledBySlots) return;
			if (typeof document === "undefined" || document.getElementById("dsh-restart-fab") !== null) return;
			try {
				var button = document.createElement("button");
				button.id = "dsh-restart-fab";
				button.type = "button";
				button.textContent = "⟳";
				button.title = "重启 DeepSeek Harness";
				button.setAttribute("aria-label", "重启 DeepSeek Harness");
				button.style.cssText = [
					"position:fixed",
					"right:18px",
					"bottom:18px",
					"z-index:2147483000",
					"width:42px",
					"height:42px",
					"border-radius:50%",
					"border:1px solid rgba(128,128,128,.45)",
					"background:#1f2937",
					"color:#fff",
					"font-size:19px",
					"line-height:1",
					"cursor:pointer",
					"box-shadow:0 6px 18px rgba(0,0,0,.35)",
					"display:flex",
					"align-items:center",
					"justify-content:center",
				].join(";");
				button.addEventListener("click", function () {
					requestRestart().then(function (body) {
						if (body && body.status === "restarting") {
							button.textContent = "…";
							button.title = "应用正在重启";
						} else if (body && body.error) {
							button.title = "重启失败：" + body.error;
							window.alert("重启失败：" + body.error);
						}
					});
				});
				document.body.appendChild(button);
				report({ step: "fallback-mounted" });
			} catch (error) {
				report({ step: "fallback-failed", message: String((error && error.message) || error) });
			}
		}

		var glyphCaptureInstalled = false;
		var glyphRenderedOnce = false;

		/**
		 * Intercept clicks on the sidebar glyph before React sees them.
		 *
		 * The host wraps every panel glyph in `<button onClick={() => selectPanel(id)}>`,
		 * and the glyph arrives through `renderSlot`, which does not share that
		 * button's React event tree — a handler on the glyph itself cannot stop
		 * the button. A capture-phase document listener runs first and swallows
		 * the event, so one click restarts instead of opening the panel.
		 */
		function installGlyphCapture() {
			if (glyphCaptureInstalled) return;
			if (typeof document === "undefined") return;
			glyphCaptureInstalled = true;
			try {
				document.addEventListener(
					"click",
					function (event) {
						var target = event.target;
						if (!target || typeof target.closest !== "function") return;
						// The click lands on the host's row button or on a wrapper it
						// owns, not necessarily on the glyph span itself, so accept any
						// button that CONTAINS this glyph.
						var hit = target.closest("[data-dsh-restart-glyph]");
						if (hit === null) {
							var row = target.closest("button");
							if (row !== null && row.querySelector("[data-dsh-restart-glyph]") !== null) hit = row;
						}
						if (hit === null) return;
						event.preventDefault();
						event.stopPropagation();
						if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
						report({ step: "glyph-clicked" });
						requestRestart(false);
					},
					true,
				);
				report({ step: "glyph-capture-installed" });
			} catch (error) {
				report({ step: "glyph-capture-failed", message: String((error && error.message) || error) });
			}
		}

		/**
		 * Subscribe to both slots and register from inside the callbacks. The
		 * synchronous return only says whether a slot happened to be ready
		 * already; later arrivals flip `settledBySlots` themselves.
		 */
		function registerPanels(slots) {
			var ok = false;
			function succeeded(where) {
				ok = true;
				settledBySlots = true;
				dropFallback();
				report({ step: "registered", where: where });
			}
			function onMain() {
				try {
					slots.register({ name: "main", key: PANEL_ID }, function () {
						return h(RestartPanel, null);
					});
					succeeded("main");
				} catch (error) {
					report({ step: "main-register-failed", message: String((error && error.message) || error) });
				}
			}
			function onPanellist() {
				try {
					slots.register(
						{ name: "sidebar.panellist", id: PANEL_ID, order: 90, label: function () { return "重启"; } },
						function (owner) {
							if (!glyphRenderedOnce) {
								glyphRenderedOnce = true;
								report({ step: "glyph-rendered", size: (owner && owner.size) || null });
							}
							return h(
								"span",
								{
									title: "点击立即重启 DeepSeek Harness",
									"data-dsh-restart-glyph": "1",
									style: {
										fontSize: String((owner && owner.size) || 16) + "px",
										lineHeight: 1,
										cursor: "pointer",
										display: "inline-flex",
										alignItems: "center",
									},
								},
								"⟳",
							);
						},
					);
					installGlyphCapture();
					succeeded("sidebar.panellist");
				} catch (error) {
					report({ step: "panellist-register-failed", message: String((error && error.message) || error) });
				}
			}
			try {
				if (typeof slots.inject === "function") {
					slots.inject("main", onMain);
					slots.inject("sidebar.panellist", onPanellist);
					report({ step: "inject-subscribed" });
				} else {
					report({ step: "no-slots-inject" });
					onMain();
					onPanellist();
				}
			} catch (error) {
				report({ step: "inject-threw", message: String((error && error.message) || error) });
			}
			return ok;
		}

		function apply(ctx) {
			try {
				report({ step: "apply", hasInject: typeof ctx.inject, hasGet: typeof ctx.get });
				var slots = service(ctx, "slots");
				report({
					step: "service-lookup",
					slots: describe(slots),
					hasSlotsInject: Boolean(slots && typeof slots.inject === "function"),
				});
				if (slots && typeof slots.register === "function") {
					registerPanels(slots);
				}
				if (!settledBySlots) {
					if (typeof document !== "undefined" && document.body) mountFallback();
					setTimeout(function () {
						if (!settledBySlots) mountFallback();
					}, 3000);
				}
			} catch (error) {
				report({ step: "apply-threw", message: String((error && error.message) || error) });
				try {
					mountFallback();
				} catch (ignored) {
					// Nothing further to try.
				}
			}
		}

		return { name: name, inject: inject, apply: apply };
	},
});
