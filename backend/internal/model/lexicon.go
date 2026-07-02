package model

import (
	"go.mongodb.org/mongo-driver/v2/bson"
)

type Acronym struct {
	Term string `bson:"term" json:"term"`
	Say  string `bson:"say"  json:"say"`
}

// Lexicon is a per-language, library-wide dictionary applied at read time
// (TTS path only) — acronym/version expansions like NVI → Nova Versão
// Internacional.
type Lexicon struct {
	ID        bson.ObjectID `bson:"_id"       json:"_id"`
	Language  string        `bson:"language"  json:"language"`
	Acronyms  []Acronym     `bson:"acronyms"  json:"acronyms"`
	CreatedAt DateTime      `bson:"createdAt" json:"createdAt"`
	UpdatedAt DateTime      `bson:"updatedAt" json:"updatedAt"`
	V         int32         `bson:"__v"       json:"__v"`
}

// DefaultAcronyms are the Bible-version acronyms seeded per language. Users
// can edit via the API.
var DefaultAcronyms = map[string][]Acronym{
	"en": {
		{Term: "KJV", Say: "King James Version"},
		{Term: "NKJV", Say: "New King James Version"},
		{Term: "NIV", Say: "New International Version"},
		{Term: "ESV", Say: "English Standard Version"},
		{Term: "NLT", Say: "New Living Translation"},
		{Term: "NASB", Say: "New American Standard Bible"},
		{Term: "NRSV", Say: "New Revised Standard Version"},
		{Term: "CSB", Say: "Christian Standard Bible"},
		{Term: "ASV", Say: "American Standard Version"},
		{Term: "AMP", Say: "Amplified Bible"},
		{Term: "e.g.", Say: "for example"},
		{Term: "i.e.", Say: "that is"},
		{Term: "cf.", Say: "compare"},
		{Term: "=", Say: "equals"},
	},
	"pt": {
		{Term: "NVI", Say: "Nova Versão Internacional"},
		{Term: "ARA", Say: "Almeida Revista e Atualizada"},
		{Term: "ARC", Say: "Almeida Revista e Corrigida"},
		{Term: "ACF", Say: "Almeida Corrigida Fiel"},
		{Term: "NTLH", Say: "Nova Tradução na Linguagem de Hoje"},
		{Term: "NAA", Say: "Nova Almeida Atualizada"},
		{Term: "NVT", Say: "Nova Versão Transformadora"},
		{Term: "KJA", Say: "King James Atualizada"},
		{Term: "e.g.", Say: "por exemplo"},
		{Term: "i.e.", Say: "isto é"},
		{Term: "cf.", Say: "confira"},
		{Term: "=", Say: "igual a"},
	},
}
