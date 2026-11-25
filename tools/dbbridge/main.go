// NEXSSH starts one driver process per connection. Requests and responses use
// private stdio pipes; neither credentials nor query text are command-line arguments.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

const rowLimit = 200
const cellLimit = 8192

type Profile struct {
	Engine, Host, Username, Password, Database, AuthSource string
	Port, ForwardPort                                      int
	TLS, MongoSRV, ReadOnly                                bool
}

type Object struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
}

type Grid struct {
	Columns   []string    `json:"columns"`
	Rows      [][]*string `json:"rows"`
	Affected  *int64      `json:"affected,omitempty"`
	Truncated bool        `json:"truncated"`
}

type Database interface {
	Objects(context.Context) ([]Object, error)
	Preview(context.Context, Object) (Grid, error)
	Query(context.Context, string) (Grid, error)
	Close() error
}

type request struct {
	Action    string
	Profile   Profile
	Object    Object
	Query     string
	RequestID string
	PageOptions
	Column             string
	Key                map[string]string
	OldValue, NewValue *string
	Scope, Path        string
}

type reply struct {
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

func serve(input io.Reader, output io.Writer) {
	lines := bufio.NewScanner(input)
	lines.Buffer(make([]byte, 4096), 2<<20)
	writer := json.NewEncoder(output)
	var db Database
	var secret, engine string
	var readOnly bool
	var running chan struct{}
	var currentID string
	var currentCancel context.CancelFunc
	defer func() {
		if running != nil {
			<-running
		}
		if db != nil {
			_ = db.Close()
		}
	}()
	for lines.Scan() {
		var req request
		if json.Unmarshal(lines.Bytes(), &req) != nil {
			return
		}
		if req.Action == "cancel" {
			if req.RequestID != "" && currentID == req.RequestID && currentCancel != nil {
				currentCancel()
			}
			continue // a cancellation message has no independent response
		}
		if running != nil {
			<-running
		}
		timeout := 30 * time.Second
		if req.Action == "connect" {
			timeout = 15 * time.Second
		} else if req.Action == "export" {
			timeout = 5 * time.Minute
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		currentID, currentCancel = req.RequestID, cancel
		running = make(chan struct{})
		var stopRequested atomic.Bool
		if req.Action == "query" && req.RequestID != "" {
			active := running
			sqlDB, _ := db.(*sqlSession)
			currentCancel = func() {
				if stopRequested.Swap(true) {
					return
				}
				if sqlDB != nil && sqlDB.mysqlCancelKey != "" {
					sqlDB.cancelMySQL(active, cancel)
				} else {
					cancel()
				}
			}
		}
		go func(req request, done chan struct{}) {
			defer close(done)
			defer cancel()
			var data any
			var err error
			switch {
			case req.Action == "connect" && db == nil:
				secret = req.Profile.Password
				engine, readOnly = req.Profile.Engine, req.Profile.ReadOnly
				switch req.Profile.Engine {
				case "mongodb", "redis":
					db, err = openNoSQL(ctx, req.Profile)
				case "mysql", "mariadb", "postgresql", "oracle", "sqlserver":
					db, err = openSQL(ctx, req.Profile)
				default:
					err = errors.New("unknown database engine")
				}
			case db == nil:
				err = errors.New("database is disconnected")
			case req.Action == "update" || req.Action == "page" || req.Action == "export":
				sqlDB, ok := db.(*sqlSession)
				if !ok {
					err = errors.New("table browsing is available for relational databases")
					break
				}
				switch req.Action {
				case "page":
					data, err = sqlDB.page(ctx, req.Object, req.PageOptions)
				case "update":
					if readOnly {
						err = errors.New("this connection is read-only")
						break
					}
					data, err = sqlDB.updateCell(ctx, req)
				case "export":
					data, err = sqlDB.export(ctx, req)
				}
			case req.Action == "objects":
				var objects []Object
				objects, err = db.Objects(ctx)
				if objects == nil {
					objects = []Object{}
				}
				data = objects
			case req.Action == "preview" || req.Action == "query":
				var g Grid
				if req.Action == "preview" {
					g, err = db.Preview(ctx, req.Object)
				} else if readOnly && (engine == "redis" || engine == "mongodb") && !readOnlyNoSQL(engine, req.Query) {
					err = errors.New("this command is unavailable on a read-only connection")
				} else if readOnly && engine != "redis" && engine != "mongodb" {
					g, err = db.(*sqlSession).readOnlyQuery(ctx, req.Query)
				} else {
					g, err = db.Query(ctx, req.Query)
				}
				if g.Columns == nil {
					g.Columns = []string{}
				}
				if g.Rows == nil {
					g.Rows = [][]*string{}
				}
				data = g
			default:
				err = errors.New("unknown database operation")
			}
			if req.Action == "query" && err == nil && stopRequested.Load() {
				err = errors.New("cancellation was requested as the query finished; check its outcome before retrying")
			}
			response := reply{Data: data}
			if err != nil {
				msg := err.Error()
				if secret != "" {
					msg = strings.ReplaceAll(msg, secret, "[redacted]")
				}
				response = reply{Error: msg}
			}
			if writer.Encode(response) != nil {
				return
			}
		}(req, running)
	}
}

func main() { serve(os.Stdin, os.Stdout) }
