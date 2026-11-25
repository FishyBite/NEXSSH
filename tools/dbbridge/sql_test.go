package main

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// TDS 7.x wraps TLS handshake records in prelogin packets. Only this
// framing is needed for checking the real SQL Server driver's TLS behavior.
type preloginFixtureConn struct {
	net.Conn
	unread []byte
}

func (c *preloginFixtureConn) Read(b []byte) (int, error) {
	if len(c.unread) == 0 {
		var header [8]byte
		if _, err := io.ReadFull(c.Conn, header[:]); err != nil {
			return 0, err
		}
		length := int(binary.BigEndian.Uint16(header[2:4])) - len(header)
		if header[0] != 18 || length <= 0 {
			return 0, errors.New("expected a TDS prelogin packet")
		}
		c.unread = make([]byte, length)
		if _, err := io.ReadFull(c.Conn, c.unread); err != nil {
			return 0, err
		}
	}
	n := copy(b, c.unread)
	c.unread = c.unread[n:]
	return n, nil
}

func (c *preloginFixtureConn) Write(b []byte) (int, error) {
	packet := make([]byte, 8+len(b))
	packet[0], packet[1] = 18, 1
	binary.BigEndian.PutUint16(packet[2:4], uint16(len(packet)))
	copy(packet[8:], b)
	_, err := c.Conn.Write(packet)
	if err != nil {
		return 0, err
	}
	return len(b), nil
}

func TestSQLForwardedTLSVerifiesOriginalHostname(t *testing.T) {
	// Let the standard library supply a disposable, untrusted test certificate.
	fixture := httptest.NewTLSServer(nil)
	certs := fixture.TLS.Certificates
	fixture.Close()
	for _, engine := range []string{"oracle", "sqlserver"} {
		t.Run(engine, func(t *testing.T) {
			l, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			sni := make(chan string, 1)
			done := make(chan error, 1)
			go func() {
				c, err := l.Accept()
				if err != nil {
					done <- err
					return
				}
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(5 * time.Second))
				if engine == "sqlserver" {
					tds := &preloginFixtureConn{Conn: c}
					if _, err = tds.Read(make([]byte, 65536)); err != nil {
						done <- err
						return
					}
					// Prelogin response with ENCRYPTION=ON.
					_, err = c.Write([]byte{4, 1, 0, 15, 0, 0, 1, 0, 1, 0, 6, 0, 1, 255, 1})
					if err != nil {
						done <- err
						return
					}
					c = tds
				}
				server := tls.Server(c, &tls.Config{Certificates: certs, GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
					sni <- hello.ServerName
					return nil, nil
				}})
				done <- server.Handshake()
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			p := Profile{Engine: engine, Host: "database.internal.invalid", Username: "nexssh", Password: "test:#/@!", Database: "demo", Port: 1521, TLS: true, ForwardPort: l.Addr().(*net.TCPAddr).Port}
			db, err := openSQL(ctx, p)
			if err == nil {
				db.Close()
				t.Fatal("accepted an untrusted certificate")
			}
			if !strings.Contains(strings.ToLower(err.Error()), "certificate") {
				t.Fatalf("expected certificate validation error, got %v", err)
			}
			select {
			case name := <-sni:
				if name != p.Host {
					t.Fatalf("incorrect SNI %q", name)
				}
			default:
				t.Fatal("driver did not present SNI")
			}
			if handshake := <-done; handshake == nil {
				t.Fatal("untrusted handshake completed")
			}
		})
	}
}

func TestOracleTLSRejectsPlaintextRedirect(t *testing.T) {
	peer, client := net.Pipe()
	defer peer.Close()
	n, err := (&tcpsConnection{Conn: client}).Write([]byte("plaintext TNS CONNECT"))
	if n != 0 || err == nil {
		t.Fatal("sent a plaintext Oracle packet")
	}
}

