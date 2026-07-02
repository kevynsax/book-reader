package store

import (
	"context"
	"fmt"
	"os"
	"sort"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend-go/internal/model"
)

// TestBookRoundTrip proves data safety before any write path exists: every
// real book document must decode into model.Book and re-encode to a BSON
// document semantically identical to the original (numeric widths aside —
// int32/int64/double holding the same value are equivalent to both drivers).
func TestBookRoundTrip(t *testing.T) {
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://localhost:27017/book-reader"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	st, err := Connect(ctx, uri)
	if err != nil {
		t.Skipf("MongoDB not reachable at %s: %v", uri, err)
	}
	defer st.Client.Disconnect(ctx)

	cur, err := st.Books.col.Find(ctx, bson.M{})
	if err != nil {
		t.Fatal(err)
	}
	defer cur.Close(ctx)

	count := 0
	for cur.Next(ctx) {
		var raw bson.D
		if err := bson.Unmarshal(cur.Current, &raw); err != nil {
			t.Fatal(err)
		}
		var book model.Book
		if err := bson.Unmarshal(cur.Current, &book); err != nil {
			name, _ := docGet(raw, "name")
			t.Errorf("decode failed for book %v (%v): %v", mustID(raw), name, err)
			continue
		}
		// Mirror the real write path: Save() normalizes nil slices to [] (the
		// same defaults Mongoose fills on save), so pre-sentence-era docs gain
		// empty sentences/segments arrays — allowed below.
		book.Normalize()
		reencoded, err := bson.Marshal(&book)
		if err != nil {
			t.Errorf("re-encode failed for book %v: %v", mustID(raw), err)
			continue
		}
		var back bson.D
		if err := bson.Unmarshal(reencoded, &back); err != nil {
			t.Fatal(err)
		}
		diffs := diffValues("", normalize(raw), normalize(back))
		if len(diffs) > 0 {
			name, _ := docGet(raw, "name")
			t.Errorf("book %v (%v) round-trip differences:\n  %s", mustID(raw), name, joinLines(diffs))
		}
		count++
	}
	if err := cur.Err(); err != nil {
		t.Fatal(err)
	}
	t.Logf("round-tripped %d book documents", count)
}

func mustID(d bson.D) any {
	id, _ := docGet(d, "_id")
	return id
}

func joinLines(lines []string) string {
	out := ""
	for i, l := range lines {
		if i > 0 {
			out += "\n  "
		}
		out += l
		if i >= 24 {
			out += fmt.Sprintf("\n  … and %d more", len(lines)-i-1)
			break
		}
	}
	return out
}

// normalize converts a BSON value tree into a comparable form: documents →
// map[string]any, arrays → []any, all numeric widths → float64, datetimes →
// unix millis.
func normalize(v any) any {
	switch x := v.(type) {
	case bson.D:
		m := map[string]any{}
		for _, e := range x {
			m[e.Key] = normalize(e.Value)
		}
		return m
	case bson.M:
		m := map[string]any{}
		for k, val := range x {
			m[k] = normalize(val)
		}
		return m
	case bson.A:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = normalize(item)
		}
		return out
	case int32:
		return float64(x)
	case int64:
		return float64(x)
	case float64:
		return x
	case bson.DateTime:
		return fmt.Sprintf("datetime:%d", int64(x))
	default:
		return v
	}
}

func diffValues(path string, a, b any) []string {
	var diffs []string
	switch av := a.(type) {
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok {
			return []string{fmt.Sprintf("%s: document vs %T", path, b)}
		}
		keys := map[string]bool{}
		for k := range av {
			keys[k] = true
		}
		for k := range bv {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		for _, k := range sorted {
			ava, inA := av[k]
			bva, inB := bv[k]
			p := path + "." + k
			switch {
			case !inA:
				// A schema default materializing on save (empty subdoc array,
				// deleted:false) matches Mongoose behavior — not a data change.
				if arr, isArr := bva.([]any); isArr && len(arr) == 0 {
					continue
				}
				if k == "deleted" && bva == false {
					continue
				}
				diffs = append(diffs, fmt.Sprintf("%s: added by Go (%v)", p, bva))
			case !inB:
				diffs = append(diffs, fmt.Sprintf("%s: dropped by Go (was %v)", p, ava))
			default:
				diffs = append(diffs, diffValues(p, ava, bva)...)
			}
		}
	case []any:
		bv, ok := b.([]any)
		if !ok {
			return []string{fmt.Sprintf("%s: array vs %T", path, b)}
		}
		if len(av) != len(bv) {
			return []string{fmt.Sprintf("%s: array length %d vs %d", path, len(av), len(bv))}
		}
		for i := range av {
			diffs = append(diffs, diffValues(fmt.Sprintf("%s[%d]", path, i), av[i], bv[i])...)
		}
	default:
		if a != b {
			diffs = append(diffs, fmt.Sprintf("%s: %v (%T) vs %v (%T)", path, a, a, b, b))
		}
	}
	return diffs
}
