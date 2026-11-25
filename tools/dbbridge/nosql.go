package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
)

func openNoSQL(ctx context.Context, c Profile) (Database, error) {
	switch c.Engine {
	case "mongodb":
		return openMongo(ctx, c)
	case "redis":
		return openRedis(ctx, c)
	default:
		return nil, fmt.Errorf("unsupported engine %q", c.Engine)
	}
}

type mongoDB struct {
	client *mongo.Client
	db     *mongo.Database
}

type forwardedMongoDialer struct{ address string }

func (d forwardedMongoDialer) DialContext(ctx context.Context, network, _ string) (net.Conn, error) {
	dialer := net.Dialer{Timeout: 10 * time.Second}
	return dialer.DialContext(ctx, network, d.address)
}

func openMongo(ctx context.Context, c Profile) (Database, error) {
	opts := options.Client()
	if c.MongoSRV {
		if c.ForwardPort != 0 {
			return nil, errors.New("use an explicit MongoDB member hostname and port through SSH")
		}
		if !validMongoSeed(c.Host) {
			return nil, errors.New("enter the MongoDB DNS seed hostname without a URI, credentials or port")
		}
		opts.ApplyURI("mongodb+srv://" + c.Host)
	} else {
		opts.SetHosts([]string{net.JoinHostPort(c.Host, strconv.Itoa(c.Port))})
	}
	opts.SetAppName("NEXSSH").
		SetConnectTimeout(10 * time.Second).SetServerSelectionTimeout(12 * time.Second).
		SetMaxPoolSize(4).SetRetryWrites(false)
	if c.ForwardPort > 0 {
		opts.SetDialer(forwardedMongoDialer{net.JoinHostPort("127.0.0.1", strconv.Itoa(c.ForwardPort))})
		opts.SetDirect(true)
	}
	if c.TLS || c.MongoSRV {
		// The driver uses each logical MongoDB hostname as the TLS name, even
		// when our dialer carries its TCP traffic through a loopback tunnel.
		opts.SetTLSConfig(&tls.Config{MinVersion: tls.VersionTLS12})
	}
	name := c.Database
	if name == "" {
		name = "admin"
	}
	if c.Username != "" || c.Password != "" {
		source := c.AuthSource
		if source == "" {
			source = name
		}
		opts.SetAuth(options.Credential{AuthSource: source, Username: c.Username, Password: c.Password})
	}
	client, err := mongo.Connect(opts)
	if err != nil {
		return nil, err
	}
	conn := &mongoDB{client: client, db: client.Database(name)}
	if err := client.Ping(ctx, readpref.Nearest()); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

func validMongoSeed(host string) bool {
	if len(host) > 253 || net.ParseIP(host) != nil || !strings.Contains(host, ".") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
				return false
			}
		}
	}
	return true
}

func (m *mongoDB) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return m.client.Disconnect(ctx)
}

func (m *mongoDB) Objects(ctx context.Context) ([]Object, error) {
	// nameOnly and authorizedCollections also work for users granted access
	// to specific collections instead of the entire database.
	cursor, err := m.db.ListCollections(ctx, bson.D{}, options.ListCollections().
		SetNameOnly(true).SetAuthorizedCollections(true))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	objects := []Object{}
	for cursor.Next(ctx) {
		var item struct{ Name, Type string }
		if err := cursor.Decode(&item); err != nil {
			return nil, err
		}
		objects = append(objects, Object{Schema: m.db.Name(), Name: item.Name, Kind: item.Type})
	}
	sort.Slice(objects, func(i, j int) bool { return objects[i].Name < objects[j].Name })
	return objects, cursor.Err()
}

func (m *mongoDB) Preview(ctx context.Context, o Object) (Grid, error) {
	if o.Schema != "" && o.Schema != m.db.Name() {
		return Grid{}, errors.New("select a collection in this database")
	}
	if o.Name == "" {
		return Grid{}, errors.New("select a collection")
	}
	cursor, err := m.db.Collection(o.Name).Find(ctx, bson.D{}, options.Find().SetLimit(rowLimit+1).SetBatchSize(32))
	if err != nil {
		return Grid{}, err
	}
	return mongoGrid(ctx, cursor)
}

