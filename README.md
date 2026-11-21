# Dusk

A free, small dark mode extension for Safari on macOS.

I built it because the free Safari dark mode extensions I tried kept crashing Safari when switching apps. Dusk does almost nothing at runtime, which is the point.

## How it works

Dusk adds one `<style>` tag to each page. It inverts the page colors with a CSS filter, then flips images, video, canvas and iframes back so they look normal. Pages that already have a dark background are left alone.

There is no DOM scanning, no `MutationObserver` watching the page, and no background script. Safari's rendering engine does all the work, so cost stays flat on heavy pages and nothing keeps running when you switch apps.

## Privacy

- No network requests. The code never calls `fetch`, `XMLHttpRequest` or anything similar.
- No access to screen, tabs history, cookies, keystrokes or page content.
- Permissions: `storage` (your three settings) and `activeTab` (so the popup can show the current site name).
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
5. In Safari: **Settings > Extensions**, tick **Dusk**, and allow it on all websites.

If Dusk does not show up in step 5, enable **Safari > Settings > Advanced > Show features for web developers**, then **Develop > Allow Unsigned Extensions**. With a free Apple ID team this is usually not needed. With "Sign to Run Locally" Safari resets that option on every launch, so pick your Apple ID team.

## Use

Click the moon in the Safari toolbar:

- **Dark mode**: global on/off.
- **On this site**: turn Dusk off for the current site only.
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
- Sites with a transparent background and a dark design painted by inner elements may get inverted. Turn Dusk off for that site.

## License

MIT
