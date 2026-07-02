package httpapi

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
)

func decodeJSON(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}

func ioCopy(dst io.Writer, src io.Reader) (int64, error) {
	return io.Copy(dst, src)
}

func JSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func Error(w http.ResponseWriter, code int, msg string) {
	JSON(w, code, map[string]string{"error": msg})
}

func Message(w http.ResponseWriter, msg string) {
	JSON(w, http.StatusOK, map[string]string{"message": msg})
}

// ClientIP mirrors Express's `trust proxy` + Node's `::ffff:` stripping:
// first X-Forwarded-For entry when present, else the socket address.
func ClientIP(r *http.Request) string {
	ip := ""
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ip = strings.TrimSpace(strings.Split(xff, ",")[0])
	} else if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		ip = host
	} else {
		ip = r.RemoteAddr
	}
	return strings.TrimPrefix(ip, "::ffff:")
}
