"""MODULE 4 — Dual-Platform Search & Share Trigger Engine.

Builds distribution metadata from what the audit already measured (transcript, on-screen
text, payoff timing). Fully deterministic; no external API.

Keyword ranking: RAKE-style phrase scores over transcript + OCR text, weighted towards
words spoken early and words shown on screen. When `keyword_volumes` (phrase -> monthly
search volume, e.g. exported from TikTok's search insights or any keyword tool) is
supplied, phrases are ranked by log(volume) x relevance instead, which is the only way to
know which phrase actually has the highest search volume.
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from typing import Any

from services.utils import r

STOPWORDS = set("""
a about above after again against all am an and any are aren't as at be because been before being below
between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each
few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself
him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most
mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't
she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then
there there's these they they'd they'll they're they've this those through to too under until up very was
wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's
whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves
just like really actually gonna wanna gotta okay ok yeah yes um uh so well also get got going go know think
thing things one two three lot stuff kind right now today here thats dont im youre ive ill its whats
literally basically guys everyone anyone someone something everything nothing always never every even still
make makes made way much many back want need see look said say says let tell keep put take use try
first second third fourth fifth last next new best real top biggest main simple easy quick little big
good great bad better worse huge whole single same different important
""".split())

TOKEN = re.compile(r"[a-z0-9][a-z0-9'\-]*")
SPLIT = re.compile(r"[.!?,;:()\[\]\"“”…\n]+")


def _tokens(text: str) -> list[str]:
    return TOKEN.findall(text.lower())


def _candidate_phrases(text: str, max_words: int = 4) -> list[list[str]]:
    phrases: list[list[str]] = []
    for chunk in SPLIT.split(text.lower()):
        current: list[str] = []
        for tok in _tokens(chunk):
            if tok in STOPWORDS or tok.isdigit() or len(tok) < 2:
                if current:
                    phrases.append(current)
                current = []
            else:
                current.append(tok.strip("'-"))
        if current:
            phrases.append(current)
    out = []
    for p in phrases:
        if len(p) <= max_words:
            out.append(p)
        else:  # long run: keep sliding windows
            out.extend(p[i:i + max_words] for i in range(len(p) - max_words + 1))
    return out


def _stem(word: str) -> str:
    """Plural folding for grouping only ("secrets" -> "secret", "boxes" -> "box")."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith(("ses", "xes", "zes", "ches", "shes")):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _key(phrase: str) -> str:
    return " ".join(_stem(w) for w in phrase.split())


def rank_keyphrases(transcript: str, onscreen: str, keyword_volumes: dict[str, float] | None = None,
                    limit: int = 12) -> list[dict[str, Any]]:
    transcript_tokens = set(_tokens(transcript))
    if transcript_tokens:
        # OCR clips words at frame edges ("SECR"); with a transcript, keep only on-screen
        # words that were also spoken so fragments can't become keywords.
        onscreen = " ".join(t for t in _tokens(onscreen) if t in transcript_tokens)
    corpus = f"{onscreen}. {transcript}".strip()
    phrases = _candidate_phrases(corpus)
    if not phrases and not keyword_volumes:
        return []

    freq: Counter[str] = Counter()
    degree: defaultdict[str, int] = defaultdict(int)
    for p in phrases:
        for w in p:
            freq[w] += 1
            degree[w] += len(p) - 1
    word_score = {w: (degree[w] + freq[w]) / freq[w] for w in freq}

    lowered = transcript.lower()
    onscreen_l = onscreen.lower()
    total_len = max(1, len(lowered))
    # Group singular/plural variants under one key; keep the most frequent spelling.
    scored: dict[str, dict[str, Any]] = {}
    forms: defaultdict[str, Counter[str]] = defaultdict(Counter)
    for p in phrases:
        phrase = " ".join(p)
        key = _key(phrase)
        forms[key][phrase] += 1
        if key in scored:
            scored[key]["count"] += 1
            continue
        pos = lowered.find(phrase)
        early = 1.0 + 0.6 * (1.0 - pos / total_len) if pos >= 0 else 1.0
        on_screen = phrase in onscreen_l
        base = sum(word_score[w] for w in p)
        scored[key] = {"phrase": phrase, "score": base * early * (1.6 if on_screen else 1.0),
                       "count": 1, "on_screen": on_screen, "volume": None}
    for key, item in scored.items():
        item["phrase"] = forms[key].most_common(1)[0][0]
        item["score"] *= 1.0 + math.log(item["count"])

    if keyword_volumes:
        corpus_tokens = set(_tokens(corpus))
        ranked = []
        for kw, vol in keyword_volumes.items():
            kw_l = kw.lower().strip()
            kt = _tokens(kw_l)
            if not kt:
                continue
            overlap = sum(1 for t in kt if t in corpus_tokens) / len(kt)
            exact = kw_l in corpus.lower()
            relevance = 1.0 if exact else overlap
            if relevance < 0.5:
                continue
            ranked.append({"phrase": kw_l, "score": math.log1p(max(0.0, float(vol))) * relevance,
                           "count": corpus.lower().count(kw_l), "on_screen": kw_l in onscreen_l,
                           "volume": float(vol), "relevance": r(relevance, 2)})
        ranked.sort(key=lambda x: x["score"], reverse=True)
        # Fall back to extracted phrases for anything the volume list doesn't cover.
        rest = sorted(scored.values(), key=lambda x: x["score"], reverse=True)
        seen = {x["phrase"] for x in ranked}
        ranked += [x for x in rest if x["phrase"] not in seen]
        result = ranked
    else:
        result = sorted(scored.values(), key=lambda x: x["score"], reverse=True)

    # Drop phrases fully contained in (or containing) a better-ranked phrase.
    final: list[dict[str, Any]] = []
    for item in result:
        k = _key(item["phrase"])
        if any(k in _key(f["phrase"]) or _key(f["phrase"]) in k for f in final):
            continue
        final.append({**item, "score": r(item["score"], 3)})
        if len(final) >= limit:
            break
    return final


