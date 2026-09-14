// offproxy — a small Open Food Facts front-end for the Tally web app.
//
// Why this exists: Open Food Facts asks every client to identify itself with a
// custom User-Agent, and browsers are forbidden from setting that header. Their
// search endpoints also send no CORS headers, so a browser cannot call them at
// all. Running the calls here fixes both: we identify properly, we stay inside
// the documented rate limits, and we serve the browser with CORS we control.
//
// It also does the work the browser shouldn't: caching, and re-ranking search
// results, which upstream returns in a fairly unhelpful order.
//
// No dependencies. Build: go build -o offproxy .
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

/* ------------------------------------------------------------------ config */

type config struct {
	addr            string
	userAgent       string
	origins         []string
	searchUpstream  string
	productUpstream string
	searchTTL       time.Duration
	productTTL      time.Duration
	maxResults      int
	dataDir         string
	accounts        []account
}

func loadConfig() (config, error) {
	c := config{
		addr:            env("OFFPROXY_ADDR", "127.0.0.1:8080"),
		userAgent:       os.Getenv("OFFPROXY_UA"),
		searchUpstream:  env("OFFPROXY_SEARCH_URL", "https://search.openfoodfacts.org/search"),
		productUpstream: env("OFFPROXY_PRODUCT_URL", "https://world.openfoodfacts.org/api/v2/product"),
		maxResults:      envInt("OFFPROXY_MAX_RESULTS", 25),
	}
	c.searchTTL = envDur("OFFPROXY_SEARCH_TTL", 6*time.Hour)
	c.productTTL = envDur("OFFPROXY_PRODUCT_TTL", 168*time.Hour)

	for _, o := range strings.Split(env("OFFPROXY_ORIGINS", ""), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.origins = append(c.origins, o)
		}
	}

	// Open Food Facts asks for AppName/Version (contact). Refusing to start
	// without one is deliberate: an unidentified client is exactly what their
	// anonymous-traffic restrictions exist to stop.
	if c.userAgent == "" {
		return c, errors.New("OFFPROXY_UA is required, e.g. \"Tally/1.0 (you@example.com)\"")
	}
	if len(c.origins) == 0 {
		return c, errors.New("OFFPROXY_ORIGINS is required, e.g. \"https://you.github.io\" (or \"*\")")
	}

	// Sync is optional: without a data directory offproxy stays the stateless
	// search service it was.
	c.dataDir = os.Getenv("OFFPROXY_DATA")
	accts, err := parseAccounts(os.Getenv("OFFPROXY_ACCOUNTS"))
	if err != nil {
		return c, err
	}
	c.accounts = accts
	if c.dataDir != "" && len(c.accounts) == 0 {
		return c, errors.New("OFFPROXY_DATA is set but OFFPROXY_ACCOUNTS is empty; sync would have no users")
	}
	if len(c.accounts) > 0 && c.dataDir == "" {
		return c, errors.New("OFFPROXY_ACCOUNTS is set but OFFPROXY_DATA is empty; there is nowhere to store diaries")
	}
	// Wildcard CORS plus bearer tokens would let any site on the internet use a
	// token it managed to obtain. Refuse the combination rather than ship it.
	if len(c.accounts) > 0 {
		for _, o := range c.origins {
			if o == "*" {
				return c, errors.New("OFFPROXY_ORIGINS=\"*\" is not allowed once accounts are configured; list your app's origin explicitly")
			}
		}
	}
	return c, nil
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func envInt(k string, d int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return d
}
func envDur(k string, d time.Duration) time.Duration {
	if v, err := time.ParseDuration(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return d
}

/* ------------------------------------------------------- the shape we serve */

// Food matches the object the Tally client already uses, so the browser can
// drop these straight into its UI with no transformation.
type Food struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Brand    string    `json:"brand,omitempty"`
	Code     string    `json:"code,omitempty"`
	Source   string    `json:"source"`
	Cat      string    `json:"cat,omitempty"`
	Per100   Nutrients `json:"per100"`
	Portions []Portion `json:"portions"`
}

