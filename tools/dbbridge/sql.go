package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgconn/ctxwatch"
	"github.com/jackc/pgx/v5/stdlib"
	mssql "github.com/microsoft/go-mssqldb"
	"github.com/microsoft/go-mssqldb/msdsn"
	ora "github.com/sijms/go-ora/v2"
)

type sqlSession struct {
	engine         string
	db             *sql.DB
	conn           *sql.Conn
	mysqlCancelKey string
	mysqlThreadID  int64
}

// Resolve the database hostname on the SSH host, while the database driver
// keeps the original hostname for SNI and certificate verification.
type forwardedEndpoint struct {
	remote string
	local  string
	host   string
}

func (f forwardedEndpoint) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if network != "tcp" || !strings.EqualFold(addr, f.remote) {
		return nil, errors.New("this database requested another endpoint; the SSH tunnel only covers the configured host and port")
	}
	return (&net.Dialer{}).DialContext(ctx, "tcp", f.local)
}

func (f forwardedEndpoint) HostName() string { return f.host }

// Oracle listeners can redirect a TCPS connection to a TCP address. The
// driver chooses the redirect's protocol for the next socket. If the user
// requested TLS, require a TLS handshake before sending any Oracle packets.
type oracleTLSDialer struct {
	dial func(context.Context, string, string) (net.Conn, error)
}

func (d oracleTLSDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	conn, err := d.dial(ctx, network, address)
	if err != nil {
		return nil, err
	}
	return &tcpsConnection{Conn: conn}, nil
}

type tcpsConnection struct {
	net.Conn
	firstWrite    sync.Once
	protocolError error
}

func (c *tcpsConnection) Write(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	c.firstWrite.Do(func() {
		// TLS handshake record, TLS record-layer major version 3, ClientHello.
		if len(b) < 6 || b[0] != 22 || b[1] != 3 || b[5] != 1 {
			c.protocolError = errors.New("Oracle listener requires an unencrypted connection; TLS is required by this profile")
			_ = c.Conn.Close()
		}
	})
	if c.protocolError != nil {
		return 0, c.protocolError
	}
	return c.Conn.Write(b)
}