func (m *mongoDB) Query(ctx context.Context, query string) (Grid, error) {
	var command bson.D
	if !json.Valid([]byte(query)) || bson.UnmarshalExtJSON([]byte(query), false, &command) != nil || len(command) == 0 {
		return Grid{}, errors.New("enter a MongoDB command as a JSON object, for example {\"ping\":1}")
	}
	switch command[0].Key {
	case "find", "aggregate", "listCollections", "listIndexes":
		cursor, err := m.db.RunCommandCursor(ctx, command)
		if err != nil {
			return Grid{}, err
		}
		return mongoGrid(ctx, cursor)
	default:
		raw, err := m.db.RunCommand(ctx, command).Raw()
		if err != nil {
			return Grid{}, err
		}
		grid := newNoSQLGrid("Result")
		err = addMongoDocument(&grid, raw)
		return grid.Grid, err
	}
}

func mongoGrid(ctx context.Context, cursor *mongo.Cursor) (Grid, error) {
	defer cursor.Close(ctx)
	grid := newNoSQLGrid("Document")
	for cursor.Next(ctx) {
		if grid.full() {
			grid.Truncated = true
			break
		}
		if err := addMongoDocument(&grid, cursor.Current); err != nil {
			return Grid{}, err
		}
	}
	return grid.Grid, cursor.Err()
}

func addMongoDocument(grid *noSQLGrid, raw bson.Raw) error {
	doc, err := bson.MarshalExtJSON(raw, false, false)
	if err != nil {
		return err
	}
	grid.add(grid.cell(string(doc)))
	return nil
}

// Redis is binary safe. Use a reversible representation for binary cells and
// keys and never split a UTF-8 code point while limiting output to the UI.
func noSQLText(value string) string {
	if !utf8.ValidString(value) {
		return "base64:" + base64.StdEncoding.EncodeToString([]byte(value))
	}
	return value
}

type noSQLGrid struct {
	Grid
	bytes    int
	overflow bool
}

const noSQLResultBytes = 1 << 20

func newNoSQLGrid(columns ...string) noSQLGrid {
	return noSQLGrid{Grid: Grid{Columns: columns, Rows: [][]*string{}}}
}

func (grid *noSQLGrid) full() bool {
	return grid.overflow || len(grid.Rows) >= rowLimit
}

func (grid *noSQLGrid) add(cells ...*string) {
	encoded, _ := json.Marshal(cells)
	if grid.bytes+len(encoded)+1 > noSQLResultBytes {
		grid.overflow = true
		grid.Truncated = true
		return
	}
	grid.bytes += len(encoded) + 1
	grid.Rows = append(grid.Rows, cells)
}

func (grid *noSQLGrid) cell(value string) *string {
	value = noSQLText(value)
	if len(value) > cellLimit {
		end := cellLimit
		for end > 0 && !utf8.RuneStart(value[end]) {
			end--
		}
		value = strings.Clone(value[:end])
		grid.Truncated = true
	}
	return &value
}

type redisDB struct {
	client *redis.Client
	conn   *redis.Conn
}

func openRedis(ctx context.Context, c Profile) (Database, error) {
	index := 0
	if c.Database != "" {
		n, err := strconv.Atoi(c.Database)
		if err != nil || n < 0 {
			return nil, errors.New("Redis database index must be a non-negative integer")
		}
		index = n
	}
	address := net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	if c.ForwardPort > 0 {
		address = net.JoinHostPort("127.0.0.1", strconv.Itoa(c.ForwardPort))
	}
	opts := &redis.Options{
		Addr: address, DB: index, Username: c.Username, Password: c.Password,
		Protocol: 2, DialTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second,
		WriteTimeout: 10 * time.Second, ContextTimeoutEnabled: true, MaxRetries: -1,
		DisableIdentity: true, PoolSize: 1,
	}
	if c.TLS {
		opts.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: c.Host}
	}
	client := redis.NewClient(opts)
	r := &redisDB{client: client, conn: client.Conn()}
	if err := r.conn.Ping(ctx).Err(); err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}

func (r *redisDB) Close() error {
	connErr := r.conn.Close()
	clientErr := r.client.Close()
	if connErr != nil {
		return connErr
	}
	return clientErr
}

func (r *redisDB) Objects(ctx context.Context) ([]Object, error) {
	objects := []Object{}
	seen := map[string]bool{}
	var cursor uint64
	for {
		names, next, err := r.conn.Scan(ctx, cursor, "", rowLimit).Result()
		if err != nil {
			return nil, err
		}
		for _, key := range names {
			if seen[key] {
				continue
			}
			seen[key] = true
			kind := "key"
			if !utf8.ValidString(key) {
				kind = "binary key"
			}
			objects = append(objects, Object{Name: noSQLText(key), Kind: kind})
			if len(objects) == rowLimit {
				break
			}
		}
		if len(objects) == rowLimit || next == 0 {
			break
		}
		cursor = next
	}
	sort.Slice(objects, func(i, j int) bool { return objects[i].Name < objects[j].Name })
	return objects, nil
}

