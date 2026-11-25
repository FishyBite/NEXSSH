package main

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Column struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	PrimaryKey bool   `json:"primaryKey"`
	Editable   bool   `json:"editable"`
}
type PageOptions struct {
	Offset, Limit                                        int
	FilterColumn, FilterValue, SortColumn, SortDirection string
}
type TablePage struct {
	Grid
	Metadata     []Column `json:"metadata"`
	HasMore      bool     `json:"hasMore"`
	EditableRows []bool   `json:"editableRows"`
}
type sqlReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func bindParameter(engine string, n int) string {
	switch engine {
	case "postgresql", "postgres":
		return "$" + strconv.Itoa(n)
	case "sqlserver", "mssql":
		return "@p" + strconv.Itoa(n)
	case "oracle":
		return ":" + strconv.Itoa(n)
	default:
		return "?"
	}
}
func scalarType(t string) bool {
	switch strings.ToLower(t) {
	case "varchar", "character varying", "nvarchar", "varchar2", "nvarchar2", "text", "tinytext", "mediumtext", "longtext", "char", "character", "nchar", "int", "integer", "smallint", "bigint", "tinyint", "mediumint", "number", "numeric", "decimal", "uuid", "uniqueidentifier", "boolean", "bool":
		return true
	}
	return false
}
func (s *sqlSession) tableColumns(ctx context.Context, r sqlReader, o Object) ([]Column, error) {
	if o.Schema == "" || o.Name == "" || strings.ContainsRune(o.Name+o.Schema, 0) {
		return nil, errors.New("choose a table or view")
	}
	var q string
	switch s.engine {
	case "mysql", "mariadb":
		q = `SELECT c.column_name,c.data_type,
 IF(EXISTS(SELECT 1 FROM information_schema.key_column_usage k WHERE k.table_schema=c.table_schema AND k.table_name=c.table_name AND k.column_name=c.column_name AND k.constraint_name='PRIMARY'),1,0),
 IF(t.table_type='BASE TABLE' AND t.engine IN ('InnoDB','XtraDB') AND COALESCE(c.generation_expression,'')='',1,0)
 FROM information_schema.columns c JOIN information_schema.tables t ON c.table_schema=t.table_schema AND c.table_name=t.table_name
 WHERE c.table_schema=? AND c.table_name=? ORDER BY c.ordinal_position`
	case "postgresql", "postgres":
		q = `SELECT a.attname,format_type(a.atttypid,NULL),
 CASE WHEN EXISTS(SELECT 1 FROM pg_index i JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(att,num) ON k.num<=i.indnkeyatts WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=k.att) THEN 1 ELSE 0 END,
 CASE WHEN c.relkind IN ('r','p') AND a.attgenerated='' AND a.attidentity='' THEN 1 ELSE 0 END
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`
	case "sqlserver", "mssql":
		q = `SELECT c.name,TYPE_NAME(c.system_type_id),
 CASE WHEN EXISTS(SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id WHERE i.is_primary_key=1 AND ic.key_ordinal>0 AND ic.object_id=c.object_id AND ic.column_id=c.column_id) THEN 1 ELSE 0 END,
 CASE WHEN t.type='U' AND c.is_computed=0 AND c.is_identity=0 AND c.generated_always_type=0 THEN 1 ELSE 0 END
 FROM sys.columns c JOIN sys.objects t ON t.object_id=c.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=@p1 AND t.name=@p2 AND c.is_hidden=0 ORDER BY c.column_id`
	case "oracle":
		q = `SELECT c.column_name,c.data_type,CASE WHEN EXISTS(SELECT 1 FROM all_constraints k JOIN all_cons_columns a ON k.owner=a.owner AND k.constraint_name=a.constraint_name WHERE k.constraint_type='P' AND k.table_name=c.table_name AND k.owner=c.owner AND a.column_name=c.column_name) THEN 1 ELSE 0 END,
 CASE WHEN c.virtual_column='NO' AND c.identity_column='NO' AND EXISTS(SELECT 1 FROM all_tables t WHERE t.owner=c.owner AND t.table_name=c.table_name) THEN 1 ELSE 0 END
 FROM all_tab_cols c WHERE c.owner=:1 AND c.table_name=:2 AND c.hidden_column='NO' ORDER BY c.column_id`
	}
	rows, err := r.QueryContext(ctx, q, o.Schema, o.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := []Column{}
	for rows.Next() {
		var c Column
		var pk, editable int
		if err := rows.Scan(&c.Name, &c.Type, &pk, &editable); err != nil {
			return nil, err
		}
		c.PrimaryKey = pk != 0
		c.Editable = editable != 0 && !c.PrimaryKey && scalarType(c.Type)
		cols = append(cols, c)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(cols) == 0 {
		return nil, errors.New("table or view no longer exists or is inaccessible")
	}
	return cols, nil
}
func (s *sqlSession) tableName(o Object) string {
	return sqlIdentifier(s.engine, o.Schema) + "." + sqlIdentifier(s.engine, o.Name)
}
func (s *sqlSession) tableSelect(o Object, meta []Column, p PageOptions, all bool, extra int) (string, []any, error) {
	if p.Offset < 0 || p.Limit < 1 || p.Limit > rowLimit || len(p.FilterValue) > 16384 {
		return "", nil, errors.New("invalid page size, offset or filter")
	}
	if p.SortDirection != "" && p.SortDirection != "asc" && p.SortDirection != "desc" {
		return "", nil, errors.New("invalid sort direction")
	}
	known := map[string]bool{}
	cols := []string{}
	order := []string{}
	for _, c := range meta {
		known[c.Name] = true
		cols = append(cols, sqlIdentifier(s.engine, c.Name))
	}
	query := "SELECT " + strings.Join(cols, ",") + " FROM " + s.tableName(o)
	args := []any{}
	if p.FilterValue != "" {
		if !known[p.FilterColumn] {
			return "", nil, errors.New("unknown filter column")
		}
		name := sqlIdentifier(s.engine, p.FilterColumn)
		arg := bindParameter(s.engine, 1)
		args = append(args, p.FilterValue)
		switch s.engine {
		case "mysql", "mariadb":
			query += " WHERE LOCATE(" + arg + ",CAST(" + name + " AS CHAR))>0"
		case "postgres", "postgresql":
			query += " WHERE STRPOS(CAST(" + name + " AS text)," + arg + ")>0"
		case "sqlserver", "mssql":
			query += " WHERE CHARINDEX(" + arg + ",CONVERT(nvarchar(max)," + name + "))>0"
		case "oracle":
			query += " WHERE INSTR(TO_CHAR(" + name + ")," + arg + ")>0"
		}
	}
	if p.SortColumn != "" {
		if !known[p.SortColumn] {
			return "", nil, errors.New("unknown sort column")
		}
		dir := " ASC"
		if p.SortDirection == "desc" {
			dir = " DESC"
		}
		order = append(order, sqlIdentifier(s.engine, p.SortColumn)+dir)
	}
	for _, c := range meta {
		if c.PrimaryKey && c.Name != p.SortColumn {
			order = append(order, sqlIdentifier(s.engine, c.Name))
		}
	}
	if len(order) == 0 {
		for _, c := range meta {
			if scalarType(c.Type) {
				order = append(order, sqlIdentifier(s.engine, c.Name))
				break
			}
		}
	}
	if len(order) > 0 {
		query += " ORDER BY " + strings.Join(order, ",")
	} else if (s.engine == "sqlserver" || s.engine == "mssql") && !all {
		query += " ORDER BY (SELECT NULL)"
	}
	if !all {
		switch s.engine {
		case "oracle", "sqlserver", "mssql":
			query += fmt.Sprintf(" OFFSET %d ROWS FETCH NEXT %d ROWS ONLY", p.Offset, p.Limit+extra)
		default:
			query += fmt.Sprintf(" LIMIT %d OFFSET %d", p.Limit+extra, p.Offset)
		}
	}
	return query, args, nil
}
func (s *sqlSession) page(ctx context.Context, o Object, p PageOptions) (TablePage, error) {
	meta, err := s.tableColumns(ctx, s.conn, o)
	if err != nil {
		return TablePage{}, err
	}
	q, args, err := s.tableSelect(o, meta, p, false, 1)
	if err != nil {
		return TablePage{}, err
	}
	rows, err := s.conn.QueryContext(ctx, q, args...)
	if err != nil {
		return TablePage{}, err
	}
	defer rows.Close()
	page := TablePage{Metadata: meta, EditableRows: []bool{}, Grid: Grid{Columns: []string{}, Rows: [][]*string{}}}
	pk := false
	usablePK := true
	for _, c := range meta {
		page.Columns = append(page.Columns, c.Name)
		if c.PrimaryKey {
			pk = true
			usablePK = usablePK && scalarType(c.Type)
		}
	}
	size := 0
	for rows.Next() {
		if len(page.Rows) == p.Limit {
			page.HasMore = true
			break
		}
		v, err := readRow(rows, len(meta))
		if err != nil {
			return TablePage{}, err
		}
		cells := make([]*string, len(v))
		editable := pk && usablePK
		for i, cell := range v {
			str, clip := sqlCell(cell, meta[i].Type)
			cells[i] = str
			size += 5
			if str != nil {
				size += len(*str)
			}
			if clip {
				page.Truncated = true
				editable = false
			}
			if meta[i].PrimaryKey && str == nil {
				editable = false
			}
		}
		if size > 1<<20 {
			if len(page.Rows) == 0 {
				return TablePage{}, errors.New("row too large to preview; select fewer columns in the SQL editor")
			}
			page.HasMore = true
			break
		}
		page.Rows = append(page.Rows, cells)
		page.EditableRows = append(page.EditableRows, editable)
	}
	return page, rows.Err()
}
func readRow(rows *sql.Rows, n int) ([]any, error) {
	values := make([]any, n)
	scan := make([]any, n)
	for i := range values {
		scan[i] = &values[i]
	}
	return values, rows.Scan(scan...)
}
func csvCell(v any, t string) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case []byte:
		switch strings.ToUpper(t) {
		case "BLOB", "BINARY", "VARBINARY", "BYTEA", "RAW", "LONG RAW", "IMAGE", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB", "GEOMETRY":
			return "0x" + hex.EncodeToString(x)
		}
		return string(x)
	case time.Time:
		return x.Format(time.RFC3339Nano)
	default:
		return fmt.Sprint(x)
	}
}
func (s *sqlSession) export(ctx context.Context, r request) (map[string]int, error) {
	if r.Scope != "all" && r.Scope != "page" {
		return nil, errors.New("choose a CSV export scope")
	}
	meta, err := s.tableColumns(ctx, s.conn, r.Object)
	if err != nil {
		return nil, err
	}
	q, args, err := s.tableSelect(r.Object, meta, r.PageOptions, r.Scope == "all", 0)
	if err != nil {
		return nil, err
	}
	rows, err := s.conn.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	f, err := os.OpenFile(r.Path, os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	w := csv.NewWriter(f)
	header := make([]string, len(meta))
	for i, c := range meta {
		header[i] = c.Name
	}
	if err = w.Write(header); err != nil {
		return nil, err
	}
	n := 0
	for rows.Next() {
		v, e := readRow(rows, len(meta))
		if e != nil {
			return nil, e
		}
		record := make([]string, len(meta))
		for i, cell := range v {
			record[i] = csvCell(cell, meta[i].Type)
		}
		if e = w.Write(record); e != nil {
			return nil, e
		}
		n++
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	w.Flush()
	if err = w.Error(); err != nil {
		return nil, err
	}
	if err = f.Sync(); err != nil {
		return nil, err
	}
	return map[string]int{"rows": n}, nil
}

const roIdent = "[a-z_][a-z_0-9]*"

var safeSelect = regexp.MustCompile("(?is)^select\\s+(\\*|count\\(\\*\\)|" + roIdent + "(?:\\s*,\\s*" + roIdent + ")*)\\s+from\\s+(" + roIdent + ")" + "(?:\\.(" + roIdent + "))?(.*)$")
var readPredicate = regexp.MustCompile("(?is)^(" + roIdent + ")\\s*(<=|>=|<>|!=|=|<|>|\\blike\\b)\\s*('(?:[^']|'')*'|[-+]?[0-9]+(?:\\.[0-9]+)?|true\\b|false\\b)")
var nullPredicate = regexp.MustCompile("(?i)^(" + roIdent + ")\\s+is\\s+(not\\s+)?null\\b")
var orderTerm = regexp.MustCompile("(?i)^(" + roIdent + ")\\b(?:\\s+(asc|desc)\\b)?")
var limitTerm = regexp.MustCompile("(?i)^limit\\s+([0-9]{1,9})$")
var whereTerm = regexp.MustCompile("(?i)^where\\s+")
var andTerm = regexp.MustCompile("(?i)^and\\s+")
var orderBy = regexp.MustCompile("(?i)^order\\s+by\\s+")
var readError = errors.New("read-only SQL supports SELECT columns, * or COUNT(*) FROM a table, optional WHERE comparisons joined by AND, ORDER BY and LIMIT; use a writable profile for other statements")

func (s *sqlSession) readOnlyQuery(ctx context.Context, query string) (Grid, error) {
	q, args, e := s.compileRead(query)
	if e != nil {
		return Grid{}, e
	}
	return s.selectGrid(ctx, q, args...)
}

// Build a single read statement from its parsed identifiers, operators and bound
// literal values. Never pass free-form SQL to engines without read-only transactions.
func (s *sqlSession) compileRead(query string) (string, []any, error) {
	q := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(query), ";"))
	if strings.EqualFold(q, "SELECT 1") || strings.EqualFold(q, "SELECT 1 FROM dual") {
		if s.engine == "oracle" {
			return "SELECT 1 FROM dual", nil, nil
		}
		return "SELECT 1", nil, nil
	}
	m := safeSelect.FindStringSubmatch(q)
	if m == nil {
		return "", nil, readError
	}
	quote := func(word string) string {
		word = strings.TrimSpace(word)
		if s.engine == "oracle" {
			word = strings.ToUpper(word)
		} else if s.engine == "postgresql" || s.engine == "postgres" {
			word = strings.ToLower(word)
		}
		return sqlIdentifier(s.engine, word)
	}
	cols := m[1]
	if cols != "*" && !strings.EqualFold(cols, "COUNT(*)") {
		parts := strings.Split(cols, ",")
		for i, v := range parts {
			parts[i] = quote(v)
		}
		cols = strings.Join(parts, ",")
	}
	name := quote(m[2])
	if m[3] != "" {
		name += "." + quote(m[3])
	}
	tail := strings.TrimSpace(m[4])
	parts := []string{}
	args := []any{}
	if loc := whereTerm.FindStringIndex(tail); loc != nil {
		tail = tail[loc[1]:]
		for {
			if n := nullPredicate.FindStringSubmatch(tail); n != nil {
				parts = append(parts, quote(n[1])+" IS "+strings.ToUpper(n[2])+"NULL")
				tail = strings.TrimSpace(tail[len(n[0]):])
			} else if p := readPredicate.FindStringSubmatch(tail); p != nil {
				var v any = p[3]
				if strings.HasPrefix(p[3], "'") {
					v = strings.ReplaceAll(p[3][1:len(p[3])-1], "''", "'")
				} else if strings.EqualFold(p[3], "true") || strings.EqualFold(p[3], "false") {
					v = strings.EqualFold(p[3], "true")
				} else if n, e := strconv.ParseInt(p[3], 10, 64); e == nil {
					v = n
				}
				args = append(args, v)
				parts = append(parts, quote(p[1])+" "+strings.ToUpper(p[2])+" "+bindParameter(s.engine, len(args)))
				tail = strings.TrimSpace(tail[len(p[0]):])
			} else {
				return "", nil, readError
			}
			if and := andTerm.FindStringIndex(tail); and != nil {
				tail = tail[and[1]:]
				continue
			}
			break
		}
	}
	suffix := " FROM " + name
	if len(parts) > 0 {
		suffix += " WHERE " + strings.Join(parts, " AND ")
	}
	if loc := orderBy.FindStringIndex(tail); loc != nil {
		tail = tail[loc[1]:]
		terms := []string{}
		for {
			ord := orderTerm.FindStringSubmatch(tail)
			if ord == nil {
				return "", nil, readError
			}
			term := quote(ord[1])
			if ord[2] != "" {
				term += " " + strings.ToUpper(ord[2])
			}
			terms = append(terms, term)
			tail = strings.TrimSpace(tail[len(ord[0]):])
			if strings.HasPrefix(tail, ",") {
				tail = strings.TrimSpace(tail[1:])
				continue
			}
			break
		}
		suffix += " ORDER BY " + strings.Join(terms, ",")
	}
	prefix := "SELECT "
	if tail != "" {
		lim := limitTerm.FindStringSubmatch(tail)
		if lim == nil {
			return "", nil, readError
		}
		n, _ := strconv.Atoi(lim[1])
		n = min(n, rowLimit+1)
		switch s.engine {
		case "sqlserver", "mssql":
			prefix += fmt.Sprintf("TOP (%d) ", n)
		case "oracle":
			suffix += fmt.Sprintf(" FETCH FIRST %d ROWS ONLY", n)
		default:
			suffix += fmt.Sprintf(" LIMIT %d", n)
		}
	}
	return prefix + cols + suffix, args, nil
}
func (s *sqlSession) updateCell(ctx context.Context, r request) (map[string]int, error) {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	meta, e := s.tableColumns(ctx, tx, r.Object)
	if e != nil {
		return nil, e
	}
	var col Column
	pk := []string{}
	for _, c := range meta {
		if c.Name == r.Column {
			col = c
		}
		if c.PrimaryKey {
			if !scalarType(c.Type) {
				return nil, errors.New("unsupported primary key type for grid edits")
			}
			pk = append(pk, c.Name)
		}
	}
	if !col.Editable || len(pk) == 0 || len(pk) != len(r.Key) {
		return nil, errors.New("choose an editable column and a complete primary key")
	}
	// Compare the exact display value after obtaining a row lock. This detects
	// case-only changes even on case-insensitive collations.
	sort.Strings(pk)
	keyArgs := []any{}
	where := func(start int) string {
		parts := []string{}
		for i, k := range pk {
			parts = append(parts, sqlIdentifier(s.engine, k)+"="+bindParameter(s.engine, i+start))
		}
		return strings.Join(parts, " AND ")
	}
	for _, k := range pk {
		v, ok := r.Key[k]
		if !ok {
			return nil, errors.New("incomplete primary key")
		}
		keyArgs = append(keyArgs, v)
	}
	table := s.tableName(r.Object)
	lock := " FOR UPDATE"
	source := table
	if s.engine == "sqlserver" || s.engine == "mssql" {
		source += " WITH (UPDLOCK,HOLDLOCK)"
		lock = ""
	}
	var current any
	err := tx.QueryRowContext(ctx, "SELECT "+sqlIdentifier(s.engine, col.Name)+" FROM "+source+" WHERE "+where(1)+lock, keyArgs...).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("the row was removed; refresh and try again")
	}
	if err != nil {
		return nil, err
	}
	old, clipped := sqlCell(current, col.Type)
	if clipped || !equalCell(old, r.OldValue) {
		return nil, errors.New("this cell changed since the preview; refresh before editing")
	}
	args := []any{r.NewValue}
	args = append(args, keyArgs...)
	res, err := tx.ExecContext(ctx, "UPDATE "+table+" SET "+sqlIdentifier(s.engine, col.Name)+"="+bindParameter(s.engine, 1)+" WHERE "+where(2), args...)
	if err != nil {
		return nil, err
	}
	affected, e := res.RowsAffected()
	if e != nil || affected != 1 {
		return nil, errors.New("the change did not affect exactly one row; rolled back")
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]int{"affected": 1}, nil
}
func equalCell(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