def _title(phrase: str) -> str:
    small = {"and", "or", "of", "to", "in", "on", "for", "vs", "the", "a"}
    words = phrase.split()
    return " ".join(w if (i and w in small) else (w[:1].upper() + w[1:]) for i, w in enumerate(words))


def _hashtag(text: str) -> str:
    return "#" + re.sub(r"[^a-z0-9]", "", text.lower())[:30]


def _first_sentence(text: str, limit: int = 140) -> str:
    text = text.strip()
    if not text:
        return ""
    m = re.match(r"(.+?[.!?])(\s|$)", text)
    s = (m.group(1) if m else text).strip()
    if len(s) > limit:
        s = s[: limit - 1].rsplit(" ", 1)[0] + "…"
    return s


def _fit(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rsplit(" ", 1)[0] + "…"


def _exactly_five(primary: str, secondary: list[str], niche: str | None) -> list[str]:
    # Multi-word phrases make specific, searchable tags; single words only fill the gaps.
    secondary = sorted(secondary, key=lambda s: 0 if " " in s else 1)
    tags: list[str] = []

    def add(t: str) -> None:
        tag = _hashtag(t)
        if len(tag) > 3 and tag not in tags:
            tags.append(tag)

    if niche:
        add(niche)
    add(primary)
    for s in secondary:
        if len(tags) >= 5:
            break
        add(s)
    fillers = [f"{niche or primary} tips", f"{primary} hack", f"{niche or primary} tok", f"learn {primary}",
               f"{primary} explained", f"{niche or primary} community", f"{primary} 2026"]
    for f in fillers:
        if len(tags) >= 5:
            break
        add(f)
    return tags[:5]


def generate(report: dict, niche: str | None = None, keyword_volumes: dict[str, float] | None = None,
             cta: str | None = None) -> dict[str, Any]:
    transcript = (report.get("transcript") or {}).get("text", "") or ""
    onscreen_parts: list[str] = []
    for frame in report.get("ocr", []):
        for d in frame.get("detections", []):
            if d["text"] not in onscreen_parts:  # the same caption is read at several timestamps
                onscreen_parts.append(d["text"])
    onscreen = " ".join(onscreen_parts)
    keys = rank_keyphrases(transcript, onscreen, keyword_volumes)
    if not keys:
        fallback = niche or "this"
        keys = [{"phrase": fallback.lower(), "score": 0.0, "count": 0, "on_screen": False, "volume": None}]
    primary = keys[0]["phrase"]
    secondary = [k["phrase"] for k in keys[1:6]]
    P = _title(primary)
    first = _first_sentence(transcript)
    duration = float(report.get("media", {}).get("analyzed_duration_s") or 0)
    payoff = None
    words = (report.get("transcript") or {}).get("words") or []
    if words and duration > 4:
        # the payoff phrase: the words spoken in the strongest energy bin after 3 s
        bins = [b for b in report.get("timeline", []) if b["t"] >= 3.0]
        if bins:
            peak = max(bins, key=lambda b: b["audio_energy"] + 0.5 * b["motion_velocity"])
            near = [w["word"] for w in words if abs(w["start"] - peak["t"]) < 1.2]
            payoff = " ".join(near).strip(" ,.") or None

    # ---- TikTok: search keyword inside the first 50 characters --------------------------
    hook_line = first or f"Everything about {primary} in {int(duration) or 30} seconds"
    lead = f"{P}: "
    tt_caption = lead + hook_line[0].lower() + hook_line[1:] if hook_line else lead.strip()
    body = ""
    if len(secondary) >= 2:
        body = f" Covers {secondary[0]} and {secondary[1]}."
    elif secondary:
        body = f" Covers {secondary[0]}."
    tt_tags = " ".join(_exactly_five(primary, secondary, niche)[:4])
    tt_caption = _fit(f"{tt_caption}{body} {cta or 'Save this for later.'} {tt_tags}".strip(), 2200)
    kw_index = tt_caption.lower().find(primary)

    # ---- Instagram ---------------------------------------------------------------------------
    hooks = [
        f"Nobody explains {primary} like this.",
        f"The {primary} mistake almost everyone makes 👇",
        f"Stop scrolling if you care about {primary}.",
        f"I wish I knew this about {primary} sooner.",
        f"{P}, explained in {max(5, int(round(duration)))} seconds.",
    ]
    ig_hooks = [_fit(h, 125) for h in hooks]
    ig_hook = min(ig_hooks, key=lambda h: abs(len(h) - 60))  # shortest truncation risk, still specific
    ig_body_lines = [ig_hook, ""]
    if first:
        ig_body_lines.append(first)
    if secondary:
        ig_body_lines.append("Covers: " + ", ".join(secondary[:3]) + ".")
    ig_body_lines.append(cta or "Send this to someone who needs it, and save it for later.")
    ig_tags = _exactly_five(primary, secondary, niche)
    alt_parts = [f"Vertical video about {primary}"]
    if niche:
        alt_parts[0] += f" for the {niche} niche"
    if onscreen:
        alt_parts.append(f"On-screen text reads: “{_fit(onscreen, 160)}”")
    if first:
        alt_parts.append(f"The speaker opens with: “{_fit(first, 200)}”")
    if secondary:
        alt_parts.append("Topics shown: " + ", ".join(secondary[:5]))
    cuts = report.get("pacing", {}).get("cut_count")
    if cuts is not None and duration:
        alt_parts.append(f"{duration:.0f}-second clip with {cuts} cuts")
    alt_text = _fit(". ".join(alt_parts) + ".", 1000)

    # ---- Share / save triggers ----------------------------------------------------------------
    s1 = secondary[0] if secondary else primary
    s2 = secondary[1] if len(secondary) > 1 else (niche or primary)
    def pick(*variants: str, limit: int = 48) -> str:
        # On-screen text must be readable in one glance: take the first variant that fits.
        return next((v for v in variants if len(v) <= limit), _fit(variants[-1], limit))

    on_screen_hooks = [
        {"text": pick(f"Save this: {primary} cheat sheet", f"Save this {primary} list", "Save this for later"),
         "trigger": "save",
         "why": "Frames the video as a reference to come back to (bookmark intent)."},
        {"text": pick(f"Send this to the friend who needs {primary} help", f"Send this to a friend who needs {primary}",
                      "Send this to the friend who needs it"),
         "trigger": "dm_send",
         "why": "Names a specific recipient, which converts viewers into DM senders."},
        {"text": pick(*( [f"Wait for {payoff}…"] if payoff else []),
                      f"Watch to the end: the last {primary} tip matters most", f"The last {primary} tip matters most",
                      "The last tip matters most"),
         "trigger": "completion",
         "why": "Open loop to the payoff timestamp, lifting completion and rewatch."},
    ]
    pinned = [
        {"text": f"Which would you try first: {s1} or {s2}? Reply with 1 or 2.", "trigger": "comment_reply",
         "why": "Binary choice lowers reply effort and seeds comment threads."},
        {"text": f"Hot take: most {primary} advice online is wrong. Agree or disagree?", "trigger": "debate_share",
         "why": "Disagreement prompts quote-replies and sends to friends for backup."},
    ]

    return {
        "keywords": keys,
        "primary_keyword": primary,
        "tiktok": {
            "caption": tt_caption,
            "primary_keyword_index": kw_index,
            "keyword_in_first_50": 0 <= kw_index and kw_index + len(primary) <= 50,
            "length": len(tt_caption),
        },
        "instagram": {
            "first_line_hook": ig_hook,
            "hook_variants": ig_hooks,
            "caption": "\n".join(ig_body_lines + ["", " ".join(ig_tags)]),
            "alt_text": alt_text,
            "hashtags": ig_tags,
            "hashtag_count": len(ig_tags),
        },
        "share_triggers": {"on_screen_hooks": on_screen_hooks, "pinned_comments": pinned, "payoff_phrase": payoff},
        "source": {"used_keyword_volumes": bool(keyword_volumes), "transcript_chars": len(transcript),
                   "onscreen_text": onscreen},
    }
