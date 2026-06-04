export function sanitizePageText(text: string | undefined): string {
  let s = text?.trim() ?? '';
  if (!s) return '';

  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (s[0] !== '{') return s;

  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed.content === 'string') return parsed.content.trim();
  } catch {
  }

  const key = s.indexOf('"content"');
  if (key >= 0) {
    const after = s
      .slice(key + '"content"'.length)
      .replace(/^\s*:\s*"/, '')
      .replace(/"\s*}?\s*$/, '');
    return after
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .trim();
  }

  return s;
}
