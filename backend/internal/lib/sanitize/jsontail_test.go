package sanitize

import "testing"

func TestStripJSONTail(t *testing.T) {
	cases := map[string]string{
		`respondeu: "É um canguru que sustenta o camelo".\"}}`: `respondeu: "É um canguru que sustenta o camelo".`,
		`texto normal termina aqui.`:                           `texto normal termina aqui.`,
		`fim da página"}}`:                                     `fim da página`,
		`fim }}`:                                               `fim`,
	}
	for in, want := range cases {
		if got := StripJSONTail(in); got != want {
			t.Errorf("StripJSONTail(%q) = %q, want %q", in, got, want)
		}
	}
}
