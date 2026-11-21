# Dusk

A free, small dark mode extension for Safari on macOS.

I built it because the free Safari dark mode extensions I tried kept crashing Safari when switching apps. Dusk does almost nothing at runtime, which is the point.

## How it works

Dusk adds one `<style>` tag to each page. It inverts the page colors with a CSS filter, then flips images, video, canvas and iframes back so they look normal. Media is re-inverted with a matching contrast correction, so photos keep their real colors at every intensity. Pages that already have a dark background are left alone: Dusk samples what is actually painted on screen, not just `<body>`.

There is no DOM scanning, no `MutationObserver` watching the page, and no background script. Safari's rendering engine does all the work, so cost stays flat on heavy pages and nothing keeps running when you switch apps.

## Privacy

- No network requests. The code never calls `fetch`, `XMLHttpRequest` or anything similar.
- No access to screen, tabs history, cookies, keystrokes or page content.
- Permissions: `storage` (your settings) and `activeTab` (so the popup can show the current site name).
- The whole extension is about 200 lines. Read it in [`extension/`](extension/).

## Install (needs Xcode, free)

Safari only loads extensions that live inside a Mac app, so you build a tiny wrapper app once.

1. Install Xcode from the App Store and open it once.
2. Clone this repo and run the build script:

   ```bash
   git clone <this repo url> dusk
   ```

   ```bash
   cd dusk && ./build-mac.sh
   ```

3. Xcode opens. Click the **Dusk** project in the sidebar, then for both the **Dusk** and **Dusk Extension** targets go to **Signing & Capabilities** and set **Team** to your Apple ID (Xcode > Settings > Accounts to add it; a free account works).
4. Press **Cmd+R**. A small Dusk window opens. You can close it.

   Skip steps 3 and 4 next time by passing your team ID: `TEAM=ABCDE12345 ./build-mac.sh` builds, signs and launches the app. Find the ID with `security find-identity -v -p codesigning` (the code in brackets). Free Apple ID signing expires after about 7 days; run the script again to renew.
5. In Safari: **Settings > Extensions**, tick **Dusk**, and allow it on all websites.

If Dusk does not show up in step 5, enable **Safari > Settings > Advanced > Show features for web developers**, then **Develop > Allow Unsigned Extensions**. With a free Apple ID team this is usually not needed. With "Sign to Run Locally" Safari resets that option on every launch, so pick your Apple ID team.

## Use

Click the moon in the Safari toolbar:

- **Dark mode**: global on/off.
- **Status line**: what Dusk is doing on this page, for example "This site is already dark".
- **Only when my Mac is dark**: follow the macOS appearance and switch live with it.
- **This site**: **Auto** (darken unless already dark), **Always** (for sites Dusk wrongly thinks are dark) or **Off**.
- **Intensity**: 50% to 100%. Lower is softer gray, higher is closer to black.

## No-Xcode option

Safari can apply one custom stylesheet to every site with no extension at all.

**Safari > Settings > Advanced > Style sheet > Other...** and pick [`stylesheet-fallback/dusk.css`](stylesheet-fallback/dusk.css).

It cannot detect already-dark sites or be turned off per site, but it cannot crash anything either.

## Layout

```
extension/            the web extension (manifest v3)
  content.js          applies and removes the dark style
  popup/              toolbar popup
  icons/
build-mac.sh          wraps the extension in a macOS app via Xcode
stylesheet-fallback/  single CSS file for Safari's built-in style sheet option
scripts/make_icons.py regenerates the icons
```

## Known limits

- Inversion is a filter, so a few colors shift slightly. Brand colors in logos made with CSS (not images) will look off.
- If Dusk guesses wrong about a site being dark or light, set that site to **Always** or **Off**.
- Background images set from a stylesheet (not inline) are inverted with the page.
- Fullscreen video and content show in natural colors.

## License

MIT
