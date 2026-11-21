"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULTS = { enabled: true, disabledSites: [], intensity: 90 };

const $ = (id) => document.getElementById(id);

async function currentHost() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    return url.protocol.startsWith("http") ? url.hostname : null;
  } catch {
    return null;
  }
}

async function init() {
  const settings = { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) };
  const host = await currentHost();

  $("enabled").checked = settings.enabled;
  $("intensity").value = settings.intensity;
  $("intensityValue").textContent = settings.intensity + "%";

  if (host) {
    $("host").textContent = host;
    $("site").checked = !settings.disabledSites.includes(host);
  } else {
    $("site").disabled = true;
  }

  $("enabled").addEventListener("change", (e) => {
    api.storage.local.set({ enabled: e.target.checked });
  });

  $("site").addEventListener("change", async (e) => {
    const { disabledSites } = await api.storage.local.get(DEFAULTS);
    const next = new Set(disabledSites);
    if (e.target.checked) next.delete(host);
    else next.add(host);
    api.storage.local.set({ disabledSites: [...next] });
  });

  $("intensity").addEventListener("input", (e) => {
    const value = Number(e.target.value);
    $("intensityValue").textContent = value + "%";
    api.storage.local.set({ intensity: value });
  });
}

init();
