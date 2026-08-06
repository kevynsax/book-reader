# Audit Report — *DANDO NOME AO ELEFANTE* (pt)

## Verdict by phase

| Phase | Verdict |
|---|---|
| 1. Sentence reflow/splitting | **OK, with one critical leak** — short-line glue rule (<30 char) is applied correctly everywhere checked; no mid-sentence breaks or bad merges found. But one page-14 sentence carries a raw JSON-fragment artifact through to the final TTS text. |
| 2. Audiobook cleaning (readText) | **Issues found** — footnote bracket markers and parenthetical punctuation survive cleaning; a math formula is only partially normalized. No over-cleaning/content-loss observed. |
| 3. SLM splits | **Mostly OK** — wording preserved, natural break points; one split fabricates a closing quotation mark not present in the source line. |
| 4. Title/language/chapters | **Mostly OK** — title and chapters plausible and consistent with page content; per-page language detection is flaky on 3 of 9 pages. |

## Findings

| Sev | Phase | Location | Quoted text | Issue |
|---|---|---|---|---|
| **High** | Reflow → readText/chapterSentences | p.14, last sentence (`chapterSentences[0].sentences[16]`) | `respondeu: "É um canguru que sustenta o camelo".\"}}` | A raw JSON-fragment (`"}}`) is appended to the sentence text and has propagated all the way into `readText` and the final `chapterSentences.text` sent to TTS. This will be read aloud as garbage/mispronounced symbols. |
| **High** | Cleaning (readText) | p.15–22, many | `[um]`, `[dois]`, `[três]`, `[quatro]` (×2), `[cinco]`, `[seis]`, `[sete]`, `[oito]`, `[nove]`, `[dez]`, `[onze]`, `[doze]`, `[treze]` | Footnote reference marks are half-cleaned: the digit is spelled out but the surrounding `[` `]` brackets are left in the string every single time a footnote occurs (13+ instances in this slice alone). A listener hears literal bracket characters (or a garbled TTS interpretation of them) after essentially every other sentence. |
| **Med** | Cleaning (readText) | p.21–22 | `(mil setecentos e vinte e quatro a mil oitocentos e quatro)`, `(mil oitocentos e trinta e três a mil novecentos e onze)`, etc. | Birth/death year parentheticals for Kant, Dilthey, Wittgenstein, Schaeffer keep the literal `(` `)` characters. Numbers are spoken correctly, but the parens themselves are unnecessary audio noise. |
| **Med-High** | Cleaning (readText) | p.15, `F = Gm₁m₂/r²` → `F igual a Gm₁m₂/r²` | `Gm₁m₂/r²` | Only the `=` sign was normalized ("igual a"). The subscripts (₁, ₂), the superscript (²), and the `/` remain as raw Unicode glyphs — unspeakable/unpredictable for TTS engines. |
| **Med** | Cleaning (readText) | p.14, 18, 19 | `"1. CAMELO..."` → `"um. CAMELO, CANGURU E ELEFANTE"`; `"1. Qual é..."` → `"um. Qual é..."` (through `"sete."`) | Leading numerals are converted to a bare number-word + period, producing sentence-fragment-sounding output ("One. Camelo...") instead of natural framing like "Capítulo um: Camelo..." or "Primeiro,". Applies consistently to both the chapter heading and the 7-question numbered list. |
| **Low** | Title/language | pages 14, 18, 20 | `"language":"unknown"` | Three pages are flagged `unknown` language despite being stylistically identical Portuguese prose to the surrounding pages (15,16,17,19,21,22 all correctly `pt`). Detector is unreliable on some pages (possibly poetry/verse on p.14, list-heavy text on p.18/20 throwing it off). |
| **Low** | Chapters | chapter 5 | `"5: SISTEMA RACIONAL, MODO DE VIDA E ESTÓRIA-MESTRE"` | Uses `5:` (colon) while all other 7 chapters use `N.` (period) — punctuation inconsistency in chapter-title extraction. |
| **Low** | SLM splits | `splits[0]`, part 2 | `"...dividida pelo quadrado da distância (r) entre eles.\""` | The source line has no closing quotation mark (`"`) at "entre eles." — the split step invented one. Wording is preserved, but a punctuation character not present in the original was fabricated. |

**Not found (checked, clean):** no asterisks/emphasis markers, no URLs, no over-cleaning/dropped prose, no cross-page sentence-continuation breakage, no violations of the 30-char short-line glue rule.

## Improvements (ranked by impact)

1. **Fix the JSON-leak root cause.** Something upstream (likely an OCR/LLM post-process step) is emitting a truncated JSON tail (`"}}`) that gets concatenated onto page text. Add a sanitization pass on ingested page text that strips trailing artifacts matching `["']?[,}]{1,2}$` and, more importantly, add a regression check that fails the pipeline if any page's `text`/`readText` contains unescaped `{`/`}`/stray `"` sequences that don't belong to actual dialogue quoting.

2. **Strip footnote bracket markers instead of half-converting them.** Replace the current "spell out the digit, keep the brackets" logic with a rule that drops the whole marker from `readText`: regex `\s*\[\s*(?:\d+|um|dois|três|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze)\s*\]` → `""`. Footnote numbers are not useful to a listener and should never be spoken at all, bracketed or not.

3. **Strip parenthesis characters from parenthetical asides.** For number/date-only parentheticals (birth-death years, formula variable call-outs), drop the literal `(` `)` and replace with comma-pause punctuation, e.g. `Immanuel Kant, mil setecentos e vinte e quatro a mil oitocentos e quatro,` instead of `Immanuel Kant (mil setecentos e vinte e quatro a mil oitocentos e quatro)`.

4. **Normalize math notation fully, or bail out to a spoken paraphrase.** Add expansion rules for subscript/superscript Unicode ranges (U+2080–2089, U+00B2/B3, U+2070–2079) and `/` → "dividido por", `*`/`×` → "vezes". For formulas too dense to expand cleanly, consider substituting a short spoken gloss ("uma fórmula com massas e distância") rather than leaving raw symbols.

5. **Rework numeral-to-word handling for headings/list markers.** Don't append a bare period after the spelled-out numeral for chapter headings or enumerated lists — prefix chapter headings with "Capítulo" and render list items as ordinal words or drop the trailing period so they don't read as truncated sentences.

6. **Improve per-page language-detection robustness.** Fall back to the majority/neighboring-page language when per-page confidence is low or the sample is short/verse-like, to avoid spurious `unknown` results (pp. 14, 18, 20 here).

7. **Add a split-fidelity check to the SLM splitter.** Assert that concatenating a `splits[].parts` array (minus the intentional break points) reproduces the source `line` verbatim, character-for-character — this would have caught the fabricated closing quote in `splits[0]`.

8. **Normalize chapter-title punctuation at detection time** (`5:` → `5.`) for consistency across the chapter list — low priority, cosmetic only.
