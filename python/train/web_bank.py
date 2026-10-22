"""Public web-page screenshot bank for threat-only softplus (ofl-v1 step A).

Screenshots are built at train time from PUBLIC_URLS and stored under out/
(or FONTSNAP_WEB_BANK). They are never committed. realset3 URLs/domains are
refused. Source id and shot count are logged by ensure_web_bank.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from train.paths import OUT, assert_under_out

# Stable id for reports / logs (bump when the URL list changes).
BANK_SOURCE = "public-web-url-list-v2"
TARGET_SHOTS = 300
MAX_SHOTS_PER_URL = 4
PAGE_TIMEOUT_MS = 12_000
# Hard stop so bank build fits pod setup slack (see WEB_BANK_SLACK_SECONDS).
DEFAULT_DEADLINE_SECONDS = 180

# Public pages only. Domains must stay outside data/realset3 (guarded in tests).
PUBLIC_URLS: tuple[str, ...] = (
    "https://fonts.google.com/",
    "https://fonts.google.com/specimen/Inter",
    "https://fonts.google.com/specimen/Roboto",
    "https://fonts.google.com/specimen/Open+Sans",
    "https://fonts.google.com/specimen/Lato",
    "https://fonts.google.com/specimen/Montserrat",
    "https://fontsource.org/",
    "https://www.fontsquirrel.com/",
    "https://www.dafont.com/",
    "https://practicaltypography.com/",
    "https://practicaltypography.com/summary-of-key-rules.html",
    "https://typographica.org/",
    "https://fontsinuse.com/",
    "https://www.typography.com/",
    "https://www.hoefler.co/",
    "https://www.Klim.co.nz/",
    "https://www.colophon-foundry.org/",
    "https://www.velvetyne.fr/",
    "https://www.collletttivo.it/",
    "https://www.fontspring.com/",
    "https://www.myfonts.com/pages/whatsthefont",
    "https://stripe.com/",
    "https://stripe.com/docs",
    "https://vercel.com/",
    "https://vercel.com/docs",
    "https://netlify.com/",
    "https://www.cloudflare.com/",
    "https://www.digitalocean.com/",
    "https://about.gitlab.com/",
    "https://github.com/features",
    "https://github.com/pricing",
    "https://www.atlassian.com/",
    "https://www.notion.so/product",
    "https://www.figma.com/",
    "https://www.canva.com/",
    "https://www.dropbox.com/",
    "https://www.box.com/",
    "https://slack.com/",
    "https://www.zoom.us/",
    "https://www.shopify.com/",
    "https://www.shopify.com/blog",
    "https://webflow.com/",
    "https://www.squarespace.com/",
    "https://www.wix.com/",
    "https://wordpress.com/",
    "https://wordpress.org/",
    "https://elementor.com/",
    "https://tailwindcss.com/",
    "https://tailwindcss.com/docs/installation",
    "https://getbootstrap.com/",
    "https://getbootstrap.com/docs/5.3/getting-started/introduction/",
    "https://mui.com/",
    "https://ant.design/",
    "https://chakra-ui.com/",
    "https://react.dev/",
    "https://react.dev/learn",
    "https://nextjs.org/",
    "https://nextjs.org/docs",
    "https://vuejs.org/",
    "https://svelte.dev/",
    "https://astro.build/",
    "https://remix.run/",
    "https://nuxt.com/",
    "https://angular.dev/",
    "https://jquery.com/",
    "https://lodash.com/",
    "https://d3js.org/",
    "https://threejs.org/",
    "https://www.typescriptlang.org/",
    "https://www.typescriptlang.org/docs/",
    "https://nodejs.org/en",
    "https://deno.com/",
    "https://bun.sh/",
    "https://www.python.org/",
    "https://www.rust-lang.org/",
    "https://go.dev/",
    "https://www.swift.org/",
    "https://kotlinlang.org/",
    "https://www.java.com/",
    "https://www.php.net/",
    "https://www.ruby-lang.org/en/",
    "https://www.docker.com/",
    "https://kubernetes.io/",
    "https://www.terraform.io/",
    "https://prometheus.io/",
    "https://grafana.com/",
    "https://www.elastic.co/",
    "https://www.mongodb.com/",
    "https://www.postgresql.org/",
    "https://redis.io/",
    "https://www.sqlite.org/index.html",
    "https://www.mysql.com/",
    "https://www.theverge.com/",
    "https://techcrunch.com/",
    "https://arstechnica.com/",
    "https://www.wired.com/",
    "https://www.engadget.com/",
    "https://www.smashingmagazine.com/",
    "https://css-tricks.com/",
    "https://alistapart.com/",
    "https://www.sitepoint.com/",
    "https://dev.to/",
    "https://hashnode.com/",
    "https://medium.com/",
    "https://substack.com/",
    "https://www.producthunt.com/",
    "https://news.ycombinator.com/",
    "https://lobste.rs/",
    "https://www.reddit.com/r/web_design/",
    "https://www.reddit.com/r/typography/",
    "https://dribbble.com/",
    "https://www.behance.net/",
    "https://www.awwwards.com/",
    "https://www.cssdesignawards.com/",
    "https://land-book.com/",
    "https://saaslandingpage.com/",
    "https://www.landingfolio.com/",
    "https://onepagelove.com/",
    "https://www.siteinspire.com/",
    "https://godly.website/",
    "https://www.framer.com/",
    "https://www.framer.com/marketplace/",
    "https://web.dev/",
    "https://developer.chrome.com/",
    "https://developer.mozilla.org/en-US/",
    "https://developer.mozilla.org/en-US/docs/Web/CSS",
    "https://developer.mozilla.org/en-US/docs/Web/HTML",
    "https://www.w3.org/",
    "https://www.w3.org/Style/CSS/Overview.en.html",
    "https://caniuse.com/",
    "https://www.mozilla.org/en-US/",
    "https://www.chromium.org/",
    "https://webkit.org/",
    "https://blog.google/",
    "https://openai.com/",
    "https://openai.com/research",
    "https://www.anthropic.com/",
    "https://huggingface.co/",
    "https://huggingface.co/docs",
    "https://www.kaggle.com/",
    "https://arxiv.org/",
    "https://paperswithcode.com/",
    "https://www.nist.gov/",
    "https://www.nasa.gov/",
    "https://www.esa.int/",
    "https://www.reuters.com/",
    "https://apnews.com/",
    "https://www.npr.org/",
    "https://www.theguardian.com/international",
    "https://www.nytimes.com/",
    "https://www.washingtonpost.com/",
    "https://www.economist.com/",
    "https://www.ft.com/",
    "https://www.bloomberg.com/",
    "https://www.cnn.com/",
    "https://www.aljazeera.com/",
    "https://www.gov.uk/",
    "https://www.usa.gov/",
    "https://europa.eu/",
    "https://www.un.org/en/",
    "https://www.who.int/",
    "https://www.cdc.gov/",
    "https://www.nih.gov/",
    "https://www.britannica.com/",
    "https://www.nationalgeographic.com/",
    "https://www.smithsonianmag.com/",
    "https://www.metmuseum.org/",
    "https://www.loc.gov/",
    "https://www.bl.uk/",
    "https://www.nypl.org/",
    "https://openlibrary.org/",
    "https://www.gutenberg.org/",
    "https://archive.org/",
    "https://en.wikipedia.org/wiki/Main_Page",
    "https://en.wikipedia.org/wiki/Typography",
    "https://en.wikipedia.org/wiki/Sans-serif",
    "https://en.wikipedia.org/wiki/Helvetica",
    "https://en.wikipedia.org/wiki/Web_typography",
    "https://en.wikipedia.org/wiki/Cascading_Style_Sheets",
    "https://en.wiktionary.org/wiki/font",
    "https://commons.wikimedia.org/wiki/Main_Page",
    "https://www.wikipedia.org/",
    "https://docs.python.org/3/",
    "https://docs.python.org/3/tutorial/",
    "https://docs.github.com/en",
    "https://stackoverflow.com/questions",
    "https://superuser.com/",
    "https://serverfault.com/",
    "https://askubuntu.com/",
    "https://unix.stackexchange.com/",
    "https://tex.stackexchange.com/",
    "https://math.stackexchange.com/",
    "https://www.latex-project.org/",
    "https://www.overleaf.com/",
    "https://tug.org/",
    "https://ctan.org/",
    "https://www.apache.org/",
    "https://www.debian.org/",
    "https://ubuntu.com/",
    "https://www.kernel.org/",
    "https://git-scm.com/",
    "https://git-scm.com/doc",
    "https://www.gnu.org/",
    "https://www.gnu.org/philosophy/free-sw.html",
    "https://opensource.org/",
    "https://www.linuxfoundation.org/",
    "https://www.cncf.io/",
    "https://json.org/",
    "https://yaml.org/",
    "https://toml.io/en/",
    "https://commonmark.org/",
    "https://www.openstreetmap.org/",
    "https://www.openstreetmap.org/about",
)

_CROP_JS = r"""() => {
  const els = [...document.querySelectorAll(
    'h1,h2,h3,h4,button,a,p,nav a,label,span,[class*=title],[class*=hero]'
  )];
  const out = [];
  const seen = new Set();
  for (const el of els) {
    const txt = (el.innerText || '').trim();
    if (txt.length < 3 || txt.length > 70 || txt.includes('\n\n')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 11 || r.top < 0 || r.left < 0) continue;
    if (r.bottom > innerHeight || r.right > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity < 0.5) continue;
    const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    const key = fam.toLowerCase() + Math.round(r.top / 20);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({x: r.left, y: r.top, w: r.width, h: r.height, size: parseFloat(cs.fontSize)});
  }
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, 8);
}"""


def bank_root() -> Path:
    override = os.environ.get("FONTSNAP_WEB_BANK")
    if override:
        return assert_under_out(Path(override))
    return assert_under_out(OUT / "web-bank")


def shot_paths(root: Path | None = None) -> tuple[Path, ...]:
    base = bank_root() if root is None else assert_under_out(root)
    if not base.is_dir():
        return ()
    return tuple(sorted(p for p in base.glob("*.png") if p.is_file()))


def _chrome_executable() -> str | None:
    for candidate in (
        os.environ.get("FONTSNAP_CHROME"),
        "/usr/local/bin/google-chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def _capture(root: Path, *, deadline_seconds: int) -> int:
    from playwright.sync_api import sync_playwright

    root.mkdir(parents=True, exist_ok=True)
    existing = list(shot_paths(root))
    if len(existing) >= TARGET_SHOTS:
        return len(existing)
    started = time.perf_counter()
    chrome = _chrome_executable()
    with sync_playwright() as pw:
        launch_kwargs: dict = {"args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        if chrome:
            launch_kwargs["executable_path"] = chrome
        browser = pw.chromium.launch(**launch_kwargs)
        try:
            for index, url in enumerate(PUBLIC_URLS):
                if len(existing) >= TARGET_SHOTS:
                    break
                if time.perf_counter() - started >= deadline_seconds:
                    break
                ctx = browser.new_context(viewport={"width": 1280, "height": 800})
                page = ctx.new_page()
                page.set_default_timeout(PAGE_TIMEOUT_MS)
                try:
                    page.goto(url, timeout=PAGE_TIMEOUT_MS, wait_until="domcontentloaded")
                    page.wait_for_timeout(800)
                    cands = page.evaluate(_CROP_JS)
                    for j, cand in enumerate(cands[:MAX_SHOTS_PER_URL]):
                        if len(existing) >= TARGET_SHOTS:
                            break
                        pad = 14
                        x = max(0.0, float(cand["x"]) - pad)
                        y = max(0.0, float(cand["y"]) - pad)
                        w = min(float(cand["w"]) + 2 * pad, 1280.0 - x)
                        h = min(float(cand["h"]) + 2 * pad, 800.0 - y)
                        if w < 20 or h < 10:
                            continue
                        dest = root / f"u{index:03d}_{j}.png"
                        page.screenshot(path=str(dest), clip={"x": x, "y": y, "width": w, "height": h})
                        existing.append(dest)
                except Exception:
                    pass
                finally:
                    ctx.close()
        finally:
            browser.close()
    return len(existing)


def ensure_web_bank(
    *,
    fetch: bool = True,
    root: Path | None = None,
    deadline_seconds: int = DEFAULT_DEADLINE_SECONDS,
) -> tuple[Path, int]:
    """Return (bank_dir, shot_count), building screenshots when fetch is true."""
    base = bank_root() if root is None else assert_under_out(root)
    base.mkdir(parents=True, exist_ok=True)
    count = len(shot_paths(base))
    if fetch and count < TARGET_SHOTS:
        try:
            count = _capture(base, deadline_seconds=deadline_seconds)
        except Exception as err:
            if count == 0:
                raise RuntimeError(f"web bank capture failed: {err}") from err
    count = len(shot_paths(base))
    print(f"fontsnap: web_bank source={BANK_SOURCE} urls={len(PUBLIC_URLS)} shots={count}", flush=True)
    if count == 0:
        raise RuntimeError("web bank is empty (no screenshots)")
    return base, count


def prepared_shot_chw(path: Path, *, textcrop: str) -> object:
    """Load one bank PNG → evaluate pack/crop → prep CHW float32."""
    import numpy as np
    from PIL import Image

    from fontsnap_ref.pipeline import prep
    from fontsnap_ref.textcrop import crop_normalize

    if textcrop not in ("pack", "crop"):
        raise ValueError(f"textcrop must be 'pack' or 'crop', got {textcrop!r}")
    # prep() calls to_rgb; do not Image.convert("RGB") (image-loading guard).
    canvas = crop_normalize(Image.open(path), textcrop)
    batch = prep(canvas)
    chw = np.ascontiguousarray(batch[0], dtype=np.float32)
    if chw.shape != (3, 320, 320):
        raise RuntimeError(f"prep shape {chw.shape}")
    return chw


class WebNegativeBank:
    """Iterable CHW views (pack and crop per shot) for softplus, no CE labels."""

    def __init__(self, root: Path | None = None) -> None:
        paths = shot_paths(root)
        if not paths:
            raise RuntimeError("web bank has no png shots")
        self.paths = paths
        # Both evaluate views per shot — same domain as realset3 / extension.
        self.views: tuple[tuple[Path, str], ...] = tuple(
            (path, view) for path in paths for view in ("pack", "crop")
        )

    def __len__(self) -> int:
        return len(self.views)

    def __getitem__(self, index: int):
        import torch

        path, view = self.views[index % len(self.views)]
        return torch.from_numpy(prepared_shot_chw(path, textcrop=view))