type Nutrients struct {
	K   float64  `json:"k"`
	P   float64  `json:"p"`
	C   float64  `json:"c"`
	F   float64  `json:"f"`
	Fib *float64 `json:"fib,omitempty"`
	Sug *float64 `json:"sug,omitempty"`
	Sal *float64 `json:"sal,omitempty"`
}

type Portion struct {
	Label string  `json:"label"`
	G     float64 `json:"g"`
	Gram  bool    `json:"gram,omitempty"`
}

/* ------------------------------------------------- lenient upstream parsing */

// flexStr accepts either "Heinz" or ["Heinz","Heinz Foods"].
type flexStr []string

func (f *flexStr) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		*f = splitTrim(s)
		return nil
	}
	var a []string
	if json.Unmarshal(b, &a) == nil {
		*f = a
		return nil
	}
	*f = nil
	return nil // a malformed brand is not worth failing the whole response over
}

func (f flexStr) first() string {
	if len(f) == 0 {
		return ""
	}
	return strings.TrimSpace(f[0])
}

func splitTrim(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

type offProduct struct {
	Code            string         `json:"code"`
	ProductName     string         `json:"product_name"`
	ProductNameEN   string         `json:"product_name_en"`
	GenericName     string         `json:"generic_name"`
	Brands          flexStr        `json:"brands"`
	Quantity        string         `json:"quantity"`
	ProductQuantity any            `json:"product_quantity"`
	ServingSize     string         `json:"serving_size"`
	ServingQuantity any            `json:"serving_quantity"`
	CountriesTags   []string       `json:"countries_tags"`
	Categories      string         `json:"categories"`
	Nutriments      map[string]any `json:"nutriments"`
}

// numOf coerces the several ways OFF expresses a number (float, int, "207").
func numOf(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return f, err == nil
	}
	return 0, false
}

func nutr(m map[string]any, key string) (float64, bool) {
	if m == nil {
		return 0, false
	}
	return numOf(m[key])
}

func ptr(v float64, ok bool) *float64 {
	if !ok {
		return nil
	}
	return &v
}

// toFood converts an upstream product, or returns false if it carries no
// usable energy figure — an entry with no calories is worse than no entry.
func toFood(p offProduct) (Food, bool) {
	kcal, ok := nutr(p.Nutriments, "energy-kcal_100g")
	if !ok {
		if kj, ok2 := nutr(p.Nutriments, "energy_100g"); ok2 && kj > 0 {
			kcal, ok = kj/4.184, true // energy_100g is kJ unless stated otherwise
		}
	}
	if !ok || kcal <= 0 {
		return Food{}, false
	}

	name := firstNonEmpty(p.ProductName, p.ProductNameEN, p.GenericName)
	if name == "" {
		if p.Code == "" {
			return Food{}, false
		}
		name = "Barcode " + p.Code
	}

	var portions []Portion
	sq, sqOK := numOf(p.ServingQuantity)
	if sqOK && sq > 0 && sq < 2000 {
		label := strings.TrimSpace(p.ServingSize)
		if label != "" {
			label = "serving — " + label
		} else {
			label = fmt.Sprintf("serving (%.0f g)", sq)
		}
		portions = append(portions, Portion{Label: label, G: sq})
	}
	if pq, ok := numOf(p.ProductQuantity); ok && pq > 0 && pq < 5000 && pq != sq {
		portions = append(portions, Portion{Label: fmt.Sprintf("whole pack (%.0f g)", pq), G: pq})
	}
	portions = append(portions,
		Portion{Label: "100 g", G: 100},
		Portion{Label: "grams", G: 1, Gram: true})

	return Food{
		ID:     "o_" + p.Code,
		Name:   strings.TrimSpace(name),
		Brand:  p.Brands.first(),
		Code:   p.Code,
		Source: "off",
		Per100: Nutrients{
			K:   round1(kcal),
			P:   round1(first(nutr(p.Nutriments, "proteins_100g"))),
			C:   round1(first(nutr(p.Nutriments, "carbohydrates_100g"))),
			F:   round1(first(nutr(p.Nutriments, "fat_100g"))),
			Fib: ptr(nutr(p.Nutriments, "fiber_100g")),
			Sug: ptr(nutr(p.Nutriments, "sugars_100g")),
			Sal: ptr(nutr(p.Nutriments, "salt_100g")),
		},
		Portions: portions,
	}, true
}

