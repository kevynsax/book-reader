// rolemigrate converts a book voiced via blanket per-sentence voiceOverrides
// (the offline quote pipeline) to role-based voicing: sentence roles and a
// book-level voiceRoles matrix. Segments of role sentences are cleared to
// stale so the next generate renders both takes fresh — a mid-generation bug
// wiped some chapters' overrides, so which voice actually rendered each old
// file cannot be trusted.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/kevynsax/book-reader/backend/internal/model"
)

type speakerRow struct {
	Ch      int    `json:"ch"`
	Order   int    `json:"order"`
	ID      string `json:"id"`
	Speaker string `json:"speaker"`
}

type quotePartRow struct {
	Ch      int    `json:"ch"`
	Text    string `json:"text"`
	Speaker string `json:"speaker"`
}

var spaces = regexp.MustCompile(`\s+`)

func norm(s string) string { return spaces.ReplaceAllString(strings.TrimSpace(s), " ") }

func speakerRole(speaker string) model.SentenceRole {
	switch speaker {
	case "man":
		return model.RoleQuoteMale
	case "woman":
		return model.RoleQuoteFemale
	case "kid":
		return model.RoleQuoteChild
	}
	return model.RoleQuoteDefault
}

func main() {
	mongoURI := flag.String("mongo", "mongodb://localhost:27017/book-reader", "mongo URI")
	bookID := flag.String("book", "", "book object id")
	speakersPath := flag.String("speakers", "", "speakers JSON from the offline pipeline")
	partsPath := flag.String("parts", "", "quote-part texts JSON (fallback for chapters whose overrides were wiped)")
	dryRun := flag.Bool("dry-run", false, "print the plan without writing")
	flag.Parse()
	if *bookID == "" {
		log.Fatal("-book is required")
	}

	speakers := map[string]string{}
	if *speakersPath != "" {
		var rows []speakerRow
		mustLoad(*speakersPath, &rows)
		for _, r := range rows {
			speakers[r.ID] = r.Speaker
		}
	}
	// (chapter, normalized text) → speaker, for sentences whose overrides a
	// mid-generation bug wiped before this migration ran.
	partSpeakers := map[int]map[string]string{}
	if *partsPath != "" {
		var rows []quotePartRow
		mustLoad(*partsPath, &rows)
		for _, r := range rows {
			if partSpeakers[r.Ch] == nil {
				partSpeakers[r.Ch] = map[string]string{}
			}
			partSpeakers[r.Ch][norm(r.Text)] = r.Speaker
		}
	}

	ctx := context.Background()
	client, err := mongo.Connect(options.Client().ApplyURI(*mongoURI))
	if err != nil {
		log.Fatal(err)
	}
	defer client.Disconnect(ctx)
	col := client.Database("book-reader").Collection("books")

	oid, err := bson.ObjectIDFromHex(*bookID)
	if err != nil {
		log.Fatal(err)
	}
	var book model.Book
	if err := col.FindOne(ctx, bson.M{"_id": oid}).Decode(&book); err != nil {
		log.Fatal(err)
	}

	// The role→voice matrix the offline pipeline used, per track.
	voiceRoles := map[string]model.RoleVoices{
		"kokoro:pm_alex": {
			model.RoleQuoteMale:    "kokoro:pm_santa",
			model.RoleQuoteFemale:  "kokoro:pf_dora",
			model.RoleQuoteChild:   "kokoro:pf_dora",
			model.RoleQuoteDefault: "kokoro:pm_santa",
		},
		"higgs:pt-BR-AntonioNeural": {
			model.RoleQuoteMale:    "kokoro:pm_alex",
			model.RoleQuoteFemale:  "higgs:pt-BR-FranciscaNeural",
			model.RoleQuoteChild:   "higgs:pt-BR-ThalitaMultilingualNeural",
			model.RoleQuoteDefault: "kokoro:pm_alex",
		},
		"openaudio:pt-BR-AntonioNeural": {
			model.RoleQuoteMale:    "kokoro:pm_alex",
			model.RoleQuoteFemale:  "openaudio:pt-BR-FranciscaNeural",
			model.RoleQuoteChild:   "openaudio:pt-BR-ThalitaMultilingualNeural",
			model.RoleQuoteDefault: "kokoro:pm_alex",
		},
	}
	fmt.Println("voiceRoles matrix:")
	for track, rv := range voiceRoles {
		fmt.Printf("  %s: %v\n", track, rv)
	}

	roleOf := func(ci int, sen model.Sentence) model.SentenceRole {
		ov := sen.VoiceOverrides["higgs:pt-BR-AntonioNeural"]
		switch {
		case strings.Contains(ov, "Francisca"):
			return model.RoleQuoteFemale
		case strings.Contains(ov, "Thalita"):
			return model.RoleQuoteChild
		case ov != "":
			return speakerRole(speakers[sen.ID.Hex()])
		}
		text := sen.Text
		if sen.Display != nil && *sen.Display != "" {
			text = *sen.Display
		}
		if speaker, ok := partSpeakers[ci][norm(text)]; ok {
			return speakerRole(speaker)
		}
		return model.RoleNone
	}

	roleCount := map[model.SentenceRole]int{}
	titleCount, overridesDropped, segsCleared := 0, 0, 0
	byOverride, byText := 0, 0

	for ci := range book.Chapters {
		chapter := &book.Chapters[ci]
		converted := map[string]bool{}
		for si := range chapter.Sentences {
			sen := &chapter.Sentences[si]
			if sen.Order == 0 && sen.Role == model.RoleNone {
				sen.Role = model.RoleTitle
				titleCount++
			}
			role := roleOf(ci, *sen)
			if role == model.RoleNone {
				continue
			}
			if sen.VoiceOverrides["higgs:pt-BR-AntonioNeural"] != "" {
				byOverride++
			} else {
				byText++
			}
			sen.Role = role
			roleCount[role]++
			converted[sen.ID.Hex()] = true
			for track, v := range sen.VoiceOverrides {
				if voiceRoles[track][role] == v {
					delete(sen.VoiceOverrides, track)
					overridesDropped++
				}
			}
			if len(sen.VoiceOverrides) == 0 {
				sen.VoiceOverrides = nil
			}
		}

		for ti := range chapter.Tracks {
			track := &chapter.Tracks[ti]
			touched := false
			for si := range track.Segments {
				seg := &track.Segments[si]
				if !converted[seg.SentenceID.Hex()] {
					continue
				}
				// Which voice rendered the old file cannot be trusted
				// (overrides were partially wiped mid-generation) — drop the
				// audio and let the next generate render both takes fresh.
				seg.AudioPath = nil
				seg.DurationSecs = nil
				seg.AltAudioPath = nil
				seg.AltDurationSecs = nil
				seg.AltVoice = ""
				seg.WhisperResults = nil
				seg.NeedsReview = false
				seg.AudioStatus = model.AudioStale
				segsCleared++
				touched = true
			}
			if touched && track.AudioStatus == model.AudioComplete {
				track.AudioStatus = model.AudioStale
			}
		}
	}

	fmt.Printf("roles: %v | titles: %d | via overrides: %d | via text match: %d | overrides dropped: %d | segments cleared: %d\n",
		roleCount, titleCount, byOverride, byText, overridesDropped, segsCleared)

	if *dryRun {
		fmt.Println("dry run — nothing written")
		return
	}
	if _, err := col.UpdateOne(ctx, bson.M{"_id": oid}, bson.M{
		"$set":         bson.M{"chapters": book.Chapters, "voiceRoles": voiceRoles},
		"$currentDate": bson.M{"updatedAt": true},
	}); err != nil {
		log.Fatal(err)
	}
	fmt.Println("book updated; run generate/continue to render both takes")
}

func mustLoad(path string, v any) {
	raw, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		log.Fatal(err)
	}
}
