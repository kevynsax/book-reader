// Package numberwords spells integers out for speech so the read-time form
// differs visibly from the digits in the source text (and the TTS pronounces
// them predictably). Covers the range needed for chapter/verse/page refs.
package numberwords

import "strconv"

var enOnes = []string{
	"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
	"ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
	"seventeen", "eighteen", "nineteen",
}
var enTens = []string{"", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"}

func enWords(n int64) string {
	switch {
	case n < 20:
		return enOnes[n]
	case n < 100:
		if o := n % 10; o != 0 {
			return enTens[n/10] + " " + enOnes[o]
		}
		return enTens[n/10]
	case n < 1000:
		out := enOnes[n/100] + " hundred"
		if r := n % 100; r != 0 {
			out += " " + enWords(r)
		}
		return out
	case n < 1_000_000:
		out := enWords(n/1000) + " thousand"
		if r := n % 1000; r != 0 {
			out += " " + enWords(r)
		}
		return out
	default:
		out := enWords(n/1_000_000) + " million"
		if r := n % 1_000_000; r != 0 {
			out += " " + enWords(r)
		}
		return out
	}
}

var ptOnes = []string{
	"zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove",
	"dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete",
	"dezoito", "dezenove",
}
var ptTens = []string{"", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"}
var ptHundreds = []string{"", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"}

// Portuguese joins a trailing group to the higher group with "e" when it is
// below 100 or a round multiple of 100, but not when it carries both hundreds
// and lower digits.
func ptConnector(r int64) string {
	if r < 100 || r%100 == 0 {
		return "e "
	}
	return ""
}

func ptWords(n int64) string {
	switch {
	case n < 20:
		return ptOnes[n]
	case n < 100:
		if o := n % 10; o != 0 {
			return ptTens[n/10] + " e " + ptOnes[o]
		}
		return ptTens[n/10]
	case n == 100:
		return "cem"
	case n < 1000:
		if r := n % 100; r != 0 {
			return ptHundreds[n/100] + " e " + ptWords(r)
		}
		return ptHundreds[n/100]
	case n < 1_000_000:
		th := n / 1000
		thWord := "mil"
		if th != 1 {
			thWord = ptWords(th) + " mil"
		}
		if r := n % 1000; r != 0 {
			return thWord + " " + ptConnector(r) + ptWords(r)
		}
		return thWord
	default:
		mi := n / 1_000_000
		miWord := "um milhão"
		if mi != 1 {
			miWord = ptWords(mi) + " milhões"
		}
		if r := n % 1_000_000; r != 0 {
			return miWord + " " + ptConnector(r) + ptWords(r)
		}
		return miWord
	}
}

func NumberToWords(n int64, lang string) string {
	if n < 0 || n > 999_999_999 {
		return strconv.FormatInt(n, 10)
	}
	if lang == "pt" {
		return ptWords(n)
	}
	return enWords(n)
}
