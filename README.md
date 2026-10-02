# 🕷️ Web Crawler

A spider that crawls the webpage you are looking at. It walks on eight inverse-kinematics legs, plants its feet on real links and words, and drags them out of place in new fonts and colours.

Nothing is scraped or sent anywhere. Press **Esc** (or trigger it again) and the page is put back exactly as it was.

- `archi.md`: the architecture, in detail
- `spider-web-crawler.md`: the original brief

## Try it

**Demo page (no install).** Open `demo/index.html` in a browser and press *Release the spider*.

**Chrome extension (works on any site).**

1. Open `chrome://extensions`
2. Turn on *Developer mode*
3. *Load unpacked* → choose the `extension/` folder
4. Open any page and click the spider icon, or press `Alt+Shift+S`

**Console.** Paste the contents of `extension/crawler.js` into DevTools on any page.

**Bookmarklet.** Host `extension/crawler.js` somewhere and save this as a bookmark:

```js
javascript:(()=>{const s=document.createElement('script');s.src='https://sriman.online/crawler.js';document.body.appendChild(s);})()
```

Sites with a strict Content-Security-Policy (Wikipedia, GitHub) block bookmarklet scripts. Use the extension there.

## Controls

| Action | Result |
|---|---|
| Move the mouse | The spider follows the cursor |
| Leave the mouse still for 2.5 s | It wanders toward nearby text on its own |
| Scroll | It scurries to catch up with the viewport |
| Esc, or click the icon again | Spider removed, page restored |

## Tuning

Every constant is in the `CFG` object at the top of `extension/crawler.js`: speeds, leg lengths, step size, how often links and words get grabbed, fonts, palettes. `words: false` makes it move links only, like the original clip. See the tuning guide in `archi.md` §16.

## Layout

```
extension/   manifest.json, background.js, crawler.js (the whole spider), icons/
demo/        index.html, a dark Wikipedia-style references page
tools/       make-icons.ps1, regenerates the extension icons
```

There is no build step. `crawler.js` is one dependency-free file used by the extension, the demo, and the bookmarklet alike.
