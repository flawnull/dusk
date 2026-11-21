"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULTS = {
  enabled: true,
  followSystem: false,
  siteModes: {},
  disabledSites: [],
  intensity: 90,
  warmth: 0,
  dimImages: false,
};

const STATE_TEXT = {
  active: "Darkening this page.",
  forced: "Darkening this page (always on for this site).",
  "already-dark": "This site is already dark, so Dusk leaves it alone.",
  "site-off": "Off for this site.",
  "system-light": "Waiting: your Mac is in light mode.",
  disabled: "Dark mode is off.",
};

const $ = (id) => document.getElementById(id);

async function currentTab() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    return url.protocol.startsWith("http") ? { id: tab.id, host: url.hostname } : null;
  } catch {
    return null;
  }
}

async function refreshStatus(tab) {
  const el = $("status");
  if (!tab) {
    el.textContent = "Dusk only works on web pages.";
    return;
  }
  try {
    const res = await api.tabs.sendMessage(tab.id, { type: "dusk:state" });
    el.textContent = STATE_TEXT[res && res.state] || "";
  } catch {
    el.textContent = "Reload this page, or allow Dusk on this website in Safari > Settings > Extensions.";
  }
}

function siteModeOf(settings, host) {
  const modes = settings.siteModes;
  const mode = modes && typeof modes === "object" && Object.prototype.hasOwnProperty.call(modes, host) ? modes[host] : undefined;
  if (mode === "on" || mode === "off") return mode;
  return Array.isArray(settings.disabledSites) && settings.disabledSites.includes(host) ? "off" : "auto";
}

async function init() {
  const settings = { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) };
  const tab = await currentTab();

  $("enabled").checked = settings.enabled;
  $("followSystem").checked = settings.followSystem;
  $("intensity").value = settings.intensity;
  $("intensityValue").textContent = settings.intensity + "%";
  $("warmth").value = settings.warmth;
  $("warmthValue").textContent = warmthLabel(settings.warmth);
  $("dimImages").checked = settings.dimImages;

  const radios = document.querySelectorAll('input[name="siteMode"]');
  if (tab) {
    $("host").textContent = tab.host;
    const mode = siteModeOf(settings, tab.host);
    for (const r of radios) r.checked = r.value === mode;
  } else {
    $("siteRow").classList.add("disabled");
    for (const r of radios) r.disabled = true;
  }

  refreshStatus(tab);
  api.storage.onChanged.addListener(() => setTimeout(() => refreshStatus(tab), 50));

  $("enabled").addEventListener("change", (e) => {
    api.storage.local.set({ enabled: e.target.checked });
  });

  $("followSystem").addEventListener("change", (e) => {
    api.storage.local.set({ followSystem: e.target.checked });
  });

  $("dimImages").addEventListener("change", (e) => {
    api.storage.local.set({ dimImages: e.target.checked });
  });

  for (const r of radios) {
    r.addEventListener("change", async (e) => {
      if (!e.target.checked || !tab) return;
      const current = { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) };
      // Built from entries, never by assignment: a host named "__proto__"
      // would otherwise hit the prototype setter and be silently dropped.
      const old = current.siteModes && typeof current.siteModes === "object" ? current.siteModes : {};
      const entries = Object.entries(old).filter(([h, m]) => h !== tab.host && (m === "on" || m === "off"));
      if (e.target.value !== "auto") entries.push([tab.host, e.target.value]);
      const siteModes = Object.fromEntries(entries);
      // Retire the v1.0 list entry for this host so the new choice wins.
      const disabledSites = (Array.isArray(current.disabledSites) ? current.disabledSites : []).filter((h) => h !== tab.host);
      api.storage.local.set({ siteModes, disabledSites });
    });
  }

  slider("intensity", (v) => v + "%");
  slider("warmth", warmthLabel);
}

function warmthLabel(v) {
  return Number(v) === 0 ? "Off" : v + "%";
}

// Every write restyles every open tab, so write at most every 150 ms while
// dragging, and always once when the slider is released.
function slider(key, label) {
  const input = $(key);
  let pending = null;
  const save = () => {
    clearTimeout(pending);
    pending = null;
    api.storage.local.set({ [key]: Number(input.value) });
  };
  input.addEventListener("input", () => {
    $(key + "Value").textContent = label(input.value);
    if (pending === null) pending = setTimeout(save, 150);
  });
  input.addEventListener("change", save);
}

init();