func first(v float64, _ bool) float64 { return v }
func round1(f float64) float64        { return math.Round(f*10) / 10 }

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

/* ----------------------------------------------------------------- ranking */

// Upstream relevance is poor — a search for "hovis wholemeal bread" returns
// Mission wraps and French pâte feuilletée above the actual Hovis loaf. We ask
// for a wide page and re-rank here.
func rankFoods(foods []Food, countries [][]string, q string) []Food {
	terms := strings.Fields(strings.ToLower(q))
	type scored struct {
		f Food
		s float64
	}
	out := make([]scored, 0, len(foods))

	for i, f := range foods {
		hay := strings.ToLower(f.Name + " " + f.Brand)
		var hits float64
		for _, t := range terms {
			if strings.Contains(hay, t) {
				hits++
			}
		}
		if len(terms) > 0 && hits == 0 {
			continue // nothing in common with the query at all
		}

		s := 0.0
		if len(terms) > 0 {
			s += 10 * (hits / float64(len(terms))) // proportion of the query matched
		}
		if strings.Contains(hay, strings.ToLower(q)) {
			s += 6 // the whole phrase, in order
		}
		if len(terms) > 0 && strings.HasPrefix(hay, terms[0]) {
			s += 4
		}
		if i < len(countries) {
			for _, c := range countries[i] {
				if c == "en:united-kingdom" {
					s += 5 // this app is used in the UK
					break
				}
			}
		}
		if f.Brand != "" {
			s += 0.5
		}
		s -= math.Min(3, float64(len(f.Name))/40) // prefer the less waffly name

		out = append(out, scored{f, s})
	}

	sort.SliceStable(out, func(a, b int) bool { return out[a].s > out[b].s })

	res := make([]Food, 0, len(out))
	seen := map[string]bool{}
	for _, x := range out {
		if x.f.Code != "" && seen[x.f.Code] {
			continue
		}
		seen[x.f.Code] = true
		res = append(res, x.f)
	}
	return res
}

/* ------------------------------------------------------------------- cache */

type cacheEntry struct {
	body []byte
	exp  time.Time
}

type cache struct {
	mu  sync.RWMutex
	m   map[string]cacheEntry
	max int
}

func newCache(max int) *cache { return &cache{m: map[string]cacheEntry{}, max: max} }

func (c *cache) get(k string) ([]byte, bool) {
	c.mu.RLock()
	e, ok := c.m[k]
	c.mu.RUnlock()
	if !ok || time.Now().After(e.exp) {
		return nil, false
	}
	return e.body, true
}

func (c *cache) put(k string, b []byte, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= c.max {
		now := time.Now()
		for key, e := range c.m { // drop expired first, then anything
			if now.After(e.exp) {
				delete(c.m, key)
			}
		}
		for key := range c.m {
			if len(c.m) < c.max {
				break
			}
			delete(c.m, key)
		}
	}
	c.m[k] = cacheEntry{body: b, exp: time.Now().Add(ttl)}
}

/* ---------------------------------------------------------- rate limiting */

// Open Food Facts documents 10 req/min/IP for search and 15 req/min/IP for
// product reads. Staying under that is our responsibility, not theirs.
type limiter struct {
	mu       sync.Mutex
	tokens   float64
	capacity float64
	perSec   float64
	last     time.Time
}

func newLimiter(perMinute float64) *limiter {
	return &limiter{tokens: perMinute, capacity: perMinute, perSec: perMinute / 60, last: time.Now()}
}

func (l *limiter) allow() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.tokens = math.Min(l.capacity, l.tokens+now.Sub(l.last).Seconds()*l.perSec)
	l.last = now
	if l.tokens >= 1 {
		l.tokens--
		return true
	}
	return false
}

/* ------------------------------------------------------------------ server */

