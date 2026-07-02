package model

import (
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// DateTime is a BSON datetime that JSON-marshals exactly like Mongoose:
// UTC ISO-8601 with fixed millisecond precision ("2006-01-02T15:04:05.000Z").
// The frontend compares these strings lexicographically, so the format is
// load-bearing — RFC3339Nano's variable fraction digits would break it.
type DateTime struct {
	time.Time
}

func Now() DateTime {
	return DateTime{time.Now().UTC().Truncate(time.Millisecond)}
}

const isoMillis = "2006-01-02T15:04:05.000Z"

func (d DateTime) MarshalJSON() ([]byte, error) {
	return []byte(`"` + d.UTC().Format(isoMillis) + `"`), nil
}

func (d *DateTime) UnmarshalJSON(b []byte) error {
	s := string(b)
	if s == "null" {
		return nil
	}
	t, err := time.Parse(`"`+time.RFC3339+`"`, s)
	if err != nil {
		return err
	}
	d.Time = t
	return nil
}

func (d DateTime) MarshalBSONValue() (byte, []byte, error) {
	t, v, err := bson.MarshalValue(bson.NewDateTimeFromTime(d.Time))
	return byte(t), v, err
}

func (d *DateTime) UnmarshalBSONValue(t byte, data []byte) error {
	if bson.Type(t) != bson.TypeDateTime {
		return fmt.Errorf("expected BSON datetime, got type %d", t)
	}
	var dt bson.DateTime
	if err := bson.UnmarshalValue(bson.Type(t), data, &dt); err != nil {
		return err
	}
	d.Time = dt.Time().UTC()
	return nil
}
