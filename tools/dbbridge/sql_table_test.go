package main

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCompiledRead(t *testing.T) {
	for _, engine := range []string{"mysql", "postgresql", "oracle", "sqlserver"} {
		s := &sqlSession{engine: engine}
		q, args, e := s.compileRead("SELECT name, id FROM app.orders WHERE status = 'pending' AND note LIKE 'a''b%' ORDER BY name DESC, id LIMIT 15")
		if e != nil || len(args) != 2 || args[1] != "a'b%" || strings.Contains(q, "pending") || !strings.Contains(q, "ORDER BY") {
			t.Fatalf("%s: %s %v %v", engine, q, args, e)
		}
		for _, unsafe := range []string{"SELECT * FROM a; DELETE FROM a", "SELECT db_write() FROM t", "SELECT a INTO outfile FROM t", "SELECT * FROM a WHERE x=1 OR evil()", "SELECT * FROM t FOR UPDATE", "COMMIT", "SELECT * FROM t ORDER BY write()", "SELECT * FROM t WHERE x='safe'; DROP TABLE t"} {
			if q, _, e = s.compileRead(unsafe); e == nil {
				t.Fatalf("compiled %q as %s", unsafe, q)
			}
		}
	}
}
func TestTableLive(t *testing.T) {
	config := os.Getenv("VEXSSH_TABLE_TEST_PROFILE")
	if config == "" {
		t.Skip("local disposable server required")
	}
	b, e := os.ReadFile(config)
	if e != nil {
		t.Fatal(e)
	}
	var p Profile
	if e = json.Unmarshal(b, &p); e != nil || p.Host != "127.0.0.1" || p.Database != "vexssh_grid_test" {
		t.Fatal("refusing non-fixture profile")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, e := openSQL(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	s := db.(*sqlSession)
	defer s.Close()
	var schema string
	switch p.Engine {
	case "postgresql":
		schema = "public"
	case "mysql", "mariadb":
		schema = p.Database
	default:
		t.Fatal("unknown fixture")
	}
	obj := Object{schema, "grid_test", "table"}
	if p.Engine == "mysql" || p.Engine == "mariadb" {
		if _, e = s.Query(ctx, "CREATE TABLE legacy_no_lock(id INT PRIMARY KEY, note CHAR(4)) ENGINE=MyISAM"); e != nil {
			t.Fatal(e)
		}
		meta, e := s.tableColumns(ctx, s.conn, Object{schema, "legacy_no_lock", "table"})
		if e != nil || len(meta) != 2 || meta[1].Editable {
			t.Fatal("nontransactional table permits unsafe writes", e)
		}
		if _, e = s.Query(ctx, "CREATE TABLE no_primary(id INT UNIQUE NOT NULL, note CHAR(4)) ENGINE=InnoDB"); e != nil {
			t.Fatal(e)
		}
		meta, e = s.tableColumns(ctx, s.conn, Object{schema, "no_primary", "table"})
		if e != nil || len(meta) != 2 || meta[0].PrimaryKey {
			t.Fatal("unique index misclassified as primary key", e)
		}
	}
	if _, e = s.Query(ctx, "CREATE TABLE grid_test (tenant INT, id INT, note VARCHAR(16000), PRIMARY KEY(tenant,id))"); e != nil {
		t.Fatal(e)
	}
	str := func(s string) *string { return &s }
	if _, e = s.Query(ctx, "INSERT INTO grid_test VALUES (1,1,'a_%'),(1,2,'b_%'),(2,1,NULL)"); e != nil {
		t.Fatal(e)
	}
	pge := PageOptions{Limit: 1, SortColumn: "id", SortDirection: "desc", FilterColumn: "note", FilterValue: "_%"}
	page, e := s.page(ctx, obj, pge)
	if e != nil || len(page.Rows) != 1 || *page.Rows[0][1] != "2" || !page.HasMore || page.Metadata[0].Editable || !page.Metadata[1].PrimaryKey || !page.Metadata[2].Editable {
		t.Fatalf("%#v %v", page, e)
	}
	pge.Offset = 1
	page, e = s.page(ctx, obj, pge)
	if e != nil || page.HasMore || *page.Rows[0][1] != "1" {
		t.Fatalf("next page %#v %v", page, e)
	}
	edit := request{Object: obj, Column: "note", Key: map[string]string{"tenant": "1", "id": "1"}, OldValue: str("a_%"), NewValue: str("casechanged")}
	if _, e = s.updateCell(ctx, edit); e != nil {
		t.Fatal(e)
	}
	if _, e = s.updateCell(ctx, edit); e == nil {
		t.Fatal("accepted stale old value")
	}
	edit.OldValue = str("CASECHANGED")
	if _, e = s.updateCell(ctx, edit); e == nil {
		t.Fatal("collation defeated concurrency check")
	}
	edit.OldValue = str("casechanged")
	long := strings.Repeat("a\n%", 3400)
	edit.NewValue = &long
	if _, e = s.updateCell(ctx, edit); e != nil {
		t.Fatal(e)
	}
	out := filepath.Join(t.TempDir(), "export.csv")
	if e = os.WriteFile(out, []byte{}, 0600); e != nil {
		t.Fatal(e)
	}
	_, e = s.export(ctx, request{Object: obj, PageOptions: PageOptions{Limit: 1, FilterColumn: "note", FilterValue: "%"}, Scope: "all", Path: out})
	if e != nil {
		t.Fatal(e)
	}
	f, e := os.Open(out)
	if e != nil {
		t.Fatal(e)
	}
	r, e := csv.NewReader(f).ReadAll()
	f.Close()
	if e != nil || len(r) != 3 || r[1][2] != long {
		t.Fatalf("streamed export count=%d %v", len(r), e)
	}
	p.ReadOnly = true
	ro, e := openSQL(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	defer ro.Close()
	g, e := ro.(*sqlSession).readOnlyQuery(ctx, "SELECT id FROM grid_test WHERE note = 'b_%' ORDER BY id DESC LIMIT 1")
	if e != nil || *g.Rows[0][0] != "2" {
		t.Fatalf("%#v %v", g, e)
	}
	if _, e = ro.(*sqlSession).Query(ctx, "DELETE FROM grid_test"); e == nil {
		t.Fatal("server allowed write on read-only session")
	}
	if _, e = ro.(*sqlSession).conn.ExecContext(ctx, "SELECT 1"); e != nil && e != sql.ErrNoRows {
		t.Fatal(e)
	}
	// Check the real stdio protocol, including an out-of-band cancel frame.
	fromClient, toServer := io.Pipe()
	fromServer, toClient := io.Pipe()
	done := make(chan bool)
	go func() { serve(fromClient, toClient); toClient.Close(); done <- true }()
	enc := json.NewEncoder(toServer)
	dec := json.NewDecoder(fromServer)
	p.ReadOnly = false
	send := func(v any) {
		if e := enc.Encode(v); e != nil {
			t.Fatal(e)
		}
	}
	receive := func() reply {
		var v reply
		if e := dec.Decode(&v); e != nil {
			t.Fatal(e)
		}
		return v
	}
	send(request{Action: "connect", Profile: p})
	if r := receive(); r.Error != "" {
		t.Fatal(r)
	}
	idQuery := "SELECT CONNECTION_ID()"
	if p.Engine == "postgresql" {
		idQuery = "SELECT pg_backend_pid()"
	}
	protocolID := func() string {
		send(request{Action: "query", Query: idQuery})
		r := receive()
		b, _ := json.Marshal(r.Data)
		var g Grid
		if e := json.Unmarshal(b, &g); r.Error != "" || e != nil || len(g.Rows) != 1 || len(g.Rows[0]) != 1 || g.Rows[0][0] == nil {
			t.Fatalf("database session unavailable: %v", r)
		}
		return *g.Rows[0][0]
	}
	originalID := protocolID()
	slow := "SELECT SLEEP(20)"
	if p.Engine == "postgresql" {
		slow = "SELECT pg_sleep(20)"
	}
	start := time.Now()
	send(request{Action: "query", RequestID: "one", Query: slow})
	time.Sleep(100 * time.Millisecond)
	send(request{Action: "cancel", RequestID: "one"})
	if r := receive(); r.Error == "" || time.Since(start) > 8*time.Second {
		t.Fatalf("query cancellation: %v", r)
	}
	if protocolID() != originalID {
		t.Fatal("cancellation replaced the database session")
	}
	// Inspect from an independent connected session after the query ended.
	var active int
	if p.Engine == "postgresql" {
		e = s.conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM pg_stat_activity WHERE pid=$1 AND state='active'", originalID).Scan(&active)
	} else {
		e = s.conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM information_schema.processlist WHERE id=? AND command='Query'", originalID).Scan(&active)
	}
	if e != nil || active != 0 {
		t.Fatalf("command still executing on server: %d %v", active, e)
	}
	toServer.Close()
	<-done
}