func (r *redisDB) Preview(ctx context.Context, o Object) (Grid, error) {
	key := o.Name
	if o.Kind == "binary key" {
		bytes, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(key, "base64:"))
		if err != nil {
			return Grid{}, errors.New("invalid encoded Redis key")
		}
		key = string(bytes)
	}
	kind, err := r.conn.Type(ctx, key).Result()
	if err != nil {
		return Grid{}, err
	}
	switch kind {
	case "none":
		return Grid{}, errors.New("this Redis key has expired or was removed")
	case "string":
		return r.run(ctx, "GETRANGE", key, 0, cellLimit)
	case "list":
		return r.run(ctx, "LRANGE", key, 0, rowLimit)
	case "zset":
		items, err := r.conn.ZRangeWithScores(ctx, key, 0, rowLimit).Result()
		if err != nil {
			return Grid{}, err
		}
		grid := newNoSQLGrid("Member", "Score")
		for _, z := range items {
			if grid.full() {
				grid.Truncated = true
				break
			}
			grid.add(grid.cell(fmt.Sprint(z.Member)), grid.cell(strconv.FormatFloat(z.Score, 'g', -1, 64)))
		}
		return grid.Grid, nil
	case "hash", "set":
		return r.scanValues(ctx, key, kind)
	case "stream":
		return r.run(ctx, "XRANGE", key, "-", "+", "COUNT", rowLimit+1)
	default:
		return Grid{}, fmt.Errorf("preview is unavailable for Redis type %q; use the command editor", kind)
	}
}

func (r *redisDB) scanValues(ctx context.Context, key, kind string) (Grid, error) {
	grid := newNoSQLGrid("Member")
	stride := 1
	if kind == "hash" {
		grid.Columns = []string{"Field", "Value"}
		stride = 2
	}
	var cursor uint64
	for {
		var page *redis.ScanCmd
		if kind == "hash" {
			page = r.conn.HScan(ctx, key, cursor, "", rowLimit)
		} else {
			page = r.conn.SScan(ctx, key, cursor, "", rowLimit)
		}
		values, next, err := page.Result()
		if err != nil {
			return Grid{}, err
		}
		for i := 0; i+stride <= len(values); i += stride {
			if grid.full() {
				grid.Truncated = true
				return grid.Grid, nil
			}
			row := []*string{grid.cell(values[i])}
			if stride == 2 {
				row = append(row, grid.cell(values[i+1]))
			}
			grid.add(row...)
		}
		if next == 0 {
			return grid.Grid, nil
		}
		cursor = next
	}
}

func (r *redisDB) Query(ctx context.Context, query string) (Grid, error) {
	var args []any
	if err := json.Unmarshal([]byte(query), &args); err != nil || len(args) == 0 {
		return Grid{}, errors.New("enter a Redis command as a JSON array of strings, for example [\"GET\",\"key\"]")
	}
	for i, arg := range args {
		value, ok := arg.(string)
		if !ok || (i == 0 && strings.TrimSpace(value) == "") {
			return Grid{}, errors.New("each Redis command argument must be a string and the command name must not be empty")
		}
	}
	return r.run(ctx, args...)
}

func (r *redisDB) run(ctx context.Context, args ...any) (Grid, error) {
	cmd := redis.NewCmd(ctx, args...)
	err := r.conn.Process(ctx, cmd)
	if err != nil && !errors.Is(err, redis.Nil) {
		return Grid{}, err
	}
	grid := newNoSQLGrid("Result")
	values, array := cmd.Val().([]any)
	if !array {
		values = []any{cmd.Val()}
	}
	for _, v := range values {
		if grid.full() {
			grid.Truncated = true
			break
		}
		var cell *string
		switch value := v.(type) {
		case nil:
		case string:
			cell = grid.cell(value)
		default:
			encoded, err := json.Marshal(value)
			if err != nil {
				return Grid{}, fmt.Errorf("could not display Redis response: %w", err)
			}
			cell = grid.cell(string(encoded))
		}
		grid.add(cell)
	}
	return grid.Grid, nil
}
