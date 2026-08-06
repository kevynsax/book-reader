# Audit Report — *Dando Nome ao Elefante*, pages 14–18

## Phase verdicts

| Phase | Verdict |
|---|---|
| 1. Sentence reflow/splitting | **OK** (no 30-char glue violations, no mid-sentence breaks found; cross-page split at 17→18 is structural, not corrupted) |
| 2. Audiobook cleaning (`readText`) | **Issues found** — footnote brackets, embedded headers, and math survive un-spoken |
| 3. SLM splits | **N/A** — `splits` is empty; at least one line is long enough that a split should have been considered |
| 4. Title/language/chapters | **Issues found** — language mistag, chapter list out of order/duplicated startPage, likely OCR-garbled chapter title |

## Findings

| Sev | Phase | Page/Line | Quoted text | Problem |
|---|---|---|---|---|
| High | Cleaning | 15 | `... mais a sério. [um]` | Footnote marker converted from `[1]` to `[um]` but brackets kept — listener hears literal "colchete um colchete" or similar, not a natural aside. Should be dropped entirely or rendered as "nota 1" without brackets. |
| High | Cleaning | 16 (×2), 17 (×2) | `[dois]`, `[três]`, `[quatro]`, `[cinco]` | Same bracket-retention bug repeated for every footnote ref on these pages. |
| High | Cleaning | 16 | `...está comprometido...\n\nDANDO NOME AO ELEFANTE\n\nEssa história ilustra...` | A running section/chapter header (`DANDO NOME AO ELEFANTE`) is spliced directly into body prose between two unrelated sentences (end of footnote [3] discussion → next paragraph). If sent to TTS as-is, the title gets read mid-paragraph with no separation, confusing the listener. |
| Med | Cleaning | 18 | `SETE PERGUNTAS BÁSICAS` embedded inline before the numbered list | Same header-in-body-text pattern; needs a pause/skip marker or removal, not verbatim inline reading. |
| High | Cleaning | 15 | `Deixe-me escrever a fórmula para você: F igual a Gm1m2/r2` | Only `=` was verbalized; `Gm1m2/r2` (implied multiplication, exponent, division) was left as raw math notation. TTS will either spell out letters/digits oddly or skip it — the formula is effectively unlistenable. Under-cleaning. |
| Med | Cleaning | 18 | `um. Qual é a realidade primordial...` / `dois. Qual é a natureza...` / `três. Que é um ser humano?` | List numerals `1.`/`2.`/`3.` converted to word+period (`um.`, `dois.`, `três.`). A period right after a number word reads like a sentence-final pause, producing an unnatural stop. Better: "Primeiro," / "Número um:" or just drop the enumerator into a natural connector. |
| Med | Title/Chapters | chapters[] | `PREFÁCIO` start=42, `2. DEFINIÇÕES...` start=21, `3. ...` start=44, ... `8. ...` start=14, `1. Camelo, Canguru e Elefante` start=14 | Chapter list is not ordered by page number and not ordered by chapter number (2,3,4,5,6,7,8,1 with Preface interleaved at 42 while chapter 2 starts at 21 — before the preface). Chapter 8 and Chapter 1 both claim `startPage:14`. This is internally inconsistent and will misplace chapter boundaries in the reader/audio player. |
| Med | Title/Chapters | page 14 vs chapter "1. Camelo, Canguru e Elefante" | `startPage:14` | Page 14 itself is `status:"error"` with empty `text` — the actual "camel/kangaroo/elephant" story content is on pages 15–17. The chapter start should point to 15, not the failed OCR page. |
| Med | Language | page 18 | `"language":"unknown"` despite `"status":"complete"` and clearly Portuguese `text` | Language detector mistagged a fully-OCR'd Portuguese page as unknown; only page 14 (blank/error) should be unknown. |
| Low | Title | chapter "8. PESSOAS INTELIGENTES QUE SE DEFONTAM DE DIA..." | `SE DEFONTAM DE DIA` | "Defontar" is not a Portuguese word — likely OCR garble of the real chapter title (plausibly "...que se enganam durante o dia"). Should be re-OCR'd/verified, not passed through to a chapter label a listener may see/hear. |
| Low | Splits | page 15 | `"O que sustenta o elefante?" ... "É… é… é… é elefante a perder de vista".` full paragraph is one long multi-clause line (~300+ chars physics sentence) | No entries exist in `splits` even though at least the gravity-formula sentence is a good candidate for natural sub-sentence breaks; can't verify part-preservation since the array is empty for this whole slice — flag as a possible coverage gap in the SLM-split trigger threshold rather than a correctness bug. |
| Low | Reflow | 17→18 boundary | page 17 ends `"...Nós a tomamos como"` / page 18 begins `"muito óbvia para ser mencionada."` | Sentence spans a page boundary and is stored split across two `pages[].text` entries. Not corrupted, but confirm downstream TTS concatenates page texts without inserting a pause/silence that would create an audible gap mid-sentence. |

## Improvements (ranked by impact)

1. **Strip footnote/reference brackets entirely in `readText`**, don't just spell the digit inside them. Regex: `\[\s*(\d+|um|dois|três|quatro|cinco|...)\s*\]` → remove (or replace with nothing / a very short pause), rather than `\[N\]` → `[palavra]`. Bracket characters should never reach the TTS engine.
2. **Detect and excise/relocate inline running headers and section titles** that get glued into body paragraphs during OCR (e.g., `DANDO NOME AO ELEFANTE`, `SETE PERGUNTAS BÁSICAS` appearing mid-page with blank-line padding around all-caps short lines). Heuristic: an all-caps line ≤ ~40 chars surrounded by blank lines, matching or resembling a known chapter/section title, should be pulled into a heading break (silence/skip) rather than read as prose.
3. **Add a math/formula normalizer** for patterns like `X = Gm1m2/r2`: expand `=` (already done), but also handle variable concatenation, implicit multiplication, and exponents/fractions before handing to TTS, or replace the whole formula with a spoken paraphrase / omit if not essential to comprehension.
4. **Fix numeral-to-word conversion for list markers**: don't convert `N.` at the start of an enumerated item straight into `palavra.` — either keep a natural pause word ("Primeiro,", "Segundo,") or convert to `"Item N:"` so the following period isn't misread as end-of-sentence.
5. **Chapter-detection ordering/validation pass**: after chapter extraction, sort/validate that `startPage` is monotonically increasing with a book's natural page order and flag duplicates (two chapters sharing `startPage:14` here) for manual review before publishing to `awaiting_chapter_review`.
6. **Language-detector confidence check**: when `status:"complete"` and `text` is non-empty PT-heavric content, `language:"unknown"` should not be possible — likely a bug where the detector runs on a decoding path that's separate from the completed OCR text; only truly empty/error pages should report unknown.
7. **Lower/verify the SLM-split trigger threshold** — this slice has clearly split-worthy long compound sentences but zero cached splits, worth confirming the length/complexity heuristic that decides when a line needs splitting.
