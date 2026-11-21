// @ts-check
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const { EXT, stubApi, watch } = require("../helpers");

const POPUP_ORIGIN = "http://ext.test";

async function openPopup(page, { settings = {}, tabUrl = "https://news.example/a", sendMessage = { value: { state: "active" } }, waitStatus = true } = {}) {
  const log = watch(page);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const file = path.join(EXT, url.pathname);
    if (url.origin === POPUP_ORIGIN && file.startsWith(EXT) && fs.existsSync(file)) {
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
      return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  const tab = tabUrl === null ? null : { id: 7, url: tabUrl };
  await page.addInitScript(stubApi, { initial: settings, tab, sendMessage });
  await page.goto(POPUP_ORIGIN + "/popup/popup.html");
  if (waitStatus) await page.waitForFunction(() => document.getElementById("status").textContent !== "");
  else await page.waitForLoadState("load");
  return log;
}

const store = (page) => page.evaluate(() => window.__duskStore);
const wait = (page, ms) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);
// The radios are visually hidden; click their visible label text instead.
const pick = (page, label) => page.locator(".segmented label", { hasText: label }).click();

test("shows host and status from the content script", async ({ page }) => {
  const log = await openPopup(page, { sendMessage: { value: { state: "already-dark" } } });
  await expect(page.locator("#host")).toHaveText("news.example");
  await expect(page.locator("#status")).toContainText("already dark");
  expect(log.errors).toEqual([]);
});

test("Always writes siteModes and retires the legacy disabledSites entry", async ({ page }) => {
  await openPopup(page, { settings: { disabledSites: ["news.example", "keep.example"] } });
  await expect(page.locator('input[value="off"]')).toBeChecked(); // legacy read as off
  await pick(page, "Always");
  await wait(page, 50);
  const s = await store(page);
  expect(s.siteModes).toEqual({ "news.example": "on" });
  expect(s.disabledSites).toEqual(["keep.example"]);
});

test("Auto deletes the host key, Off sets it", async ({ page }) => {
  await openPopup(page, { settings: { siteModes: { "news.example": "on", "x.example": "off" } } });
  await expect(page.locator('input[value="on"]')).toBeChecked();
  await pick(page, "Off");
  await wait(page, 50);
  expect((await store(page)).siteModes).toEqual({ "news.example": "off", "x.example": "off" });
  await pick(page, "Auto");
  await wait(page, 50);
  expect((await store(page)).siteModes).toEqual({ "x.example": "off" });
});

test("non-http tab disables site controls", async ({ page }) => {
  await openPopup(page, { tabUrl: "safari-extension://abc/page.html" });
  await expect(page.locator("#siteRow")).toHaveClass(/disabled/);
  for (const v of ["auto", "on", "off"]) await expect(page.locator(`input[value="${v}"]`)).toBeDisabled();
  await expect(page.locator("#status")).toHaveText("Dusk only works on web pages.");
});

test("no active tab at all behaves like a non-web page", async ({ page }) => {
  const log = await openPopup(page, { tabUrl: null });
  await expect(page.locator("#status")).toHaveText("Dusk only works on web pages.");
  expect(log.errors).toEqual([]);
});

test("sendMessage failure tells the user to reload", async ({ page }) => {
  await openPopup(page, { sendMessage: { reject: true } });
  await expect(page.locator("#status")).toContainText("Reload this page");
});

test("unknown state from the content script shows nothing, not 'undefined'", async ({ page }) => {
  await openPopup(page, { sendMessage: { value: { state: "weird" } }, waitStatus: false });
  await wait(page, 100);
  const text = await page.locator("#status").textContent();
  expect(text).not.toContain("undefined");
});

test("toggles write enabled and followSystem", async ({ page }) => {
  await openPopup(page);
  await expect(page.locator("#enabled")).toBeChecked();
  await expect(page.locator("#followSystem")).not.toBeChecked();
  await page.locator("#enabled").click();
  await page.locator("#followSystem").click();
  await wait(page, 50);
  const s = await store(page);
  expect(s.enabled).toBe(false);
  expect(s.followSystem).toBe(true);
});

test("intensity slider saves a number and updates the label", async ({ page }) => {
  await openPopup(page);
  await expect(page.locator("#intensityValue")).toHaveText("90%");
  await page.locator("#intensity").fill("65");
  await wait(page, 250);
  await expect(page.locator("#intensityValue")).toHaveText("65%");
  expect((await store(page)).intensity).toBe(65);
});

test("status refreshes after a setting change", async ({ page }) => {
  await openPopup(page, { sendMessage: { value: { state: "active" } } });
  await expect(page.locator("#status")).toHaveText("Darkening this page.");
  // Next reply from the content script will say disabled.
  await page.evaluate(() => {
    window.browser.tabs.sendMessage = () => Promise.resolve({ state: "disabled" });
  });
  await page.locator("#enabled").click();
  await expect(page.locator("#status")).toHaveText("Dark mode is off.");
});