func sqlConnector(p Profile) (driver.Connector, error) {
	addr := net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
	tunnel := forwardedEndpoint{remote: addr, local: net.JoinHostPort("127.0.0.1", strconv.Itoa(p.ForwardPort)), host: p.Host}
	tlsConfig := &tls.Config{ServerName: p.Host, MinVersion: tls.VersionTLS12}
	switch p.Engine {
	case "mysql", "mariadb":
		config := mysql.NewConfig()
		config.Net, config.Addr = "tcp", addr
		config.User, config.Passwd, config.DBName = p.Username, p.Password, p.Database
		config.Timeout = 12 * time.Second
		config.Logger = &mysql.NopLogger{}
		if p.TLS {
			config.TLS = tlsConfig
		}
		if p.ForwardPort != 0 {
			config.DialFunc = tunnel.DialContext
		}
		return mysql.NewConnector(config)
	case "postgresql", "postgres":
		// The pgx connector must originate from ParseConfig. Keep passwords
		// out of parse errors and provide the connection profile explicitly.
		config, err := pgx.ParseConfig("postgres://localhost/postgres?sslmode=disable")
		if err != nil {
			return nil, errors.New("invalid PostgreSQL connection configuration")
		}
		config.Host, config.Port, config.Fallbacks = p.Host, uint16(p.Port), nil
		config.User, config.Password, config.Database = p.Username, p.Password, p.Database
		if config.Database == "" {
			config.Database = p.Username
		}
		config.ConnectTimeout = 12 * time.Second
		config.BuildContextWatcherHandler = func(conn *pgconn.PgConn) ctxwatch.Handler {
			return &pgconn.CancelRequestContextWatcherHandler{Conn: conn, DeadlineDelay: 3 * time.Second}
		}
		if p.TLS {
			config.TLSConfig = tlsConfig
		}
		if p.ForwardPort != 0 {
			config.LookupFunc = func(ctx context.Context, host string) ([]string, error) { return []string{host}, nil }
			config.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
				// pgx sends its authenticated cancellation to the physical socket's
				// RemoteAddr. When tunneled, that is this exact local forward.
				if address == tunnel.local {
					address = tunnel.remote
				}
				return tunnel.DialContext(ctx, network, address)
			}
		}
		return stdlib.GetConnector(*config), nil
	case "sqlserver", "mssql":
		options := url.Values{"database": {p.Database}, "encrypt": {"disable"}, "dial timeout": {"12"}}
		if p.TLS {
			options.Set("encrypt", "true")
			options.Set("hostnameincertificate", p.Host)
			options.Set("trustservercertificate", "false")
			options.Set("tlsmin", "1.2")
		}
		u := url.URL{Scheme: "sqlserver", Host: addr, RawQuery: options.Encode()}
		config, err := msdsn.Parse(u.String())
		if err != nil {
			return nil, errors.New("invalid SQL Server connection configuration")
		}
		config.User, config.Password = p.Username, p.Password
		connector := mssql.NewConnectorConfig(config)
		if p.ForwardPort != 0 {
			connector.Dialer = tunnel
		}
		return connector, nil
	case "oracle":
		if p.Username == "" || p.Password == "" {
			return nil, errors.New("enter an Oracle username and password")
		}
		if p.Database == "" {
			return nil, errors.New("enter the Oracle service name")
		}
		if strings.ContainsAny(p.Database, "()\x00\r\n") {
			return nil, errors.New("enter a service name, not an Oracle connection descriptor")
		}
		options := url.Values{"CONNECT TIMEOUT": {"12"}}
		if p.TLS {
			options.Set("SSL", "true")
			options.Set("SSL VERIFY", "true")
		}
		u := url.URL{Scheme: "oracle", Host: addr, User: url.UserPassword(p.Username, p.Password), Path: "/" + p.Database, RawQuery: options.Encode()}
		connector := ora.NewConnector(u.String()).(*ora.OracleConnector)
		if p.TLS {
			connector.WithTLSConfig(tlsConfig)
			dial := (&net.Dialer{Timeout: 12 * time.Second}).DialContext
			if p.ForwardPort != 0 {
				dial = tunnel.DialContext
			}
			connector.Dialer(oracleTLSDialer{dial: dial})
		} else if p.ForwardPort != 0 {
			connector.Dialer(tunnel)
		}
		return connector, nil
	default:
		return nil, errors.New("unsupported SQL engine")
	}
}

func openSQL(ctx context.Context, p Profile) (Database, error) {
	if p.Port < 1 || p.Port > 65535 || p.ForwardPort < 0 || p.ForwardPort > 65535 || p.Host == "" {
		return nil, errors.New("enter a database hostname and a valid port")
	}
	connector, err := sqlConnector(p)
	if err != nil {
		return nil, err
	}
	db := sql.OpenDB(connector)
	// User-written SQL owns a single persistent connection. Grid edits use
	// their own short transaction, independent of the editor's BEGIN/COMMIT.
	db.SetMaxOpenConns(2)
	conn, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		// URL-based drivers can quote credentials in parse errors. The IPC
		// layer redacts plain passwords; avoid leaking their escaped forms.
		if p.Password != "" {
			message := err.Error()
			for _, secret := range []string{strings.TrimPrefix(url.UserPassword("", p.Password).String(), ":"), url.QueryEscape(p.Password), p.Password} {
				message = strings.ReplaceAll(message, secret, "[redacted]")
			}
			if message != err.Error() {
				return nil, errors.New(message)
			}
		}
		return nil, err
	}
	if p.ReadOnly {
		var statement string
		switch p.Engine {
		case "mysql", "mariadb":
			statement = "SET SESSION TRANSACTION READ ONLY"
		case "postgres", "postgresql":
			statement = "SET default_transaction_read_only TO on"
		}
		if statement != "" {
			if _, err = conn.ExecContext(ctx, statement); err != nil {
				_ = conn.Close()
				_ = db.Close()
				return nil, fmt.Errorf("cannot enable server read-only mode: %w", err)
			}
		}
	}
	session := &sqlSession{engine: p.Engine, db: db, conn: conn}
	if p.Engine == "mysql" || p.Engine == "mariadb" {
		// A thread number alone is ambiguous on clustered endpoints. The
		// connection-scoped marker proves a control socket reached this server.
		key := "vexssh-query-" + rand.Text()
		var locked int
		if err := conn.QueryRowContext(ctx, "SELECT CONNECTION_ID(), GET_LOCK(?,0)", key).Scan(&session.mysqlThreadID, &locked); err == nil && locked == 1 {
			session.mysqlCancelKey = key
		}
	}
	return session, nil
}

