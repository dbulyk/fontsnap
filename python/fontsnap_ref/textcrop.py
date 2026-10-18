"""Text crop / normalize (FontSnap). Pure numpy+cv2 ops chosen to be easy to port to JS (canvas + typed arrays):
grayscale -> dominant-gray polarity + morphological top/black-hat ink map -> polarity normalize (dark text on white) -> ink map (Otsu on
|bg-gray|) -> horizontal projection -> text lines -> tight per-line crops -> contrast-normalized dark-on-white ->
scale each line to a fixed height -> optionally pack lines into a near-square canvas so the 320x320 input is filled.
mode: 'crop' = lines stacked (no wrapping), 'pack' = wrap/stack into near-square."""

import cv2
import numpy as np
from PIL import Image

from .image import to_rgb

LINE_H = 96  # target line height in px before final 320 resize


def _otsu(v):
    v = np.clip(v, 0, 255).astype(np.uint8)
    t, _ = cv2.threshold(v, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return t


def _runs(mask, min_gap):
    """start/end of True runs in a 1D bool array, merging gaps < min_gap."""
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return []
    runs = []
    s = p = idx[0]
    for i in idx[1:]:
        if i - p > min_gap:
            runs.append((s, p + 1))
            s = i
        p = i
    runs.append((s, p + 1))
    return runs


def text_lines(img):
    """returns (normalized dark-on-white uint8 gray image, list of (y0,y1,x0,x1) line boxes)"""
    g = cv2.cvtColor(np.asarray(to_rgb(img)), cv2.COLOR_RGB2GRAY).astype(np.float32)
    h, w = g.shape
    k = int(np.clip(h * 0.5, 9, 61)) | 1
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    g8 = g.astype(np.uint8)
    hist = np.convolve(np.bincount(g8.ravel(), minlength=256), np.ones(9) / 9, "same")
    m = float(hist.argmax())
    prior_light = (g > m + 30).mean() > (g < m - 30).mean()  # background = dominant gray; text = minority side
    cands = {}
    for light_text in (False, True):  # try both polarities, keep the more text-like ink map
        d = (cv2.morphologyEx(g8, cv2.MORPH_TOPHAT, ker) if light_text else cv2.morphologyEx(g8, cv2.MORPH_BLACKHAT, ker)).astype(
            np.float32
        )
        if d.max() < 10:
            continue
        t = max(_otsu(d * 255.0 / max(d.max(), 1)) * max(d.max(), 1) / 255.0, 12.0)
        ink = d > t
        n, lab, st, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), 8)
        cw_, ch_, area = st[:, cv2.CC_STAT_WIDTH], st[:, cv2.CC_STAT_HEIGHT], st[:, cv2.CC_STAT_AREA]
        x_, y_ = st[:, cv2.CC_STAT_LEFT], st[:, cv2.CC_STAT_TOP]
        fill = area / np.maximum(cw_ * ch_, 1)
        touch = (x_ <= 0) | (y_ <= 0) | (x_ + cw_ >= w) | (y_ + ch_ >= h)
        big = ((cw_ > 0.7 * w) & (fill > 0.35)) | (ch_ > 0.9 * h) | (touch & ((ch_ > 0.6 * h) | (cw_ > 0.5 * w)))
        keep = (area >= 4) & ~big
        keep[0] = False
        if not keep.any():
            continue
        hk = ch_[keep]
        score = float(np.sort(hk)[-min(len(hk), 40) :].sum())  # tall letter-like components win; counters/dots are short
        cands[light_text] = (score, d, keep[lab])
    if not cands:
        return None, []
    pick = prior_light if prior_light in cands else (not prior_light)
    if (not pick) in cands and cands[not pick][0] > 2.0 * cands[pick][0]:
        pick = not pick  # override prior only on strong evidence
    _, d, ink = cands[pick]
    rows = ink.sum(1) > max(1, 0.003 * w)
    lines = []
    for y0, y1 in _runs(rows, max(1, h // 100)):
        if y1 - y0 < 5:
            continue
        cols = ink[y0:y1].any(0)
        cr = _runs(cols, (y1 - y0))  # merge gaps smaller than a line height (word spaces)
        if not cr:
            continue
        x0, x1 = cr[0][0], cr[-1][1]
        if x1 - x0 < 4:
            continue
        lines.append((y0, y1, x0, x1))
    # contrast-normalized image: text dark, bg white, antialiasing kept
    halo = cv2.dilate(ink.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=2).astype(bool)
    norm = 255 - np.clip(d * 255.0 / max(np.percentile(d[ink], 90) if ink.any() else 1, 1), 0, 255)
    norm[~halo] = 255
    return norm.astype(np.uint8), lines


def crop_normalize(img, mode="pack", line_h=LINE_H, max_lines=6):
    norm, lines = text_lines(img)
    if not lines:  # fallback: just polarity-normalized full image
        return img if norm is None else Image.fromarray(norm).convert("RGB")
    lines = sorted(lines, key=lambda b: -(b[1] - b[0]) * (b[3] - b[2]))[:max_lines]
    lines.sort(key=lambda b: b[0])
    hs = np.array([b[1] - b[0] for b in lines])
    ref = np.median(hs)
    lines = [b for b in lines if (b[1] - b[0]) > 0.4 * ref]  # drop tiny lines (captions/noise) relative to main text
    H, W = norm.shape
    strips = []
    for y0, y1, x0, x1 in lines:
        m = int(0.15 * (y1 - y0)) + 1
        s = norm[max(0, y0 - m) : min(H, y1 + m), max(0, x0 - m) : min(W, x1 + m)]
        sc = line_h / s.shape[0]
        strips.append(cv2.resize(s, (max(1, int(s.shape[1] * sc)), line_h), interpolation=cv2.INTER_CUBIC if sc > 1 else cv2.INTER_AREA))
    gap = line_h // 3
    if mode == "crop":
        cw = max(s.shape[1] for s in strips)
        out = np.full((len(strips) * (line_h + gap) + gap, cw + 2 * gap), 255, np.uint8)
        for i, s in enumerate(strips):
            out[gap + i * (line_h + gap) : gap + i * (line_h + gap) + line_h, gap : gap + s.shape[1]] = s
        return Image.fromarray(out).convert("RGB")
    # pack: concatenate strips, then wrap at blank columns into ~square
    row = np.concatenate([np.pad(s, ((0, 0), (0, gap)), constant_values=255) for s in strips], 1)
    total = row.shape[1]
    nrows = int(np.clip(np.floor(np.sqrt(total / (2.5 * line_h))), 1, 4))
    target = total / nrows
    colblank = (row < 200).sum(0) == 0
    # word gaps only: blank runs at least 0.25*line_h wide (never split inside a word)
    blank = np.zeros_like(colblank)
    for a_, b_ in _runs(colblank, 1):
        if b_ - a_ >= line_h // 4:
            blank[a_:b_] = True
    gaps = np.array([(a_ + b_) // 2 for a_, b_ in _runs(blank, 1)], int)
    cuts = []
    for r_ in range(1, nrows):
        if gaps.size == 0:
            break
        c = int(gaps[np.abs(gaps - r_ * target).argmin()])
        if (not cuts or c > cuts[-1] + line_h) and c < total - line_h:
            cuts.append(c)
    edges = [0] + cuts + [total]
    pieces = [row[:, edges[i] : edges[i + 1]] for i in range(len(edges) - 1)]
    cw = max(p.shape[1] for p in pieces)
    out = np.full((len(pieces) * (line_h + gap) + gap, cw + 2 * gap), 255, np.uint8)
    for i, p in enumerate(pieces):
        out[gap + i * (line_h + gap) : gap + i * (line_h + gap) + line_h, gap : gap + p.shape[1]] = p
    return Image.fromarray(out).convert("RGB")