type server struct {
	cfg    config
	client *http.Client
	sCache *cache
	pCache *cache
	sLimit *limiter
	pLimit *limiter
	store  *store
}

func newServer(cfg config) *server {
	st, err := newStore(cfg.dataDir)
	if err != nil {
		log.Fatalf("data directory: %v", err)
	}
	return &server{
		cfg:    cfg,
		client: &http.Client{Timeout: 12 * time.Second},
		sCache: newCache(2000),
		pCache: newCache(20000),
		sLimit: newLimiter(10),
		pLimit: newLimiter(15),
		store:  st,
	}
}

func (s *server) fetch(ctx context.Context, u string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", s.cfg.userAgent) // the whole point of this service
	req.Header.Set("Accept", "application/json")

	res, err := s.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	return b, res.StatusCode, err
}

func (s *server) cors(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	for _, allowed := range s.cfg.origins {
		if allowed == "*" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			break
		}
		if allowed == origin {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			break
		}
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	w.Header().Set("Access-Control-Max-Age", "86400")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

/* --------------------------------------------------------------- /api/search */

type searchResponse struct {
	Hits []offProduct `json:"hits"`
}

func (s *server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "MISSING_QUERY", "pass ?q=")
		return
	}
	if len(q) > 120 {
		q = q[:120]
	}

	limit := s.cfg.maxResults
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 50 {
		limit = n
	}

	key := strings.ToLower(q)
	if b, ok := s.sCache.get(key); ok {
		w.Header().Set("X-Cache", "hit")
		s.serveFoods(w, b, limit)
		return
	}

	if !s.sLimit.allow() {
		w.Header().Set("Retry-After", "6")
		writeErr(w, http.StatusServiceUnavailable, "RATE_LIMITED",
			"upstream search budget spent, try again in a few seconds")
		return
	}

	u := s.cfg.searchUpstream + "?" + url.Values{
		"q":         {q},
		"page_size": {"50"},
		"fields": {"code,product_name,product_name_en,generic_name,brands,quantity," +
			"product_quantity,serving_size,serving_quantity,countries_tags,nutriments"},
	}.Encode()

	body, status, err := s.fetch(r.Context(), u)
	if err != nil {
		log.Printf("search upstream error: %v", err)
		writeErr(w, http.StatusBadGateway, "UPSTREAM_UNREACHABLE", "could not reach Open Food Facts")
		return
	}
	if status != http.StatusOK {
		log.Printf("search upstream status %d", status)
		writeErr(w, http.StatusBadGateway, "UPSTREAM_ERROR",
			fmt.Sprintf("Open Food Facts returned %d", status))
		return
	}

	var sr searchResponse
	if err := json.Unmarshal(body, &sr); err != nil {
		writeErr(w, http.StatusBadGateway, "UPSTREAM_MALFORMED", "unexpected response from Open Food Facts")
		return
	}

	foods := make([]Food, 0, len(sr.Hits))
	countries := make([][]string, 0, len(sr.Hits))
	for _, p := range sr.Hits {
		if f, ok := toFood(p); ok {
			foods = append(foods, f)
			countries = append(countries, p.CountriesTags)
		}
	}
	ranked := rankFoods(foods, countries, q)

	enc, _ := json.Marshal(ranked)
	s.sCache.put(key, enc, s.cfg.searchTTL)
	w.Header().Set("X-Cache", "miss")
	s.serveFoods(w, enc, limit)
}

func (s *server) serveFoods(w http.ResponseWriter, encoded []byte, limit int) {
	var foods []Food
	_ = json.Unmarshal(encoded, &foods)
	if len(foods) > limit {
		foods = foods[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"foods": foods})
}

/* -------------------------------------------------------------- /api/product */

type productResponse struct {
	Status  int        `json:"status"`
	Product offProduct `json:"product"`
}

