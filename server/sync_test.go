package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

const (
	markTok   = "mark-token-0123456789abcdef"
	claireTok = "claire-token-0123456789abcdef"
)

func syncConfig(t *testing.T) config {
	t.Helper()
	c := testConfig("http://unused", "http://unused")
	c.dataDir = t.TempDir()
	c.accounts = []account{{ID: "mark", Token: markTok}, {ID: "claire", Token: claireTok}}
	return c
}

func req(t *testing.T, h http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r = httptest.NewRequest(method, path, bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("Origin", "https://mark.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func day(updatedAt int64, meals string) map[string]any {
	return map[string]any{"updatedAt": updatedAt, "meals": json.RawMessage(meals)}
}

func diaryOf(t *testing.T, w *httptest.ResponseRecorder) diaryDoc {
	t.Helper()
	var out struct {
		Account string   `json:"account"`
		Diary   diaryDoc `json:"diary"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad JSON: %v\n%s", err, w.Body.String())
	}
	return out.Diary
}

/* ------------------------------------------------------------------ access */

func TestOneAccountCannotSeeTheOther(t *testing.T) {
	h := newServer(syncConfig(t)).routes()

	// Mark logs a day
	w := req(t, h, "POST", "/api/diary", markTok, map[string]any{
		"days": map[string]any{"2026-09-11": day(1000, `{"Breakfast":[{"name":"Porridge"}]}`)},
	})
	if w.Code != 200 {
		t.Fatalf("mark POST: %d %s", w.Code, w.Body.String())
	}

	// Claire reads with her own token and must see nothing of his
	w = req(t, h, "GET", "/api/diary", claireTok, nil)
	if w.Code != 200 {
		t.Fatalf("claire GET: %d", w.Code)
	}
	if d := diaryOf(t, w); len(d.Days) != 0 {
		t.Fatalf("claire can see mark's diary: %+v", d.Days)
	}

	// and Mark still has his
	w = req(t, h, "GET", "/api/diary", markTok, nil)
	if d := diaryOf(t, w); len(d.Days) != 1 {
		t.Fatalf("mark lost his diary: %+v", d.Days)
	}
}

func TestAccountComesFromTokenNotFromTheClient(t *testing.T) {
	h := newServer(syncConfig(t)).routes()

	req(t, h, "POST", "/api/diary", markTok, map[string]any{
		"days": map[string]any{"2026-09-11": day(1000, `{"Breakfast":[]}`)},
	})

	// Try every obvious way of asking for someone else's data
	for _, path := range []string{
		"/api/diary?account=mark",
		"/api/diary?user=mark",
		"/api/diary/mark",
	} {
		w := req(t, h, "GET", path, claireTok, nil)
		if w.Code == 200 {
			if d := diaryOf(t, w); len(d.Days) > 0 {
				t.Errorf("%s leaked mark's diary to claire", path)
			}
		}
	}

	// And that the response names the authenticated account, not a requested one
	w := req(t, h, "GET", "/api/diary?account=mark", claireTok, nil)
	var out struct {
		Account string `json:"account"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out.Account != "claire" {
		t.Errorf("account resolved to %q, want claire", out.Account)
	}
}

func TestBadTokens(t *testing.T) {
	h := newServer(syncConfig(t)).routes()

	for _, tok := range []string{"", "wrong", markTok + "x", markTok[:10]} {
		w := req(t, h, "GET", "/api/diary", tok, nil)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("token %q gave %d, want 401", tok, w.Code)
		}
	}
	if w := req(t, h, "GET", "/api/whoami", markTok, nil); w.Code != 200 {
		t.Errorf("valid token rejected by whoami: %d", w.Code)
	}
}

func TestSyncDisabledWithoutConfig(t *testing.T) {
	c := testConfig("http://unused", "http://unused") // no dataDir, no accounts
	h := newServer(c).routes()
	if w := req(t, h, "GET", "/api/diary", markTok, nil); w.Code != http.StatusNotImplemented {
		t.Errorf("got %d, want 501 when sync is not configured", w.Code)
	}
	// search must still work
	if w := req(t, h, "GET", "/api/search", "", nil); w.Code == http.StatusNotImplemented {
		t.Error("disabling sync should not disable search")
	}
}

/* ------------------------------------------------------------------ merging */

func TestStaleDeviceCannotClobberNewerDays(t *testing.T) {
	h := newServer(syncConfig(t)).routes()

	// laptop writes Thursday and Friday
	req(t, h, "POST", "/api/diary", markTok, map[string]any{"days": map[string]any{
		"2026-09-10": day(5000, `{"Breakfast":[{"name":"laptop-thu"}]}`),
		"2026-09-11": day(5000, `{"Breakfast":[{"name":"laptop-fri"}]}`),
	}})

	// a phone that has been offline posts an older Friday and a newer Thursday
	w := req(t, h, "POST", "/api/diary", markTok, map[string]any{"days": map[string]any{
		"2026-09-10": day(9000, `{"Breakfast":[{"name":"phone-thu"}]}`), // newer, should win
		"2026-09-11": day(1000, `{"Breakfast":[{"name":"phone-fri"}]}`), // older, must lose
	}})

	d := diaryOf(t, w)
	if got := string(d.Days["2026-09-10"].Meals); !contains(got, "phone-thu") {
		t.Errorf("newer day did not win: %s", got)
	}
	if got := string(d.Days["2026-09-11"].Meals); !contains(got, "laptop-fri") {
		t.Errorf("stale device clobbered a newer day: %s", got)
	}
	if len(d.Days) != 2 {
		t.Errorf("expected both days retained, got %d", len(d.Days))
	}
}

func TestDaysNotMentionedAreKept(t *testing.T) {
	h := newServer(syncConfig(t)).routes()

	req(t, h, "POST", "/api/diary", markTok, map[string]any{"days": map[string]any{
		"2026-09-01": day(1000, `{"Breakfast":[{"name":"old"}]}`),
	}})
	// a fresh install posts only today — history must survive
	w := req(t, h, "POST", "/api/diary", markTok, map[string]any{"days": map[string]any{
		"2026-09-11": day(2000, `{"Breakfast":[{"name":"new"}]}`),
	}})
	d := diaryOf(t, w)
	if len(d.Days) != 2 {
		t.Fatalf("history dropped: %+v", d.Days)
	}
	if !contains(string(d.Days["2026-09-01"].Meals), "old") {
		t.Error("older day lost")
	}
}

func TestWeightsAndSettingsMergeByRecency(t *testing.T) {
	h := newServer(syncConfig(t)).routes()

	req(t, h, "POST", "/api/diary", markTok, map[string]any{
		"weights":  map[string]any{"2026-09-11": map[string]any{"updatedAt": 100, "value": json.RawMessage(`84.2`)}},
		"settings": map[string]any{"updatedAt": 100, "value": json.RawMessage(`{"goal":2200}`)},
	})
	w := req(t, h, "POST", "/api/diary", markTok, map[string]any{
		"weights":  map[string]any{"2026-09-11": map[string]any{"updatedAt": 50, "value": json.RawMessage(`99.9`)}},
		"settings": map[string]any{"updatedAt": 200, "value": json.RawMessage(`{"goal":1900}`)},
	})
	d := diaryOf(t, w)
	if got := string(d.Weights["2026-09-11"].Value); got != "84.2" {
		t.Errorf("older weight won: %s", got)
	}
	if got := string(d.Settings.Value); !contains(got, "1900") {
		t.Errorf("newer settings did not win: %s", got)
	}
}

/* ------------------------------------------------------- shared food library */

func TestFoodLibraryIsSharedBetweenAccounts(t *testing.T) {
	h := newServer(syncConfig(t)).routes()

	req(t, h, "POST", "/api/foods", markTok, map[string]any{"foods": map[string]any{
		"c_lasagne": map[string]any{"updatedAt": 100, "food": json.RawMessage(`{"name":"Mum's lasagne","per100":{"k":180}}`)},
	}})

	w := req(t, h, "GET", "/api/foods", claireTok, nil)
	if w.Code != 200 {
		t.Fatalf("claire GET foods: %d", w.Code)
	}
	var out struct {
		Foods map[string]sharedFood `json:"foods"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out.Foods) != 1 || !contains(string(out.Foods["c_lasagne"].Food), "lasagne") {
		t.Errorf("shared food not visible to the other account: %+v", out.Foods)
	}
}

func TestFoodDeletionIsATombstoneThatSticks(t *testing.T) {
	h := newServer(syncConfig(t)).routes()

	req(t, h, "POST", "/api/foods", markTok, map[string]any{"foods": map[string]any{
		"c_x": map[string]any{"updatedAt": 100, "food": json.RawMessage(`{"name":"Thing"}`)},
	}})
	// claire deletes it
	req(t, h, "POST", "/api/foods", claireTok, map[string]any{"foods": map[string]any{
		"c_x": map[string]any{"updatedAt": 200, "deleted": true},
	}})
	// mark's device, unaware, re-posts its stale copy
	w := req(t, h, "POST", "/api/foods", markTok, map[string]any{"foods": map[string]any{
		"c_x": map[string]any{"updatedAt": 100, "food": json.RawMessage(`{"name":"Thing"}`)},
	}})

	var out struct {
		Foods map[string]sharedFood `json:"foods"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if !out.Foods["c_x"].Deleted {
		t.Error("a stale device resurrected a deleted food")
	}
}

/* -------------------------------------------------------------- persistence */

func TestDataSurvivesRestartAndIsWrittenPrivately(t *testing.T) {
	cfg := syncConfig(t)
	h := newServer(cfg).routes()
	req(t, h, "POST", "/api/diary", markTok, map[string]any{"days": map[string]any{
		"2026-09-11": day(1000, `{"Breakfast":[{"name":"kept"}]}`),
	}})

	// a completely fresh server over the same directory
	h2 := newServer(cfg).routes()
	d := diaryOf(t, req(t, h2, "GET", "/api/diary", markTok, nil))
	if !contains(string(d.Days["2026-09-11"].Meals), "kept") {
		t.Fatal("diary did not survive a restart")
	}

	info, err := os.Stat(fmt.Sprintf("%s/accounts/mark.json", cfg.dataDir))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("diary written with mode %04o, want 0600", perm)
	}
}

/* ------------------------------------------------------------------- config */

func TestAccountParsing(t *testing.T) {
	if _, err := parseAccounts("mark:short"); err == nil {
		t.Error("should reject a short token")
	}
	if _, err := parseAccounts("mark"); err == nil {
		t.Error("should reject a missing token")
	}
	if _, err := parseAccounts("mark:" + markTok + ",mark:" + claireTok); err == nil {
		t.Error("should reject duplicate account names")
	}
	if _, err := parseAccounts("../etc:" + markTok); err == nil {
		t.Error("should reject a name that could escape the data directory")
	}
	got, err := parseAccounts(" mark:" + markTok + " , claire:" + claireTok + " ")
	if err != nil || len(got) != 2 || got[1].ID != "claire" {
		t.Errorf("parse failed: %+v %v", got, err)
	}
}

func TestWildcardOriginRefusedWithAccounts(t *testing.T) {
	t.Setenv("OFFPROXY_UA", "Tally/1.1 (m@example.com)")
	t.Setenv("OFFPROXY_ORIGINS", "*")
	t.Setenv("OFFPROXY_DATA", t.TempDir())
	t.Setenv("OFFPROXY_ACCOUNTS", "mark:"+markTok)
	if _, err := loadConfig(); err == nil {
		t.Error("wildcard CORS with bearer tokens should be refused")
	}
}

func TestSyncConfigMustBeComplete(t *testing.T) {
	t.Setenv("OFFPROXY_UA", "Tally/1.1 (m@example.com)")
	t.Setenv("OFFPROXY_ORIGINS", "https://mark.example")

	t.Setenv("OFFPROXY_DATA", t.TempDir())
	t.Setenv("OFFPROXY_ACCOUNTS", "")
	if _, err := loadConfig(); err == nil {
		t.Error("data dir without accounts should be refused")
	}
	t.Setenv("OFFPROXY_DATA", "")
	t.Setenv("OFFPROXY_ACCOUNTS", "mark:"+markTok)
	if _, err := loadConfig(); err == nil {
		t.Error("accounts without a data dir should be refused")
	}
}

func TestGeneratedTokensAreLongAndUnique(t *testing.T) {
	a, b := generateToken(), generateToken()
	if a == b {
		t.Error("tokens are not unique")
	}
	if len(a) < 32 {
		t.Errorf("token too short: %d chars", len(a))
	}
}

func TestCORSAllowsAuthorizationHeader(t *testing.T) {
	h := newServer(syncConfig(t)).routes()
	r := httptest.NewRequest(http.MethodOptions, "/api/diary", nil)
	r.Header.Set("Origin", "https://mark.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if got := w.Header().Get("Access-Control-Allow-Headers"); !contains(got, "Authorization") {
		t.Errorf("preflight does not allow Authorization: %q", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Methods"); !contains(got, "POST") {
		t.Errorf("preflight does not allow POST: %q", got)
	}
}

func contains(haystack, needle string) bool {
	return bytes.Contains([]byte(haystack), []byte(needle))
}

/* ------------------------------------------------------ active energy feed */

func activityOf(t *testing.T, h http.Handler, tok string) map[string]stampedVal {
	t.Helper()
	return diaryOf(t, req(t, h, "GET", "/api/diary", tok, nil)).Activity
}

func TestActivityIsStoredAndReadBack(t *testing.T) {
	h := newServer(syncConfig(t)).routes()

	w := req(t, h, "POST", "/api/activity", markTok, map[string]any{"date": "2026-09-13", "kcal": 540})
	if w.Code != 200 {
		t.Fatalf("post: %d %s", w.Code, w.Body.String())
	}
	a := activityOf(t, h, markTok)
	if got := string(a["2026-09-13"].Value); got != "540" {
		t.Errorf("stored %s, want 540", got)
	}
	if a["2026-09-13"].UpdatedAt == 0 {
		t.Error("server did not stamp the entry")
	}
}

// Shortcuts often sends numbers as text; refusing that would be a miserable
// afternoon for whoever is building the automation.
func TestActivityAcceptsKcalAsString(t *testing.T) {
	h := newServer(syncConfig(t)).routes()
	if w := req(t, h, "POST", "/api/activity", markTok,
		map[string]any{"date": "2026-09-13", "kcal": "612.4"}); w.Code != 200 {
		t.Fatalf("string kcal rejected: %d %s", w.Code, w.Body.String())
	}
	if got := string(activityOf(t, h, markTok)["2026-09-13"].Value); got != "612" {
		t.Errorf("stored %s, want 612", got)
	}
}

func TestActivityRejectsNonsense(t *testing.T) {
	h := newServer(syncConfig(t)).routes()
	cases := []struct {
		name string
		body map[string]any
	}{
		{"bad date", map[string]any{"date": "13/09/2026", "kcal": 100}},
		{"path traversal in date", map[string]any{"date": "../../etc/passwd", "kcal": 100}},
		{"negative", map[string]any{"date": "2026-09-13", "kcal": -5}},
		{"absurd", map[string]any{"date": "2026-09-13", "kcal": 99999}},
		{"not a number", map[string]any{"date": "2026-09-13", "kcal": "loads"}},
	}
	for _, c := range cases {
		if w := req(t, h, "POST", "/api/activity", markTok, c.body); w.Code != http.StatusBadRequest {
			t.Errorf("%s gave %d, want 400", c.name, w.Code)
		}
	}
	if w := req(t, h, "POST", "/api/activity", "", map[string]any{"kcal": 100}); w.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated gave %d, want 401", w.Code)
	}
}

// The critical one: a phone syncing its diary knows nothing about activity,
// and must not blank out what the Shortcut posted.
func TestClientSyncCannotWipeActivity(t *testing.T) {
	h := newServer(syncConfig(t)).routes()

	req(t, h, "POST", "/api/activity", markTok, map[string]any{"date": "2026-09-13", "kcal": 540})

	// a normal diary sync, with no activity field at all
	req(t, h, "POST", "/api/diary", markTok, map[string]any{
		"days": map[string]any{"2026-09-13": day(1000, `{"Breakfast":[{"name":"Porridge"}]}`)},
	})
	if got := string(activityOf(t, h, markTok)["2026-09-13"].Value); got != "540" {
		t.Fatalf("a diary sync wiped the activity figure: %q", got)
	}

	// and a client that tries to set activity directly is ignored
	req(t, h, "POST", "/api/diary", markTok, map[string]any{
		"activity": map[string]any{
			"2026-09-13": map[string]any{"updatedAt": 9999999999999, "value": json.RawMessage(`1`)},
		},
	})
	if got := string(activityOf(t, h, markTok)["2026-09-13"].Value); got != "540" {
		t.Errorf("client overwrote the watch feed: %q", got)
	}
}

func TestActivityIsPerAccount(t *testing.T) {
	h := newServer(syncConfig(t)).routes()
	req(t, h, "POST", "/api/activity", markTok, map[string]any{"date": "2026-09-13", "kcal": 540})
	if a := activityOf(t, h, claireTok); len(a) != 0 {
		t.Errorf("claire can see mark's activity: %+v", a)
	}
}

func TestActivityDefaultsToTodayWhenDateOmitted(t *testing.T) {
	h := newServer(syncConfig(t)).routes()
	w := req(t, h, "POST", "/api/activity", markTok, map[string]any{"kcal": 300})
	if w.Code != 200 {
		t.Fatalf("omitted date rejected: %d", w.Code)
	}
	var out struct{ Date string }
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if !dateRe.MatchString(out.Date) {
		t.Errorf("server returned a malformed date: %q", out.Date)
	}
}
