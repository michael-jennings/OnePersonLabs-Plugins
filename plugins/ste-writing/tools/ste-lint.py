import re, sys, json, glob, os

MARKETING = ["seamless","seamlessly","robust","powerful","cutting-edge","effortless","effortlessly",
    "world-class","next-generation","revolutionary","blazing","lightning-fast","elegant","delightful",
    "turnkey","best-in-class","state-of-the-art","game-changing","first-class","battle-tested",
    "enterprise-grade","supercharge","unlock","unleash","empower","empowers"]
BANNED = ["begin","begins","commence","commences","initiate","initiates","originate",
    "utilize","utilizes","utilizing","leverage","leverages","leveraging","facilitate","facilitates",
    "ensure","ensures","ensuring","prior to","subsequent to","obtain","obtains","acquire","acquires",
    "demonstrate","demonstrates","additionally","furthermore","moreover","comprehensive","comprehensively",
    "utilization","aforementioned","henceforth","therein","whilst","amongst","numerous","myriad","plethora",
    "in order to","a variety of","in the event that","due to the fact that","it is important to note"]
PHRASAL = ["spin up","spin down","reach out","dive into","dives into","diving into","kick off","kicks off",
    "roll out","rolls out","tear down","ramp up","circle back","drill down","spun up","reaching out"]
MODAL_HEDGE = ["it is important to note","it should be noted","it is worth noting","please note that",
    "as mentioned","as noted above"]
BE = r"(?:am|is|are|was|were|be|been|being)"
PP_IRREG = r"(?:done|made|sent|read|built|kept|held|set|put|run|written|shown|given|taken|found|got|gotten|seen|known|thrown|drawn)"

def strip_code(t):
    def preserve_lines(match):
        return "".join("\n" if char == "\n" else " " for char in match.group(0))
    t = re.sub(r"```.*?```", preserve_lines, t, flags=re.S)
    t = re.sub(r"`[^`]*`", preserve_lines, t)
    return t

def sentences_with_lines(text):
    out = []
    for line_number, line in enumerate(text.split("\n"), 1):
        s = line.strip()
        if not s: continue
        s = re.sub(r"^\s*#{1,6}\s*", "", s)
        s = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", s)
        if not s: continue
        parts = re.split(r"(?<=[.!?:])\s+(?=[A-Z0-9\"'\-])", s)
        for p in parts:
            p = p.strip()
            if p: out.append((p, line_number))
    return out

def sentences(text):
    return [sentence for sentence, _ in sentences_with_lines(text)]

def wc(s):
    return len([w for w in re.findall(r"[A-Za-z0-9][A-Za-z0-9'\-/]*", s)])

def count_ci(text, phrases):
    n = 0; hits = []
    low = text.lower()
    for ph in phrases:
        for m in re.finditer(r"(?<![a-z])" + re.escape(ph) + r"(?![a-z])", low):
            n += 1; hits.append(ph)
    return n, hits

def phrase_matches(text, phrases):
    low = text.lower()
    for phrase in phrases:
        yield from ((match, phrase) for match in re.finditer(
            r"(?<![a-z])" + re.escape(phrase) + r"(?![a-z])", low
        ))

def source_detail(raw, start, end, rule, matched=None):
    line_start = raw.rfind("\n", 0, start) + 1
    line_end = raw.find("\n", end)
    if line_end == -1: line_end = len(raw)
    line = raw[line_start:line_end].strip()
    if len(line) > 160: line = line[:157] + "..."
    return {
        "rule": rule,
        "line": raw.count("\n", 0, start) + 1,
        "column": start - line_start + 1,
        "match": (matched if matched is not None else raw[start:end]).strip(),
        "source": line,
    }

def line_detail(raw, line_number, rule, matched=""):
    lines = raw.split("\n")
    line_index = max(0, min(line_number - 1, len(lines) - 1))
    line = lines[line_index].strip()
    if len(line) > 160: line = line[:157] + "..."
    return {
        "rule": rule,
        "line": line_index + 1,
        "column": 1,
        "match": matched,
        "source": line,
    }

