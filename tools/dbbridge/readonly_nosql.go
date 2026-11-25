package main

import (
	"encoding/json"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Unrecognised commands remain unavailable in a read-only connection. Parse
// Mongo using the same ordered document representation that Query sends.
func readOnlyNoSQL(engine, query string) bool {
	switch engine {
	case "redis":
		var args []string
		if json.Unmarshal([]byte(query), &args) != nil || len(args) == 0 {
			return false
		}
		switch strings.ToUpper(args[0]) {
		case "PING", "ECHO", "GET", "MGET", "STRLEN", "GETRANGE", "EXISTS", "TYPE", "TTL", "PTTL",
			"SCAN", "HSCAN", "SSCAN", "ZSCAN", "HGET", "HMGET", "HGETALL", "HLEN", "HEXISTS",
			"HKEYS", "HVALS", "LRANGE", "LLEN", "LINDEX", "SMEMBERS", "SISMEMBER", "SCARD",
			"ZRANGE", "ZREVRANGE", "ZSCORE", "ZCARD", "ZRANK", "DBSIZE", "INFO", "TIME", "XRANGE", "XLEN":
			return true
		}
	case "mongodb":
		var doc bson.D
		if !json.Valid([]byte(query)) || bson.UnmarshalExtJSON([]byte(query), false, &doc) != nil || len(doc) == 0 {
			return false
		}
		switch doc[0].Key {
		case "ping", "hello", "buildInfo", "find", "count", "distinct", "listCollections", "listIndexes", "dbStats", "collStats":
			return mongoReadExpression(doc)
		case "aggregate":
			// Only a single pipeline with known read-only stages is eligible.
			found := false
			for _, field := range doc {
				if field.Key != "pipeline" {
					continue
				}
				stages, ok := field.Value.(bson.A)
				if found || !ok {
					return false
				}
				found = true
				for _, value := range stages {
					stage, ok := value.(bson.D)
					if !ok || len(stage) != 1 {
						return false
					}
					switch stage[0].Key {
					case "$match", "$group", "$project", "$sort", "$skip", "$limit", "$count", "$unwind", "$addFields", "$set", "$unset", "$sortByCount", "$replaceRoot", "$replaceWith":
					default:
						return false
					}
				}
			}
			return found && mongoReadExpression(doc)
		}
	}
	return false
}

func mongoReadExpression(v any) bool {
	switch value := v.(type) {
	case bson.D:
		for _, field := range value {
			switch field.Key {
			case "$function", "$where", "$accumulator", "$out", "$merge":
				return false
			}
			if !mongoReadExpression(field.Value) {
				return false
			}
		}
	case bson.A:
		for _, item := range value {
			if !mongoReadExpression(item) {
				return false
			}
		}
	}
	return true
}
