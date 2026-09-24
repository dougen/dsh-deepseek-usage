// dsh-deepseek-usage — browser half.
//
// 侧边栏底部用量卡片（注册进 `sidebar.footer.action` 槽位，独占一行，位于
// Cordis 面板按钮下方）。轮询宿主路由 `/api/deepseek-usage`（见 lib/index.js）
// 每 5 分钟一次，点击卡片任意位置可立即刷新；还没拿到余额（宿主刚重启/接口刚起来）
// 时按 QUICK_RETRY_MS 阶梯快速补几次请求，卡片几秒内收敛。
// 两种形态：
//   · 侧边栏展开——完整卡片：余额（放大显示，符号随币种 ¥/$）+ 当前模型档单价
//     （输入/输入缓存/输出，图标 + 数字，位于卡片右下角）+ 峰谷指示灯（右上角，
//     只有颜色）+ 距下次峰谷切换的倒计时（`2d 15h` / `5h 47m` / `23m`，与指示灯同行、位于其左侧）。
//   · 侧边栏折叠——36px 图标栏里只有峰谷指示灯（见下方 `if (!wide)` 分支）。
//
// 设计约束（用户只关心"我还能花多少、这会儿什么价"）：
//   · 插件的内部信息——取价路径、模型改名、放假日期来源——一律不出现在 UI 上
//     （历史上圆点的 title 里塞过这些，已删除）。
//   · 唯一的交互是「点击卡片刷新」；没有可切换的提示态。
//   · 只有余额类错误（未配置 Key / 余额接口或网络失败）才置空卡片说明原因。
// 样式仅使用 `--dsw-*` 主题变量（含兜底值），跟随明暗主题。
window.__ModuleLoader__.load({
	id: "@dougen/dsh-deepseek-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useCallback, useRef } = react;
		const h = react.createElement;

		// ---- constants -------------------------------------------------
		const POLL_MS = 5 * 60 * 1000;
		const USAGE_PATH = "/api/deepseek-usage";
		// 放假日期：宿主路由（见 lib/index.js），浏览器启动时读一次，覆盖内置镜像表；
		// 读不到就继续用内置表（两边都是同一份国务院办公厅日期表）。
		const HOLIDAYS_PATH = "/api/deepseek-usage/holidays";
		// 常态卡片高度：上下 padding 8+16 + 金额行 minHeight 28 + 边框 2 = 54。
		// 底部多留的 8px 是为了让倒计时那一行与下方单价行之间有呼吸感。
		// 倒计时与圆点都在金额行内定位，不额外增高（无头 Chromium 实测 cardH=54）。
		// 异常态把卡片置空时用它兜住同一个高度，侧边栏高度不跳动。
		const CARD_MIN_HEIGHT = 54;
		// 卡片还没拿到余额时的快速重试节奏（宿主刚重启、接口刚起来、或本次请求失败）：
		// 否则要等满 5 分钟轮询才会从空卡片变成真实数字。
		const QUICK_RETRY_MS = [4000, 8000, 15000, 30000];

		// ---- i18n（DSH locale 服务；zh 为兜底）----
		// 注意：卡片上只出现「输入 / 输入缓存 / 输出」这三个标签。峰谷灯没有文字、
		// 没有 hover；倒计时统一用英文单位（d/h/m）且不带前缀，中英界面完全一致——
		// 插件内部的取价路径等一概不进 UI。
		const NS = "dsh-deepseek-usage";
		const ZH = {
			"price.input": "输入",
			"price.cache": "输入缓存",
			"price.output": "输出",
		};
		const EN = {
			"price.input": "Input",
			"price.cache": "Input cache",
			"price.output": "Output",
		};

		// ---- 倒计时文案（语言无关，故不进词典）----
		/** 峰谷灯 hover：切换时刻 / 即将切换。 */
		const SWITCH_AT = "{at} switch";
		const SWITCHING = "switching";

		// ---- 峰谷规则（必须与 lib/pricing.js 的 isPeak / PEAK_WINDOWS /
		// PEAK_WEEKDAYS_ONLY / HOLIDAY_RANGES 保持一致；浏览器侧无法 import 宿主模块，
		// 只能镜像。2026 年起官方口径：法定节假日全天、调休上班的周末都是空闲时段，
		// 所以放假日期必须一起镜像，否则中秋/国庆白天会被误显示成高峰价）----
		const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
		const PEAK_WINDOWS = [[9, 12], [14, 18]];
		const PEAK_WEEKDAYS_ONLY = true;
		// 放假日期（含起止，闭区间）：国务院办公厅 2026 年节假日安排。
		const HOLIDAY_RANGES = [
			['2026-01-01', '2026-01-03'],
			['2026-02-15', '2026-02-23'],
			['2026-04-04', '2026-04-06'],
			['2026-05-01', '2026-05-05'],
			['2026-06-19', '2026-06-21'],
			['2026-09-25', '2026-09-27'],
			['2026-10-01', '2026-10-07'],
		];
		const HOLIDAY_DAYS = (() => {
			const set = new Set();
			const DAY = 24 * 60 * 60 * 1000;
			for (const [from, to] of HOLIDAY_RANGES) {
				const start = Date.parse(from + 'T00:00:00Z');
				const end = Date.parse(to + 'T00:00:00Z');
				if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
				for (let t = start; t <= end; t += DAY) set.add(new Date(t).toISOString().slice(0, 10));
			}
			return set;
		})();

		/** 某时刻的北京时间小时（0–23）。 */
		function shanghaiHour(ms) {
			return new Date(ms + SHANGHAI_OFFSET_MS).getUTCHours();
		}

		/** 该时刻所在北京时间日历日是否为法定节假日（放假日期）。 */
		function isHoliday(ms) {
			return HOLIDAY_DAYS.has(new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10));
		}

		/** 某时刻是否为高峰时段（按北京时间；节假日全天与周末恒为空闲）。与 lib/pricing.js 的 isPeak 等价。 */
		function isPeak(ms) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			if (isHoliday(now)) return false;
			const d = new Date(now + SHANGHAI_OFFSET_MS);
			if (PEAK_WEEKDAYS_ONLY) {
				const dow = d.getUTCDay();
				if (dow === 0 || dow === 6) return false;
			}
			const h = d.getUTCHours();
			return PEAK_WINDOWS.some(([start, end]) => h >= start && h < end);
		}

		/**
		 * 距下一个计费时段边界的剩余时间；与 lib/pricing.js 的 nextChange 等价。
		 * 逐分钟向前探测（上限 16 天，覆盖春节长假 → 假期后首个工作日早晨）。
		 */
		function nextChange(ms) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			const current = isPeak(now);
			for (let step = 1; step <= 16 * 24 * 60; step += 1) {
				const at = now + step * 60 * 1000;
				const peak = isPeak(at);
				if (peak !== current) return { peak, at, ms: Math.max(0, at - now) };
			}
			return { peak: !current, at: now, ms: 0 };
		}

		/** m/h/d 三档短标签（语言无关）。 */
		const _u = (v, u) => `${v}${u}`;

		/**
		 * 剩余毫秒 → 英文单位时长，最多两级：`2d 15h` / `5h 47m` / `23m` / `switching`。
		 * 不足 1 分钟显示 `switching`。向下取整，避免"还剩 59 秒却显示 1m"的反向偏差。
		 */
		function fmtCountdown(ms) {
			const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 60000));
			const days = Math.floor(total / 1440);
			const hours = Math.floor((total % 1440) / 60);
			const minutes = total % 60;
			if (days > 0) return _u(days, "d") + " " + _u(hours, "h");
			if (hours > 0) return _u(hours, "h") + " " + _u(minutes, "m");
			return minutes > 0 ? _u(minutes, "m") : SWITCHING;
		}

		/** 时间戳（ms）→ `HH:mm`（本地时区）；无效值返回空串。 */
		function fmtClock(value) {
			const n = Number(value);
			if (!Number.isFinite(n) || n <= 0) return "";
			const d = new Date(n);
			const p = (v) => String(v).padStart(2, "0");
			return `${p(d.getHours())}:${p(d.getMinutes())}`;
		}

		function money(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return n.toFixed(2);
		}

		function fmtPrice(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return String(parseFloat(n.toFixed(2)));
		}

		// 主题变量（带兜底值）
		const C = {
			bg: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))",
			border: "var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
			label: "var(--dsw-alias-label-primary, #111)",
			sub: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
			err: "var(--dsw-alias-state-error-primary, rgb(200,40,40))",
			peak: "var(--dsw-alias-state-warn-primary, rgb(230,120,0))",
			idle: "var(--dsw-alias-state-success-primary, rgb(34,160,80))",
		};

		const svgBase = {
			width: 12,
			height: 12,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2.2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			style: { flex: "none", display: "block" },
		};
		// 输入：右箭头指向右边界（→|，数据进入边界）
		const IconIn = () => h("svg", svgBase,
			h("path", { d: "M20 4v16" }),
			h("path", { d: "M20 12H6" }),
			h("path", { d: "M10 7l5 5-5 5" }));
		// 输出：左边界发出右箭头（|→，数据从边界流出）
		const IconOut = () => h("svg", svgBase,
			h("path", { d: "M4 4v16" }),
			h("path", { d: "M4 12h14" }),
			h("path", { d: "M14 7l5 5-5 5" }));
		// 缓存：闪电（缓存命中，快）
		const IconCache = () => h("svg", svgBase,
			h("path", { d: "M13 2 3 14h7l-1 8 10-12h-7l1-8z" }));

		// ---- the widget -------------------------------------------------
		function UsageCell(props) {
			const ctx = props.ctx;
			const wide = !!props.wide;
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			// 倒计时走字用的心跳：每 30 秒 bump 一次，渲染时按当前时刻重算剩余时间。
			const [tick, setTick] = useState(0);
			const [holidayRanges, setHolidayRanges] = useState(() => HOLIDAY_RANGES);
			// 放假日期表变化时重算（与宿主口径一致）。
			useEffect(() => {
				const set = new Set();
				const DAY = 24 * 60 * 60 * 1000;
				for (const [from, to] of holidayRanges) {
					const start = Date.parse(String(from) + 'T00:00:00Z');
					const end = Date.parse(String(to) + 'T00:00:00Z');
					if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
					for (let t = start; t <= end; t += DAY) set.add(new Date(t).toISOString().slice(0, 10));
				}
				HOLIDAY_DAYS.clear();
				for (const day of set) HOLIDAY_DAYS.add(day);
			}, [holidayRanges]);
			const mounted = useRef(true);
			// 快速重试：阶梯下标 + 定时器（宿主刚起来、余额接口还没返回时，几秒后自己再看一眼）。
			const retryStep = useRef(0);
			const retryTimer = useRef(null);
			const locale = ctx && ctx.locale;

			// 订阅语言变化（DSH locale 服务；不可用时回退中文）。
			const lcSnap = react.useSyncExternalStore(
				(cb) => (locale && typeof locale.subscribe === "function" ? locale.subscribe(cb) : () => {}),
				() => (locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot() : { active: "zh", locales: [], revision: 0 }),
			);
			const lang = lcSnap && lcSnap.active === "en" ? "en" : "zh";
			// locale.bind(ns) 返回绑定命名空间的翻译函数；不可用时回退中文词典。
			const boundT = locale && typeof locale.bind === "function" ? locale.bind(NS) : null;
			const t = (key) => {
				try {
					if (boundT) {
						const v = boundT(key);
						if (typeof v === "string" && v !== key) return v;
					}
				} catch (e) { /* 词典不可用，回退中文 */ }
				return ZH[key] || key;
			};

			// 宿主还在后台忙（重启后首次余额、接口刚起来）时按 QUICK_RETRY_MS 阶梯补几次请求，
			// 让卡片几秒内收敛；封顶后回到 5 分钟轮询。失败同样按此节奏重试。
			// 判断依据只看"有没有拿到余额"，不依赖宿主内部字段。
			const load = useCallback(async () => {
				try {
					const res = await fetch(USAGE_PATH + "?lang=" + lang, { cache: "no-store" });
					let body = null;
					try {
						body = await res.json();
					} catch {}
					if (!res.ok || body === null || typeof body !== "object" || body.ok !== true) {
						// 失败原因优先用宿主给的文案（未配置 Key / 余额接口异常，用户看得懂）；
						// 拿不到就用一句人话兜底——不把 HTTP 状态码这类传输细节摆到卡片上。
						throw new Error(body && typeof body.message === "string" && body.message !== "" ? body.message : "刷新失败，请稍后重试");
					}
					if (!mounted.current) return;
					setData(body);
					setError("");
					const total = body.balance && body.balance.total;
					if (!Number.isFinite(Number(total))) scheduleRetry();
					else retryStep.current = 0;
				} catch (e) {
					if (!mounted.current) return;
					setError(e instanceof Error ? e.message : String(e));
					scheduleRetry();
				}
			}, [lang]);

			/** 按 QUICK_RETRY_MS 阶梯安排一次补请求（用 ref 记录进度；卸载时清理）。 */
			const scheduleRetry = () => {
				if (!mounted.current) return;
				const delay = QUICK_RETRY_MS[retryStep.current];
				if (delay === undefined) return;
				retryStep.current += 1;
				if (retryTimer.current !== null) clearTimeout(retryTimer.current);
				retryTimer.current = setTimeout(() => {
					retryTimer.current = null;
					load();
				}, delay);
			};

			useEffect(() => {
				mounted.current = true;
				load();
				const timer = setInterval(load, POLL_MS);
				// 模型切换（写入 settings 触发 document-updated）时立即刷新，单价跟着变。
				let off = null;
				try {
					if (ctx && ctx.remote && typeof ctx.remote.$on === "function") {
						off = ctx.remote.$on("settings/document-updated", () => {
							try { load(); } catch (e) { /* 忽略刷新错误 */ }
						});
					}
				} catch (e) {
					off = null;
				}
				return () => {
					mounted.current = false;
					clearInterval(timer);
					if (retryTimer.current !== null) {
						clearTimeout(retryTimer.current);
						retryTimer.current = null;
					}
					try {
						if (typeof off === "function") off();
					} catch (e) { /* 忽略退订错误 */ }
				};
			}, [load, ctx]);

			// ---- 放假日期表（宿主是唯一权威：启动时拉一次，只用于本地兜底计算）----
			// 浏览器侧必须镜像峰谷规则（无法 import 宿主模块），放假日期也就不该各写一份，
			// 否则放假那几天两边会算出不同结果。
			useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch(HOLIDAYS_PATH, { cache: "no-store" });
						let body = null;
						try { body = await res.json(); } catch {}
						if (cancelled || !res.ok || !body || body.ok !== true) return;
						if (Array.isArray(body.ranges)) setHolidayRanges(body.ranges);
					} catch { /* 读不到就用内置表继续 */ }
				})();
				return () => { cancelled = true; };
			}, []);

			// 倒计时走字：每 30 秒重算一次渲染（跨过切换瞬间时，不依赖下一次 5 分钟轮询）。
			// 30s 而非 60s 是为了保证"剩余不足 1 分钟"的窗口不会被整分钟跳过。
			useEffect(() => {
				const timer = setInterval(() => setTick((v) => v + 1), 30 * 1000);
				return () => clearInterval(timer);
			}, []);

			const balance = data && data.balance ? data.balance : null;
			const tier = data && data.tier ? data.tier : null;
			const symbol = balance && balance.currency === "USD" ? "$" : "¥";
			// 卡片只显示"用户要的数字"：余额、当前档单价、状态圆点、距下次切换的倒计时。
			// 插件的内部信息（取价路径、模型改名）一律不进 UI，
			// 唯一的交互是点击卡片刷新。只有"余额类错误"（未配置 Key / 接口或网络失败）才
			// 把卡片置空并说明原因——否则余额是空的，用户无从判断。
			const errs = (Array.isArray(data && data.errors) ? data.errors : []).concat(error ? [error] : []);
			const blanked = errs.length > 0;
			// 每次渲染都以"当前时刻"求剩余时间；tick 每 30 秒 bump 一次触发这次重算，
			// 所以跨过切换瞬间时不需要等下一次 5 分钟轮询。
			// nextAt 优先用宿主给的 next.at（避免宿主与浏览器时钟不一致导致数字跳变），
			// 宿主没给（旧版本 / 字段缺失）时用同一套规则在本地推算。
			const nowMs = Date.now();
			const nextAt = (() => {
				const raw = data && data.next && Number(data.next.at);
				if (Number.isFinite(raw) && raw > 0) return raw;
				const age = data && Number(data.updatedAt) > 0 ? Math.max(0, nowMs - Number(data.updatedAt)) : 0;
				return nextChange(nowMs - age).at;
			})();
			void tick; // tick 只用来触发重渲染，值本身不参与计算
			const countdown = fmtCountdown(nextAt - nowMs);
			const dot = {
				width: 8,
				height: 8,
				borderRadius: "50%",
				flex: "none",
				background: data && data.peak ? C.peak : C.idle,
				boxShadow: "0 0 4px rgba(0,0,0,.3)",
			};
			// 圆点自身没有任何 hover（历史上的 title 里塞了价格表路径等内部信息，
			// 对用户毫无意义，已删除）；它只表达"现在是高峰还是空闲"，切换时刻由旁边的
			// 倒计时承担。
			// 点击卡片：唯一动作 = 刷新。
			const onCardClick = () => {
				load();
			};

			// 折叠态（图标栏）：内容宽 36px（侧边栏 56px − 折叠态左右各 10px 内边距），
			// 只容得下峰谷指示灯，没有外框也没有底色（直接坐在侧边栏背景上）。
			// 指示灯仍是"点击刷新"的落点。
			if (!wide) {
				return h("div", {
					style: {
						boxSizing: "border-box",
						flex: "none",
						padding: "4px 8px",
						cursor: "pointer",
						display: "flex",
						flexDirection: "row",
						alignItems: "center",
						userSelect: "none",
					},
					onClick: () => load(),
				}, h("span", { style: dot }));
			}

			// 只有"余额类错误"（未配置 Key / 余额接口或网络失败）才走到这里：卡片置空、
			// 只显示原因文字，不画余额/单价/圆点/倒计时。minHeight 兜住常态卡片高度
			// （CARD_MIN_HEIGHT），侧边栏不跳动；文字多行时卡片自然变高。
			// 注意：这里不显示任何插件内部信息（取价路径、放假日期来源），历史上那批
			// 良性提示已随"去技术化"一起删除。
			// 折叠态（!wide）早在上面就返回了：它只有峰谷指示灯，没有文字空间。
			if (blanked) {
				return h("div", {
					style: {
						boxSizing: "border-box",
						flex: "1 1 100%",
						minWidth: 0,
						minHeight: CARD_MIN_HEIGHT,
						padding: "8px 10px",
						borderRadius: 10,
						border: "1px solid " + C.border,
						background: C.bg,
						color: C.label,
						cursor: "pointer",
						userSelect: "none",
						display: "flex",
						flexDirection: "column",
						justifyContent: "center",
						gap: 3,
						marginTop: 4,
						fontSize: "12px",
						lineHeight: "15px",
					},
					onClick: onCardClick,
				},
					h("div", {
						style: { color: C.err, fontSize: 12, lineHeight: "16px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
					}, errs.join(" | ")));
			}

			const Price = (icon, label, value) =>
				h("span", { style: { display: "inline-flex", alignItems: "center", gap: 3, minWidth: 0, color: C.sub, whiteSpace: "nowrap" } },
					h("span", { style: { display: "inline-flex", alignItems: "center" }, title: label }, icon),
					h("span", { style: { fontWeight: 600 } }, fmtPrice(value)));

			return h("div", {
				style: {
					boxSizing: "border-box",
					flex: "1 1 100%",
					minWidth: 0,
					// 上 8 下 10（配合单价行 bottom:2，这组是用户看过后选定的观感）。
					// 顶部保持 8px 不动，圆点才能继续紧贴右上角。
					padding: "8px 10px 12px",
					borderRadius: 10,
					border: "1px solid " + C.border,
					background: C.bg,
					color: C.label,
					cursor: "pointer",
					userSelect: "none",
					display: "flex",
					flexDirection: "column",
					gap: 4,
					marginTop: 4,
					position: "relative",
					fontSize: "12px",
					lineHeight: "15px",
				},
				onClick: onCardClick,
			},
				// 金额行：余额 + 右侧「倒计时 + 峰谷圆点」。
				// 倒计时与圆点放在同一个 flex 行里、alignItems:center，两者圆心必然重合；
				// 整组 alignSelf:flex-start + 负 margin，让圆点距卡片顶/右各 8px。
				// 两个反面做法都试过并实测过：
				//   · alignSelf:center → 圆点被压到卡片中线，不再是"右上角"；
				//   · paddingTop:6    → 金额行被撑高，卡片被撑大，圆点反而更靠下。
				// 倒计时 minWidth:0 + overflow:hidden：窄侧边栏下先省略号截断，不挤压余额
				// （实测 "2d 23h" 在 170px 宽的卡片里仍放得下）。
				h("div", { style: { display: "flex", alignItems: "baseline", minHeight: 28, minWidth: 0, gap: 6 } },
					h("span", { style: { fontWeight: 700, fontSize: 24, color: C.label, lineHeight: "28px", marginRight: 3 } }, symbol),
					h("span", { style: { fontWeight: 700, fontSize: 24, color: C.label, lineHeight: "28px" } }, money(balance && balance.total)),
					// 负 margin 只挪动整组，不改变金额行高度（卡片高度由内边距决定）。
					// 实测：marginTop -4 与 marginRight -3 时，圆点距卡片顶、右各 8px
					// （右侧不能按"内边距 10 − 8"去推，内边距本就含在行宽里）。
					h("span", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, marginLeft: "auto", flex: "0 1 auto", alignSelf: "flex-start", marginTop: -4, marginRight: -3 } },
						// 倒计时：距下次峰谷切换的剩余时间（`2d 15h` / `5h 47m` / `23m` / `switching`）。
						// 纯英文单位、无前缀，中英界面一致。
						// 字号/字重刻意与右下角单价数字对齐（继承卡片正文 12px、fontWeight 600），
						// 让右上角这行和右下角单价行是同一套文字样式。
						h("span", {
							style: {
								fontWeight: 600,
								color: C.sub,
								minWidth: 0,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							},
						}, countdown),
						// 峰谷指示灯：只有颜色（橙=高峰 / 绿=空闲），没有 title、没有其他文字。
						h("span", { style: dot }))),
				// 底部行：只剩当前档单价，恒靠右下角。
				// 这组 bottom:2 + 卡片下内边距 10 是用户看过多组对比后选定的观感（价格略微下移、
				// 下方不再空一大块）。注意绝对定位的行不参与卡片高度计算，改内边距时两者要一起看。
				// 用 flex-end 而不是 space-between：容器只有一个子元素时 space-between 会把它
				// 推到最左侧（0.6.0 的回归点）。
				h("span", {
					style: { position: "absolute", left: 9, right: 9, bottom: 2, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 },
				},
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, flex: "none" } },
						Price(h(IconIn, null), t("price.input"), tier && tier.input),
						Price(h(IconCache, null), t("price.cache"), tier && tier.cacheRead),
						Price(h(IconOut, null), t("price.output"), tier && tier.output))));
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots", "remote", "locale"];

		function apply(ctx) {
			// 注册 i18n 词典（DSH locale 服务；不可用时组件回退中文）。
			try {
				if (ctx.locale && typeof ctx.locale.register === "function") {
					ctx.locale.register(NS, { zh: ZH, en: EN });
				}
			} catch (e) { /* 词典注册失败不影响卡片 */ }
			// 注入本包样式：footerActions 换行（卡片独占一行）。
			const tagId = "dsh-deepseek-usage";
			if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-deepseek-usage";
				style.dataset.pluginCss = tagId;
				style.textContent = 'div[class*="footerActions"]{flex-wrap:wrap}';
				document.head.appendChild(style);
			}
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "dsh-usage", order: 100, label: "DeepSeek 用量" },
				(props) => h(UsageCell, { wide: props.wide, ctx }),
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数透出（供 test/client-layout.test.mjs 直接做确定性断言，不必模拟计时器）。
		exports.__internals = { nextChange, isPeak, fmtCountdown };
		return module.exports;
	}
});
