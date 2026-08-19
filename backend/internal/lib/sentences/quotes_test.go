package sentences

import (
	"reflect"
	"testing"
)

func TestSplitQuoteRuns(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []QuoteRun
	}{
		{
			"narration then curly quote",
			`Certo dia um menino veio ao seu pai: “Hoje a professora nos mostrou um imenso globo.”`,
			[]QuoteRun{
				{Text: "Certo dia um menino veio ao seu pai:", IsQuote: false},
				{Text: "“Hoje a professora nos mostrou um imenso globo.”", IsQuote: true},
			},
		},
		{
			"quote then attribution",
			`“Rogo-te que me mostres a tua glória”, pede ele (Êx 33.18).`,
			[]QuoteRun{
				{Text: "“Rogo-te que me mostres a tua glória”", IsQuote: true},
				{Text: ", pede ele (Êx 33.18).", IsQuote: false},
			},
		},
		{
			"quote narration quote",
			`“O que sustenta o elefante?” Seu pai respondeu: “É elefante a perder de vista”.`,
			[]QuoteRun{
				{Text: "“O que sustenta o elefante?”", IsQuote: true},
				{Text: "Seu pai respondeu:", IsQuote: false},
				{Text: "“É elefante a perder de vista”.", IsQuote: true},
			},
		},
		{
			"short scare quote stays narration",
			`Ele chamou isso de “cosmovisão” no livro.`,
			[]QuoteRun{{Text: `Ele chamou isso de “cosmovisão” no livro.`, IsQuote: false}},
		},
		{
			"straight quotes",
			`Ela disse: "É um camelo que sustenta o mundo, filho".`,
			[]QuoteRun{
				{Text: "Ela disse:", IsQuote: false},
				{Text: `"É um camelo que sustenta o mundo, filho".`, IsQuote: true},
			},
		},
		{
			"em-dash dialogue",
			`— Papai, o que sustenta o camelo?`,
			[]QuoteRun{{Text: "— Papai, o que sustenta o camelo?", IsQuote: true}},
		},
		{
			"unclosed quote runs to end",
			`Ele começou: “Hoje a professora nos mostrou um imenso globo.`,
			[]QuoteRun{
				{Text: "Ele começou:", IsQuote: false},
				{Text: "“Hoje a professora nos mostrou um imenso globo.", IsQuote: true},
			},
		},
		{
			"plain narration",
			`Seu pai percebeu agora que poderia estar em apuros.`,
			[]QuoteRun{{Text: "Seu pai percebeu agora que poderia estar em apuros.", IsQuote: false}},
		},
		{
			"guillemets",
			`Diz o texto: «O cosmo é tudo que é, que foi, que será».`,
			[]QuoteRun{
				{Text: "Diz o texto:", IsQuote: false},
				{Text: "«O cosmo é tudo que é, que foi, que será».", IsQuote: true},
			},
		},
	}
	for _, c := range cases {
		if got := SplitQuoteRuns(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got %#v\nwant %#v", c.name, got, c.want)
		}
	}
}
