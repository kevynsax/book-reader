You are auditing the text-processing pipeline of a PDF→audiobook app. The evidence JSON (attached below) contains, for a slice of one real book:

- `name`, `language`, `summaryPages`/`coverPage`/`firstPage`/`lastPage`: results of the title-reading, language-detection and summary/chapter-detection phases.
- `chapters`: detected chapter titles + start pages.
- `pages[]`: per page, `text` = the OCR output after sentence reflow (one sentence per line; lines shorter than 30 chars must not have been split off at a period — e.g. "1. Canguru" must stay glued to its sentence), and `readText` = the speech-normalized text actually sent to TTS.
- `splits[]`: cached SLM splits of long lines (line → parts). Parts must jointly preserve the original wording and each be a natural speakable sub-sentence.
- `chapterSentences[]`: the FINAL per-chapter sentence lists produced by the sentence phase — `display` is the human text, `text` is the speech-normalized string sent verbatim to TTS. This is the most important artifact: audit `text` for anything a listener should not hear (brackets, footnote marks, asterisks, page furniture, raw math, unnatural list numerals) and for meaning drift vs `display`.

Audit each phase and report concrete findings:

1. **Sentence reflow/splitting**: Are sentences preserved intact (no mid-sentence breaks, no merged unrelated sentences)? Any line breaks right after a leading number/heading ("1.") that violate the 30-char minimum? Are hard-wrapped lines correctly unwrapped? Cross-page sentence continuations handled?
2. **Audiobook cleaning (`readText` vs `text`)**: Is content unsuitable for audio removed or spoken properly — asterisks/emphasis markers, footnote reference marks (*, †, superscript numbers), bracketed references, page numbers, running headers/footers, URLs? Quote every instance that survived into `readText` that a listener should not hear. Also flag over-cleaning (real prose that was deleted or mangled).
3. **SLM splits**: For each entry in `splits`, verify the parts preserve the sentence's full wording (nothing dropped/invented) and break at natural points.
4. **Title / language / chapters**: Is `name` a plausible book title? Is `language` right for the page text? Do chapter titles/start pages look consistent with the page contents in the slice?

Output a Markdown report:
- A short verdict per phase (OK / issues found).
- A findings table: severity (high/med/low), phase, page/line, exact quoted text, what's wrong.
- A final "Improvements" section: concrete, implementable suggestions for the pipeline (e.g. regexes or normalization rules for the classes of junk you found), ranked by impact.

Be strict: this text is read aloud verbatim, so every stray mark is heard by the listener.

Print the full Markdown report as your response. Do not use any tools, do not write any files, do not ask for approval — your printed answer IS the report.
