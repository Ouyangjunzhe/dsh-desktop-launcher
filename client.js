// dsh-desktop-launcher —— browser 半区
//
// 在「设置」里加一节「桌面启动」，用来一键生成 / 修复 / 移除桌面快捷方式。
// host 半区（index.js）提供 /desktop-launcher 的 status / install / uninstall 三个接口。

window.__ModuleLoader__.load({
	id: "dsh-desktop-launcher",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");

		var API = "/desktop-launcher";

		// ── 与 host 半区通信 ────────────────────────────────────────────────
		// 用相对路径 fetch，浏览器会自动带上同源 Origin 与正确的 Host，
		// 从而通过 host 侧的信任围栏（拒绝跨站 / 非 loopback 来源）。
		function request(action, body) {
			var method = action === "status" || body === undefined && action !== "install" && action !== "uninstall" ? "GET" : "POST";
			var init = { method: method };
			if (body !== undefined || action === "install" || action === "uninstall") {
				init.headers = { "Content-Type": "application/json" };
				if (body !== undefined) init.body = JSON.stringify(body);
				else init.body = JSON.stringify({});
			}
			return fetch(API + (action ? "/" + action : ""), init).then(function (res) {
				return res.json().catch(function () {
					return { ok: false, error: "HTTP " + res.status };
				});
			});
		}

		// ── 样式：全部走主题 CSS 变量，深浅色自适应 ─────────────────────────
		var S = {
			wrap: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 },
			card: {
				border: "1px solid var(--vscode-panel-border, rgba(128,128,128,.28))",
				borderRadius: 8,
				padding: 16,
				display: "flex",
				flexDirection: "column",
				gap: 10,
			},
			row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
			label: { fontSize: 12, opacity: 0.75, minWidth: 92 },
			value: {
				fontSize: 12,
				fontFamily: "ui-monospace, Consolas, monospace",
				wordBreak: "break-all",
				opacity: 0.9,
			},
			btn: {
				padding: "6px 14px",
				borderRadius: 6,
				border: "1px solid var(--vscode-button-border, transparent)",
				background: "var(--vscode-button-background, #0e639c)",
				color: "var(--vscode-button-foreground, #fff)",
				cursor: "pointer",
				fontSize: 13,
			},
			btnGhost: {
				padding: "6px 14px",
				borderRadius: 6,
				border: "1px solid var(--vscode-panel-border, rgba(128,128,128,.4))",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				fontSize: 13,
			},
			hint: { fontSize: 12, opacity: 0.7, lineHeight: 1.6 },
			ok: { fontSize: 12, color: "var(--vscode-charts-green, #3fb950)" },
			bad: { fontSize: 12, color: "var(--vscode-charts-red, #f85149)" },
		};

		function StatusDot(props) {
			return react.createElement("span", {
				style: {
					display: "inline-block",
					width: 7,
					height: 7,
					borderRadius: "50%",
					flex: "0 0 auto",
					background: props.on
						? "var(--vscode-charts-green, #3fb950)"
						: "var(--vscode-charts-red, #f85149)",
				},
			});
		}

		function Field(props) {
			return react.createElement(
				"div",
				{ style: S.row },
				react.createElement("span", { style: S.label }, props.label),
				react.createElement("span", { style: S.value }, props.value || "—")
			);
		}

		function DesktopLauncherSection() {
			var state = react.useState(null); // 服务器返回的状态
			var status = state[0];
			var setStatus = state[1];

			var busyState = react.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];

			var msgState = react.useState(null); // { kind: 'ok' | 'bad', text }
			var message = msgState[0];
			var setMessage = msgState[1];

			var portState = react.useState(3080);
			var port = portState[0];
			var setPort = portState[1];

			function refresh() {
				return request("status").then(function (r) {
					setStatus(r);
					return r;
				});
			}

			react.useEffect(function () {
				refresh();
			}, []);

			function run(label, promise) {
				setBusy(true);
				setMessage(null);
				promise
					.then(function (r) {
						if (r && r.ok === false) {
							setMessage({ kind: "bad", text: r.error || "操作失败" });
						} else {
							setMessage({ kind: "ok", text: label + "完成" });
							if (r && r.warning) {
								setMessage({ kind: "ok", text: label + "完成（提示：" + r.warning + "）" });
							}
						}
						if (r) setStatus(r);
					})
					.catch(function (e) {
						setMessage({ kind: "bad", text: String(e && e.message ? e.message : e) });
					})
					.then(function () {
						setBusy(false);
						// 安装/卸载后重新拉一次，确保展示的是磁盘真实状态
						refresh();
					});
			}

			var installed = !!(status && status.shortcutExists);

			return react.createElement(
				"div",
				{ style: S.wrap },

				react.createElement(
					"div",
					{ style: S.hint },
					"在桌面生成「DeepSeek Harness」快捷方式，双击即可启动 Web GUI 并自动打开系统默认浏览器。",
					react.createElement("br"),
					"图标取自 DSH 自带的小鲸鱼 favicon；浏览器跟随系统默认设置。"
				),

				react.createElement(
					"div",
					{ style: S.card },
					react.createElement(
						"div",
						{ style: S.row },
						react.createElement(StatusDot, { on: installed }),
						react.createElement(
							"strong",
							{ style: { fontSize: 13 } },
							installed ? "快捷方式已安装" : "尚未安装快捷方式"
						)
					),

					react.createElement(Field, {
						label: "桌面路径",
						value: status ? status.desktop : "读取中…",
					}),
					installed
						? react.createElement(Field, { label: "图标", value: status.icon || "（系统默认）" })
						: null,
					installed && status && status.readError
						? react.createElement(
								"div",
								{ style: S.bad },
								"读取快捷方式失败：" + status.readError
						  )
						: null,

					react.createElement(
						"div",
						{ style: S.row },
						react.createElement("span", { style: S.label }, "服务端口"),
						react.createElement("input", {
							type: "number",
							value: port,
							min: 1,
							max: 65535,
							disabled: busy,
							onChange: function (e) {
								setPort(Number(e.target.value) || 3080);
							},
							style: {
								width: 96,
								padding: "5px 8px",
								borderRadius: 6,
								border: "1px solid var(--vscode-panel-border, rgba(128,128,128,.4))",
								background: "var(--vscode-input-background, transparent)",
								color: "inherit",
								fontSize: 13,
							},
						}),
						react.createElement(
							"span",
							{ style: S.hint },
							"需与 dsh web 实际监听端口一致（默认 3080）"
						)
					),

					react.createElement(
						"div",
						{ style: S.row },
						react.createElement(
							"button",
							{
								type: "button",
								style: S.btn,
								disabled: busy,
								onClick: function () {
									run(installed ? "修复" : "安装", request("install", { port: port }));
								},
							},
							busy ? "处理中…" : installed ? "重新生成 / 修复" : "生成桌面快捷方式"
						),
						installed
							? react.createElement(
									"button",
									{
										type: "button",
										style: S.btnGhost,
										disabled: busy,
										onClick: function () {
											run("移除", request("uninstall"));
										},
									},
									"移除快捷方式"
							  )
							: null,
						react.createElement(
							"button",
							{
								type: "button",
								style: S.btnGhost,
								disabled: busy,
								onClick: function () {
									refresh();
								},
							},
							"刷新状态"
						)
					),

					message
						? react.createElement(
								"div",
								{ style: message.kind === "ok" ? S.ok : S.bad },
								message.text
						  )
						: null
				),

				react.createElement(
					"div",
					{ style: S.hint },
					"说明：插件运行在 dsh 进程内部，因此它负责「生成入口」，而实际启动由快捷方式完成 —— 这两件事无法合并。"
				)
			);
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register(
					{
						name: "settings.section",
						id: "desktop-launcher",
						order: 60,
						label: function () {
							return "桌面启动";
						},
					},
					DesktopLauncherSection
				);
			});
		}

		exports.name = "dsh-desktop-launcher";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
