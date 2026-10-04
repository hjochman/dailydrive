/**
 * Daily Drive — Client-side i18n language switcher
 * Loads DE or EN strings from /i18n/{lang}.json and applies them to
 * all elements with a data-i18n attribute.
 * The active language is persisted in localStorage.
 */
(function () {
  "use strict";

  const DEFAULT_LANG = "de";
  const SUPPORTED    = ["de", "en"];

  let _strings = {};

  function currentLang() {
    const stored = localStorage.getItem("dd_lang");
    return SUPPORTED.includes(stored) ? stored : DEFAULT_LANG;
  }

  function applyStrings() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (_strings[key] !== undefined) {
        // Allow simple HTML in values (used for <strong> in instructions)
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          el.placeholder = _strings[key];
        } else {
          el.innerHTML = _strings[key];
        }
      }
    });

    // Format timestamps based on the current active language (locale)
    document.querySelectorAll("[data-timestamp]").forEach((el) => {
      const ts = el.getAttribute("data-timestamp");
      if (ts) {
        try {
          const date = new Date(ts);
          if (!isNaN(date.getTime())) {
            el.textContent = date.toLocaleString(currentLang());
          }
        } catch (e) {
          console.error("i18n: Failed to format timestamp", ts, e);
        }
      }
    });

    // Update lang buttons
    document.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lang === currentLang());
    });

    // Update html lang attribute
    document.documentElement.lang = currentLang();
  }

  async function loadLang(lang) {
    try {
      const resp = await fetch(`/i18n/${lang}.json?v=${Date.now()}`);
      if (!resp.ok) throw new Error("fetch failed");
      _strings = await resp.json();
      localStorage.setItem("dd_lang", lang);
      applyStrings();
    } catch (e) {
      console.warn("i18n: could not load", lang, e);
    }
  }

  // Public API
  window.DDLang = {
    load: () => loadLang(currentLang()),
    switch: (lang) => loadLang(lang),
    t: (key) => _strings[key] || key,
  };

  // Auto-load on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => DDLang.load());
  } else {
    DDLang.load();
  }
})();
