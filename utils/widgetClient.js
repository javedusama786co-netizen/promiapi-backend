/**
 * Browser-side floating WhatsApp widget.
 * Served as text by publicRoutes ("(" + fn.toString() + ")()"), so keep it self-contained:
 * no imports, no references to Node variables.
 * Renders inside a Shadow DOM so the host site's CSS can't break it, and builds DOM with
 * textContent only (no innerHTML), so config values can never inject markup.
 */
function widgetClient() {
  var script = document.currentScript;
  if (!script || !script.src) return;
  var origin = new URL(script.src).origin;
  var key = script.getAttribute("data-key");

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function isOnline(h) {
    if (!h || !h.enabled) return true;
    try {
      var parts = new Intl.DateTimeFormat("en-US", { timeZone: h.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
      var p = {}; parts.forEach(function (x) { p[x.type] = x.value; });
      var day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
      var mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
      var s = h.start.split(":"), e = h.end.split(":");
      return h.days.indexOf(day) !== -1 && mins >= (+s[0]) * 60 + (+s[1]) && mins < (+e[0]) * 60 + (+e[1]);
    } catch (err) { return true; }
  }

  function track(event) {
    if (!key) return;
    try {
      var body = JSON.stringify({ key: key, event: event, page: location.pathname });
      if (navigator.sendBeacon) navigator.sendBeacon(origin + "/api/widgets/event", new Blob([body], { type: "text/plain" }));
      else fetch(origin + "/api/widgets/event", { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "text/plain" } });
    } catch (err) {}
  }

  function boot(c) {
    if (!c || !c.phoneNumber || c.enabled === false) return;
    var mobile = window.matchMedia("(max-width: 768px)").matches;
    if ((mobile && !c.showOnMobile) || (!mobile && !c.showOnDesktop)) return;

    var online = isOnline(c.hours);
    var side = c.position === "left" ? "left" : "right";
    var color = /^#[0-9a-f]{6}$/i.test(c.brandColor) ? c.brandColor : "#128C7E";

    var host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;bottom:20px;" + side + ":20px;z-index:2147483000;";
    var root = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent =
      ":host{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}" +
      "*{box-sizing:border-box}" +
      ".card{width:min(320px,calc(100vw - 40px));background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(16,24,40,.22);overflow:hidden;margin-bottom:14px;transform-origin:bottom " + side + ";transition:opacity .18s,transform .18s}" +
      ".card[hidden]{display:block;opacity:0;transform:scale(.94) translateY(8px);pointer-events:none;visibility:hidden}" +
      ".btn{width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;color:#fff;display:grid;place-items:center;box-shadow:0 6px 18px rgba(0,0,0,.25);position:relative;float:" + side + ";transition:transform .15s}" +
      ".btn:hover{transform:scale(1.06)}.btn:focus-visible,a.cta:focus-visible,.x:focus-visible{outline:3px solid #fff;outline-offset:-5px;box-shadow:0 0 0 3px " + color + "}" +
      ".badge{position:absolute;top:-2px;right:-2px;width:16px;height:16px;border-radius:50%;background:#f04438;border:2px solid #fff}" +
      "@media(prefers-reduced-motion:no-preference){.badge{animation:p 2s infinite}@keyframes p{0%,100%{transform:scale(1)}50%{transform:scale(1.25)}}}";
    root.appendChild(style);

    var card = el("div"); card.className = "card"; card.hidden = true;
    card.setAttribute("role", "dialog"); card.setAttribute("aria-label", c.title || "Chat");

    var head = el("div", "background:" + color + ";color:#fff;padding:14px 16px;display:flex;gap:12px;align-items:center");
    var av = el("div", "width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.22);display:grid;place-items:center;font-weight:700;font-size:16px;flex:none", (c.title || "S").trim().charAt(0).toUpperCase());
    var meta = el("div", "flex:1;min-width:0");
    meta.appendChild(el("div", "font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", c.title));
    var st = el("div", "font-size:12px;opacity:.92;display:flex;align-items:center;gap:6px");
    st.appendChild(el("span", "width:8px;height:8px;border-radius:50%;background:" + (online ? "#6ce9a6" : "#fdb022")));
    st.appendChild(el("span", "", online ? c.subtitle : "Offline"));
    meta.appendChild(st);
    var x = el("button", "background:none;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:4px", "\u00d7");
    x.className = "x"; x.setAttribute("aria-label", "Close chat");
    head.appendChild(av); head.appendChild(meta); head.appendChild(x);

    var body = el("div", "padding:16px;background:#efeae2");
    body.appendChild(el("div", "background:#fff;padding:10px 12px;border-radius:0 12px 12px 12px;font-size:14px;line-height:1.45;color:#1d2433;max-width:90%;box-shadow:0 1px 1px rgba(0,0,0,.08)", online ? c.welcomeMessage : c.offlineMessage));

    var foot = el("div", "padding:12px 16px 16px;background:#fff");
    var a = el("a", "display:flex;align-items:center;justify-content:center;gap:8px;background:" + color + ";color:#fff;padding:11px 14px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px", c.buttonLabel || "Chat on WhatsApp");
    a.className = "cta"; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.href = "https://wa.me/" + String(c.phoneNumber).replace(/\D/g, "") + (c.prefilledMessage ? "?text=" + encodeURIComponent(c.prefilledMessage) : "");
    a.addEventListener("click", function () { track("lead"); });
    foot.appendChild(a);
    card.appendChild(head); card.appendChild(body); card.appendChild(foot);

    var btn = el("button"); btn.className = "btn"; btn.style.background = color; btn.setAttribute("aria-label", "Open WhatsApp chat"); btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 3.5A11.8 11.8 0 0 0 12 0C5.4 0 .1 5.3.1 11.9c0 2.1.5 4.1 1.6 5.9L0 24l6.4-1.7a11.9 11.9 0 0 0 5.6 1.4C18.600 23.700 24 18.400 24 11.900c0-3.200-1.200-6.200-3.500-8.400zM12 21.700c-1.800 0-3.500-.5-5-1.400l-.4-.2-3.800 1 1-3.700-.2-.4a9.700 9.700 0 0 1-1.500-5.100C2.100 6.500 6.500 2.100 12 2.100c2.600 0 5.100 1 6.900 2.900a9.700 9.700 0 0 1 2.900 6.900c0 5.400-4.400 9.800-9.800 9.800zm5.400-7.300c-.3-.1-1.700-.8-2-.9-.3-.1-.5-.1-.7.100l-.9 1.100c-.2.200-.3.200-.6.100-1.600-.8-2.700-1.400-3.700-3.200-.3-.5.300-.5.800-1.500.1-.2 0-.4 0-.5l-.9-2.100c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.400-.3.300-1 1-1 2.400s1.100 2.800 1.200 3c.1.200 2.100 3.200 5.100 4.500 1.900.8 2.600.9 3.600.7.600-.1 1.700-.7 2-1.400.2-.7.2-1.200.2-1.400-.1-.1-.3-.2-.6-.3z"/></svg>';
    if (c.showBadge) { var b = el("span"); b.className = "badge"; btn.appendChild(b); }

    var opened = false;
    function toggle(open) {
      opened = open; card.hidden = !open; btn.setAttribute("aria-expanded", String(open));
      var bd = btn.querySelector(".badge"); if (open && bd) bd.remove();
      if (open) track("open");
    }
    btn.addEventListener("click", function () { toggle(!opened); });
    x.addEventListener("click", function () { toggle(false); });
    root.addEventListener("keydown", function (e) { if (e.key === "Escape" && opened) { toggle(false); btn.focus(); } });

    root.appendChild(card); root.appendChild(btn);
    document.body.appendChild(host);
    track("impression");

    var delay = Number(c.autoOpenDelay) || 0;
    if (delay > 0) {
      var seen = false;
      try { seen = sessionStorage.getItem("promi_w_auto") === "1"; } catch (err) {}
      if (!seen) setTimeout(function () { if (!opened) { toggle(true); try { sessionStorage.setItem("promi_w_auto", "1"); } catch (err) {} } }, delay * 1000);
    }
  }

  function start() {
    if (key) {
      fetch(origin + "/api/widgets/public/" + encodeURIComponent(key))
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d && d.success) boot(d.data); })
        .catch(function () {});
    } else if (script.getAttribute("data-phone")) { // legacy embed (no tracking)
      boot({
        enabled: true, phoneNumber: script.getAttribute("data-phone"), title: script.getAttribute("data-title") || "Support",
        subtitle: "Typically replies within minutes", welcomeMessage: script.getAttribute("data-msg") || "Hello!", prefilledMessage: script.getAttribute("data-msg") || "",
        buttonLabel: "Chat on WhatsApp", position: script.getAttribute("data-pos") || "right", showOnMobile: true, showOnDesktop: true, showBadge: true,
      });
    }
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
}

module.exports = widgetClient;
