"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULTS = {
  enabled: true,
  followSystem: false,
  siteModes: {},
  disabledSites: [],
  intensity: 90,
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
    el.textContent = "Reload this page to apply Dusk.";
  }
}

function siteModeOf(settings, host) {
  const mode = settings.siteModes[host];
  if (mode === "on" || mode === "off") return mode;
  return settings.disabledSites.includes(host) ? "off" : "auto";
}

async function init() {
  const settings = { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) };
  const tab = await currentTab();

  $("enabled").checked = settings.enabled;
  $("followSystem").checked = settings.followSystem;
  $("intensity").value = settings.intensity;
  $("intensityValue").textContent = settings.intensity + "%";

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

  for (const r of radios) {
    r.addEventListener("change", async (e) => {
      if (!e.target.checked || !tab) return;
      const current = { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) };
      const siteModes = { ...current.siteModes };
      if (e.target.value === "auto") delete siteModes[tab.host];
      else siteModes[tab.host] = e.target.value;
      // Retire the v1.0 list entry for this host so the new choice wins.
      const disabledSites = current.disabledSites.filter((h) => h !== tab.host);
      api.storage.local.set({ siteModes, disabledSites });
    });
  }

  $("intensity").addEventListener("input", (e) => {
    const value = Number(e.target.value);
    $("intensityValue").textContent = value + "%";
    api.storage.local.set({ intensity: value });
  });
}

init();