func (s *server) handleProduct(w http.ResponseWriter, r *http.Request) {
	code := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/product/"), "/")
	if code == "" || !isDigits(code) || len(code) > 14 {
		writeErr(w, http.StatusBadRequest, "BAD_BARCODE", "expected a numeric barcode")
		return
	}

	if b, ok := s.pCache.get(code); ok {
		w.Header().Set("X-Cache", "hit")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(b)
		return
	}

	if !s.pLimit.allow() {
		w.Header().Set("Retry-After", "4")
		writeErr(w, http.StatusServiceUnavailable, "RATE_LIMITED",
			"upstream product budget spent, try again in a few seconds")
		return
	}

	u := fmt.Sprintf("%s/%s.json?fields=%s", strings.TrimSuffix(s.cfg.productUpstream, "/"), code,
		url.QueryEscape("code,product_name,product_name_en,generic_name,brands,quantity,"+
			"product_quantity,serving_size,serving_quantity,nutriments"))

	body, status, err := s.fetch(r.Context(), u)
	if err != nil {
		log.Printf("product upstream error: %v", err)
		writeErr(w, http.StatusBadGateway, "UPSTREAM_UNREACHABLE", "could not reach Open Food Facts")
		return
	}
	if status != http.StatusOK {
		writeErr(w, http.StatusBadGateway, "UPSTREAM_ERROR",
			fmt.Sprintf("Open Food Facts returned %d", status))
		return
	}

	var pr productResponse
	if err := json.Unmarshal(body, &pr); err != nil {
		writeErr(w, http.StatusBadGateway, "UPSTREAM_MALFORMED", "unexpected response from Open Food Facts")
		return
	}
	if pr.Status != 1 {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "no such product in Open Food Facts")
		return
	}
	food, ok := toFood(pr.Product)
	if !ok {
		writeErr(w, http.StatusUnprocessableEntity, "NO_NUTRITION",
			"the product exists but has no nutrition data")
		return
	}

	enc, _ := json.Marshal(map[string]any{"food": food})
	s.pCache.put(code, enc, s.cfg.productTTL)
	w.Header().Set("X-Cache", "miss")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(enc)
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

/* ------------------------------------------------------------------ routing */

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()

	wrap := func(methods string, h http.HandlerFunc) http.HandlerFunc {
		allowed := strings.Split(methods, ",")
		return func(w http.ResponseWriter, r *http.Request) {
			s.cors(w, r)
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			for _, m := range allowed {
				if r.Method == m {
					h(w, r)
					return
				}
			}
			writeErr(w, http.StatusMethodNotAllowed, "METHOD", methods+" only")
		}
	}

	mux.HandleFunc("/api/search", wrap("GET", s.handleSearch))
	mux.HandleFunc("/api/product/", wrap("GET", s.handleProduct))

	// sync — present only when OFFPROXY_DATA and OFFPROXY_ACCOUNTS are set
	mux.HandleFunc("/api/whoami", wrap("GET", s.handleWhoami))
	mux.HandleFunc("/api/diary", wrap("GET,POST", s.handleDiary))
	mux.HandleFunc("/api/foods", wrap("GET,POST", s.handleFoods))
	mux.HandleFunc("/api/activity", wrap("POST", s.handleActivity))

	mux.HandleFunc("/health", wrap("GET", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "service": "offproxy", "userAgent": s.cfg.userAgent,
			"sync": s.store != nil && len(s.cfg.accounts) > 0,
		})
	}))
	return mux
}

func main() {
	// Convenience so nobody invents a weak token by hand.
	for _, a := range os.Args[1:] {
		if a == "-gen-token" || a == "--gen-token" {
			fmt.Println(generateToken())
			return
		}
	}

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           newServer(cfg).routes(),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Printf("offproxy listening on %s as %q", cfg.addr, cfg.userAgent)
		if len(cfg.accounts) > 0 {
			ids := make([]string, 0, len(cfg.accounts))
			for _, a := range cfg.accounts {
				ids = append(ids, a.ID)
			}
			log.Printf("sync enabled for %s, data in %s", strings.Join(ids, ", "), cfg.dataDir)
		} else {
			log.Printf("sync disabled (set OFFPROXY_DATA and OFFPROXY_ACCOUNTS to enable)")
		}
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	log.Println("offproxy stopped")
}