def lint(text):
    raw = text
    text = strip_code(text)
    sentence_entries = sentences_with_lines(text)
    sents = [sentence for sentence, _ in sentence_entries]
    words = sum(wc(s) for s in sents) or 1
    v = {}
    details = []
    longs = [(wc(s), s) for s in sents if wc(s) > 20]
    v["long_sentence(>20w)"] = len(longs)
    details.extend(
        line_detail(raw, line_number, "long_sentence(>20w)", sentence)
        for sentence, line_number in sentence_entries
        if wc(sentence) > 20
    )
    v["semicolon"] = text.count(";")
    details.extend(
        source_detail(raw, match.start(), match.end(), "semicolon")
        for match in re.finditer(";", text)
    )

    contraction_matches = list(re.finditer(r"\b\w+['’](?:t|re|ve|ll|d|s|m)\b", text))
    v["contraction"] = len(contraction_matches)
    details.extend(source_detail(raw, m.start(), m.end(), "contraction") for m in contraction_matches)

    passive_matches = list(re.finditer(rf"\b{BE}\s+(?:\w+ed|{PP_IRREG})\b", text, re.I))
    v["passive_voice"] = len(passive_matches)
    details.extend(source_detail(raw, m.start(), m.end(), "passive_voice") for m in passive_matches)

    ing_matches = list(re.finditer(rf"\b{BE}\s+\w+ing\b", text, re.I))
    v["ing_main_verb"] = len(ing_matches)
    details.extend(source_detail(raw, m.start(), m.end(), "ing_main_verb") for m in ing_matches)

    nominal_matches = list(re.finditer(r"\b(?:perform(?:s|ed)?|conduct(?:s|ed)?|provide(?:s|d)?|carry out|carries out|make use of|makes use of)\b", text, re.I))
    nominal_matches += list(re.finditer(r"\b\w{4,}(?:tion|ment|ance|ence)\s+of\b", text, re.I))
    v["nominalization"] = len(nominal_matches)
    details.extend(source_detail(raw, m.start(), m.end(), "nominalization") for m in nominal_matches)

    phrase_details = {
        "phrasal_verb": list(phrase_matches(text, PHRASAL)),
        "banned_word": list(phrase_matches(text, BANNED)),
        "marketing_adjective": list(phrase_matches(text, MARKETING)),
        "modal_hedge": list(phrase_matches(text, MODAL_HEDGE)),
    }
    for rule, matches in phrase_details.items():
        v[rule] = len(matches)
        details.extend(source_detail(raw, match.start(), match.end(), rule, phrase) for match, phrase in matches)
    bh = [phrase for _, phrase in phrase_details["banned_word"]]
    mh = [phrase for _, phrase in phrase_details["marketing_adjective"]]
    paras = [p for p in re.split(r"\n\s*\n", raw) if p.strip()]
    v["long_paragraph(>6s)"] = sum(1 for p in paras if len(sentences(strip_code(p))) > 6)
    for paragraph in re.finditer(r"\S(?:.*?\S)?(?=\n\s*\n|\Z)", raw, re.S):
        if len(sentences(strip_code(paragraph.group(0)))) > 6:
            details.append(source_detail(raw, paragraph.start(), paragraph.start(), "long_paragraph(>6s)", "(paragraph)"))
    em = raw.count("—") + raw.count("–")
    total = sum(v.values())
    per100 = {k: round(x*100.0/words, 2) for k, x in v.items()}
    return {
        "words": words, "sentences": len(sents),
        "violations": v, "total": total,
        "details": details,
        "total_per100w": round(total*100.0/words, 2),
        "em_dash(slop-marker)": em,
        "longest_sentence_words": (max(longs)[0] if longs else max((wc(s) for s in sents), default=0)),
        "sample_marketing": list(dict.fromkeys(mh))[:6],
        "sample_banned": list(dict.fromkeys(bh))[:6],
    }

if __name__ == "__main__":
    files = sys.argv[1:] or []
    if not files:
        print(json.dumps(lint(sys.stdin.read()), indent=2)); sys.exit(0)
    exp = []
    for f in files: exp += sorted(glob.glob(f)) if any(c in f for c in "*?[") else [f]
    for f in exp:
        with open(f, encoding="utf-8") as fh: r = lint(fh.read())
        print(f"{os.path.basename(f):32} words={r['words']:4d} total={r['total']:3d} per100w={r['total_per100w']:6.2f} em_dash={r['em_dash(slop-marker)']:2d}")
