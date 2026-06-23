// Spell integers out for speech so the read-time form differs visibly from the
// digits in the source text (and the TTS pronounces them predictably). Covers the
// range needed for chapter/verse/page references.

const EN_ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enWords(n: number): string {
  if (n < 20) return EN_ONES[n];
  if (n < 100) {
    const o = n % 10;
    return o ? `${EN_TENS[(n / 10) | 0]} ${EN_ONES[o]}` : EN_TENS[(n / 10) | 0];
  }
  if (n < 1000) {
    const r = n % 100;
    return `${EN_ONES[(n / 100) | 0]} hundred${r ? ' ' + enWords(r) : ''}`;
  }
  if (n < 1_000_000) {
    const r = n % 1000;
    return `${enWords((n / 1000) | 0)} thousand${r ? ' ' + enWords(r) : ''}`;
  }
  const r = n % 1_000_000;
  return `${enWords((n / 1_000_000) | 0)} million${r ? ' ' + enWords(r) : ''}`;
}

const PT_ONES = [
  'zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove',
  'dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete',
  'dezoito', 'dezenove',
];
const PT_TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const PT_HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

// Portuguese joins a trailing group to the higher group with "e" when it is
// below 100 or a round multiple of 100 ("dois mil e quinhentos"), but not when
// it carries both hundreds and lower digits ("dois mil quinhentos e cinquenta").
function ptConnector(r: number): string {
  return r < 100 || r % 100 === 0 ? 'e ' : '';
}

function ptWords(n: number): string {
  if (n < 20) return PT_ONES[n];
  if (n < 100) {
    const o = n % 10;
    return o ? `${PT_TENS[(n / 10) | 0]} e ${PT_ONES[o]}` : PT_TENS[(n / 10) | 0];
  }
  if (n === 100) return 'cem';
  if (n < 1000) {
    const r = n % 100;
    return r ? `${PT_HUNDREDS[(n / 100) | 0]} e ${ptWords(r)}` : PT_HUNDREDS[(n / 100) | 0];
  }
  if (n < 1_000_000) {
    const th = (n / 1000) | 0;
    const r = n % 1000;
    const thWord = th === 1 ? 'mil' : `${ptWords(th)} mil`;
    return r ? `${thWord} ${ptConnector(r)}${ptWords(r)}` : thWord;
  }
  const mi = (n / 1_000_000) | 0;
  const r = n % 1_000_000;
  const miWord = mi === 1 ? 'um milhão' : `${ptWords(mi)} milhões`;
  return r ? `${miWord} ${ptConnector(r)}${ptWords(r)}` : miWord;
}

const SPELLERS: Record<string, (n: number) => string> = { en: enWords, pt: ptWords };

export function numberToWords(n: number, lang: string): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) return String(n);
  return (SPELLERS[lang] ?? enWords)(n);
}
