package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testConfig(searchURL, productURL string) config {
	return config{
		addr:            "127.0.0.1:0",
		userAgent:       "TallyTest/1.0 (test@example.com)",
		origins:         []string{"https://mark.example"},
		searchUpstream:  searchURL,
		productUpstream: productURL,
		searchTTL:       time.Hour,
		productTTL:      time.Hour,
		maxResults:      25,
	}
}

func get(t *testing.T, h http.Handler, path, origin string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func decodeFoods(t *testing.T, body string) []Food {
	t.Helper()
	var out struct {
		Foods []Food `json:"foods"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("bad JSON: %v\n%s", err, body)
	}
	return out.Foods
}

/* ------------------------------------------------------------------ upstream stubs */

const beansJSON = `{"code":"5000157024671","status":1,"product":{
  "code":"5000157024671","product_name":"Beanz in a rich tomato sauce","brands":"Heinz",
  "quantity":"415g","product_quantity":415,"serving_size":"0.5 Can (207 g)","serving_quantity":207,
  "nutriments":{"energy-kcal_100g":79,"proteins_100g":4.7,"carbohydrates_100g":12.9,
                "fat_100g":0.2,"fiber_100g":3.7,"sugars_100g":5,"salt_100g":0.6}}}`

// Mirrors what search.openfoodfacts.org actually returns: brands as an array,
// irrelevant foreign products ranked above the one you asked for, and hits
// with no nutrition at all.
const hovisSearchJSON = `{"hits":[
 {"code":"9555615900012","brands":["Mission"],"product_name":"Wraps Wholegrain",
  "countries_tags":["en:france"],
  "nutriments":{"energy-kcal_100g":282,"proteins_100g":8,"carbohydrates_100g":48.9,"fat_100g":5.11}},
 {"code":"0499007358816","product_name":"hovis tasty wholemeal","countries_tags":["en:united-kingdom"]},
 {"code":"3560071534486","brands":["Carrefour"],"product_name":"Pâte feuilletée",
  "countries_tags":["en:france"],
  "nutriments":{"energy-kcal_100g":377,"proteins_100g":6,"carbohydrates_100g":43,"fat_100g":18}},
 {"code":"5010026500114","brands":["Hovis"],"product_name":"Hovis Wholemeal Bread",
  "countries_tags":["en:united-kingdom"],"serving_size":"1 slice (40 g)","serving_quantity":"40",
  "nutriments":{"energy-kcal_100g":221,"proteins_100g":9.6,"carbohydrates_100g":36.5,"fat_100g":2.1}},
 {"code":"5010026527012","brands":["Hovis"],"product_name":"Hovis Soft White Medium",
  "countries_tags":["en:united-kingdom"],
  "nutriments":{"energy-kcal_100g":233,"proteins_100g":8.1,"carbohydrates_100g":44.2,"fat_100g":1.5}}
]}`

func stubSearch(t *testing.T, body string, calls *int64) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls != nil {
			atomic.AddInt64(calls, 1)
		}
		if ua := r.Header.Get("User-Agent"); !strings.HasPrefix(ua, "TallyTest/1.0") {
			t.Errorf("upstream did not receive our User-Agent, got %q", ua)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, body)
	}))
}

/* ----------------------------------------------------------------------- tests */

func TestSearchRanksTheRightLoafFirst(t *testing.T) {
	up := stubSearch(t, hovisSearchJSON, nil)
	defer up.Close()
	h := newServer(testConfig(up.URL, "")).routes()

	w := get(t, h, "/api/search?q=hovis+wholemeal+bread", "https://mark.example")
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	foods := decodeFoods(t, w.Body.String())
	if len(foods) == 0 {
		t.Fatal("no results")
	}
	if foods[0].Name != "Hovis Wholemeal Bread" {
		names := []string{}
		for _, f := range foods {
			names = append(names, f.Name)
		}
		t.Errorf("wrong top hit: %v", names)
	}
	for _, f := range foods {
		if f.Name == "hovis tasty wholemeal" {
			t.Error("kept a product with no nutrition data")
		}
		if f.Per100.K <= 0 {
			t.Errorf("%s has no energy value", f.Name)
		}
	}
}

func TestSearchParsesArrayBrandsAndStringServingQuantity(t *testing.T) {
	up := stubSearch(t, hovisSearchJSON, nil)
	defer up.Close()
	h := newServer(testConfig(up.URL, "")).routes()

	foods := decodeFoods(t, get(t, h, "/api/search?q=hovis+wholemeal+bread", "").Body.String())
	var loaf *Food
	for i := range foods {
		if foods[i].Code == "5010026500114" {
			loaf = &foods[i]
		}
	}
	if loaf == nil {
		t.Fatal("loaf missing")
	}
	if loaf.Brand != "Hovis" {
		t.Errorf("brand from array = %q, want Hovis", loaf.Brand)
	}
	if len(loaf.Portions) == 0 || loaf.Portions[0].G != 40 {
		t.Errorf("serving_quantity given as a string was not parsed: %+v", loaf.Portions)
	}
}

func TestSearchLimitAndCache(t *testing.T) {
	var calls int64
	up := stubSearch(t, hovisSearchJSON, &calls)
	defer up.Close()
	h := newServer(testConfig(up.URL, "")).routes()

	w1 := get(t, h, "/api/search?q=hovis&limit=1", "")
	if got := len(decodeFoods(t, w1.Body.String())); got != 1 {
		t.Errorf("limit ignored, got %d", got)
	}
	if w1.Header().Get("X-Cache") != "miss" {
		t.Error("first call should be a miss")
	}

	w2 := get(t, h, "/api/search?q=HOVIS&limit=5", "") // different case, same query
	if w2.Header().Get("X-Cache") != "hit" {
		t.Error("second call should be served from cache")
	}
	if calls != 1 {
		t.Errorf("upstream called %d times, want 1", calls)
	}
	if got := len(decodeFoods(t, w2.Body.String())); got < 2 {
		t.Errorf("cached response should still honour a larger limit, got %d", got)
	}
}

func TestProductLookup(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "5000157024671") {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, beansJSON)
	}))
	defer up.Close()
	h := newServer(testConfig("", up.URL)).routes()

	w := get(t, h, "/api/product/5000157024671", "https://mark.example")
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var out struct{ Food Food }
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	f := out.Food
	if f.Name != "Beanz in a rich tomato sauce" || f.Brand != "Heinz" {
		t.Errorf("bad product: %+v", f)
	}
	if f.Per100.K != 79 {
		t.Errorf("kcal = %v, want 79", f.Per100.K)
	}
	if f.Per100.Fib == nil || *f.Per100.Fib != 3.7 {
		t.Errorf("fibre not carried through: %+v", f.Per100.Fib)
	}
	// serving, whole pack, 100 g, grams
	if len(f.Portions) != 4 {
		t.Fatalf("portions = %+v", f.Portions)
	}
	if f.Portions[0].G != 207 || !strings.Contains(f.Portions[0].Label, "0.5 Can") {
		t.Errorf("serving portion wrong: %+v", f.Portions[0])
	}
	if f.Portions[1].G != 415 {
		t.Errorf("pack portion wrong: %+v", f.Portions[1])
	}
	if !f.Portions[3].Gram {
		t.Error("gram portion missing")
	}
}

func TestProductErrors(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "9999999999999"):
			fmt.Fprint(w, `{"code":"9999999999999","status":0}`)
		case strings.Contains(r.URL.Path, "1111111111111"):
			fmt.Fprint(w, `{"code":"1111111111111","status":1,"product":{"code":"1111111111111","product_name":"Mystery","nutriments":{}}}`)
		default:
			w.WriteHeader(500)
		}
	}))
	defer up.Close()
	h := newServer(testConfig("", up.URL)).routes()

	if w := get(t, h, "/api/product/9999999999999", ""); w.Code != 404 {
		t.Errorf("unknown barcode gave %d, want 404", w.Code)
	}
	if w := get(t, h, "/api/product/1111111111111", ""); w.Code != 422 {
		t.Errorf("product with no nutrition gave %d, want 422", w.Code)
	}
	if w := get(t, h, "/api/product/abc", ""); w.Code != 400 {
		t.Errorf("non-numeric barcode gave %d, want 400", w.Code)
	}
	if w := get(t, h, "/api/product/2222222222222", ""); w.Code != 502 {
		t.Errorf("upstream 500 gave %d, want 502", w.Code)
	}
}

func TestSearchRequiresQuery(t *testing.T) {
	h := newServer(testConfig("http://unused", "")).routes()
	if w := get(t, h, "/api/search", ""); w.Code != 400 {
		t.Errorf("missing q gave %d, want 400", w.Code)
	}
}

func TestCORS(t *testing.T) {
	h := newServer(testConfig("http://unused", "")).routes()

	w := get(t, h, "/health", "https://mark.example")
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://mark.example" {
		t.Errorf("allowed origin not echoed, got %q", got)
	}
	w = get(t, h, "/health", "https://someone-else.example")
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("unknown origin was allowed: %q", got)
	}

	r := httptest.NewRequest(http.MethodOptions, "/api/search", nil)
	r.Header.Set("Origin", "https://mark.example")
	wr := httptest.NewRecorder()
	h.ServeHTTP(wr, r)
	if wr.Code != http.StatusNoContent {
		t.Errorf("preflight gave %d, want 204", wr.Code)
	}
}

func TestRateLimiterStopsUsHammeringUpstream(t *testing.T) {
	l := newLimiter(10) // ten a minute, full bucket
	allowed := 0
	for i := 0; i < 20; i++ {
		if l.allow() {
			allowed++
		}
	}
	if allowed != 10 {
		t.Errorf("burst allowed %d, want 10", allowed)
	}
	if l.allow() {
		t.Error("bucket should be empty")
	}
}

func TestRateLimitedSearchReturns503(t *testing.T) {
	up := stubSearch(t, hovisSearchJSON, nil)
	defer up.Close()
	s := newServer(testConfig(up.URL, ""))
	s.sLimit = newLimiter(0.0001) // effectively empty
	h := s.routes()

	w := get(t, h, "/api/search?q=anything", "")
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Error("no Retry-After header")
	}
}

func TestConfigRefusesToStartUnidentified(t *testing.T) {
	t.Setenv("OFFPROXY_UA", "")
	t.Setenv("OFFPROXY_ORIGINS", "https://mark.example")
	if _, err := loadConfig(); err == nil {
		t.Error("should refuse to start without a User-Agent")
	}
	t.Setenv("OFFPROXY_UA", "Tally/1.0 (m@example.com)")
	t.Setenv("OFFPROXY_ORIGINS", "")
	if _, err := loadConfig(); err == nil {
		t.Error("should refuse to start without an allowed origin")
	}
}

func TestKilojouleFallback(t *testing.T) {
	p := offProduct{Code: "1", ProductName: "Only kJ",
		Nutriments: map[string]any{"energy_100g": 1180.0}}
	f, ok := toFood(p)
	if !ok {
		t.Fatal("should convert using kJ")
	}
	if f.Per100.K < 281 || f.Per100.K > 283 {
		t.Errorf("kJ->kcal = %v, want ~282", f.Per100.K)
	}
}
