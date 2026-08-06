#!/usr/bin/env bash
# Audit the import pipeline's text quality with a Claude agent (Sonnet 5).
#
# Pulls a slice of a book from prod Mongo (reflowed page text, speech-ready
# readText, cached SLM sentence splits, title/language/summary detection) and
# asks the agent to verify that sentence splitting preserves the prose while
# stripping everything that doesn't belong in an audiobook (asterisks,
# footnote markers, reference marks, page furniture). Audio generation is out
# of scope.
#
# Usage: tools/audit-import.sh [bookId] [fromPage] [toPage]
#   defaults: the ELEFANTE book, pages 12–18
set -euo pipefail
cd "$(dirname "$0")/.."

BOOK_ID="${1:-6a739474790e0f52a5022f77}"
FROM_PAGE="${2:-12}"
TO_PAGE="${3:-18}"
OUT_DIR="tools/audit-import-out"
mkdir -p "$OUT_DIR"

echo "Fetching book $BOOK_ID pages $FROM_PAGE-$TO_PAGE from prod…"
kubectl --context home -n book-reader exec deploy/mongo -- sh -c '
mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "
db = db.getSiblingDB(\"book-reader\");
const b = db.books.findOne({_id: ObjectId(\"'"$BOOK_ID"'\")});
const pages = (b.ocrPages||[]).filter(p => p.page >= '"$FROM_PAGE"' && p.page <= '"$TO_PAGE"').map(p => ({page: p.page, language: p.language, status: p.status, text: p.text, readText: p.readText||null}));
const lines = pages.flatMap(p => (p.text||\"\").split(\"\n\").map(l => l.trim()).filter(l => l));
const splits = db.splitcache.find({line: {\$in: lines}}, {line:1, parts:1}).toArray().map(s => ({line: s.line, parts: s.parts}));
const sentences = (b.chapters||[])
  .map((c, i) => ({idx: i, title: c.title, startPage: c.startPage,
    sentences: (c.sentences||[]).slice(0, 60).map(s => ({display: s.display||null, text: s.text}))}))
  .filter(c => c.sentences.length && c.startPage >= '"$FROM_PAGE"' - 6 && c.startPage <= '"$TO_PAGE"');
print(JSON.stringify({
  name: b.name, language: b.language||null, status: b.status,
  summaryPages: b.summaryPages, coverPage: b.coverPage, firstPage: b.firstPage, lastPage: b.lastPage,
  chapters: (b.chapters||[]).map(c => ({title: c.title, startPage: c.startPage, startChar: c.startChar, sentenceCount: (c.sentences||[]).length})),
  pages, splits, chapterSentences: sentences,
}));
"' > "$OUT_DIR/evidence.json"

PAGES=$(python3 -c "import json; d=json.load(open('$OUT_DIR/evidence.json')); print(len(d['pages']))")
echo "Evidence: $PAGES pages, $(python3 -c "import json; d=json.load(open('$OUT_DIR/evidence.json')); print(len(d['splits']))") cached splits → $OUT_DIR/evidence.json"
if [ "$PAGES" = "0" ]; then
  echo "No OCR'd pages in that range yet — pick a range the import has already read." >&2
  exit 1
fi

cat > "$OUT_DIR/prompt.md" <<'PROMPT'
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
PROMPT

echo "Running Sonnet 5 audit agent…"
# Warm-up call: the CLI's OAuth refresh is flaky on the first cold call.
claude --model claude-sonnet-5 -p "ok" >/dev/null 2>&1 || true
# Prompt goes via stdin — a multi-hundred-KB argv makes the CLI fail.
{ cat "$OUT_DIR/prompt.md"; echo; echo "--- EVIDENCE JSON ---"; cat "$OUT_DIR/evidence.json"; } \
  | claude --model claude-sonnet-5 -p > "$OUT_DIR/report.md"

echo "Report: $OUT_DIR/report.md"
