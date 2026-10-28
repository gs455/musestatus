"use strict";
// Theme for the docs pages: the stored choice wins, else the system
// preference. The key matches the hub docs pages' convention.
(function () {
  var key = "musestatus-docs-theme";
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem(key); } catch (error) { /* private mode */ }
  var dark = stored ? stored === "dark"
    : (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) root.setAttribute("data-theme", "dark");
  var toggle = document.querySelector(".docs-theme");
  function paint() {
    var isDark = root.getAttribute("data-theme") === "dark";
    toggle.textContent = isDark ? "☀️" : "🌙";
    toggle.title = isDark ? "Light mode" : "Dark mode";
    toggle.setAttribute("aria-label", toggle.title);
  }
  if (toggle) {
    paint();
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      if (next === "dark") root.setAttribute("data-theme", "dark");
      else root.removeAttribute("data-theme");
      try { localStorage.setItem(key, next); } catch (error) { /* private mode */ }
      paint();
    });
  }
})();
