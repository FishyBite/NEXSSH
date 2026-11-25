package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestForwardedTLSIdentity(t *testing.T) {
	for _, engine := range []string{"mongodb", "redis"} {
		t.Run(engine, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			name := make(chan string, 1)
			tlsConfig := &tls.Config{GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
				name <- hello.ServerName
				return nil, errors.New("fixture ends after reading TLS name")
			}}
			go func() {
				raw, err := listener.Accept()
				if err != nil {
					return
				}
				defer raw.Close()
				raw.SetDeadline(time.Now().Add(3 * time.Second))
				tls.Server(raw, tlsConfig).Handshake()
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			db, err := openNoSQL(ctx, Profile{Engine: engine, Host: "database.invalid", Port: 27017,
				ForwardPort: listener.Addr().(*net.TCPAddr).Port, TLS: true})
			if err == nil {
				db.Close()
				t.Fatal("accepted an unverified TLS endpoint")
			}
			select {
			case got := <-name:
				if got != "database.invalid" {
					t.Fatalf("TLS server name = %q", got)
				}
			default:
				t.Fatal("driver did not send a TLS client hello")
			}
		})
	}
}

func TestNoSQLGridLimits(t *testing.T) {
	g := newNoSQLGrid("Value")
	value := strings.Repeat("€", cellLimit)
	cell := g.cell(value)
	if !g.Truncated || len(*cell) > cellLimit || !utf8.ValidString(*cell) {
		t.Fatal("text must be truncated at a UTF-8 boundary")
	}
	for !g.full() {
		g.add(cell)
	}
	if !g.overflow || g.bytes > noSQLResultBytes {
		t.Fatal("output budget was not enforced")
	}
}

func TestInvalidNoSQLCommands(t *testing.T) {
	if !validMongoSeed("cluster0.a1-b2.mongodb.net") {
		t.Fatal("expected a valid DNS seed")
	}
	for _, host := range []string{"mongodb+srv://cluster.mongodb.net", "user:pass@cluster.mongodb.net", "cluster.mongodb.net:27017", "127.0.0.1", "cluster..example", "cluster.-example.net"} {
		if validMongoSeed(host) {
			t.Fatalf("accepted malformed seed %q", host)
		}
	}
	for _, query := range []string{"[]", "null", "{}", `["GET",null]`, `["GET",42]`, `[""]`} {
		if _, err := (&redisDB{}).Query(context.Background(), query); err == nil {
			t.Fatalf("accepted %s", query)
		}
	}
	for _, query := range []string{"", "null", "{}", "[]", `{"ping":1} trailing`} {
		if _, err := (&mongoDB{}).Query(context.Background(), query); err == nil {
			t.Fatalf("accepted %s", query)
		}
	}
}

// Run with the port of a disposable loopback server and unique test objects.
// No credentials, connection strings or external hosts are taken from the environment.
func localNoSQLFixture(t *testing.T, engine, portEnv string) (Database, context.Context) {
	t.Helper()
	portString := os.Getenv(portEnv)
	if portString == "" {
		t.Skip("no isolated test server configured")
	}
	port, err := strconv.Atoi(portString)
	if err != nil || port < 1 || port > 65535 {
		t.Fatalf("invalid fixture port: %q", portString)
	}
	// Exercise forwarded dialing with a hostname that cannot resolve locally.
	c := Profile{Engine: engine, Host: "database.invalid", Port: 27017, ForwardPort: port}
	if engine == "mongodb" {
		c.Database = "nexssh_fixture"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	t.Cleanup(cancel)
	db, err := openNoSQL(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, ctx
}

func TestMongoLoopback(t *testing.T) {
	db, ctx := localNoSQLFixture(t, "mongodb", "NEXSSH_FIXTURE_MONGO_PORT")
	name := fmt.Sprintf("fixture_%d", time.Now().UnixNano())
	t.Cleanup(func() { db.Query(ctx, fmt.Sprintf(`{"drop":%q}`, name)) })
	if _, err := db.Query(ctx, fmt.Sprintf(`{"insert":%q,"documents":[{"label":"kopi","n":7}]}`, name)); err != nil {
		t.Fatal(err)
	}
	objects, err := db.Objects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, obj := range objects {
		if obj.Name == name && obj.Kind == "collection" {
			grid, err := db.Preview(ctx, obj)
			if err != nil || len(grid.Rows) != 1 || !strings.Contains(*grid.Rows[0][0], "kopi") {
				t.Fatalf("preview: %+v %v", grid, err)
			}
			grid, err = db.Query(ctx, fmt.Sprintf(`{"find":%q,"filter":{"n":7}}`, name))
			if err != nil || len(grid.Rows) != 1 || !strings.Contains(*grid.Rows[0][0], "kopi") {
				t.Fatalf("filtered query: %+v %v", grid, err)
			}
			return
		}
	}
	t.Fatal("collection missing from object browser")
}

func TestRedisLoopback(t *testing.T) {
	db, ctx := localNoSQLFixture(t, "redis", "NEXSSH_FIXTURE_REDIS_PORT")
	key := fmt.Sprintf("fixture:%d", time.Now().UnixNano())
	t.Cleanup(func() { db.Query(ctx, fmt.Sprintf(`["DEL",%q]`, key)) })
	if _, err := db.Query(ctx, fmt.Sprintf(`["HSET",%q,"warna","biru"]`, key)); err != nil {
		t.Fatal(err)
	}
	objects, err := db.Objects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, obj := range objects {
		if obj.Name == key {
			grid, err := db.Preview(ctx, obj)
			if err != nil || len(grid.Rows) != 1 || *grid.Rows[0][0] != "warna" || *grid.Rows[0][1] != "biru" {
				t.Fatalf("hash preview: %+v %v", grid, err)
			}
			grid, err = db.Query(ctx, fmt.Sprintf(`["HGET",%q,"absent"]`, key))
			if err != nil || len(grid.Rows) != 1 || grid.Rows[0][0] != nil {
				t.Fatalf("null result: %+v %v", grid, err)
			}
			return
		}
	}
	t.Fatal("key missing from object browser")
}