func TestSQLIdentifierQuoting(t *testing.T) {
	for _, tt := range []struct{ engine, input, want string }{
		{"mariadb", "a`b", "`a``b`"},
		{"postgresql", "a\"b", "\"a\"\"b\""},
		{"oracle", "a\"b", "\"a\"\"b\""},
		{"sqlserver", "a]b", "[a]]b]"},
	} {
		if got := sqlIdentifier(tt.engine, tt.input); got != tt.want {
			t.Fatalf("%s: %s", tt.engine, got)
		}
	}
}

func TestSQLCell(t *testing.T) {
	v, clipped := sqlCell(nil, "TEXT")
	if v != nil || clipped {
		t.Fatal("SQL NULL must stay distinct from an empty string")
	}
	v, clipped = sqlCell([]byte{0, 255}, "BYTEA")
	if *v != "0x00ff" || clipped {
		t.Fatal("binary preview incorrect")
	}
	v, clipped = sqlCell([]byte(strings.Repeat("€", cellLimit)), "VARCHAR")
	if !utf8.ValidString(*v) || !clipped || len(*v) > cellLimit {
		t.Fatal("broken multibyte preview")
	}
	v, clipped = sqlCell("", "TEXT")
	if v == nil || *v != "" || clipped {
		t.Fatal("empty string must stay distinct from SQL NULL")
	}
}

// NEXSSH_TEST_PG_PORT is supplied only by a disposable, unauthenticated
// PostgreSQL instance on loopback. No real profiles are needed for this test.
func TestLoopbackPostgreSQL(t *testing.T) {
	portValue := os.Getenv("NEXSSH_TEST_PG_PORT")
	if portValue == "" {
		t.Skip("requires local PostgreSQL fixture")
	}
	port, err := strconv.Atoi(portValue)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	p := Profile{Engine: "postgresql", Host: "127.0.0.1", Port: port, Username: "postgres", Database: "postgres"}
	db, err := openSQL(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec := func(q string) Grid {
		t.Helper()
		g, err := db.Query(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		return g
	}
	exec(`CREATE TEMP TABLE "client "" test" (id integer, description text, data bytea)`)
	g := exec(`INSERT INTO "client "" test" VALUES (1,NULL,'\x00ff')`)
	if g.Affected == nil || *g.Affected != 1 {
		t.Fatal("missing insert count")
	}
	objects, err := db.Objects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var o Object
	for _, item := range objects {
		if item.Name == "client \" test" {
			o = item
			break
		}
	}
	g, err = db.Preview(ctx, o)
	if err != nil || len(g.Rows) != 1 || len(g.Columns) != 3 || g.Rows[0][1] != nil || *g.Rows[0][2] != "0x00ff" {
		t.Fatalf("preview: %#v %v", g, err)
	}
	exec("BEGIN")
	g = exec(`UPDATE "client "" test" SET id=2 RETURNING id`)
	if len(g.Rows) != 1 || *g.Rows[0][0] != "2" {
		t.Fatal("RETURNING lost")
	}
	exec("ROLLBACK")
	g = exec(`SELECT id FROM "client "" test"`)
	if *g.Rows[0][0] != "1" {
		t.Fatal("transaction did not persist across requests")
	}
	g = exec("SELECT i FROM generate_series(1,220) i")
	if !g.Truncated || len(g.Rows) != rowLimit {
		t.Fatal("row limit missing")
	}

	// Emulate the socket endpoint exposed by a local SSH forward. The
	// original hostname is deliberately unresolvable on the client.
	p.ForwardPort = port
	p.Host = "private-db.nexssh.invalid"
	p.Port = 5432
	forwarded, err := openSQL(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	defer forwarded.Close()
	g, err = forwarded.Query(ctx, "SELECT 42")
	if err != nil || *g.Rows[0][0] != "42" {
		t.Fatalf("forward: %v", err)
	}
	p.TLS = true
	if insecure, err := openSQL(ctx, p); err == nil {
		insecure.Close()
		t.Fatal("TLS-required session connected to non-TLS fixture")
	}
}