// Cancel only the active server query. Hold the protocol dispatcher until
// it finishes so a tardy KILL cannot interrupt the next editor operation.
func (s *sqlSession) cancelMySQL(done <-chan struct{}, fallback context.CancelFunc) {
	select {
	case <-done:
		return
	default:
	}
	ctx, finish := context.WithTimeout(context.Background(), 2*time.Second)
	defer finish()
	control, err := s.db.Conn(ctx)
	if err != nil {
		fallback()
		return
	}
	defer control.Close()
	var owner sql.NullInt64
	if err = control.QueryRowContext(ctx, "SELECT IS_USED_LOCK(?)", s.mysqlCancelKey).Scan(&owner); err != nil || !owner.Valid || owner.Int64 != s.mysqlThreadID {
		fallback()
		return
	}
	for {
		select {
		case <-done:
			return
		default:
		}
		if _, err = control.ExecContext(ctx, "KILL QUERY "+strconv.FormatInt(owner.Int64, 10)); err != nil {
			fallback()
			return
		}
		// A cancel can arrive just before the server starts the query.
		select {
		case <-done:
			return
		case <-ctx.Done():
			fallback()
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (s *sqlSession) Close() error {
	connErr := s.conn.Close()
	return errors.Join(connErr, s.db.Close())
}

func (s *sqlSession) Objects(ctx context.Context) ([]Object, error) {
	var query string
	switch s.engine {
	case "mysql", "mariadb":
		query = `SELECT table_schema, table_name, table_type FROM information_schema.tables
			WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
			AND (DATABASE() IS NULL OR table_schema=DATABASE()) ORDER BY table_schema, table_name LIMIT 2000`
	case "postgres", "postgresql":
		query = `SELECT table_schema, table_name, table_type FROM information_schema.tables
			WHERE table_schema NOT IN ('information_schema','pg_catalog') AND table_schema NOT LIKE 'pg_toast%'
			ORDER BY table_schema, table_name LIMIT 2000`
	case "mssql", "sqlserver":
		query = `SELECT TOP (2000) TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
			ORDER BY TABLE_SCHEMA, TABLE_NAME`
	case "oracle":
		query = `SELECT owner, object_name, object_type FROM
			(SELECT owner, object_name, object_type FROM all_objects WHERE object_type IN ('TABLE','VIEW')
			AND owner=SYS_CONTEXT('USERENV','CURRENT_SCHEMA') ORDER BY owner, object_name) WHERE ROWNUM<=2000`
	}
	rows, err := s.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	objects := make([]Object, 0)
	for rows.Next() {
		var o Object
		if err = rows.Scan(&o.Schema, &o.Name, &o.Kind); err != nil {
			return nil, err
		}
		if strings.Contains(strings.ToUpper(o.Kind), "VIEW") {
			o.Kind = "view"
		} else {
			o.Kind = "table"
		}
		objects = append(objects, o)
	}
	return objects, rows.Err()
}

func sqlIdentifier(engine, name string) string {
	left, right := "\"", "\""
	switch engine {
	case "mysql", "mariadb":
		left, right = "`", "`"
	case "sqlserver", "mssql":
		left, right = "[", "]"
	}
	return left + strings.ReplaceAll(name, right, right+right) + right
}

func (s *sqlSession) Preview(ctx context.Context, o Object) (Grid, error) {
	if o.Name == "" || o.Schema == "" || strings.ContainsRune(o.Name+o.Schema, 0) {
		return Grid{}, errors.New("choose a table or view")
	}
	table := sqlIdentifier(s.engine, o.Schema) + "." + sqlIdentifier(s.engine, o.Name)
	top := strconv.Itoa(rowLimit + 1)
	query := "SELECT * FROM " + table + " LIMIT " + top
	switch s.engine {
	case "sqlserver", "mssql":
		query = "SELECT TOP (" + top + ") * FROM " + table
	case "oracle":
		query = "SELECT * FROM " + table + " WHERE ROWNUM<=" + top
	}
	return s.selectGrid(ctx, query)
}

func (s *sqlSession) Query(ctx context.Context, query string) (Grid, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return Grid{}, errors.New("enter a SQL statement")
	}
	// database/sql has separate APIs for affected counts and returned rows.
	// Use Exec only for unambiguous single statements. A statement with
	// RETURNING/OUTPUT, a CTE or a batch goes through Query exactly once.
	queryBody := strings.TrimSpace(strings.TrimSuffix(query, ";"))
	words := strings.Fields(strings.ToUpper(queryBody))
	if len(words) > 0 && !strings.Contains(queryBody, ";") {
		switch words[0] {
		case "INSERT", "DELETE", "UPDATE", "MERGE", "REPLACE":
			upper := strings.ToUpper(queryBody)
			if !strings.Contains(upper, "RETURNING") && !strings.Contains(upper, "OUTPUT") {
				result, err := s.conn.ExecContext(ctx, query)
				if err != nil {
					return Grid{}, err
				}
				count, err := result.RowsAffected()
				if err == nil && count >= 0 {
					return Grid{Affected: &count}, nil
				}
				return Grid{}, nil
			}
		case "CREATE", "ALTER", "DROP", "TRUNCATE", "BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "SET", "USE", "GRANT", "REVOKE":
			_, err := s.conn.ExecContext(ctx, query)
			return Grid{}, err
		}
	}
	return s.selectGrid(ctx, query)
}

func (s *sqlSession) selectGrid(ctx context.Context, query string, args ...any) (Grid, error) {
	rows, err := s.conn.QueryContext(ctx, query, args...)
	if err != nil {
		return Grid{}, err
	}
	defer rows.Close()
	grid := Grid{}
	for {
		grid.Columns, err = rows.Columns()
		if err != nil {
			return Grid{}, err
		}
		if len(grid.Columns) > 0 {
			break
		}
		if !rows.NextResultSet() {
			return grid, rows.Err()
		}
	}
	types, err := rows.ColumnTypes()
	if err != nil {
		return Grid{}, err
	}
	values := make([]any, len(types))
	targets := make([]any, len(types))
	for i := range values {
		targets[i] = &values[i]
	}
	const maxGridBytes = 1 << 20
	size := 0
	for _, name := range grid.Columns {
		size += len(name) + 4
	}
	for rows.Next() {
		if len(grid.Rows) == rowLimit {
			grid.Truncated = true
			break
		}
		if err = rows.Scan(targets...); err != nil {
			return Grid{}, err
		}
		row := make([]*string, len(values))
		for i, v := range values {
			value, clipped := sqlCell(v, types[i].DatabaseTypeName())
			grid.Truncated = grid.Truncated || clipped
			row[i] = value
			size += 5
			if value != nil {
				size += len(*value)
			}
		}
		if size > maxGridBytes {
			grid.Truncated = true
			break
		}
		grid.Rows = append(grid.Rows, row)
	}
	return grid, rows.Err()
}

func sqlCell(v any, typeName string) (*string, bool) {
	if v == nil {
		return nil, false
	}
	var value string
	switch raw := v.(type) {
	case time.Time:
		value = raw.Format(time.RFC3339Nano)
	case []byte:
		switch strings.ToUpper(typeName) {
		case "BLOB", "BINARY", "VARBINARY", "BYTEA", "RAW", "LONG RAW", "IMAGE", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB", "GEOMETRY":
			n := min(len(raw), (cellLimit-2)/2)
			value = "0x" + hex.EncodeToString(raw[:n])
			return &value, n < len(raw)
		}
		if len(raw) > cellLimit {
			value = string(raw[:cellLimit])
			text, _ := clipSQLText(value)
			return text, true
		}
		value = string(raw)
	case string:
		value = raw
	default:
		value = fmt.Sprint(raw)
	}
	return clipSQLText(value)
}

func clipSQLText(text string) (*string, bool) {
	clipped := len(text) > cellLimit
	if clipped {
		text = text[:cellLimit]
	}
	// Decoded database text should be UTF-8. Handle misconfigured encodings
	// and a multibyte character split by the display limit without invalid JSON.
	text = strings.ToValidUTF8(text, "\uFFFD")
	if len(text) > cellLimit {
		end := cellLimit
		for !utf8.RuneStart(text[end]) {
			end--
		}
		text = text[:end]
		clipped = true
	}
	return &text, clipped
}
