// Diary sync and the shared food library.
//
// Two accounts, one household. Each account's diary is private to its own
// token; the food library is shared by everyone on the server.
//
// The merge rules matter more than they look. A phone that has been offline
// for a week must not be able to wipe out entries made on the laptop since,
// so nothing is ever replaced wholesale: days, weights and foods each carry
// their own timestamp and the newer one wins, item by item.
package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

/* ---------------------------------------------------------------- accounts */

type account struct {
	ID    string
	Token string
}

// parseAccounts reads "mark:tok1,claire:tok2".
func parseAccounts(s string) ([]account, error) {
	var out []account
	seen := map[string]bool{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, tok, ok := strings.Cut(part, ":")
		id, tok = strings.TrimSpace(id), strings.TrimSpace(tok)
		if !ok || id == "" || tok == "" {
			return nil, fmt.Errorf("account %q must be in the form name:token", part)
		}
		if !safeID(id) {
			return nil, fmt.Errorf("account name %q may only contain letters, digits, - and _", id)
		}
		if len(tok) < 16 {
			return nil, fmt.Errorf("token for %q is too short; use at least 16 characters (offproxy -gen-token)", id)
		}
		if seen[id] {
			return nil, fmt.Errorf("account %q appears twice", id)
		}
		seen[id] = true
		out = append(out, account{ID: id, Token: tok})
	}
	return out, nil
}

func safeID(s string) bool {
	if s == "" || len(s) > 40 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// authenticate resolves a request to an account, or "" if the token is no good.
// The account is derived from the token alone — a client never gets to say who
// it is, so one person's device cannot ask for the other's diary.
func (s *server) authenticate(r *http.Request) (string, bool) {
	tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if tok == "" {
		return "", false
	}
	for _, a := range s.cfg.accounts {
		// constant time: token comparison should not leak length-prefix info
		if subtle.ConstantTimeCompare([]byte(tok), []byte(a.Token)) == 1 {
			return a.ID, true
		}
	}
	return "", false
}

func generateToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

/* ------------------------------------------------------------------- store */

type store struct {
	dir string
	mu  sync.Mutex // one writer at a time; the data here is tiny
}

func newStore(dir string) (*store, error) {
	if dir == "" {
		return nil, nil // sync disabled
	}
	if err := os.MkdirAll(filepath.Join(dir, "accounts"), 0o700); err != nil {
		return nil, err
	}
	return &store{dir: dir}, nil
}

func (st *store) path(parts ...string) string {
	return filepath.Join(append([]string{st.dir}, parts...)...)
}

func (st *store) read(p string, v any) error {
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil // absent is simply empty
	}
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return nil
	}
	return json.Unmarshal(b, v)
}

// write replaces the file atomically, so a crash mid-write can't leave a
// half-written diary behind.
func (st *store) write(p string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}

/* -------------------------------------------------------------- the shapes */

type stampedDay struct {
	UpdatedAt int64           `json:"updatedAt"`
	Meals     json.RawMessage `json:"meals"`
}

type stampedVal struct {
	UpdatedAt int64           `json:"updatedAt"`
	Value     json.RawMessage `json:"value"`
}

type diaryDoc struct {
	Days    map[string]stampedDay `json:"days"`
	Weights map[string]stampedVal `json:"weights"`
	// Active energy from a watch, keyed by local date. Written only by
	// /api/activity — never by a syncing client — so a phone that knows
	// nothing about it cannot wipe what the Shortcut posted.
	Activity map[string]stampedVal `json:"activity,omitempty"`
	Settings *stampedVal           `json:"settings,omitempty"`
}

type sharedFood struct {
	UpdatedAt int64           `json:"updatedAt"`
	Deleted   bool            `json:"deleted,omitempty"`
	Food      json.RawMessage `json:"food,omitempty"`
}

type foodsDoc struct {
	Foods map[string]sharedFood `json:"foods"`
}

/* ------------------------------------------------------------------ merging */

// mergeDiary folds an incoming document into the stored one. Newer wins per
// day, per weight, and for the settings blob — never wholesale.
func mergeDiary(stored, incoming diaryDoc) diaryDoc {
	if stored.Days == nil {
		stored.Days = map[string]stampedDay{}
	}
	if stored.Weights == nil {
		stored.Weights = map[string]stampedVal{}
	}
	for date, in := range incoming.Days {
		if cur, ok := stored.Days[date]; !ok || in.UpdatedAt > cur.UpdatedAt {
			stored.Days[date] = in
		}
	}
	for date, in := range incoming.Weights {
		if cur, ok := stored.Weights[date]; !ok || in.UpdatedAt > cur.UpdatedAt {
			stored.Weights[date] = in
		}
	}
	if incoming.Settings != nil && (stored.Settings == nil || incoming.Settings.UpdatedAt > stored.Settings.UpdatedAt) {
		stored.Settings = incoming.Settings
	}
	// Activity is deliberately not merged from the client: the watch feed is
	// the only writer, and stored.Activity is left exactly as it was.
	return stored
}

// mergeFoods folds the shared library. A deletion is a tombstone with a
// timestamp, so "I deleted it" and "I edited it" resolve by recency like
// anything else rather than the deletion silently losing.
func mergeFoods(stored, incoming foodsDoc) foodsDoc {
	if stored.Foods == nil {
		stored.Foods = map[string]sharedFood{}
	}
	for id, in := range incoming.Foods {
		if cur, ok := stored.Foods[id]; !ok || in.UpdatedAt > cur.UpdatedAt {
			stored.Foods[id] = in
		}
	}
	return stored
}

