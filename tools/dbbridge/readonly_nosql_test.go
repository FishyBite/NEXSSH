package main

import "testing"

func TestReadOnlyNoSQLCommands(t *testing.T) {
	for _, tc := range []struct {
		engine, query string
		allow         bool
	}{
		{"redis", `["gEt","report"]`, true}, {"redis", `["SET","report","42"]`, false},
		{"redis", `["SORT","report","STORE","archive"]`, false}, {"redis", `["EVAL","return 1","0"]`, false},
		{"mongodb", `{"find":"orders","filter":{"id":3}}`, true},
		{"mongodb", `{"aggregate":"orders","pipeline":[{"$match":{"id":3}},{"$count":"total"}],"cursor":{}}`, true},
		{"mongodb", `{"aggregate":"orders","pipeline":[{"$out":"archive"}],"cursor":{}}`, false},
		{"mongodb", `{"aggregate":"orders","pipeline":[],"pipeline":[{"$merge":"archive"}]}`, false},
		{"mongodb", `{"delete":"orders"}`, false}, {"mongodb", `{"find":"orders","filter":{"$where":"x"}}`, false},
	} {
		if readOnlyNoSQL(tc.engine, tc.query) != tc.allow {
			t.Errorf("%s: %s", tc.engine, tc.query)
		}
	}
}
