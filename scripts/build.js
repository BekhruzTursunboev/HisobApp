// One source, two builds.
//   npm run build
//
//   src/app.html          the app, written as a fragment
//     -> hisob.html           artifact build: fragment verbatim
//     -> public/index.html    hosted build: full document + PWA head + SW
//
// Keeping one source means the two copies cannot drift, which is how the
// header/chart class collision survived as long as it did.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Normalise line endings up front: the source is edited on Windows, so it
// carries \r\n, and every regex below would silently fail to match without this.
const src = readFileSync(join(root, "src", "app.html"), "utf8").replace(/\r\n/g, "\n");

// ── artifact build: exactly the source ──
writeFileSync(join(root, "hisob.html"), src);

// ── hosted build ──
const title = (src.match(/<title>([^<]*)<\/title>/) || [, "Hisob"])[1];
const body = src.replace(/^<title>[^<]*<\/title>\n/, "").replace(/^<link rel="stylesheet"[^>]*>\n/m, "");
const fontLink = (src.match(/<link rel="stylesheet"[^>]*fonts\.googleapis[^>]*>/) || [""])[0];

const HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="Log what you spend, see where it goes, add a budget only if you want one.">

<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<link rel="icon" href="/icons/icon-192.png" type="image/png">

<meta name="theme-color" content="#EFEFF1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0A0A0C" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">

<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${title}">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fontLink}
</head>
<body>
`;

const TAIL = `
<div class="install" id="install" role="region" aria-label="Install this app">
  <p id="install-text"></p>
  <button type="button" id="install-go">Install</button>
  <button type="button" class="ghost" id="install-no" aria-label="Dismiss">Later</button>
</div>

<script>
(function () {
  "use strict";

  // ── service worker ──
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {
        // no worker means no offline and no install prompt; the app still runs
      });
    });
  }

  // ── install ──
  var bar = document.getElementById("install");
  var text = document.getElementById("install-text");
  var go = document.getElementById("install-go");
  var no = document.getElementById("install-no");
  var DISMISS = "dailyspend.install.dismissed";

  function standalone() {
    return window.matchMedia("(display-mode: standalone)").matches ||
           window.navigator.standalone === true;
  }

  function dismissed() {
    try { return localStorage.getItem(DISMISS) === "1"; } catch (e) { return false; }
  }

  function hide(remember) {
    bar.classList.remove("up");
    if (remember) { try { localStorage.setItem(DISMISS, "1"); } catch (e) {} }
  }

  no.addEventListener("click", function () { hide(true); });

  if (standalone() || dismissed()) return;

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
              (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // Android and desktop Chrome hand us a real prompt
  var deferred = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    text.innerHTML = "Install <b>${title}</b> for offline use.";
    go.hidden = false;
    setTimeout(function () { bar.classList.add("up"); }, 1400);
  });

  go.addEventListener("click", function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function () { deferred = null; hide(true); });
  });

  // iOS has no prompt API — it has to be explained
  if (isIOS) {
    text.innerHTML = "Add to your Home Screen: tap <b>Share</b>, then <b>Add to Home Screen</b>. Your data is only kept for 7 days otherwise.";
    go.hidden = true;
    setTimeout(function () { bar.classList.add("up"); }, 1800);
  }

  window.addEventListener("appinstalled", function () { hide(true); });
})();
</script>
</body>
</html>
`;

writeFileSync(join(root, "public", "index.html"), HEAD + body + TAIL);

const kb = (s) => (s.length / 1024).toFixed(1) + " KB";
console.log("  hisob.html           " + kb(src) + "   (artifact build)");
console.log("  public/index.html    " + kb(HEAD + body + TAIL) + "   (hosted build, PWA)");