/* ----------------------------------------------------------------- handlers */

const maxBody = 8 << 20 // a decade of diary is far below this

func (s *server) requireSync(w http.ResponseWriter) bool {
	if s.store == nil {
		writeErr(w, http.StatusNotImplemented, "SYNC_DISABLED",
			"this server has no OFFPROXY_DATA directory configured")
		return false
	}
	if len(s.cfg.accounts) == 0 {
		writeErr(w, http.StatusNotImplemented, "NO_ACCOUNTS",
			"this server has no OFFPROXY_ACCOUNTS configured")
		return false
	}
	return true
}

func (s *server) handleDiary(w http.ResponseWriter, r *http.Request) {
	if !s.requireSync(w) {
		return
	}
	acct, ok := s.authenticate(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="tally"`)
		writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing or unrecognised token")
		return
	}

	p := s.store.path("accounts", acct+".json")

	s.store.mu.Lock()
	defer s.store.mu.Unlock()

	var doc diaryDoc
	if err := s.store.read(p, &doc); err != nil {
		writeErr(w, http.StatusInternalServerError, "READ_FAILED", "could not read the stored diary")
		return
	}

	if r.Method == http.MethodPost {
		var incoming diaryDoc
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&incoming); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_BODY", "could not parse the request body")
			return
		}
		doc = mergeDiary(doc, incoming)
		if err := s.store.write(p, doc); err != nil {
			writeErr(w, http.StatusInternalServerError, "WRITE_FAILED", "could not save the diary")
			return
		}
	}

	if doc.Days == nil {
		doc.Days = map[string]stampedDay{}
	}
	if doc.Weights == nil {
		doc.Weights = map[string]stampedVal{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"account": acct, "diary": doc})
}

func (s *server) handleFoods(w http.ResponseWriter, r *http.Request) {
	if !s.requireSync(w) {
		return
	}
	if _, ok := s.authenticate(r); !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="tally"`)
		writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing or unrecognised token")
		return
	}

	p := s.store.path("foods.json")

	s.store.mu.Lock()
	defer s.store.mu.Unlock()

	var doc foodsDoc
	if err := s.store.read(p, &doc); err != nil {
		writeErr(w, http.StatusInternalServerError, "READ_FAILED", "could not read the food library")
		return
	}

	if r.Method == http.MethodPost {
		var incoming foodsDoc
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&incoming); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_BODY", "could not parse the request body")
			return
		}
		doc = mergeFoods(doc, incoming)
		if err := s.store.write(p, doc); err != nil {
			writeErr(w, http.StatusInternalServerError, "WRITE_FAILED", "could not save the food library")
			return
		}
	}

	if doc.Foods == nil {
		doc.Foods = map[string]sharedFood{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"foods": doc.Foods})
}

/* ------------------------------------------------- active energy from a watch */

var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// handleActivity takes one day's active-energy total, posted by an iOS
// Shortcut reading Apple Health.
//
//	POST /api/activity   {"date":"2026-09-13","kcal":540}
//
// Deliberately forgiving, because building JSON in Shortcuts is fiddly:
// kcal may arrive as a number or a string, and date may be omitted (the
// server then uses its own UTC date — which is why the Shortcut should send
// one, since the phone knows the user's real day boundary and the server
// does not).
func (s *server) handleActivity(w http.ResponseWriter, r *http.Request) {
	if !s.requireSync(w) {
		return
	}
	acct, ok := s.authenticate(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="tally"`)
		writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing or unrecognised token")
		return
	}

	var in struct {
		Date string `json:"date"`
		Kcal any    `json:"kcal"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_BODY", "expected {\"date\":\"YYYY-MM-DD\",\"kcal\":123}")
		return
	}

	date := strings.TrimSpace(in.Date)
	if date == "" {
		date = time.Now().UTC().Format("2006-01-02")
	}
	if !dateRe.MatchString(date) {
		writeErr(w, http.StatusBadRequest, "BAD_DATE", "date must be YYYY-MM-DD")
		return
	}

	kcal, ok := numOf(in.Kcal)
	if !ok || kcal < 0 || kcal > 20000 {
		writeErr(w, http.StatusBadRequest, "BAD_KCAL", "kcal must be a number between 0 and 20000")
		return
	}
	kcal = math.Round(kcal)

	p := s.store.path("accounts", acct+".json")

	s.store.mu.Lock()
	defer s.store.mu.Unlock()

	var doc diaryDoc
	if err := s.store.read(p, &doc); err != nil {
		writeErr(w, http.StatusInternalServerError, "READ_FAILED", "could not read the stored diary")
		return
	}
	if doc.Activity == nil {
		doc.Activity = map[string]stampedVal{}
	}
	raw, _ := json.Marshal(kcal)
	doc.Activity[date] = stampedVal{UpdatedAt: time.Now().UnixMilli(), Value: raw}

	if err := s.store.write(p, doc); err != nil {
		writeErr(w, http.StatusInternalServerError, "WRITE_FAILED", "could not save")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"account": acct, "date": date, "kcal": kcal})
}

// handleWhoami lets a freshly-configured device confirm its token works and
// find out which account it belongs to, without touching any data.
func (s *server) handleWhoami(w http.ResponseWriter, r *http.Request) {
	if !s.requireSync(w) {
		return
	}
	acct, ok := s.authenticate(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="tally"`)
		writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing or unrecognised token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"account": acct})
}
