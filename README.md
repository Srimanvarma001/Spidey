<img src="extension/icons/icon128.png" width="96" alt="Web Crawler logo: a blue spider on a thread to a link">

# Web Crawler

A spider that crawls the webpage you are looking at. It walks on six zigzag inverse-kinematics legs, shoots a thread from its head to one link at a time, and restyles each link it catches: new font, new colour, highlight bars, tiny or huge, and now and then knocked out of place.

Nothing is scraped or sent anywhere. Press **Esc** (or trigger it again) and the page is put back exactly as it was.

- `architecture.md`: the architecture, in detail
- `spider-web-crawler.md`: the original brief

## Try it

**Demo page (no install).** Open `demo/index.html` in a browser and press *Release the spider*.

**Chrome extension (works on any site).**

1. Open `chrome://extensions`
2. Turn on *Developer mode*
3. *Load unpacked* → choose the `extension/` folder
4. Open any page and click the spider icon, or press `Alt+Shift+S`

The icon shows an `ON` badge while the spider is out. After changing any file in `extension/`, press the reload arrow on its card at `chrome://extensions`.

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
| Esc, or click the icon again | The restyled links fly home, the spider fades, and the page is restored |

## Tuning

Every constant is in the `CFG` object at the top of `extension/crawler.js`: speeds, leg lengths, step size, thread range and timing, how often a foot kicks a link out of place. Two worth knowing:

- `themeEvery: 6000` alternates the blue/pink spider with the orange/green one every six seconds, as the original clip does. The default keeps it blue/pink.
- `words: 'auto'` leaves plain text alone wherever the page has links, and falls back to single words where it has few. `false` means links only, `true` means words always.

See the tuning guide in `architecture.md` §16.

## Layout

```
extension/   manifest.json, background.js, crawler.js (the whole spider), icons/
demo/        index.html, a dark Wikipedia-style references page
tools/       make-icons.ps1, regenerates the extension icons
```

There is no build step. `crawler.js` is one dependency-free file used by the extension, the demo, and the bookmarklet alike.
